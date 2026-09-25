import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

vi.mock('../diagnostics', () => ({ log: vi.fn() }));

import { probeClaudeMcp } from './mcpProbe';
import { seenMcpServers, seenMcpTools, setMcpSeenFileForTests } from './mcpToolCache';

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-'));
  setMcpSeenFileForTests(path.join(dir, 'seen.json'));
});
afterEach(() => {
  setMcpSeenFileForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('probeClaudeMcp', () => {
  it('records the init event and stops Claude before it answers', async () => {
    const proc = fakeProc();
    const done = probeClaudeMcp('claude', { spawnFn: () => proc as unknown as ChildProcess });
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }],
      tools: ['Read', 'mcp__claude_ai_Gmail__search_threads'],
    });
    // Split across chunks, after a line that is not init.
    proc.stdout.emit('data', Buffer.from('{"type":"system","subtype":"hook"}\n' + init.slice(0, 20)));
    proc.stdout.emit('data', Buffer.from(init.slice(20) + '\n'));

    expect(await done).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
    expect(seenMcpServers()).toEqual(['claude.ai Gmail']);
    expect(seenMcpTools()).toEqual(['mcp__claude_ai_Gmail__search_threads']);
  });

  it('gives up on a Claude that exits or stalls without an init', async () => {
    const exits = fakeProc();
    const first = probeClaudeMcp('claude', { spawnFn: () => exits as unknown as ChildProcess });
    exits.emit('exit', 1);
    expect(await first).toBe(false);

    const stalls = fakeProc();
    expect(await probeClaudeMcp('claude', { timeoutMs: 10, spawnFn: () => stalls as unknown as ChildProcess })).toBe(false);
    expect(stalls.kill).toHaveBeenCalled();
  });

  it('shares one probe between concurrent callers', async () => {
    const proc = fakeProc();
    const spawnFn = vi.fn(() => proc as unknown as ChildProcess);
    const a = probeClaudeMcp('claude', { spawnFn });
    const b = probeClaudeMcp('claude', { spawnFn });
    proc.emit('exit', 0);
    await Promise.all([a, b]);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
