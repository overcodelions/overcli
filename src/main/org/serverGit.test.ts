import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { UNREADABLE_CONFIG, gitCommandOf, hardening, scopedEntries, serverGitLaunch, talksToRemote, unsafeRepoConfig, useTrustedGitCredentials, type GitLaunch } from './serverGit';

const argsOf = (l: GitLaunch | null): string[] => (l && 'args' in l ? l.args : []);

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
    // No shared ~/.gitconfig and no system config: a worker can write the
    // first (uploadpack.packObjectsHook, say), and the hardening puts back
    // the one thing the server needs from the second.
    expect(launch).toMatchObject({ as: 'server', env: { GIT_SSH_COMMAND: 'ssh', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const args = argsOf(launch);
    expect(args.slice(-4)).toEqual(['push', '-u', 'origin', 'feat/x']);
    for (const pair of ['safe.directory=*', 'core.fsmonitor=', 'core.hooksPath=/dev/null', 'core.askPass=', 'protocol.ext.allow=never', 'protocol.file.allow=never', 'credential.helper=']) expect(args).toContain(pair);
    // A worktree's own config could ask for a signed push and name the signer: neither is read.
    for (const pair of ['push.gpgSign=false', 'commit.gpgSign=false', 'tag.gpgSign=false', 'gpg.program=/bin/false', 'gpg.openpgp.program=/bin/false', 'gpg.x509.program=/bin/false', 'gpg.ssh.program=/bin/false']) expect(args).toContain(pair);
    // No proxy and no loosened TLS from any file; the server's own proxy, from its environment, stays.
    for (const pair of ['http.proxy=', 'remote.origin.proxy=', 'http.sslVerify=true']) expect(args).toContain(pair);
    // Only https and ssh: a remote helper named by an address (`evil::x`) or a remote's vcs never starts.
    for (const pair of ['protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always']) expect(args).toContain(pair);
    expect(argsOf(serverGitLaunch('git', ['fetch'], '/data/repos/a', worker, roots, { https_proxy: 'http://egress.acme.example:3128' }, () => []))).toContain('http.proxy=http://egress.acme.example:3128');
    // A global file the operator names in the server's own environment is the server's to read.
    expect(serverGitLaunch('git', ['fetch'], '/data/repos/a', worker, roots, { GIT_CONFIG_GLOBAL: '/etc/overcli/gitconfig' })).toMatchObject({ env: { GIT_CONFIG_GLOBAL: '/etc/overcli/gitconfig' } });
    // The helpers configured anywhere are cleared first; the server's own come after.
    expect(args.indexOf('credential.https://github.com.helper=!f() { echo password=$GH_TOKEN; }; f')).toBeGreaterThan(args.indexOf('credential.helper='));
    // A caller's own -c (a clone's helper) still comes after the hardening.
    const clone = serverGitLaunch('git', ['-c', 'credential.https://h.helper=x', 'clone', 'https://h/r', '/data/repos/r'], '/app', worker, roots, {})!;
    expect(argsOf(clone).indexOf('credential.https://h.helper=x')).toBeGreaterThan(argsOf(clone).indexOf('credential.helper='));
    expect(serverGitLaunch('git', ['fetch'], '/data/repos/a', worker, roots, { GIT_SSH_COMMAND: 'ssh -i /keys/deploy' })).toMatchObject({ env: { GIT_SSH_COMMAND: 'ssh -i /keys/deploy' } });
  });

  it('refuses to talk to a remote from a repo whose own config steers requests or credentials', () => {
    const steering = (dir: string) => (dir === '/data/repos/a' ? ['http.https://github.com.proxy', 'credential.helper'] : []);
    expect(serverGitLaunch('git', ['fetch', 'origin'], '/data/repos/a', worker, roots, {}, steering)).toEqual({ as: 'refused', keys: ['http.https://github.com.proxy', 'credential.helper'], dir: '/data/repos/a' });
    expect(serverGitLaunch('git', ['-C', '/data/repos/a', 'push', 'origin', 'HEAD:x'], '/app', worker, roots, {}, steering)).toMatchObject({ as: 'refused' });
    expect(serverGitLaunch('git', ['fetch', 'origin'], '/data/repos/b', worker, roots, {}, steering)).toMatchObject({ as: 'server' });
    // Only network commands are checked: nothing else sends credentials, and the check's own `git config` must not check itself.
    const never = () => { throw new Error('consulted'); };
    expect(serverGitLaunch('git', ['config', '--local', '--list'], '/data/repos-private/a', worker, roots, {}, never)).toMatchObject({ as: 'server' });
    expect(serverGitLaunch('git', ['status'], '/data/repos/a', worker, roots, {}, never)).toMatchObject({ as: 'worker' });
  });

  it('reads the steering keys out of a real repo, includes followed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-steer-'));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      expect(unsafeRepoConfig(dir, [])).toEqual([]);
      git('config', 'user.name', 'x');
      expect(unsafeRepoConfig(dir, [])).toEqual([]);
      git('config', 'http.https://github.com.proxy', 'http://evil.example:8080');
      git('config', 'remote.origin.proxy', 'http://evil.example:8080');
      fs.writeFileSync(path.join(dir, 'extra.inc'), '[http]\n\tsslVerify = false\n');
      git('config', 'include.path', path.join(dir, 'extra.inc'));
      expect(unsafeRepoConfig(dir, []).sort()).toEqual(['http.https://github.com.proxy', 'http.sslverify', 'remote.origin.proxy']);
      expect(unsafeRepoConfig(path.join(dir, 'nope'), [])).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets through exactly the credential helper the server writes into a connected repo, and nothing else under that name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-steer-own-'));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('remote', 'add', 'origin', 'https://bitbucket.org/acme/web.git');
      const helper = '!f() { test "$1" = get && echo "username=${ACME_USER:-x-token-auth}" && echo "password=$ACME_TOKEN"; }; f';
      git('config', 'credential.https://bitbucket.org.helper', helper);
      const trusted: Array<[string, string]> = [['credential.https://bitbucket.org.helper', helper]];
      // What every connected https repo looks like: nothing to refuse.
      expect(unsafeRepoConfig(dir, trusted)).toEqual([]);
      // The same key with another value is a worker's helper, not the server's.
      git('config', 'credential.https://bitbucket.org.helper', '!cat /data/secrets.key; f');
      expect(unsafeRepoConfig(dir, trusted)).toEqual(['credential.https://bitbucket.org.helper']);
      git('config', 'credential.https://bitbucket.org.helper', helper);
      // A remote helper by vcs is refused too.
      git('config', 'remote.origin.vcs', 'evil');
      expect(unsafeRepoConfig(dir, trusted)).toEqual(['remote.origin.vcs']);
      git('config', '--unset', 'remote.origin.vcs');
      // The caller's own -c (the hardening, the trusted helpers) is not the repo's config.
      expect(unsafeRepoConfig(dir, trusted, { ...process.env, GIT_CONFIG_PARAMETERS: "'http.proxy'='http://evil.example:1'" })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the repo config cannot be read, whatever the shared HOME holds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-steer-broken-'));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'http.https://github.com.proxy', 'http://evil.example:8080');
      // A broken shared ~/.gitconfig is never read, so it can't make the check skip the repo.
      fs.mkdirSync(path.join(dir, 'home'));
      fs.writeFileSync(path.join(dir, 'home', '.gitconfig'), '[broken\n');
      expect(unsafeRepoConfig(dir, [], { ...process.env, HOME: path.join(dir, 'home') })).toEqual(['http.https://github.com.proxy']);
      // A broken repo config: unknown, so refused.
      fs.appendFileSync(path.join(dir, '.git', 'config'), '[broken\n');
      expect(unsafeRepoConfig(dir, [])).toEqual([UNREADABLE_CONFIG]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads scoped config entries, values with newlines and keys without values', () => {
    expect(scopedEntries('local\0remote.origin.url\nhttps://x\0worktree\0core.bare\0command\0http.proxy\n\0')).toEqual([
      { scope: 'local', key: 'remote.origin.url', value: 'https://x' },
      { scope: 'worktree', key: 'core.bare', value: '' },
      { scope: 'command', key: 'http.proxy', value: '' },
    ]);
  });

  it('changes nothing without a worker user, or for anything but git', () => {
    expect(serverGitLaunch('git', ['diff'], '/data/repos/a', null, roots)).toBeNull();
    expect(serverGitLaunch('/usr/bin/npm', ['test'], '/data/repos/a', worker, roots)).toBeNull();
    expect(hardening([])).not.toContain('credential.https://github.com.helper');
  });
});
