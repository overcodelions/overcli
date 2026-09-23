import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({
  fail: false,
  /// When set, the child exits with this code right after spawning.
  exitCode: undefined as number | null | undefined,
  calls: [] as unknown[][],
  unref: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    spawned.calls.push(args);
    const handlers: Record<string, Array<(value?: unknown) => void>> = {};
    const add = (name: string, cb: (value?: unknown) => void) => {
      (handlers[name] ??= []).push(cb);
      return child;
    };
    const fire = (name: string, value?: unknown) => {
      for (const cb of handlers[name] ?? []) cb(value);
    };
    const child = { once: add, on: add, unref: spawned.unref };
    queueMicrotask(() => {
      if (spawned.fail) return fire('error', new Error('spawn failed'));
      fire('spawn');
      if (spawned.exitCode !== undefined) queueMicrotask(() => fire('exit', spawned.exitCode));
    });
    return child;
  },
}));

import { findBrowser, openInBrowser } from './openInBrowser';

beforeEach(() => {
  spawned.fail = false;
  spawned.exitCode = undefined;
  spawned.calls = [];
  spawned.unref.mockReset();
});

const only = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe('findBrowser', () => {
  describe('macOS', () => {
    it('prefers an installed third-party browser over Safari', () => {
      const found = findBrowser(
        'darwin',
        only('/Applications/Google Chrome.app', '/Applications/Safari.app'),
      );
      expect(found).toEqual({
        name: 'Chrome',
        exec: 'open',
        args: ['-a', '/Applications/Google Chrome.app'],
      });
    });

    it('falls back to Safari, including its System location', () => {
      expect(findBrowser('darwin', only('/System/Applications/Safari.app'))?.name).toBe('Safari');
    });
  });

  describe('Windows', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    };

    it('finds a per-machine Chrome install', () => {
      const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      expect(findBrowser('win32', only(exe), env)).toEqual({ name: 'Chrome', exec: exe, args: [] });
    });

    it('finds a per-user Chrome install under LOCALAPPDATA', () => {
      const exe = 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
      expect(findBrowser('win32', only(exe), env)?.exec).toBe(exe);
    });

    it('falls back to Edge when nothing else is installed', () => {
      const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      expect(findBrowser('win32', only(exe), env)?.name).toBe('Edge');
    });
  });

  describe('Linux', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' };

    it('resolves a browser command on PATH', () => {
      expect(findBrowser('linux', only('/usr/bin/firefox'), env)).toEqual({
        name: 'Firefox',
        exec: '/usr/bin/firefox',
        args: [],
      });
    });

    it('accepts the Debian spelling of a command', () => {
      expect(findBrowser('linux', only('/usr/bin/google-chrome-stable'), env)?.name).toBe('Chrome');
    });

    it('prefers Chrome over Firefox when both are on PATH', () => {
      expect(findBrowser('linux', only('/usr/bin/firefox', '/usr/bin/chromium'), env)?.name).toBe(
        'Chromium',
      );
    });

    it('is null when PATH is empty', () => {
      expect(findBrowser('linux', () => true, { PATH: '' })).toBeNull();
    });
  });

  it('is null when no browser is installed, so the row is hidden', () => {
    expect(findBrowser('darwin', () => false)).toBeNull();
    expect(findBrowser('win32', () => false, {})).toBeNull();
  });
});

describe('openInBrowser', () => {
  const browser = { name: 'Firefox', exec: '/usr/bin/firefox', args: ['--new-window'] };

  it('resolves on spawn and detaches the browser process', async () => {
    await expect(openInBrowser('/tmp/page.html', browser)).resolves.toEqual({ ok: true, browser: 'Firefox' });
    expect(spawned.calls[0]).toEqual([
      '/usr/bin/firefox',
      ['--new-window', '/tmp/page.html'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ]);
    expect(spawned.unref).toHaveBeenCalledOnce();
  });

  it('returns a spawn error without claiming success', async () => {
    spawned.fail = true;
    await expect(openInBrowser('/tmp/page.html', browser)).resolves.toEqual({ ok: false, error: 'spawn failed' });
    expect(spawned.unref).not.toHaveBeenCalled();
  });

  describe('through macOS `open`', () => {
    const safari = { name: 'Safari', exec: 'open', args: ['-a', '/Applications/Safari.app'] };

    it('reports success only once `open` exits cleanly, still detached', async () => {
      spawned.exitCode = 0;
      await expect(openInBrowser('/tmp/page.html', safari)).resolves.toEqual({ ok: true, browser: 'Safari' });
      expect(spawned.unref).toHaveBeenCalledOnce();
    });

    it('reports a failed `open` as a failure, not as opened', async () => {
      spawned.exitCode = 1;
      const res = await openInBrowser('/tmp/page.html', safari);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/Safari.*exited 1/);
    });
  });
});
