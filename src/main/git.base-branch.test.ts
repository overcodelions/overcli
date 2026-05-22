import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawnSync, mockExistsSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: { ...real, existsSync: mockExistsSync },
    existsSync: mockExistsSync,
  };
});

import { detectBaseBranch, listBaseBranches } from './git';

function ok(stdout: string) {
  return { stdout, stderr: '', status: 0 };
}

function fail() {
  return { stdout: '', stderr: '', status: 1 };
}

beforeEach(() => {
  mockExistsSync.mockReturnValue(true);
  mockSpawnSync.mockImplementation(() => fail());
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
