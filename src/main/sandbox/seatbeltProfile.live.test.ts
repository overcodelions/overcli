// Real-process proof that the generated profile is a jail, not a hope: each
// case execs /usr/bin/sandbox-exec with a profile from `sandboxRootsFor` and
// checks the filesystem afterwards. macOS only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_EXEC, sandboxRootsFor, writeSeatbeltProfile } from './seatbeltProfile';

describe.skipIf(process.platform !== 'darwin')('seatbelt write jail against real processes', () => {
  let base: string;
  let worktree: string;
  let outside: string;
  let home: string;
  let profile: string;
  let commonDir: string;

  function jailed(script: string): { status: number | null; stderr: string } {
    const res = spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', script], {
      cwd: worktree,
      encoding: 'utf-8',
    });
    return { status: res.status, stderr: res.stderr };
  }

  beforeAll(() => {
    // NOT under os.tmpdir(): temp is a writable root, so an "outside" path
    // there would be allowed. The profiles dir must be outside too.
    base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.homedir(), '.overcli-seatbelt-live-')),
    );
    const repo = path.join(base, 'repo');
    worktree = path.join(base, 'wt');
    outside = path.join(base, 'outside');
    home = path.join(base, 'home');
    fs.mkdirSync(outside);
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf-8' });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'run', worktree);
    commonDir = fs.realpathSync.native(path.join(repo, '.git'));
    const roots = sandboxRootsFor({ backend: 'claude', cwd: worktree, home });
    profile = writeSeatbeltProfile(roots, path.join(base, 'profiles'));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('denies a write outside every writable root, and the file is not created', () => {
    const target = path.join(outside, 'pwned.txt');
    const res = jailed(`echo pwned > "${target}"`);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Operation not permitted');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('denies deleting a file outside the roots', () => {
    const victim = path.join(outside, 'keep.txt');
    fs.writeFileSync(victim, 'precious');
    const res = jailed(`rm -f "${victim}"`);
    expect(res.status).not.toBe(0);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious');
  });

  it('allows a write inside the worktree', () => {
    const res = jailed('echo ok > inside.txt && mkdir -p sub/dir && echo ok > sub/dir/f.txt');
    expect(res).toEqual({ status: 0, stderr: '' });
    expect(fs.readFileSync(path.join(worktree, 'inside.txt'), 'utf-8')).toBe('ok\n');
  });

  it('allows /dev/null and temp writes (a blanket deny would take them)', () => {
    const res = jailed('echo x > /dev/null && t=$(mktemp) && echo x > "$t" && rm "$t"');
    expect(res).toEqual({ status: 0, stderr: '' });
  });

  it('lets git commit from the linked worktree (writes land in the main .git)', () => {
    const res = jailed(
      'echo c > c.txt && git add c.txt && git -c user.email=t@t -c user.name=t commit -q -m jailed',
    );
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it('re-denies git hooks and git config inside the allowed git dir', () => {
    const hook = path.join(commonDir, 'hooks', 'post-commit');
    expect(jailed(`echo evil > "${hook}"`).status).not.toBe(0);
    expect(fs.existsSync(hook)).toBe(false);
    const res = jailed('git config core.hooksPath /tmp/evil');
    expect(res.status).not.toBe(0);
    const cfg = fs.readFileSync(path.join(commonDir, 'config'), 'utf-8');
    expect(cfg).not.toContain('hooksPath');
  });

  it('cannot rewrite its own profile', () => {
    const res = jailed(`echo '(version 1)(allow default)' > "${profile}"`);
    expect(res.status).not.toBe(0);
    expect(fs.readFileSync(profile, 'utf-8')).toContain('(deny file-write* (subpath "/"))');
  });
});
