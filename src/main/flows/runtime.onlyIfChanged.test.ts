// `runChangedBeyondNotes` against a real repository: whether a team piece's
// check step has anything to check. A mock of `../git` could only repeat
// back what we assume `git diff` and `ls-files` report.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

useTestHost('/tmp/overcli-only-if-changed-tests');
vi.mock('./runsStore', () => ({ loadAllRuns: () => [], saveRun: vi.fn(), deleteRun: vi.fn() }));
vi.mock('./storage', () => ({ loadAllFlows: () => [] }));

import { runChangedBeyondNotes } from './runtime';

let repo: string;
let baseline: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'overcli-changed-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  baseline = git('rev-parse', 'HEAD');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const run = () => ({ projectPath: repo, baselineCommit: baseline });

describe('runChangedBeyondNotes', () => {
  it('is false for an untouched repo, or one that only gained notes', async () => {
    expect(await runChangedBeyondNotes(run())).toBe(false);
    writeFileSync(join(repo, 'piece.md'), '# notes\n');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'ignored');
    expect(await runChangedBeyondNotes(run())).toBe(false);
  });

  it('is true for an edit, a new code file, or a commit since the baseline', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    expect(await runChangedBeyondNotes(run())).toBe(true);
    git('checkout', '-q', 'app.ts');
    writeFileSync(join(repo, 'new.ts'), 'export {};\n');
    expect(await runChangedBeyondNotes(run())).toBe(true);
    git('add', 'new.ts');
    git('commit', '-q', '-m', 'add');
    expect(await runChangedBeyondNotes(run())).toBe(true);
  });

  it('is true when it cannot tell: no baseline, or not a repo', async () => {
    expect(await runChangedBeyondNotes({ projectPath: repo, baselineCommit: undefined })).toBe(true);
    expect(await runChangedBeyondNotes({ projectPath: tmpdir(), baselineCommit: baseline })).toBe(true);
  });
});
