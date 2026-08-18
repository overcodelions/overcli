import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('./diagnostics', () => ({ log: vi.fn() }));

import { openTerminalAt, runInTerminal } from './terminal';

/// A stand-in for the osascript child: emits `stderr` then closes with `code`.
function fakeOsascript(code: number, stderr = '') {
  const child: any = new EventEmitter();
  child.stderr = Readable.from(stderr ? [stderr] : []);
  child.kill = vi.fn();
  setImmediate(() => child.emit('close', code));
  return child;
}

/// `open -a Terminal` is fire-and-forget; only osascript is inspected.
function fakeOpen() {
  const child: any = new EventEmitter();
  child.unref = vi.fn();
  return child;
}

function wireSpawn(osascript: () => any) {
  spawn.mockImplementation((cmd: string) => (cmd === 'osascript' ? osascript() : fakeOpen()));
}

const realPlatform = process.platform;

beforeEach(() => {
  spawn.mockReset();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('runInTerminal', () => {
  it('opens a window before scripting it, so a refused Apple Event still leaves something visible', async () => {
    wireSpawn(() => fakeOsascript(0));
    const res = await runInTerminal('brew upgrade ollama');
    expect(res).toEqual({ ok: true });
    const commands = spawn.mock.calls.map((c) => c[0]);
    expect(commands).toEqual(['open', 'osascript']);
    expect(spawn.mock.calls[0][1]).toEqual(['-a', 'Terminal', expect.any(String)]);
  });

  it('reports failure when osascript exits non-zero instead of claiming success', async () => {
    wireSpawn(() => fakeOsascript(1, 'execution error: Terminal got an error. (-1728)'));
    const res = await runInTerminal('brew upgrade ollama');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.command).toBe('brew upgrade ollama');
  });

  it('turns an Automation denial into instructions plus a copyable command', async () => {
    wireSpawn(() =>
      fakeOsascript(1, 'execution error: Not authorized to send Apple events to Terminal. (-1743)'),
    );
    const res = await runInTerminal('brew upgrade ollama');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('Privacy & Security → Automation');
    // The command travels as its own field, not buried in the prose, so the
    // UI can render it with a copy button.
    expect(res.ok === false && res.command).toBe('brew upgrade ollama');
  });

  it('hands back the command on platforms with no terminal launcher', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const res = await runInTerminal('brew upgrade ollama');
    expect(res.ok === false && res.command).toBe('brew upgrade ollama');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still refuses shell metacharacters before spawning anything', async () => {
    wireSpawn(() => fakeOsascript(0));
    const res = await runInTerminal('brew upgrade ollama && rm -rf /');
    expect(res.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('openTerminalAt', () => {
  it('runs the command in the window opened at cwd', async () => {
    wireSpawn(() => fakeOsascript(0));
    const res = await openTerminalAt('/tmp/work', 'claude auth login');
    expect(res).toEqual({ ok: true });
    expect(spawn.mock.calls[0][1]).toEqual(['-a', 'Terminal', '/tmp/work']);
    expect(spawn.mock.calls[1][1][1]).toContain('do script "claude auth login" in front window');
  });

  it('propagates an osascript failure with the command to run by hand', async () => {
    wireSpawn(() => fakeOsascript(1, 'boom'));
    const res = await openTerminalAt('/tmp/work', 'claude auth login');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.command).toBe('claude auth login');
  });
});
