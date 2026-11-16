// While a conversation's worktree is being released (git.ts releaseWorktree),
// the runner holds its turns: a send is refused and a prewarm skipped, so no
// turn starts in a directory that's about to go. Holds count, so an overlapping
// release keeps the hold until both have let go, and letting go twice is once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: string[][] = [];
const children: import('node:child_process').ChildProcess[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // Stands in for the CLI: idles until killed.
    spawn: (_command: string, args: string[], opts: object) => {
      spawnCalls.push(args);
      const child = real.spawn('/bin/sh', ['-c', 'trap "exit 0" TERM; while :; do sleep 0.01; done'], opts as never);
      children.push(child);
      return child;
    },
  };
});

import { RunnerManager } from './runner';
import { useTestHost } from './testHost';

const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hold-data-')));
const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hold-cwd-')));
useTestHost(dataDir);
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.pid) try { process.kill(c.pid, 'SIGKILL'); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const CONV = 'acme-hold-1';
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
const HELD = { ok: false, error: 'Its worktree is being tidied away. Send again in a moment.' };

function manager() {
  return new RunnerManager(
    () => {},
    () => ({ backends: {}, backendPaths: { claude: '/usr/bin/true' } }) as never,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe('holding a conversation’s turns', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('refuses a send and skips a prewarm until every hold is let go', async () => {
    const m = manager();
    const first = m.holdTurns(CONV as never);
    const second = m.holdTurns(CONV as never);
    first();
    // One release is still going.
    expect(m.send({ ...base, prompt: 'go' } as never)).toEqual(HELD);
    m.prewarm(base as never);
    await tick();
    expect(spawnCalls).toHaveLength(0);

    second();
    expect(m.send({ ...base, prompt: 'go' } as never)).toEqual({ ok: true });
    await tick();
    expect(spawnCalls).toHaveLength(1);
    m.stop(CONV);
  });

  it('counts letting go twice as once', async () => {
    const m = manager();
    const first = m.holdTurns(CONV as never);
    const second = m.holdTurns(CONV as never);
    first();
    first();
    expect(m.send({ ...base, prompt: 'go' } as never)).toEqual(HELD);
    second();
    second();
    expect(m.send({ ...base, prompt: 'go' } as never)).toEqual({ ok: true });
    m.stop(CONV);
  });

  it('holds only the conversation it names', () => {
    const m = manager();
    const release = m.holdTurns(CONV as never);
    expect(m.send({ ...base, conversationId: 'acme-other', prompt: 'go' } as never)).toEqual({ ok: true });
    release();
    m.stop('acme-other');
  });
});
