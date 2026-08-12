import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, default: { ...real, existsSync: () => true }, existsSync: () => true };
});

import { resolveDiffBase } from './git';

/// Route each git invocation to `[stdout, exitCode]` by argv. Unmatched
/// commands fail (exit 1) rather than returning empty-and-successful — a
/// resolver that walks a candidate list has to see real failures to walk.
function routeGit(byCmd: Record<string, [string, number?]>) {
  mockExecFile.mockImplementation((_bin, args: string[], _opts, cb) => {
    const cmd = args.join(' ');
    const [stdout, code] = byCmd[cmd] ?? ['', 1];
    if (code && code !== 0) {
      const err = Object.assign(new Error(`exit ${code}`), { code });
      cb(err, stdout, '');
      return;
    }
    cb(null, stdout, '');
  });
}

const CWD = '/wt/feature';
const OLD = 'a'.repeat(40); // frozen fork point, now well behind
const TIP = 'b'.repeat(40); // merge-base with live upstream

// Braces matter: `mockReset()` returns the mock, and an arrow that returns
// a function hands vitest a teardown callback it later invokes with no
// arguments — which lands in the execFile mock as an argv-less call.
beforeEach(() => {
  mockExecFile.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveDiffBase', () => {
  it('prefers the remote-tracking form of the named base branch', async () => {
    routeGit({
      [`rev-parse --verify --quiet ${OLD}^{commit}`]: [`${OLD}\n`],
      'merge-base origin/master HEAD': [`${TIP}\n`],
      [`merge-base --is-ancestor ${TIP} ${OLD}`]: ['', 1], // TIP is newer
    });
    expect(
      await resolveDiffBase({ cwd: CWD, preferredBranch: 'master', fallbackCommit: OLD }),
    ).toEqual({ commit: TIP, ref: 'origin/master' });
  });

  it('collapses to nothing once the branch work has landed upstream', async () => {
    // The RED-6644 case: the PR merged, then the worktree pulled master
    // back in, so merge-base(origin/master, HEAD) IS HEAD.
    const head = 'c'.repeat(40);
    routeGit({
      [`rev-parse --verify --quiet ${OLD}^{commit}`]: [`${OLD}\n`],
      'symbolic-ref --short refs/remotes/origin/HEAD': ['origin/master\n'],
      'merge-base origin/master HEAD': [`${head}\n`],
      [`merge-base --is-ancestor ${head} ${OLD}`]: ['', 1],
    });
    expect(await resolveDiffBase({ cwd: CWD, fallbackCommit: OLD })).toEqual({
      commit: head,
      ref: 'origin/master',
    });
  });

  it('keeps the frozen baseline when the merge-base is older', async () => {
    // Worktree forked from a parent feature branch: merge-base with master
    // reaches back past the parent's work, which is not this run's.
    const ancient = 'd'.repeat(40);
    routeGit({
      [`rev-parse --verify --quiet ${OLD}^{commit}`]: [`${OLD}\n`],
      'symbolic-ref --short refs/remotes/origin/HEAD': ['origin/master\n'],
      'merge-base origin/master HEAD': [`${ancient}\n`],
      [`merge-base --is-ancestor ${ancient} ${OLD}`]: ['', 0], // ancient is older
    });
    expect(await resolveDiffBase({ cwd: CWD, fallbackCommit: OLD })).toEqual({
      commit: OLD,
      ref: null,
    });
  });

  it('falls through to main/master when origin/HEAD is unset', async () => {
    routeGit({
      'merge-base origin/main HEAD': ['', 1],
      'merge-base main HEAD': ['', 1],
      'merge-base origin/master HEAD': [`${TIP}\n`],
    });
    expect(await resolveDiffBase({ cwd: CWD })).toEqual({ commit: TIP, ref: 'origin/master' });
  });

  it('drops a baseline whose commit no longer exists', async () => {
    // A rebase orphans the fork point; gc eventually reaps it. Diffing
    // against it would fail outright with `bad object`.
    routeGit({
      [`rev-parse --verify --quiet ${OLD}^{commit}`]: ['', 1],
      'symbolic-ref --short refs/remotes/origin/HEAD': ['origin/master\n'],
      'merge-base origin/master HEAD': [`${TIP}\n`],
    });
    expect(await resolveDiffBase({ cwd: CWD, fallbackCommit: OLD })).toEqual({
      commit: TIP,
      ref: 'origin/master',
    });
  });

  it('falls back to the baseline when no base branch resolves', async () => {
    routeGit({ [`rev-parse --verify --quiet ${OLD}^{commit}`]: [`${OLD}\n`] });
    expect(await resolveDiffBase({ cwd: CWD, fallbackCommit: OLD })).toEqual({
      commit: OLD,
      ref: null,
    });
  });

  it('falls back to HEAD with no base branch and no baseline', async () => {
    routeGit({});
    expect(await resolveDiffBase({ cwd: CWD })).toEqual({ commit: 'HEAD', ref: null });
  });

  it('refuses a leading-dash ref name', async () => {
    // `git diff --output=/path` would truncate an arbitrary file, and a
    // hostile remote can ship a branch named exactly that.
    routeGit({ 'merge-base origin/master HEAD': [`${TIP}\n`] });
    await resolveDiffBase({ cwd: CWD, preferredBranch: '--output=/tmp/pwned' });
    const argvs = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(argvs.some((a) => a.includes('--output=/tmp/pwned'))).toBe(false);
  });
});
