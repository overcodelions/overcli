import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  parseWorktreeList,
  classifyWorktree,
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

  it('marks a clean, unreferenced, managed worktree reclaimable', () => {
    expect(
      classifyWorktree({ worktreePath: managed('done'), referenced: null, ...clean }),
    ).toBe('reclaimable');
  });

  it('marks a merged branch reclaimable even with commits ahead of base', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('merged'),
        referenced: null,
        dirtyFiles: 0,
        commitsAhead: 4,
        isMergedIntoBase: true,
      }),
    ).toBe('reclaimable');
  });

  it('refuses to touch anything outside the managed root', () => {
    expect(
      classifyWorktree({
        worktreePath: path.join(os.homedir(), 'git-worktrees', 'other', 'branch'),
        referenced: null,
        ...clean,
      }),
    ).toBe('foreign');
  });

  it('treats foreign as foreign even when a conversation references it', () => {
    expect(
      classifyWorktree({
        worktreePath: '/somewhere/else',
        referenced: 'conversation',
        ...clean,
      }),
    ).toBe('foreign');
  });

  it('protects worktrees a conversation or run still points at', () => {
    expect(
      classifyWorktree({ worktreePath: managed('a'), referenced: 'conversation', ...clean }),
    ).toBe('live');
    expect(classifyWorktree({ worktreePath: managed('b'), referenced: 'run', ...clean })).toBe(
      'live',
    );
  });

  it('keeps a live classification ahead of dirty state', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('busy'),
        referenced: 'run',
        dirtyFiles: 12,
        commitsAhead: 3,
        isMergedIntoBase: false,
      }),
    ).toBe('live');
  });

  it('never calls an orphan with uncommitted changes reclaimable', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('dirty'),
        referenced: null,
        dirtyFiles: 2,
        commitsAhead: 0,
        isMergedIntoBase: true,
      }),
    ).toBe('has-work');
  });

  it('never calls an orphan with unmerged commits reclaimable', () => {
    expect(
      classifyWorktree({
        worktreePath: managed('unmerged'),
        referenced: null,
        dirtyFiles: 0,
        commitsAhead: 3,
        isMergedIntoBase: false,
      }),
    ).toBe('has-work');
  });

  it('does not treat the managed root itself as a managed worktree', () => {
    expect(
      classifyWorktree({ worktreePath: managedWorktreeRoot(), referenced: null, ...clean }),
    ).toBe('foreign');
  });

  it('is not fooled by a sibling directory with the root as a prefix', () => {
    expect(
      classifyWorktree({
        worktreePath: managedWorktreeRoot() + '-backup/proj/x',
        referenced: null,
        ...clean,
      }),
    ).toBe('foreign');
  });

  it('leaves a claimed worktree live however old the conversation is', () => {
    // Ageing a conversation out means deleting the conversation, which is
    // Settings → Conversations' job. A disk sweep must never do it.
    expect(
      classifyWorktree({ worktreePath: managed('ancient'), referenced: 'conversation', ...clean }),
    ).toBe('live');
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
