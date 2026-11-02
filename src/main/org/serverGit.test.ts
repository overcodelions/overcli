import { afterEach, describe, expect, it } from 'vitest';
import { gitCommandOf, hardening, serverGitLaunch, talksToRemote, useTrustedGitCredentials } from './serverGit';

const worker = { uid: 1001, gid: 1001 };
const roots = ['/data/home', '/data/repos', '/data/projects'];

afterEach(() => useTrustedGitCredentials(() => []));

describe("the server's git while workers run as their own user", () => {
  it('finds the subcommand and its folder past global options', () => {
    expect(gitCommandOf(['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff'], '/data/repos/a')).toEqual({ sub: 'merge', next: '--no-ff', dir: '/data/repos/a' });
    expect(gitCommandOf(['-C', '/data/home/.overcli/worktrees/x', 'diff', 'HEAD'], '/app')).toMatchObject({ sub: 'diff', dir: '/data/home/.overcli/worktrees/x' });
    expect(gitCommandOf(['--no-pager', '--git-dir', '/x/.git', 'log'], '/r')).toMatchObject({ sub: 'log' });
  });

  it('knows which commands talk to a remote', () => {
    for (const [sub, next] of [['push', 'origin'], ['fetch', '--quiet'], ['clone', 'https://x'], ['ls-remote', 'origin'], ['remote', 'update'], ['remote', 'prune']] as const) expect(talksToRemote(sub, next)).toBe(true);
    for (const [sub, next] of [['diff', 'HEAD'], ['status', '--porcelain'], ['remote', 'get-url'], ['commit', '-m'], ['worktree', 'add']] as const) expect(talksToRemote(sub, next)).toBe(false);
  });

  it('runs what reads or writes a folder workers share as the worker, args unchanged', () => {
    expect(serverGitLaunch('/usr/bin/git', ['diff', 'abc123'], '/data/home/.overcli/worktrees/x', worker, roots)).toEqual({ as: 'worker', args: ['diff', 'abc123'] });
    expect(serverGitLaunch('git', ['-C', '/data/repos/a', 'status', '--porcelain'], '/app', worker, roots)).toMatchObject({ as: 'worker' });
    // A folder that merely starts with a shared one's name isn't in it.
    expect(serverGitLaunch('git', ['status'], '/data/repos-private/a', worker, roots)).toMatchObject({ as: 'server' });
  });

  it('runs what talks to a remote as the server, with every way config could run a command switched off', () => {
    useTrustedGitCredentials(() => [['credential.https://github.com.helper', '!f() { echo password=$GH_TOKEN; }; f']]);
    const launch = serverGitLaunch('git', ['push', '-u', 'origin', 'feat/x'], '/data/home/.overcli/worktrees/x', worker, roots, {});
    expect(launch).toMatchObject({ as: 'server', env: { GIT_SSH_COMMAND: 'ssh' } });
    const args = launch!.args;
    expect(args.slice(-4)).toEqual(['push', '-u', 'origin', 'feat/x']);
    for (const pair of ['core.fsmonitor=', 'core.hooksPath=/dev/null', 'core.askPass=', 'protocol.ext.allow=never', 'credential.helper=']) expect(args).toContain(pair);
    // The helpers configured anywhere are cleared first; the server's own come after.
    expect(args.indexOf('credential.https://github.com.helper=!f() { echo password=$GH_TOKEN; }; f')).toBeGreaterThan(args.indexOf('credential.helper='));
    // A caller's own -c (a clone's helper) still comes after the hardening.
    const clone = serverGitLaunch('git', ['-c', 'credential.https://h.helper=x', 'clone', 'https://h/r', '/data/repos/r'], '/app', worker, roots, {})!;
    expect(clone.args.indexOf('credential.https://h.helper=x')).toBeGreaterThan(clone.args.indexOf('credential.helper='));
    expect(serverGitLaunch('git', ['fetch'], '/data/repos/a', worker, roots, { GIT_SSH_COMMAND: 'ssh -i /keys/deploy' })).toMatchObject({ env: { GIT_SSH_COMMAND: 'ssh -i /keys/deploy' } });
  });

  it('changes nothing without a worker user, or for anything but git', () => {
    expect(serverGitLaunch('git', ['diff'], '/data/repos/a', null, roots)).toBeNull();
    expect(serverGitLaunch('/usr/bin/npm', ['test'], '/data/repos/a', worker, roots)).toBeNull();
    expect(hardening([])).not.toContain('credential.https://github.com.helper');
  });
});
