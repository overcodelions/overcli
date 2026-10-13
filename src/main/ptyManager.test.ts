import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager, defaultShell, shellEnvironment, type PtyEvent, type PtyProcess } from './ptyManager';

class FakePty implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  private dataListener: (d: string) => void = () => {};
  private exitListener: (e: { exitCode: number }) => void = () => {};
  onData(l: (d: string) => void) {
    this.dataListener = l;
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.exitListener = l;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill() {
    this.killed = true;
  }
  emitData(d: string) {
    this.dataListener(d);
  }
  emitExit(code: number) {
    this.exitListener({ exitCode: code });
  }
}

let fakes: FakePty[];
let events: PtyEvent[];
let spawnCalls: Array<{ file: string; args: string[]; opts: { cwd: string; env: Record<string, string> } }>;

function manager(env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', HOME: '/Users/acme' }) {
  return new PtyManager({
    platform: 'darwin',
    env,
    emit: (e) => events.push(e),
    spawn: (file, args, opts) => {
      spawnCalls.push({ file, args, opts });
      const p = new FakePty();
      fakes.push(p);
      return p;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fakes = [];
  events = [];
  spawnCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PtyManager', () => {
  it('starts the user login shell in the asked-for folder', () => {
    const m = manager();
    const s = m.create({ cwd: '/work/acme-api', cols: 120, rows: 30 });
    expect(spawnCalls[0]!.file).toBe('/bin/zsh');
    expect(spawnCalls[0]!.args).toEqual(['-l']);
    expect(spawnCalls[0]!.opts.cwd).toBe('/work/acme-api');
    expect(s).toMatchObject({ cwd: '/work/acme-api', shell: 'zsh', pid: 4242, exitCode: null });
  });

  it('batches output into one event per frame', () => {
    const m = manager();
    const s = m.create({ cwd: '/w', cols: 80, rows: 24 });
    fakes[0]!.emitData('a');
    fakes[0]!.emitData('b');
    fakes[0]!.emitData('c');
    expect(events).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(events).toEqual([{ type: 'terminalData', id: s.id, data: 'abc' }]);
  });

  it('flushes pending output before answering a snapshot, so a view never prints it twice', () => {
    const m = manager();
    const s = m.create({ cwd: '/w', cols: 80, rows: 24 });
    fakes[0]!.emitData('first ');
    vi.advanceTimersByTime(20);
    fakes[0]!.emitData('second');
    expect(m.snapshot(s.id)).toBe('first second');
    expect(events.map((e) => (e.type === 'terminalData' ? e.data : ''))).toEqual(['first ', 'second']);
    vi.advanceTimersByTime(20);
    expect(events).toHaveLength(2);
  });

  it('keeps only a bounded tail, cut at a line break', () => {
    const m = manager();
    const s = m.create({ cwd: '/w', cols: 80, rows: 24 });
    const line = 'x'.repeat(1023) + '\n';
    for (let i = 0; i < 400; i++) fakes[0]!.emitData(line);
    const tail = m.snapshot(s.id)!;
    expect(tail.length).toBeLessThanOrEqual(256 * 1024);
    expect(tail.startsWith('x')).toBe(true);
    expect(tail.length % line.length).toBe(0);
  });

  it('forwards keystrokes and resizes, ignoring a collapsed drawer', () => {
    const m = manager();
    const s = m.create({ cwd: '/w', cols: 80, rows: 24 });
    m.write(s.id, 'ls\r');
    m.resize(s.id, 100, 40);
    m.resize(s.id, 100, 0);
    expect(fakes[0]!.written).toEqual(['ls\r']);
    expect(fakes[0]!.sizes).toEqual([[100, 40]]);
  });

  it('reports an exit and stops forwarding input after it', () => {
    const m = manager();
    const s = m.create({ cwd: '/w', cols: 80, rows: 24 });
    fakes[0]!.emitData('bye');
    fakes[0]!.emitExit(3);
    expect(events).toEqual([
      { type: 'terminalData', id: s.id, data: 'bye' },
      { type: 'terminalExit', id: s.id, exitCode: 3 },
    ]);
    m.write(s.id, 'ignored');
    expect(fakes[0]!.written).toEqual([]);
    expect(m.list()[0]!.exitCode).toBe(3);
  });

  it('kills the shell on close and forgets it', () => {
    const m = manager();
    const a = m.create({ cwd: '/a', cols: 80, rows: 24 });
    const b = m.create({ cwd: '/b', cols: 80, rows: 24 });
    expect(a.id).not.toBe(b.id);
    fakes[0]!.emitData('late');
    m.close(a.id);
    vi.advanceTimersByTime(20);
    expect(fakes[0]!.killed).toBe(true);
    expect(events).toEqual([]);
    expect(m.list().map((t) => t.id)).toEqual([b.id]);
    expect(m.snapshot(a.id)).toBeNull();
    m.closeAll();
    expect(fakes[1]!.killed).toBe(true);
    expect(m.list()).toEqual([]);
  });
});

describe('PtyManager startup command', () => {
  it('waits for the shell to draw its prompt before typing the command', () => {
    const m = manager();
    m.create({ cwd: '/w', cols: 80, rows: 24, command: 'claude --resume abc' });
    expect(fakes[0]!.written).toEqual([]);
    fakes[0]!.emitData('Last login: today\r\n');
    vi.advanceTimersByTime(100);
    fakes[0]!.emitData('acme$ ');
    vi.advanceTimersByTime(100);
    expect(fakes[0]!.written).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(fakes[0]!.written).toEqual(['claude --resume abc\r']);
    fakes[0]!.emitData('more');
    vi.advanceTimersByTime(1000);
    expect(fakes[0]!.written).toHaveLength(1);
  });

  it('types it anyway after the deadline, and never into a closed shell', () => {
    const m = manager();
    m.create({ cwd: '/w', cols: 80, rows: 24, command: 'ls' });
    vi.advanceTimersByTime(5000);
    expect(fakes[0]!.written).toEqual(['ls\r']);

    const s = m.create({ cwd: '/w', cols: 80, rows: 24, command: 'ls' });
    m.close(s.id);
    vi.advanceTimersByTime(5000);
    expect(fakes[1]!.written).toEqual([]);
  });
});

describe('defaultShell', () => {
  it('uses $SHELL as a login shell, with a per-platform fallback', () => {
    expect(defaultShell('darwin', { SHELL: '/opt/homebrew/bin/fish' })).toEqual({
      file: '/opt/homebrew/bin/fish',
      argv: ['-l'],
    });
    expect(defaultShell('darwin', {}).file).toBe('/bin/zsh');
    expect(defaultShell('linux', {}).file).toBe('/bin/bash');
  });

  it('uses PowerShell on Windows rather than cmd', () => {
    expect(defaultShell('win32', { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      file: 'powershell.exe',
      argv: [],
    });
  });
});

describe('shellEnvironment', () => {
  it('drops the app-only switches and sets the terminal type', () => {
    const env = shellEnvironment(
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', VITE_DEV_SERVER_URL: 'http://x', PWD: '/app' },
      'darwin',
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.VITE_DEV_SERVER_URL).toBeUndefined();
    expect(env.PWD).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
    expect(env.LANG).toBe('en_US.UTF-8');
  });
});
