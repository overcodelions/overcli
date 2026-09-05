import { describe, expect, it } from 'vitest';
import { findBrowser } from './openInBrowser';

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
