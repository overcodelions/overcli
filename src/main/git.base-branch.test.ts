import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawnSync, mockExecFile, mockExistsSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockExecFile: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
  execFile: mockExecFile,
}));

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: { ...real, existsSync: mockExistsSync },
    existsSync: mockExistsSync,
  };
});

import {
  baseBranchExistsAsync,
  detectBaseBranch,
  listBaseBranches,
  listBaseBranchesFresh,
} from './git';

function ok(stdout: string) {
  return { stdout, stderr: '', status: 0 };
}

function fail() {
  return { stdout: '', stderr: '', status: 1 };
}

/// `execFile` calls back with (error, stdout, stderr); a non-zero exit is
/// reported as an Error carrying a numeric `code`.
function execOk(stdout: string) {
  return (cb: ExecCallback) => cb(null, stdout, '');
}

function execFail() {
  return (cb: ExecCallback) => cb(Object.assign(new Error('git failed'), { code: 1 }), '', '');
}

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

beforeEach(() => {
  mockExistsSync.mockReturnValue(true);
  mockSpawnSync.mockImplementation(() => fail());
  mockExecFile.mockImplementation((_bin, _args, _opts, cb) => execFail()(cb));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('detectBaseBranch', () => {
  it('prefers the currently checked out branch', () => {
    mockSpawnSync.mockImplementation((_bin, args) => {
      const cmd = args.join(' ');
      if (cmd === 'branch --show-current') return ok('feature/wip\n');
      return fail();
    });

    expect(detectBaseBranch('/repo')).toBe('feature/wip');
  });

  it('falls back to origin/HEAD when the current branch is empty', () => {
    mockSpawnSync.mockImplementation((_bin, args) => {
      const cmd = args.join(' ');
      if (cmd === 'branch --show-current') return ok('');
      if (cmd === 'symbolic-ref refs/remotes/origin/HEAD') return ok('refs/remotes/origin/main\n');
      return fail();
    });

    expect(detectBaseBranch('/repo')).toBe('main');
  });
});

describe('listBaseBranches', () => {
  it('dedupes local and remote refs and prepends the detected base branch', () => {
    mockSpawnSync.mockImplementation((_bin, args) => {
      const cmd = args.join(' ');
      if (cmd === 'branch --show-current') return ok('feature/wip\n');
      if (cmd === 'for-each-ref --sort=-committerdate --format=%(refname:short) refs/heads') {
        return ok('main\nfeature/wip\nrelease\nfeature/wip\n');
      }
      if (cmd === 'for-each-ref --sort=-committerdate --format=%(refname:short) refs/remotes') {
        return ok('origin\norigin/HEAD\norigin/main\nupstream/release\n');
      }
      if (cmd === 'rev-parse --verify --quiet feature/wip^{commit}') return ok('sha\n');
      return fail();
    });

    expect(listBaseBranches('/repo')).toEqual([
      'feature/wip',
      'main',
      'release',
      'origin/main',
      'upstream/release',
    ]);
  });
});

// Git's ref rules allow a branch literally named `--output=/path`, which a
// clone carries over from a hostile remote. If such a name reaches the
// `git diff <base>` argv it is parsed as an option, and `--output=` alone
// truncates an arbitrary file. Neither entry point may hand one back.
describe('option-injecting ref names', () => {
  it('detectBaseBranch falls back rather than returning a leading-dash branch', () => {
    mockSpawnSync.mockImplementation((_bin, args) => {
      const cmd = args.join(' ');
      if (cmd === 'branch --show-current') return ok('--output=/tmp/pwned\n');
      if (cmd === 'rev-parse --verify main') return ok('sha\n');
      return fail();
    });

    expect(detectBaseBranch('/repo')).toBe('main');
  });

  it('listBaseBranches drops leading-dash refs', () => {
    mockSpawnSync.mockImplementation((_bin, args) => {
      const cmd = args.join(' ');
      if (cmd === 'for-each-ref --sort=-committerdate --format=%(refname:short) refs/heads') {
        return ok('main\n--output=/tmp/pwned\n-u\n');
      }
      return fail();
    });

    expect(listBaseBranches('/repo')).toEqual(['main']);
  });
});

// The picker lists refs that are already local, so a branch pushed from
// another machine (the PR you just opened) is invisible until something
// fetches. `listBaseBranchesFresh` is that something.
describe('listBaseBranchesFresh', () => {
  function localRefs(extra: (cmd: string) => unknown = () => null) {
    mockSpawnSync.mockImplementation((_bin: string[], args: string[]) => {
      const cmd = args.join(' ');
      const custom = extra(cmd);
      if (custom) return custom;
      if (cmd === 'for-each-ref --sort=-committerdate --format=%(refname:short) refs/heads') {
        return ok('main\n');
      }
      return fail();
    });
  }

  it('fetches origin before listing so newly pushed branches appear', async () => {
    localRefs();
    const calls: string[] = [];
    mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const cmd = args.join(' ');
      calls.push(cmd);
      if (cmd === 'rev-parse --is-inside-work-tree') return execOk('true\n')(cb);
      if (cmd === 'remote get-url origin') return execOk('git@github.com:o/r.git\n')(cb);
      if (cmd === 'fetch origin --prune') {
        // The fetch is what makes the remote ref resolvable locally.
        localRefs((c) =>
          c === 'for-each-ref --sort=-committerdate --format=%(refname:short) refs/remotes'
            ? ok('origin/feature/new-pr\n')
            : null,
        );
        return execOk('')(cb);
      }
      return execFail()(cb);
    });

    const branches = await listBaseBranchesFresh('/repo');
    expect(calls).toContain('fetch origin --prune');
    expect(branches).toContain('origin/feature/new-pr');
    expect(branches).toContain('feature/new-pr');
  });

  it('still returns local refs when the fetch fails (offline, no creds)', async () => {
    localRefs();
    mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --is-inside-work-tree') return execOk('true\n')(cb);
      if (cmd === 'remote get-url origin') return execOk('git@github.com:o/r.git\n')(cb);
      return execFail()(cb);
    });

    expect(await listBaseBranchesFresh('/repo')).toEqual(['main']);
  });

  it('returns nothing outside a git repo instead of shelling out further', async () => {
    const calls: string[] = [];
    mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push(args.join(' '));
      return execFail()(cb);
    });

    expect(await listBaseBranchesFresh('/not-a-repo')).toEqual([]);
    expect(calls).toEqual(['rev-parse --is-inside-work-tree']);
  });
});

describe('baseBranchExistsAsync', () => {
  it('resolves a branch reachable only as a remote ref', async () => {
    mockExecFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --verify --quiet origin/release^{commit}') return execOk('abc\n')(cb);
      return execFail()(cb);
    });

    expect(await baseBranchExistsAsync('/repo', 'release')).toBe(true);
  });

  it('reports a branch this repo has never had', async () => {
    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      execFail()(cb),
    );

    expect(await baseBranchExistsAsync('/repo', 'feature/from-some-other-repo')).toBe(false);
  });
});
