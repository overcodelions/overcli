// A process the runner has replaced must not speak for its conversation.
//
// A flow warms the next step's process ahead of time. When the real send
// launches differently (a changed allowlist, model, permission mode), the
// runner kills the warm process and spawns another under the same
// conversation. The killed CLI answers SIGTERM with a final `result` and a
// nonzero exit; both used to reach the conversation as "turn over" plus an
// error, and the flow read that as the new step finishing with no output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 1,
  total_cost_usd: 0,
  session_id: 'acme-session',
});

const spawnCalls: { command: string; args: string[] }[] = [];
// When set, a process can't be signalled, as when it runs as the worker user
// and the server lacks CAP_KILL: Node's kill() then emits 'error' (EPERM,
// syscall 'kill') synchronously and returns false.
let killFails = false;
const children: import('node:child_process').ChildProcess[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // Stands in for the CLI: idles until killed, then does what the real one
    // does on SIGTERM — prints a closing result and exits 1.
    spawn: (command: string, args: string[], opts: object) => {
      spawnCalls.push({ command, args });
      const child = real.spawn(
        '/bin/sh',
        ['-c', `trap 'echo ${JSON.stringify(RESULT_LINE).replace(/'/g, '')}; exit 1' TERM; while :; do sleep 0.01; done`],
        opts as never,
      );
      children.push(child);
      if (killFails) {
        child.kill = () => {
          child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' }));
          return false;
        };
      }
      return child;
    },
  };
});

import { idleSourceFrames, isCurrentProcess, isSignalError, RunnerManager, stderrTailForLog, turnPending } from './runner';
import { changedLaunchParams, type LaunchParams } from './launchParams';
import { useTestHost } from './testHost';

const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-respawn-data-')));
const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-respawn-cwd-')));
useTestHost(dataDir);
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.pid) try { process.kill(c.pid, 'SIGKILL'); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

type Event = { type: string; conversationId?: string; isRunning?: boolean };

const CONV = 'acme-conv-1';
const base = {
  conversationId: CONV,
  prompt: '',
  backend: 'claude' as const,
  cwd,
  model: 'claude-opus-5-5',
  permissionMode: 'acceptEdits' as const,
  reviewBackend: null,
  reviewMode: null,
  reviewModel: null,
  reviewPersona: null,
};

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function manager(events: Event[]) {
  return new RunnerManager(
    (e: Event) => events.push(e),
    () => ({ backends: {}, backendPaths: { claude: '/usr/bin/true' } }) as never,
  );
}

describe('a superseded process', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it("does not end the live turn or report an error when it's killed for a respawn", async () => {
    const events: Event[] = [];
    const m = manager(events);
    m.prewarm(base as never);
    await until(() => spawnCalls.length === 1);
    // Let the stand-in install its trap, as a real CLI would be up by now.
    await new Promise((r) => setTimeout(r, 150));

    // A different allowlist is a launch-param change: the warm process is
    // killed and replaced.
    expect(m.send({ ...base, prompt: 'go', flowStep: true, enabledTools: ['Read'] } as never)).toEqual({ ok: true });
    await until(() => spawnCalls.length === 2);
    // Long enough for the killed process to print, exit and be reaped.
    await new Promise((r) => setTimeout(r, 300));

    const mine = events.filter((e) => e.conversationId === CONV);
    expect(mine.some((e) => e.type === 'running' && e.isRunning === false)).toBe(false);
    expect(mine.some((e) => e.type === 'error')).toBe(false);
    m.stop(CONV);
  });

  it("keeps the live turn and the conversation's broker when the old process can't be signalled", async () => {
    killFails = true;
    const events: Event[] = [];
    const m = manager(events);
    try {
      m.prewarm(base as never);
      await until(() => spawnCalls.length === 1);
      await new Promise((r) => setTimeout(r, 150));
      expect(spawnCalls[0].args).toContain('--mcp-config');

      expect(m.send({ ...base, prompt: 'go', flowStep: true, enabledTools: ['Read'] } as never)).toEqual({ ok: true });
      await until(() => spawnCalls.length === 2);
      await new Promise((r) => setTimeout(r, 150));

      const mine = events.filter((e) => e.conversationId === CONV);
      // The failed kill used to read as the live process closing: "turn over"
      // for the conversation, a spawn error, and its broker released.
      expect(mine.some((e) => e.type === 'running' && e.isRunning === false)).toBe(false);
      expect(mine.some((e) => e.type === 'error')).toBe(false);
      expect(m.isTurnPending(CONV)).toBe(true);
      // So the relaunch kept its MCP config and permission prompt tool.
      expect(spawnCalls[1].args).toContain('--mcp-config');
      expect(spawnCalls[1].args).toContain('--permission-prompt-tool');
    } finally {
      m.stop(CONV);
      killFails = false;
    }
  });

  it('is not respawned when the send launches the way the prewarm did', async () => {
    const events: Event[] = [];
    const m = manager(events);
    m.prewarm({ ...base, enabledTools: ['Read'] } as never);
    await until(() => spawnCalls.length === 1);

    m.send({ ...base, prompt: 'go', flowStep: true, enabledTools: ['Read'] } as never);
    await new Promise((r) => setTimeout(r, 200));

    expect(spawnCalls).toHaveLength(1);
    m.stop(CONV);
  });
});

