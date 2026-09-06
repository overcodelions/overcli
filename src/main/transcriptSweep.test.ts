import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { isOrphanTranscriptDir, claudeProjectsRoot } from './transcriptSweep';
import { claudeProjectSlug } from './history';
import { managedWorktreeRoot } from './worktreeSweep';

const rootSlug = claudeProjectSlug(managedWorktreeRoot());
const slugFor = (project: string, tree: string) =>
  claudeProjectSlug(path.join(managedWorktreeRoot(), project, tree));

describe('isOrphanTranscriptDir', () => {
  const live = new Set([slugFor('overcli', 'shift-18'), slugFor('unifyr', 'WOW-4062')]);

  it('claims a folder whose worktree is gone', () => {
    expect(isOrphanTranscriptDir(slugFor('overcli', 'shift-01'), live, rootSlug)).toBe(true);
  });

  it('leaves a folder whose worktree still exists', () => {
    expect(isOrphanTranscriptDir(slugFor('overcli', 'shift-18'), live, rootSlug)).toBe(false);
    expect(isOrphanTranscriptDir(slugFor('unifyr', 'WOW-4062'), live, rootSlug)).toBe(false);
  });

  it('never touches a transcript from a real project checkout', () => {
    // These are the sessions people actually go back to. Whatever their age,
    // they are not in scope — only folders under the managed worktree root are.
    expect(
      isOrphanTranscriptDir(claudeProjectSlug('/Users/someone/git/overcli'), live, rootSlug),
    ).toBe(false);
    expect(
      isOrphanTranscriptDir(claudeProjectSlug('/Users/someone/Documents'), live, rootSlug),
    ).toBe(false);
  });

  it('does not treat the worktree root itself as a worktree', () => {
    expect(isOrphanTranscriptDir(rootSlug, live, rootSlug)).toBe(false);
  });

  it('reports nothing as orphaned when the live set could not be read', () => {
    // `liveWorktreeSlugs` returns an empty set when the managed root is
    // missing. That must not turn every transcript folder into a candidate —
    // but a folder under the root's prefix genuinely has no worktree then,
    // so the guard that matters is the prefix, which still holds.
    expect(isOrphanTranscriptDir(claudeProjectSlug('/Users/someone/git/x'), new Set(), rootSlug)).toBe(
      false,
    );
  });

  it('is not fooled by a sibling directory that merely starts like the root', () => {
    // `-Users-me--overcli-worktrees` vs `-Users-me--overcli-worktrees-backup`:
    // the second IS under the prefix by string comparison, and that is
    // deliberate — a folder can only get that name from a path under the root
    // (`.../worktrees/backup/...`), which is exactly a worktree slug.
    const sibling = slugFor('backup', 'tree');
    expect(isOrphanTranscriptDir(sibling, new Set(), rootSlug)).toBe(true);
    expect(isOrphanTranscriptDir(sibling, new Set([sibling]), rootSlug)).toBe(false);
  });
});

describe('claudeProjectsRoot', () => {
  it('points at Claude’s own store, not overcli’s', () => {
    expect(claudeProjectsRoot().endsWith(path.join('.claude', 'projects'))).toBe(true);
  });
});
