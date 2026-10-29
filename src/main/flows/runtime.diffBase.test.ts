// Where a run's diff starts, against real git repos.
//
// The failure: a branch that took in main after the run began (a merge or a
// fast-forward) diffed from the run's baseline, so every teammate's merged
// work landed in the run's diff. One such diff reached 41 MB.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { effectiveDiffBase } from './runtime';

describe('effectiveDiffBase', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-diffbase-'));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      }).trim();
    const commit = (file: string, msg: string) => {
      writeFileSync(join(dir, file), `${msg}\n`);
      git('add', '.');
      git('commit', '-m', msg);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-b', 'main');
    const root = commit('readme.md', 'root');
    git('checkout', '-b', 'feature');
    return { dir, git, commit, root };
  }

  it('keeps the baseline when the branch has not taken in main', async () => {
    const { dir, git, commit, root } = repo();
    commit('mine.ts', 'my work');
    git('checkout', 'main');
    commit('theirs.json', 'teammate work');
    git('checkout', 'feature');

    expect(await effectiveDiffBase(dir, root)).toBe(root);
  });

  it('starts after main once the branch merged it in', async () => {
    const { dir, git, commit, root } = repo();
    commit('mine.ts', 'my work');
    git('checkout', 'main');
    const theirs = commit('theirs.json', 'teammate work');
    git('checkout', 'feature');
    git('merge', '--no-edit', 'main');

    expect(await effectiveDiffBase(dir, root)).toBe(theirs);
  });

  it('starts after main when the branch was fast-forwarded to it', async () => {
    const { dir, git, commit, root } = repo();
    git('checkout', 'main');
    const theirs = commit('theirs.json', 'teammate work');
    git('checkout', 'feature');
    git('merge', '--ff-only', 'main');

    expect(await effectiveDiffBase(dir, root)).toBe(theirs);
  });

  it('prefers the run base branch over the default', async () => {
    const { dir, git, commit, root } = repo();
    git('checkout', '-b', 'release', 'main');
    const rel = commit('release.md', 'release work');
    git('checkout', 'feature');
    git('merge', '--no-edit', 'release');

    expect(await effectiveDiffBase(dir, root, 'release')).toBe(rel);
  });

  it('keeps the baseline for a run working on the base branch itself', async () => {
    const { dir, git, commit, root } = repo();
    // A run in the project folder, on main: its commits are main's, and the
    // merge-base with main is HEAD.
    git('checkout', 'main');
    commit('mine.ts', 'my work on main');
    commit('more.ts', 'more of it');

    expect(await effectiveDiffBase(dir, root)).toBe(root);
  });

  it('keeps the baseline when no base branch can be found', async () => {
    const { dir, git, root } = repo();
    git('branch', '-m', 'main', 'trunk');

    expect(await effectiveDiffBase(dir, root)).toBe(root);
  });
});