describe('isSignalError', () => {
  it("is a signal that couldn't be delivered, not a spawn failure", () => {
    expect(isSignalError(Object.assign(new Error('x'), { code: 'EPERM', syscall: 'kill' }))).toBe(true);
    expect(isSignalError(Object.assign(new Error('x'), { code: 'ENOENT', syscall: 'spawn /usr/local/bin/claude' }))).toBe(false);
  });
});

describe('isCurrentProcess', () => {
  it('is true only for the process registered for the conversation', () => {
    const live = {};
    expect(isCurrentProcess(live, live)).toBe(true);
    expect(isCurrentProcess({}, live)).toBe(false);
    expect(isCurrentProcess(undefined, live)).toBe(false);
  });
});

describe('isTurnPending', () => {
  it('is true from the send until the process goes, and false for an unused prewarm', async () => {
    const events: Event[] = [];
    const m = manager(events);
    m.prewarm(base as never);
    await until(() => spawnCalls.length > 0);
    // Warm but never sent to: nothing is owed.
    expect(m.isTurnPending(CONV)).toBe(false);

    m.send({ ...base, prompt: 'go', flowStep: true } as never);
    // A Claude send prepares its broker first; it is owed from that moment.
    expect(m.isTurnPending(CONV)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(m.isTurnPending(CONV)).toBe(true);

    m.stop(CONV);
    expect(m.isTurnPending(CONV)).toBe(false);
  });

  it('reads a pending send or a turn without its result as owed', () => {
    expect(turnPending({ sendPending: true, turnInFlight: false })).toBe(true);
    expect(turnPending({ sendPending: false, turnInFlight: true })).toBe(true);
    expect(turnPending({ sendPending: false, turnInFlight: false })).toBe(false);
    // A transport that doesn't track turns is never held.
    expect(turnPending({ sendPending: false, turnInFlight: undefined })).toBe(false);
  });
});

describe('what the session log says', () => {
  it('names the frames that emitted idle, without their folders', () => {
    const stack = [
      'Error',
      '    at logIdleSource (/app/dist/main/runner.js:480:40)',
      '    at RunnerManager.emit (/app/dist/main/runner.js:1336:7)',
      '    at RunnerManager.handleActiveClose (/app/dist/main/runner.js:4418:14)',
      '    at ChildProcess.<anonymous> (/app/dist/main/runner.js:4230:51)',
      '    at ChildProcess.emit (node:events:518:28)',
    ].join('\n');
    expect(idleSourceFrames(stack)).toBe('RunnerManager.handleActiveClose (runner.js:4418) < ChildProcess.<anonymous> (runner.js:4230) < ChildProcess.emit (node:events:518)');
  });

  it('names the launch params that changed, and only their names', () => {
    const a = { launchModel: 'acme-1', launchTurbo: false, launchEffort: '', cwd: '/w' } as unknown as LaunchParams;
    const b = { launchModel: 'acme-1', launchTurbo: true, launchEffort: 'low', cwd: '/w' } as unknown as LaunchParams;
    expect(changedLaunchParams(a, b)).toEqual(['launchTurbo', 'launchEffort']);
  });

  it("keeps a stderr tail on one line, with secrets taken out", () => {
    const out = stderrTailForLog('boom\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('\n');
    expect(out.startsWith('boom ')).toBe(true);
  });
});
