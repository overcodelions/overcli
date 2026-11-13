import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitAsync } from '../git';
import { conflictNote, leftoverMarkers, mergeDefaultWhereConflicting } from './mergeOnConflict';

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=t@acme.test', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const asyncGit = (args: string[], cwd: string) => runGitAsync(['-c', 'user.email=t@acme.test', '-c', 'user.name=t', ...args], cwd);

let root = '';
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

/// A clone on `feature/ACME-7`, pushed, and main moved on with `mainLine` on
/// the same line the branch changed (or a different file when `apart`).
function setup(apart = false): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-conflict-'));
  git(['init', '-q', '--bare', '-b', 'main', 'remote.git'], root);
  git(['clone', '-q', 'remote.git', 'work'], root);
  const work = path.join(root, 'work');
  git(['checkout', '-q', '-b', 'main'], work);
  fs.writeFileSync(path.join(work, 'app.txt'), 'hello\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'init'], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['switch', '-q', '-c', 'feature/ACME-7'], work);
  fs.writeFileSync(path.join(work, 'app.txt'), 'hello from the branch\n');
  git(['commit', '-qam', 'branch change'], work);
  git(['push', '-q', 'origin', 'feature/ACME-7'], work);
  git(['switch', '-q', 'main'], work);
  if (apart) fs.writeFileSync(path.join(work, 'other.txt'), 'new\n');
  else fs.writeFileSync(path.join(work, 'app.txt'), 'hello from main\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'main change'], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['switch', '-q', 'feature/ACME-7'], work);
  git(['fetch', '-q', 'origin'], work);
  return work;
}

describe('mergeDefaultWhereConflicting', () => {
  it('starts the merge where the pull request conflicts, and leaves it for the run', async () => {
    const work = setup();
    const lines = await mergeDefaultWhereConflicting([{ name: 'acme-api', worktreePath: work, defaultBranch: 'main' }], asyncGit);
    expect(lines).toEqual(['- acme-api: merging origin/main conflicts in app.txt']);
    expect(fs.readFileSync(path.join(work, 'app.txt'), 'utf8')).toContain('<<<<<<<');
    // Not committed: the run's resolution and the merge go out as one commit.
    expect(fs.existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(conflictNote(lines)).toContain('CONFLICTS TO RESOLVE');

    // Resolved and committed the way the server does, it sits on top of the
    // pushed branch, so the push adds to it rather than replacing it.
    fs.writeFileSync(path.join(work, 'app.txt'), 'hello from both\n');
    git(['add', '-A'], work);
    git(['commit', '-qm', 'resolve'], work);
    expect(() => git(['merge-base', '--is-ancestor', 'origin/feature/ACME-7', 'HEAD'], work)).not.toThrow();
    expect(() => git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], work)).not.toThrow();
  });

  it('leaves a branch that is only behind as it is', async () => {
    const work = setup(true);
    const head = git(['rev-parse', 'HEAD'], work);
    expect(await mergeDefaultWhereConflicting([{ name: 'acme-api', worktreePath: work, defaultBranch: 'main' }], asyncGit)).toEqual([]);
    expect(git(['rev-parse', 'HEAD'], work)).toBe(head);
    expect(git(['status', '--porcelain'], work)).toBe('');
  });

  it('skips a repo whose default branch it cannot find', async () => {
    const work = setup();
    expect(await mergeDefaultWhereConflicting([{ name: 'acme-api', worktreePath: work, defaultBranch: 'trunk' }], asyncGit)).toEqual([]);
  });
});

describe('leftoverMarkers', () => {
  it('names the files whose added lines still carry a marker', () => {
    const diff = [
      'diff --git a/app.txt b/app.txt',
      '--- a/app.txt',
      '+++ b/app.txt',
      '@@ -1 +1,5 @@',
      '+<<<<<<< HEAD',
      '+hello',
      '+=======',
      '+>>>>>>> origin/main',
      'diff --git a/ok.txt b/ok.txt',
      '--- a/ok.txt',
      '+++ b/ok.txt',
      '@@ -1 +1 @@',
      '+// a <<<<<<< in a comment is fine',
    ].join('\n');
    expect(leftoverMarkers(diff)).toEqual(['app.txt']);
  });

  it('finds none in a clean change', () => {
    expect(leftoverMarkers('+++ b/app.txt\n+hello\n-<<<<<<< HEAD\n')).toEqual([]);
  });
});
