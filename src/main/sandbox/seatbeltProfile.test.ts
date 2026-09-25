import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  backendStateDirs,
  buildSeatbeltProfile,
  canonicalRoots,
  claudeTranscriptSlugs,
  SANDBOX_EXEC,
  sandboxedCommand,
  sandboxRootsFor,
  sandboxSupported,
  writeSeatbeltProfile,
} from './seatbeltProfile';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-unit-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function mk(...parts: string[]): string {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe('buildSeatbeltProfile', () => {
  const text = buildSeatbeltProfile({ writable: ['/w/one', '/w/two'], denied: ['/w/one/.git/hooks'] });
  const lines = text.trim().split('\n');

  it('allows everything, then denies all writes, before any root is re-allowed', () => {
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write* (subpath "/"))');
    const firstAllow = lines.findIndex((l) => l.includes('(subpath "/w/one")'));
    expect(firstAllow).toBeGreaterThan(2);
  });

  it('emits one subpath allow per writable root, in order', () => {
    expect(lines.filter((l) => l.startsWith('(allow file-write* (subpath'))).toEqual([
      '(allow file-write* (subpath "/w/one"))',
      '(allow file-write* (subpath "/w/two"))',
    ]);
  });

  it('puts re-denials LAST so they win over an enclosing allow', () => {
    expect(lines[lines.length - 1]).toBe('(deny file-write* (subpath "/w/one/.git/hooks"))');
  });

  it('re-allows the device nodes a blanket deny would take (/dev/null, ttys, fds)', () => {
    expect(text).toContain('(literal "/dev/null")');
    expect(text).toContain('(regex #"^/dev/tty")');
    expect(text).toContain('(regex #"^/dev/fd/")');
  });

  it('escapes quotes and backslashes so a path cannot break out of its string', () => {
    const t = buildSeatbeltProfile({ writable: ['/a"b\\c'], denied: [] });
    expect(t).toContain('(allow file-write* (subpath "/a\\"b\\\\c"))');
    expect(t).not.toContain('(subpath "/a"b');
  });

  it('with no roots still denies writes', () => {
    const t = buildSeatbeltProfile({ writable: [], denied: [] });
    expect(t).toContain('(deny file-write* (subpath "/"))');
    expect(t).not.toContain('(allow file-write* (subpath');
  });
});

describe('canonicalRoots', () => {
  it('resolves symlinks to real paths and drops duplicates, empties and relatives', () => {
    const real = mk('real');
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link);
    expect(canonicalRoots([link, real, '', 'relative/dir'])).toEqual([real]);
  });

  it('keeps a not-yet-created dir under its real ancestor (a CLI creates it on first use)', () => {
    const real = mk('anc');
    const link = path.join(tmp, 'anc-link');
    fs.symlinkSync(real, link);
    expect(canonicalRoots([path.join(link, 'not', 'yet')])).toEqual([path.join(real, 'not', 'yet')]);
  });
});

describe('claudeTranscriptSlugs', () => {
  it('maps every non-alphanumeric to - like the claude CLI does', () => {
    const d = mk('a.b_c d');
    const [cli] = claudeTranscriptSlugs(d);
    expect(cli).toBe(d.replace(/[^a-zA-Z0-9]/g, '-'));
    expect(cli).not.toMatch(/[._ /]/);
  });
  it('also returns overcli’s own spelling when it differs (underscore kept)', () => {
    const d = mk('x_y');
    expect(claudeTranscriptSlugs(d)).toHaveLength(2);
  });
});

