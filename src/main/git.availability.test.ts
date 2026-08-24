// The probe behind "Overcli needs git and it isn't here". Everything is
// injected, because the one thing these tests must NOT depend on is whether
// the machine running them happens to have git installed — that is the exact
// condition under test.

import { describe, expect, it, vi } from 'vitest';

import { gitInstallCommand, probeGitAvailability } from './git';

function deps(over: Partial<Parameters<typeof probeGitAvailability>[0]> = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    resolvedBinary: () => '/opt/homebrew/bin/git',
    xcodeSelectPath: async () => 0,
    gitVersion: async () => ({ stdout: 'git version 2.44.0\n', stderr: '', exitCode: 0 }),
    ...over,
  };
}

describe('probeGitAvailability', () => {
  it('reports the version when git runs', async () => {
    expect(await probeGitAvailability(deps())).toEqual({
      state: 'ok',
      version: 'git version 2.44.0',
    });
  });

  // The whole reason this probe exists. `/usr/bin/git` is present on a Mac
  // that has never installed the developer tools, so a path-existence check
  // says "git is here" on precisely the machine where it is not.
  it('detects the macOS stub without running it', async () => {
    const gitVersion = vi.fn();
    const res = await probeGitAvailability(
      deps({
        resolvedBinary: () => '/usr/bin/git',
        xcodeSelectPath: async () => 1,
        gitVersion: gitVersion as never,
      }),
    );
    expect(res).toEqual({ state: 'needs-xcode-tools' });
    // Running the stub is what pops the OS install dialog — the thing we are
    // avoiding, not merely an optimisation.
    expect(gitVersion).not.toHaveBeenCalled();
  });

  it('accepts /usr/bin/git once the developer tools are installed', async () => {
    const res = await probeGitAvailability(
      deps({ resolvedBinary: () => '/usr/bin/git', xcodeSelectPath: async () => 0 }),
    );
    expect(res).toEqual({ state: 'ok', version: 'git version 2.44.0' });
  });

  it('reads the stub error if it runs anyway', async () => {
    const res = await probeGitAvailability(
      deps({
        gitVersion: async () => ({
          stdout: '',
          stderr: 'xcrun: error: invalid active developer path',
          exitCode: 1,
        }),
      }),
    );
    expect(res).toEqual({ state: 'needs-xcode-tools' });
  });

  it('reports a spawn failure as missing', async () => {
    const res = await probeGitAvailability(
      deps({
        platform: 'win32',
        resolvedBinary: () => 'git',
        gitVersion: async () => ({ stdout: '', stderr: 'spawn git ENOENT', exitCode: -1 }),
      }),
    );
    expect(res).toEqual({ state: 'missing' });
  });

  // A zero exit with no output is not a working git; treating it as one would
  // let every later git call fail with an unexplained empty result.
  it('does not accept a silent success', async () => {
    const res = await probeGitAvailability(
      deps({ gitVersion: async () => ({ stdout: '   ', stderr: '', exitCode: 0 }) }),
    );
    expect(res).toEqual({ state: 'missing' });
  });
});

describe('gitInstallCommand', () => {
  it('has a command for macOS and Windows, and none for Linux', () => {
    expect(gitInstallCommand('darwin')).toBe('xcode-select --install');
    expect(gitInstallCommand('win32')).toContain('winget install');
    expect(gitInstallCommand('linux')).toBeNull();
  });

  // `runInTerminal` refuses shell metacharacters outright, so a command that
  // contained one would be rejected at launch rather than at review.
  it('emits commands runInTerminal will accept', () => {
    for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
      expect(gitInstallCommand(platform)).not.toMatch(/[`$;&|<>\n\r]/);
    }
  });
});
