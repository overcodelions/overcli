// The server's own git, while workers run as a user of their own.
//
// Workers can write the repos, worktrees and HOME they share with the server,
// and with them a repo's .git/config, its .gitattributes and ~/.gitconfig.
// Git runs commands named there: core.fsmonitor on a status or diff, a
// textconv or filter driver on a diff, hooks, a credential helper on a push.
// Run by the server, any of those would run as the server's user, which can
// read every secret a worker can't.
//
// So every git the server starts goes one of two ways (childCaps.ts applies
// this to every launch):
//
//   in a folder workers can write, and not talking to a remote: run as the
//     worker user. The repo's own config, filters, LFS and hooks behave as
//     they always have; whatever they run, runs as the worker. Same umask as
//     the server, so what git writes has the modes it always had.
//   talking to a remote (push, fetch, clone…), or anywhere else: run as the
//     server, with what could run a command switched off on the command line
//     (which wins over every config file): fsmonitor, hooks, askpass, every
//     configured credential helper (the server's own, for each connected
//     repo's host, put back), signing (push.gpgSign with gpg.program names
//     a program to run), and the ext::, git:// and local-path transports. The shared ~/.gitconfig and the system config are not read
//     at all (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM): a worker could write
//     the first, and with it `uploadpack.packObjectsHook`, which a fetch
//     from a remote pointed at a local path would run as the server. These
//     commands don't touch the work tree, so no filter runs.
//
// With no worker user (the desktop app, a server without OVERCLI_WORKER_UID)
// nothing changes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkerUser } from './workerUser';

/// Subcommands that talk to a remote, and so need the server's token.
const NETWORK = new Set(['push', 'fetch', 'clone', 'ls-remote', 'submodule', 'archive']);
/// `git remote <these>` talks to the remote too; the rest only read config.
const NETWORK_REMOTE = new Set(['update', 'prune', 'show']);

let trustedHelpers: () => Array<[string, string]> = () => [];

/// The credential helpers the server gives git, as `[key, value]` config
/// pairs: one per connected repo's host (repos.ts credentialHelper).
export function useTrustedGitCredentials(fn: () => Array<[string, string]>): void {
  trustedHelpers = fn;
}

export function isGitBinary(file: string): boolean {
  return path.basename(file) === 'git';
}

/// The subcommand of `git …args`, and the folder it works in (`-C` applied).
export function gitCommandOf(args: readonly string[], cwd: string): { sub: string; next: string | undefined; dir: string } {
  let dir = cwd;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') { dir = path.resolve(dir, args[i + 1] ?? ''); i += 2; continue; }
    if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--config-env' || a === '--exec-path') { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    return { sub: a, next: args[i + 1], dir };
  }
  return { sub: '', next: undefined, dir };
}

export function talksToRemote(sub: string, next: string | undefined): boolean {
  return NETWORK.has(sub) || (sub === 'remote' && !!next && NETWORK_REMOTE.has(next));
}

function within(dir: string, roots: readonly string[]): boolean {
  const d = path.resolve(dir);
  return roots.some((r) => {
    const root = path.resolve(r);
    return d === root || d.startsWith(root + path.sep);
  });
}