describe('backendStateDirs', () => {
  const home = '/Users/u';
  it('scopes claude to subdirectories, never ~/.claude itself, its settings or ~/.claude.json', () => {
    const dirs = backendStateDirs('claude', home, '/private/tmp/wt');
    expect(dirs).toContain('/Users/u/.claude/projects/-private-tmp-wt');
    expect(dirs).toContain('/Users/u/.claude/todos');
    expect(dirs).toContain('/Users/u/.claude/sessions');
    expect(dirs).not.toContain('/Users/u/.claude');
    expect(dirs).not.toContain('/Users/u/.claude/projects');
    expect(dirs).not.toContain('/Users/u/.claude.json');
    expect(dirs.some((d) => d.includes('settings') || d.endsWith('/hooks'))).toBe(false);
  });
  it('never grants home, ssh, aws, Desktop or Documents to any backend', () => {
    for (const b of ['claude', 'codex', 'gemini', 'copilot', 'ollama'] as const) {
      for (const d of backendStateDirs(b, home, '/wt')) {
        expect(d).not.toBe(home);
        expect(d).not.toMatch(/\/(\.ssh|\.aws|Desktop|Documents)(\/|$)/);
      }
    }
  });
  it('grants each other CLI its own dot-dir', () => {
    expect(backendStateDirs('codex', home, '/wt')).toContain('/Users/u/.codex');
    expect(backendStateDirs('gemini', home, '/wt')).toContain('/Users/u/.gemini');
    expect(backendStateDirs('copilot', home, '/wt')).toContain('/Users/u/.copilot');
    expect(backendStateDirs('ollama', home, '/wt')).toEqual([]);
  });
});

describe('sandboxRootsFor', () => {
  it('includes cwd, extras, temp and the git common dir; re-denies hooks and config', () => {
    const wt = mk('wt');
    const attach = mk('attach');
    const common = mk('repo', '.git');
    mk('repo', '.git', 'hooks');
    fs.writeFileSync(path.join(common, 'config'), '');
    const home = mk('home');
    const member = mk('member');
    const memberCommon = mk('member-repo', '.git');
    const asked: string[] = [];
    const roots = sandboxRootsFor({
      backend: 'codex',
      cwd: wt,
      extraWritable: [attach],
      extraRepos: [member],
      home,
      tmpdir: os.tmpdir(),
      gitCommonDirFor: (d) => {
        asked.push(d);
        return d === wt ? common : d === member ? memberCommon : '/should/not/be/asked';
      },
    });
    expect(roots.writable.slice(0, 5)).toEqual([wt, member, attach, common, memberCommon]);
    // The attachment dir is not a checkout: never ask git what encloses it.
    expect(asked).toEqual([wt, member]);
    expect(roots.writable).toContain(fs.realpathSync.native(os.tmpdir()));
    expect(roots.writable).not.toContain(home);
    expect(roots.denied).toEqual([
      path.join(common, 'hooks'),
      path.join(common, 'config'),
      path.join(memberCommon, 'hooks'),
      path.join(memberCommon, 'config'),
    ]);
  });

  it('works outside a git repo (no common dir, nothing re-denied)', () => {
    const wt = mk('plain');
    const roots = sandboxRootsFor({ backend: 'claude', cwd: wt, home: mk('h2'), gitCommonDirFor: () => null });
    expect(roots.writable[0]).toBe(wt);
    expect(roots.denied).toEqual([]);
  });
});

describe('writeSeatbeltProfile / sandboxedCommand', () => {
  it('writes the profile into the given dir, rewriting it every time', () => {
    const dir = path.join(tmp, 'profiles');
    const roots = { writable: ['/w'], denied: [] };
    const file = writeSeatbeltProfile(roots, dir);
    expect(path.dirname(file)).toBe(dir);
    fs.writeFileSync(file, '(version 1)(allow default)');
    expect(writeSeatbeltProfile(roots, dir)).toBe(file);
    expect(fs.readFileSync(file, 'utf-8')).toBe(buildSeatbeltProfile(roots));
  });

  it('prefixes sandbox-exec -f <profile> ahead of the untouched argv', () => {
    expect(sandboxedCommand('/bin/claude', ['-p', '--model', 'x'], '/p.sb')).toEqual({
      command: SANDBOX_EXEC,
      args: ['-f', '/p.sb', '/bin/claude', '-p', '--model', 'x'],
    });
  });

  it('is only supported on darwin', () => {
    expect(sandboxSupported('darwin')).toBe(true);
    expect(sandboxSupported('linux')).toBe(false);
    expect(sandboxSupported('win32')).toBe(false);
  });
});
