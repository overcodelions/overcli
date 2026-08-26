// Spawn-failure containment for GeminiAcpClient.
//
// Regression context: the client registered a 'close' handler but no 'error'
// handler on the spawned child. A spawn failure (gemini not installed, not on
// PATH, not executable, or a cwd that no longer exists) emits Node's 'error'
// event; with no listener Node rethrows it as an uncaught exception, and
// `index.ts` installs an `uncaughtException` handler only under `isDev`. In a
// packaged build that killed the entire Electron main process — every open
// conversation, flow run and worker shift, not just the one with the bad path.
//
// These tests use a REAL spawn of a nonexistent binary rather than a mock, so
// they exercise Node's genuine event sequence: 'error' → stdin write rejects
// EPIPE → 'close' (status -2). `resolveGeminiAcpFlag` runs `spawnSync(binary,
// ['--help'])` in the constructor, which returns an error object rather than
// throwing for a missing binary, so constructing against a bogus path is safe.

import { describe, expect, it, vi } from 'vitest';
import { GeminiAcpClient } from './geminiAcp';

const MISSING = '/nonexistent/path/to/gemini-binary';

function makeClient(overrides: { cwd?: string; binary?: string } = {}) {
  const onClose = vi.fn();
  const client = new GeminiAcpClient({
    binary: overrides.binary ?? MISSING,
    cwd: overrides.cwd ?? process.cwd(),
    env: process.env,
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    onStderr: vi.fn(),
    onClose,
  });
  return { client, onClose };
}

/// Resolve once the client has finished tearing down, i.e. after its onClose
/// fired. Fails loudly rather than hanging forever if teardown never happens.
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

describe('GeminiAcpClient spawn failure', () => {
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

  it('tears down with onClose(null) so the owner learns the client is gone', async () => {
    const { onClose } = makeClient();
    await whenClosed(onClose);
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it('rejects an in-flight request with the real cause, not an opaque EPIPE', async () => {
    const { client, onClose } = makeClient();
    const inFlight = client.request('session/new', {});
    await expect(inFlight).rejects.toThrow(/was not found/);
    // The generic close message must NOT be what the caller sees.
    await expect(inFlight).rejects.not.toThrow(/status -2/);
    await whenClosed(onClose);
  });

  it('names the missing working directory rather than blaming the CLI', async () => {
    const { client, onClose } = makeClient({ cwd: '/nonexistent/worktree/gone' });
    await expect(client.request('session/new', {})).rejects.toThrow(
      /working directory no longer exists/,
    );
    await whenClosed(onClose);
  });

  it('carries the spawn cause on a request issued after the failure', async () => {
    const { client, onClose } = makeClient();
    await whenClosed(onClose);
    // This request never becomes pending — it hits the `closed` guard, which
    // must prefer the stored cause over "connection is closed".
    await expect(client.request('session/new', {})).rejects.toThrow(/was not found/);
    await expect(client.request('session/new', {})).rejects.not.toThrow(/connection is closed/);
  });

  it('does not double-process when close arrives after error', async () => {
    const { client, onClose } = makeClient();
    await whenClosed(onClose);
    // Node emits both 'error' and 'close' for one failed spawn. Wait past the
    // close, then assert the owner was still notified exactly once and the
    // stored cause was not overwritten by "exited with status -2".
    await new Promise((r) => setTimeout(r, 200));
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(client.request('session/new', {})).rejects.not.toThrow(/status -2/);
  });
});