/// What switches off every way config could make the server's git run a
/// command, or send its credentials somewhere else, as `-c` pairs, the
/// server's own credential helpers last. `proxy`: the server's own, from its
/// environment, or none.
export function hardening(helpers: Array<[string, string]> = trustedHelpers(), proxy = ''): string[] {
  const pairs: Array<[string, string]> = [
    // A proxy and a loosened TLS check in a repo's config would hand the
    // token the helper supplies to whoever runs the proxy. The server's own
    // proxy, if its environment names one, stays.
    ['http.proxy', proxy],
    ['remote.origin.proxy', proxy],
    ['http.sslVerify', 'true'],
    // The system config isn't read (see serverGitLaunch), and the
    // entrypoint's `safe.directory *` with it: said here instead, where only
    // the command line can say it.
    ['safe.directory', '*'],
    ['core.fsmonitor', ''],
    ['core.hooksPath', '/dev/null'],
    ['core.askPass', ''],
    // Only https and ssh: any other scheme in a remote's address (`evil::x`)
    // or a remote's `vcs` would start a `git-remote-<name>` from PATH, which
    // runs in the shared HOME workers write.
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['protocol.ssh.allow', 'always'],
    ['protocol.ext.allow', 'never'],
    ['protocol.git.allow', 'never'],
    // A remote at a local path is a repo a worker can write, served by a
    // git-upload-pack the server would start.
    ['protocol.file.allow', 'never'],
    ['remote.origin.uploadpack', 'git-upload-pack'],
    ['remote.origin.receivepack', 'git-receive-pack'],
    // A signed push runs gpg.program; a worker's worktree config can name
    // both, and a remote of its own that takes signed pushes.
    ['push.gpgSign', 'false'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['gpg.program', '/bin/false'],
    ['gpg.openpgp.program', '/bin/false'],
    ['gpg.x509.program', '/bin/false'],
    ['gpg.ssh.program', '/bin/false'],
    // An empty helper clears every helper configured before it.
    ['credential.helper', ''],
    ...helpers,
  ];
  return pairs.flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

export type GitLaunch =
  | { as: 'worker'; args: string[] }
  | { as: 'server'; args: string[]; env: Record<string, string> }
  /// Not run at all: the repo's own config (which workers write) sets keys
  /// that would steer where the server's credentials go.
  | { as: 'refused'; keys: string[]; dir: string };

/// Config keys that decide where an http request goes or how it is checked,
/// or who answers for a credential. The command line can't pin them all: a
/// `http.<url>.*` key for the remote's address wins over a plain `-c`
/// (git's url matching picks the closest match, whatever its source).
const STEERING_KEYS = /^(?:http\.|url\.|credential\.|core\.gitproxy$|remote\..+\.(?:proxy|vcs|uploadpack|receivepack)$)/i;

/// What stands for a repo whose config couldn't be read: refused, since
/// what it would have said is unknown.
export const UNREADABLE_CONFIG = '(its config, which could not be read)';

/// Parse `git config --list --show-scope -z`: `scope\0key\nvalue\0` per
/// entry, or `scope\0key\0` for a key with no value.
export function scopedEntries(out: string): Array<{ scope: string; key: string; value: string }> {
  const fields = out.split('\0');
  const entries: Array<{ scope: string; key: string; value: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    const rest = fields[i + 1];
    if (!scope && !rest) continue;
    const nl = rest.indexOf('\n');
    entries.push({ scope, key: nl < 0 ? rest : rest.slice(0, nl), value: nl < 0 ? '' : rest.slice(nl + 1) });
  }
  return entries;
}

/// The steering keys set in the repo at `dir`: its .git/config and its
/// worktree config, includes followed. A key the server itself writes, with
/// exactly the value it writes (a connected repo's credential helper,
/// repos.ts), is not one. Fails closed: config that can't be read is
/// refused. Not a repo at all: nothing.
export function unsafeRepoConfig(dir: string, trusted: Array<[string, string]> = trustedHelpers(), env: NodeJS.ProcessEnv = process.env): string[] {
  // Read with the server's git rules (no shared or system config, nothing
  // from the caller's own -c), and past the ownership guard: a tree a worker
  // made would otherwise be skipped silently, and read as empty.
  // A folder that isn't there has no config, and the command fails anyway.
  if (!fs.existsSync(dir)) return [];
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$|^GIT_DIR$|^GIT_WORK_TREE$/.test(k)));
  let out: string;
  try {
    out = execFileSync('git', ['-c', 'safe.directory=*', 'config', '--list', '--includes', '--show-scope', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      env: { ...clean, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (/not a git repository/i.test(stderr)) return [];
    return [UNREADABLE_CONFIG];
  }
  const ok = new Set(trusted.map(([k, v]) => `${k.toLowerCase()}\n${v}`));
  const keys = new Set<string>();
  for (const e of scopedEntries(out)) {
    if (e.scope !== 'local' && e.scope !== 'worktree') continue;
    if (!STEERING_KEYS.test(e.key)) continue;
    if (ok.has(`${e.key.toLowerCase()}\n${e.value}`)) continue;
    keys.add(e.key);
  }
  return [...keys];
}

/// How the server should start `git …args` in `cwd`, or null to start it as
/// it is (no worker user, or not git).
export function serverGitLaunch(file: string, args: readonly string[], cwd: string, worker: WorkerUser | null, roots: readonly string[], env: NodeJS.ProcessEnv = process.env, repoConfig: (dir: string) => string[] = unsafeRepoConfig): GitLaunch | null {
  if (!worker || !isGitBinary(file)) return null;
  const { sub, next, dir } = gitCommandOf(args, cwd);
  const network = talksToRemote(sub, next);
  if (!network && within(dir, roots)) return { as: 'worker', args: [...args] };
  // A command that would send the server's credentials, from a repo whose
  // config says where to: not run. (Only network commands are checked, so
  // the check's own `git config` never checks itself.)
  if (network) {
    const keys = repoConfig(dir);
    if (keys.length) return { as: 'refused', keys, dir };
  }
  // ssh reads core.sshCommand from config; the environment wins over it.
  // Neither the shared ~/.gitconfig (workers write it) nor the system config
  // is read: a global file the operator sets in the server's own
  // environment is, since only the server sees that.
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '';
  return {
    as: 'server',
    args: [...hardening(trustedHelpers(), proxy), ...args],
    env: { GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh', GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL || '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  };
}
