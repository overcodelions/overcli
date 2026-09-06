import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  parseWorktreeList,
  classifyWorktree,
  indexClaims,
  managedWorktreeRoot,
  isProtectedBranch,
} from './worktreeSweep';
import { isStaleConversation, conversationActiveAt } from '../shared/types';

const managed = (name: string) => path.join(managedWorktreeRoot(), 'proj', name);

describe('parseWorktreeList', () => {
  it('parses the main checkout, branches, detached HEADs and flags', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/master',
      '',
      'worktree /wt/feature',
      'HEAD bbbb',
      'branch refs/heads/feature/add-tests',
      '',
      'worktree /wt/review',
      'HEAD cccc',
      'detached',
      '',
      'worktree /wt/gone',
      'HEAD dddd',
      'branch refs/heads/stale',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /wt/held',
      'HEAD eeee',
      'branch refs/heads/held',
      'locked under review',
      '',
    ].join('\n');

    expect(parseWorktreeList(porcelain)).toEqual([
      { worktreePath: '/repo', branchName: 'master', locked: false, prunable: false },
      {
        worktreePath: '/wt/feature',
        branchName: 'feature/add-tests',
        locked: false,
        prunable: false,
      },
      { worktreePath: '/wt/review', branchName: null, locked: false, prunable: false },
      { worktreePath: '/wt/gone', branchName: 'stale', locked: false, prunable: true },
      { worktreePath: '/wt/held', branchName: 'held', locked: true, prunable: false },
    ]);
  });

  it('handles a final record with no trailing blank line', () => {
    const parsed = parseWorktreeList('worktree /repo\nHEAD aaaa\nbranch refs/heads/main');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].branchName).toBe('main');
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('classifyWorktree', () => {
  const clean = { dirtyFiles: 0, commitsAhead: 0, isMergedIntoBase: true };

  it('marks a clean, idle, managed worktree reclaimable', () => {
    expect(classifyWorktree({ worktreePath: managed('done'), busy: false, ...clean })).toBe(
      'reclaimable',
    );
  });

  it('marks a merged branch reclaimable even with commits ahead of base', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('merged'),
        busy: false,
        dirtyFiles: 0,
        commitsAhead: 4,
        isMergedIntoBase: true,
      }),
    ).toBe('reclaimable');
  });

  it('offers a finished shift whose conversation still exists', () => {
    // The whole point of the cleanup surface: a worker's finished shift is
    // claimed by a conversation and is still safe to clear. Under the old
    // `referenced` rule this answered `live` and nothing could ever release it.
    expect(classifyWorktree({ worktreePath: managed('shift-18'), busy: false, ...clean })).toBe(
      'reclaimable',
    );
  });

  it('refuses to touch anything outside the managed root', () => {
    expect(
      classifyWorktree({
        worktreePath: path.join(os.homedir(), 'git-worktrees', 'other', 'branch'),
        busy: false,
        ...clean,
      }),
    ).toBe('foreign');
  });

  it('treats foreign as foreign even while it is busy', () => {
    expect(
      classifyWorktree({ worktreePath: '/somewhere/else', busy: true, ...clean }),
    ).toBe('foreign');
  });

  it('protects a worktree that is working right now', () => {
    expect(classifyWorktree({ worktreePath: managed('a'), busy: true, ...clean })).toBe('live');
  });

  it('keeps a live classification ahead of dirty state', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('busy'),
        busy: true,
        dirtyFiles: 12,
        commitsAhead: 3,
        isMergedIntoBase: false,
      }),
    ).toBe('live');
  });

  it('never calls an idle worktree with uncommitted changes reclaimable', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('dirty'),
        busy: false,
        dirtyFiles: 2,
        commitsAhead: 0,
        isMergedIntoBase: true,
      }),
    ).toBe('has-work');
  });

  it('never calls an idle worktree with unmerged commits reclaimable', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('unmerged'),
        busy: false,
        dirtyFiles: 0,
        commitsAhead: 3,
        isMergedIntoBase: false,
      }),
    ).toBe('has-work');
  });

  it('does not treat the managed root itself as a managed worktree', () => {
    expect(
      classifyWorktree({ worktreePath: managedWorktreeRoot(), busy: false, ...clean }),
    ).toBe('foreign');
  });

  it('is not fooled by a sibling directory with the root as a prefix', () => {
    expect(
      classifyWorktree({
        worktreePath: managedWorktreeRoot() + '-backup/proj/x',
        busy: false,
        ...clean,
      }),
    ).toBe('foreign');
  });
});

describe('readProjectRefFacts parsing', () => {
  // The parsing lives inside `readProjectRefFacts`, which shells out. What is
  // worth pinning here is the decoration `git branch` puts in front of names:
  // `+ ` marks a branch checked out in ANOTHER worktree, which on a cleanup
  // install is nearly every branch — miss it and every merged branch reads as
  // unmerged, so nothing is ever offered as safe.
  it('strips the current and other-worktree markers', () => {
    const lines = ['* master', '+ feature/one', '  feature/two', 'feature/three'];
    const parsed = lines.map((l) => l.replace(/^[*+]?\s+/, '').trim());
    expect(parsed).toEqual(['master', 'feature/one', 'feature/two', 'feature/three']);
  });
});

