// The Codex MCP login is a long-lived child process. Each terminal path
// (clean exit, non-zero exit, spawn error, timeout) must settle the promise
// exactly once, or the IPC handler hangs forever.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { loginCodexMcp } from './mcpLogin';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  spawnMock.mockReturnValue(child);
  return child;
}

const login = (onUrl?: (u: string) => void, timeoutMs?: number) =>
  loginCodexMcp({ binary: 'codex', name: 'linear', env: {}, onUrl, timeoutMs });

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe('loginCodexMcp', () => {
  it('spawns `codex mcp login <name>`', async () => {
    const child = fakeChild();
    const p = login();
    expect(spawnMock.mock.calls[0][0]).toBe('codex');
    expect(spawnMock.mock.calls[0][1]).toEqual(['mcp', 'login', 'linear']);
    child.emit('close', 0);
    await p;
  });

  it('resolves ok with the collected output on exit 0', async () => {
    const child = fakeChild();
    const p = login();
    child.stdout.emit('data', Buffer.from('done\n'));
    child.emit('close', 0);
    await expect(p).resolves.toEqual({ ok: true, output: 'done\n' });
  });

  it('collects stderr into the same output buffer', async () => {
    const child = fakeChild();
    const p = login();
    child.stderr.emit('data', Buffer.from('warn\n'));
    child.emit('close', 0);
    expect((await p).output).toBe('warn\n');
  });

  it('fails with the exit code on a non-zero exit', async () => {
    const child = fakeChild();
    const p = login();
    child.emit('close', 3);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('3');
  });

  it('fails with the spawn error message', async () => {
    const child = fakeChild();
    const p = login();
    child.emit('error', new Error('ENOENT'));
    expect(await p).toEqual({ ok: false, error: 'ENOENT', output: '' });
  });

  it('reports the first URL exactly once', async () => {
    const child = fakeChild();
    const onUrl = vi.fn();
    const p = login(onUrl);
    child.stdout.emit('data', Buffer.from('open https://auth.example/x?a=1 now'));
    child.stdout.emit('data', Buffer.from('or https://second.example/y'));
    child.emit('close', 0);
    await p;
    expect(onUrl).toHaveBeenCalledTimes(1);
    expect(onUrl).toHaveBeenCalledWith('https://auth.example/x?a=1');
  });

  it('kills the child and fails once the timeout elapses', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const p = login(undefined, 1000);
    vi.advanceTimersByTime(1000);
    const r = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('timed out');
  });

  it('ignores a late close after the timeout already settled', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const p = login(undefined, 1000);
    vi.advanceTimersByTime(1000);
    child.emit('close', 0);
    expect((await p).ok).toBe(false);
  });
});
