// `initRepo` and `removeRepoHistory` back the "Everyday projects" undo
// history: turning a plain folder into a repo without ever saying "git",
// and reversing that cleanly. These run the real `git` binary against a
// throwaway temp dir rather than mocking child_process, the same pattern
// used in flows/runtime.retry.test.ts for live-diff coverage.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitAllAsync, initRepo, readProjectLog, removeRepoHistory, restoreProjectVersion } from './git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-everyday-project-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('initRepo', () => {
  it('reports a missing path instead of trying to init it', async () => {
    const res = await initRepo({ projectPath: path.join(dir, 'nope') });
    expect(res).toEqual({
      ok: false,
      reason: 'no-folder',
      error: expect.stringContaining('does not exist'),
    });
  });

  it('inits a fresh folder, commits everything already in it, and lands on main', async () => {
    fs.mkdirSync(path.join(dir, 'inbox'));
    fs.writeFileSync(path.join(dir, 'inbox', 'README.txt'), 'put files here\n');

    const res = await initRepo({ projectPath: dir });

    expect(res).toEqual({ ok: true, branch: 'main' });
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(git(dir, 'branch', '--show-current')).toBe('main');
    expect(git(dir, 'log', '-1', '--pretty=%s')).toBe('Starting point');
    // The pre-existing file was staged and committed, not left untracked.
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('inbox/README.txt');
  });

  it('writes a default .gitignore when the folder does not already have one', async () => {
    await initRepo({ projectPath: dir });

    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(ignore).toContain('.DS_Store');
    expect(ignore).toContain('node_modules/');
  });

  it('leaves an existing .gitignore untouched', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'my-custom-rule\n');

    await initRepo({ projectPath: dir });

    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toBe('my-custom-rule\n');
  });

  it('refuses a folder that already has a history', async () => {
    git(dir, 'init');

    const res = await initRepo({ projectPath: dir });

    expect(res).toEqual({ ok: false, reason: 'already-tracked', error: expect.stringContaining('already has a history') });
  });

  it('refuses a folder nested inside an existing repo, even without its own .git', async () => {
    git(dir, 'init');
    const sub = path.join(dir, 'sub-project');
    fs.mkdirSync(sub);

    const res = await initRepo({ projectPath: sub });

    expect(res.ok).toBe(false);
  });
});

describe('removeRepoHistory', () => {
  it('errors when there is no history to remove', async () => {
    const res = await removeRepoHistory({ projectPath: dir });
    expect(res).toEqual({ ok: false, error: 'No history to remove.' });
  });

  it('deletes only .git, leaving the rest of the folder in place', async () => {
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), '# hello\n');
    await initRepo({ projectPath: dir });
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);

    const res = await removeRepoHistory({ projectPath: dir });

    expect(res).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'BRIEF.md'))).toBe(true);
  });

  it('refuses to touch a folder that only looks like a repo from inside a larger one', async () => {
    // A stray, uninitialized `.git` directory is not a valid repo root, so
    // git treats the enclosing repo as the real one — `--show-toplevel`
    // resolves to `dir`, not `sub`, and the removal must be refused rather
    // than reaching for `sub/.git`.
    git(dir, 'init');
    const sub = path.join(dir, 'sub-project');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });

    const res = await removeRepoHistory({ projectPath: sub });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Refused');
    expect(fs.existsSync(path.join(sub, '.git'))).toBe(true);
  });
});

describe('version history', () => {
  it('reads a log with the files each version touched, newest first', async () => {
    await initRepo({ projectPath: dir });
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'first\n');
    await commitAllAsync({ cwd: dir, message: 'Created BRIEF.md' });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'notes\n');
    await commitAllAsync({ cwd: dir, message: 'Added 1 document' });

    const res = await readProjectLog({ cwd: dir });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.versions.map((v) => v.subject)).toEqual([
      'Added 1 document',
      'Created BRIEF.md',
      'Starting point',
    ]);
    // numstat, so a version row can say how much moved rather than just
    // which files did.
    expect(res.versions[0].files).toEqual([
      { path: 'notes.md', additions: 1, deletions: 0, binary: false },
    ]);
    expect(res.versions[0].at).not.toBe('');
  });

  it('says so instead of committing when nothing changed', async () => {
    await initRepo({ projectPath: dir });
    const res = await commitAllAsync({ cwd: dir, message: 'Edited BRIEF.md' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.nothingToCommit).toBe(true);
  });

  it('restores an earlier version forward, without losing what came after', async () => {
    await initRepo({ projectPath: dir });
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'original\n');
    await commitAllAsync({ cwd: dir, message: 'Created BRIEF.md' });
    const log = await readProjectLog({ cwd: dir });
    const target = log.ok ? log.versions[0].sha : '';

    // Something later goes wrong: the file is mangled and a new file appears.
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'mangled\n');
    fs.writeFileSync(path.join(dir, 'junk.md'), 'junk\n');
    await commitAllAsync({ cwd: dir, message: 'Rewrote BRIEF.md' });

    const res = await restoreProjectVersion({ cwd: dir, sha: target, label: 'Today 4:12pm' });

    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf-8')).toBe('original\n');
    // read-tree, not `checkout -- .`: a file added after the target must go.
    expect(fs.existsSync(path.join(dir, 'junk.md'))).toBe(false);
    // Nothing was rewound — the bad version is still in the log, so the
    // restore is itself undoable.
    const after = await readProjectLog({ cwd: dir });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.versions[0].subject).toBe('Restored Today 4:12pm');
    expect(after.versions.map((v) => v.subject)).toContain('Rewrote BRIEF.md');
  });

  it('refuses a version that does not exist', async () => {
    await initRepo({ projectPath: dir });
    const res = await restoreProjectVersion({ cwd: dir, sha: 'deadbeef', label: 'x' });
    expect(res.ok).toBe(false);
  });
});
