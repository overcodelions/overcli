// Spawn-failure containment for CodexAppServerClient.
//
// Regression context: the client registered a 'close' handler but no 'error'
// handler on the spawned child. A spawn failure (codex not installed, not on
// PATH, not executable, or a cwd that no longer exists) emits Node's 'error'
// event; with no listener Node rethrows it as an uncaught exception, and
// `index.ts` installs an `uncaughtException` handler only under `isDev`. In a
// packaged build that killed the entire Electron main process — every open
// conversation, flow run and worker shift, not just the one with the bad path.
//
// Uses a REAL spawn of a nonexistent binary rather than a mock, so the tests
// exercise Node's genuine event sequence: 'error' → stdin write rejects EPIPE
// → 'close' (status -2).
//
// Note the client extends EventEmitter, so the failure is surfaced on
// 'spawnError', NOT 'error' — EventEmitter throws on an emitted 'error' with
// no listener, which would reintroduce the crash being fixed here.

import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './codex-app-server';

const MISSING = '/nonexistent/path/to/codex-binary';

const startOpts = {
  cwd: '/tmp/project',
  model: 'gpt-5',
  approval: 'on-request' as const,
  sandbox: 'workspace-write' as const,
  approvalsReviewer: undefined,
};

function makeClient(overrides: { cwd?: string } = {}) {
  const client = new CodexAppServerClient({
    binary: MISSING,
    cwd: overrides.cwd ?? process.cwd(),
    env: process.env,
  });
  const onClose = vi.fn();
  const onSpawnError = vi.fn();
  client.on('close', onClose);
  client.on('spawnError', onSpawnError);
  return { client, onClose, onSpawnError };
}

/// Resolve once the client has torn down, i.e. after its 'close' fired.
/// Fails loudly rather than hanging forever if teardown never happens.
function whenClosed(onClose: ReturnType<typeof vi.fn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (onClose.mock.calls.length > 0) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started > 5000) {
        clearInterval(tick);
        reject(new Error('client never tore down after the failed spawn'));
      }
    }, 5);
  });
}

describe('CodexAppServerClient spawn failure', () => {
  it('does not throw uncaught when the binary cannot be launched', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const { onClose } = makeClient();
      await whenClosed(onClose);
      // Give any stray rethrow a turn of the loop to surface.
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });

  it('tears down with close(null) so consumers learn the client is gone', async () => {
    const { onClose } = makeClient();
    await whenClosed(onClose);
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it('reports the cause on spawnError, not on the EventEmitter error channel', async () => {
    const { onClose, onSpawnError } = makeClient();
    await whenClosed(onClose);
    expect(onSpawnError).toHaveBeenCalledTimes(1);
    expect(onSpawnError.mock.calls[0][0]).toMatch(/was not found/);
  });

  it('rejects an in-flight start() with the real cause, not an opaque EPIPE', async () => {
    const { client, onClose } = makeClient();
    const started = client.start(startOpts);
    await expect(started).rejects.toThrow(/was not found/);
    await expect(started).rejects.not.toThrow(/status -2/);
    await whenClosed(onClose);
  });

  it('names the missing working directory rather than blaming the CLI', async () => {
    const { client, onClose } = makeClient({ cwd: '/nonexistent/worktree/gone' });
    await expect(client.start(startOpts)).rejects.toThrow(/working directory no longer exists/);
    await whenClosed(onClose);
  });

  it('carries the spawn cause on a request issued after the failure', async () => {
    const { client, onClose } = makeClient();
    await whenClosed(onClose);
    // This request never becomes pending — it hits the `closed` guard, which
    // must prefer the stored cause over "connection is closed".
    await expect(client.start(startOpts)).rejects.toThrow(/was not found/);
    await expect(client.start(startOpts)).rejects.not.toThrow(/connection is closed/);
  });

  it('does not double-process when close arrives after error', async () => {
    const { client, onClose, onSpawnError } = makeClient();
    await whenClosed(onClose);
    // Node emits both 'error' and 'close' for one failed spawn. Wait past the
    // close, then assert consumers were notified exactly once and the stored
    // cause was not overwritten by "exited with status -2".
    await new Promise((r) => setTimeout(r, 200));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSpawnError).toHaveBeenCalledTimes(1);
    await expect(client.start(startOpts)).rejects.not.toThrow(/status -2/);
  });
});
