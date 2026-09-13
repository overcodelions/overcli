import { describe, expect, it } from 'vitest';
import { createdLabel, parseBranchRefs, rankRefs, shortenPath, type BranchChoice } from './refChoices';
import type { WorktreeChoice } from './worktrees';

const wt = (ref: string, over: Partial<WorktreeChoice> = {}): WorktreeChoice => ({
  path: `/wt/${ref}`,
  ref,
  primary: false,
  detached: false,
  ...over,
});
const br = (ref: string, remote = false): BranchChoice => ({ ref, remote });

describe('parsing git refs', () => {
  it('reads local and remote branches with their dates', () => {
    const out = parseBranchRefs(
      'refs/heads/master\t2 hours ago\nrefs/remotes/origin/feature/x\t3 days ago\n',
    );
    expect(out).toEqual([
      { ref: 'master', remote: false, when: '2 hours ago' },
      { ref: 'origin/feature/x', remote: true, when: '3 days ago' },
    ]);
  });

  it('drops origin/HEAD', () => {
    // A symref onto the default branch — never a thing to check out, and it
    // appears as a duplicate of whatever it points at.
    const out = parseBranchRefs('refs/remotes/origin/HEAD\t\nrefs/heads/main\t\n');
    expect(out.map((b) => b.ref)).toEqual(['main']);
  });
});

describe('ranking what a service can run from', () => {
  const worktrees = [
    wt('master', { primary: true, path: '/gitrepo' }),
    wt('feature/XYZ-6814'),
    wt('ABC-5185-campaign-entities'),
    wt('a5253232', { detached: true }),
  ];

  it('leads with where it runs now, then the main checkout', () => {
    const rows = rankRefs({ worktrees, branches: [], current: 'feature/XYZ-6814', query: '' });
    expect(rows.checkouts.map((c) => c.ref)).toEqual([
      'feature/XYZ-6814',
      'master',
      'ABC-5185-campaign-entities',
      'a5253232',
    ]);
  });

  it('puts the newest worktree first, not the one that sorts first', () => {
    // A hundred flow worktrees, alphabetical: the one made this afternoon was
    // somewhere below "feature/AUTO-3786".
    const now = Date.now();
    const rows = rankRefs({
      worktrees: [
        wt('master', { primary: true }),
        wt('feature/AUTO-3786', { createdAt: now - 90 * 86_400_000 }),
        wt('XYZ-6950-2', { createdAt: now - 3_600_000 }),
        wt('XYZ-6718', { createdAt: now - 7_200_000 }),
      ],
      branches: [],
      query: '',
    });
    expect(rows.checkouts.map((c) => c.ref)).toEqual([
      'master',
      'XYZ-6950-2',
      'XYZ-6718',
      'feature/AUTO-3786',
    ]);
  });

  it('holds back older checkouts until you type, but never the current or main one', () => {
    const now = Date.now();
    const many = Array.from({ length: 100 }, (_, i) => wt(`flow-${i}`, { createdAt: now - i * 60_000 }));
    const rows = rankRefs({
      worktrees: [...many, wt('master', { primary: true }), wt('old-one', { createdAt: 1 })],
      branches: [],
      current: 'old-one',
      query: '',
      checkoutLimit: 8,
    });
    expect(rows.checkouts).toHaveLength(8);
    expect(rows.checkouts.slice(0, 2).map((c) => c.ref)).toEqual(['old-one', 'master']);
    expect(rows.hiddenCheckouts).toBe(94);
  });

  it('shows every matching checkout once you are searching', () => {
    const many = Array.from({ length: 30 }, (_, i) => wt(`RED-${i}`));
    const rows = rankRefs({ worktrees: many, branches: [], query: 'RED', checkoutLimit: 8 });
    expect(rows.checkouts).toHaveLength(30);
    expect(rows.hiddenCheckouts).toBe(0);
  });

  it('sinks detached trees, because a short sha tells you nothing', () => {
    const rows = rankRefs({ worktrees, branches: [], query: '' });
    expect(rows.checkouts[rows.checkouts.length - 1].ref).toBe('a5253232');
  });

  it('never lists a branch that already has a checkout', () => {
    // The old picker's worst habit: the same choice offered twice under two
    // headings, with different consequences attached to each.
    const rows = rankRefs({
      worktrees,
      branches: [br('master'), br('feature/XYZ-6814'), br('feature/AUTO-3829')],
      query: '',
    });
    expect(rows.branches.map((b) => b.ref)).toEqual(['feature/AUTO-3829']);
  });

  it('collapses a remote branch onto its local counterpart', () => {
    const rows = rankRefs({
      worktrees: [],
      branches: [br('origin/master', true), br('master'), br('origin/only-remote', true)],
      defaultBranch: 'master',
      query: '',
    });
    expect(rows.branches.map((b) => b.ref)).toEqual(['master', 'origin/only-remote']);
  });

  it('pins the default branch above whatever was committed to last', () => {
    const rows = rankRefs({
      worktrees: [],
      branches: [br('feature/AUTO-3829'), br('feature/XYZ-6892'), br('master')],
      defaultBranch: 'master',
      query: '',
    });
    expect(rows.branches[0].ref).toBe('master');
  });

  it('holds back the long tail until you type', () => {
    const many = Array.from({ length: 80 }, (_, i) => br(`feature/B-${i}`));
    const rows = rankRefs({ worktrees: [], branches: many, query: '', limit: 6 });
    expect(rows.branches).toHaveLength(6);
    expect(rows.hiddenBranches).toBe(74);
  });

  it('hides nothing once you are searching', () => {
    // A search that silently truncates is worse than the wall it replaced.
    const many = Array.from({ length: 80 }, (_, i) => br(`feature/B-${i}`));
    const rows = rankRefs({ worktrees: [], branches: many, query: 'B-1', limit: 6 });
    expect(rows.hiddenBranches).toBe(0);
    expect(rows.branches.length).toBeGreaterThan(6);
  });

  it('searches checkouts by path as well as by ref', () => {
    const rows = rankRefs({ worktrees, branches: [], query: 'gitrepo' });
    expect(rows.checkouts.map((c) => c.ref)).toEqual(['master']);
  });
});

describe('shortening a checkout path', () => {
  it('keeps enough to tell two repos apart', () => {
    // Both worktrees are on `master`; the basename alone says nothing.
    expect(shortenPath('/Users/me/git/gitrepo/wt/master')).toBe('…/wt/master');
  });

  it('leaves a short path alone', () => {
    expect(shortenPath('/gitrepo')).toBe('/gitrepo');
  });
});

describe('how old a worktree is', () => {
  const now = 1_700_000_000_000;
  it('reads in the space a menu row has', () => {
    expect(createdLabel(now - 20_000, now)).toBe('just now');
    expect(createdLabel(now - 5 * 60_000, now)).toBe('5m ago');
    expect(createdLabel(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(createdLabel(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(createdLabel(now - 65 * 86_400_000, now)).toBe('2mo ago');
  });

  it('says nothing for a checkout with no recorded age', () => {
    expect(createdLabel(undefined, now)).toBe('');
  });
});