describe('indexClaims', () => {
  const wt = managed('shared');

  it('keeps one claim per path', () => {
    const index = indexClaims([
      { worktreePath: wt, kind: 'conversation', convId: 'c1', title: 'One' },
    ]);
    expect(index.size).toBe(1);
    expect(index.get(path.resolve(wt))?.convId).toBe('c1');
  });

  it('resolves two spellings of the same directory to one claim', () => {
    const index = indexClaims([
      { worktreePath: wt, kind: 'conversation', convId: 'c1', title: 'One' },
      { worktreePath: path.join(wt, '.', ''), kind: 'conversation', convId: 'c1', title: 'One' },
    ]);
    expect(index.size).toBe(1);
  });

  it('lets the run own a tree a conversation borrowed, whatever the order', () => {
    const conv = { worktreePath: wt, kind: 'conversation' as const, convId: 'c1', title: 'Chat' };
    const run = { worktreePath: wt, kind: 'run' as const, runId: 'r1', title: 'Run' };
    for (const claims of [[conv, run], [run, conv]]) {
      const hit = indexClaims(claims).get(path.resolve(wt));
      expect(hit?.kind).toBe('run');
      expect(hit?.runId).toBe('r1');
      expect(hit?.adoptedConvIds).toEqual(['c1']);
    }
  });

  it('makes the merged claim busy when any claimant is busy', () => {
    const hit = indexClaims([
      { worktreePath: wt, kind: 'run', runId: 'r1', title: 'Run', busy: false },
      { worktreePath: wt, kind: 'conversation', convId: 'c1', title: 'Chat', busy: true },
    ]).get(path.resolve(wt));
    expect(hit?.busy).toBe(true);
  });
});

describe('conversationActiveAt', () => {
  it('prefers lastActiveAt', () => {
    expect(conversationActiveAt({ lastActiveAt: 500, createdAt: 100 })).toBe(500);
  });

  it('falls back to createdAt when a conversation never ran a turn', () => {
    expect(conversationActiveAt({ createdAt: 100 })).toBe(100);
  });

  it('is 0 when undated, so an undated conversation reads as old', () => {
    expect(conversationActiveAt({})).toBe(0);
  });
});

describe('isStaleConversation', () => {
  const now = Date.UTC(2026, 7, 5);
  const daysAgo = (n: number) => now - n * 24 * 60 * 60 * 1000;

  it('leaves a recently used conversation alone', () => {
    expect(
      isStaleConversation({ lastActiveAt: daysAgo(3), archived: false, staleDays: 14, now }),
    ).toBe(false);
  });

  it('flags one untouched past the threshold', () => {
    expect(
      isStaleConversation({ lastActiveAt: daysAgo(20), archived: false, staleDays: 14, now }),
    ).toBe(true);
  });

  it('does not flag exactly at the boundary', () => {
    expect(
      isStaleConversation({ lastActiveAt: daysAgo(14), archived: false, staleDays: 14, now }),
    ).toBe(false);
  });

  it('ages archived conversations twice as fast', () => {
    // Archiving is an explicit "done with this for now" — a stronger signal
    // than silence, so half the threshold is enough.
    const args = { lastActiveAt: daysAgo(10), staleDays: 14, now };
    expect(isStaleConversation({ ...args, archived: false })).toBe(false);
    expect(isStaleConversation({ ...args, archived: true })).toBe(true);
  });

  it('respects a threshold the user widened', () => {
    expect(
      isStaleConversation({ lastActiveAt: daysAgo(45), archived: false, staleDays: 90, now }),
    ).toBe(false);
  });

  it('ages a never-run conversation by when it was created', () => {
    expect(
      isStaleConversation({ createdAt: daysAgo(30), archived: false, staleDays: 14, now }),
    ).toBe(true);
  });
});

// The sweep may remove a worktree sitting on an integration branch, but it
// must never delete the branch itself — that is unrecoverable in a way the
// worktree is not.
describe('isProtectedBranch', () => {
  it('protects the well-known integration branches', () => {
    for (const b of ['main', 'master', 'develop', 'trunk']) {
      expect(isProtectedBranch(b)).toBe(true);
    }
  });

  it("protects the project's own base branch whatever it is called", () => {
    expect(isProtectedBranch('release/2026', 'release/2026')).toBe(true);
  });

  it('leaves ordinary agent branches deletable', () => {
    expect(isProtectedBranch('feature/add-tests', 'main')).toBe(false);
  });

  it('is not confused by a detached HEAD', () => {
    expect(isProtectedBranch(null)).toBe(false);
    expect(isProtectedBranch(null, 'main')).toBe(false);
  });

  it('does not match a branch merely containing a protected name', () => {
    expect(isProtectedBranch('feature/main-nav', 'main')).toBe(false);
  });
});
