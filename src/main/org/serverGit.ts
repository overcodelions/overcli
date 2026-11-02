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
//     repo's host, put back), and the ext:: and git:// transports. These
//     don't touch the work tree, so no filter runs.
//
// With no worker user (the desktop app, a server without OVERCLI_WORKER_UID)
// nothing changes.

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
/// command, as `-c` pairs, the server's own credential helpers last.
export function hardening(helpers: Array<[string, string]> = trustedHelpers()): string[] {
  const pairs: Array<[string, string]> = [
    ['core.fsmonitor', ''],
    ['core.hooksPath', '/dev/null'],
    ['core.askPass', ''],
    ['protocol.ext.allow', 'never'],
    ['protocol.git.allow', 'never'],
    ['remote.origin.uploadpack', 'git-upload-pack'],
    ['remote.origin.receivepack', 'git-receive-pack'],
    // An empty helper clears every helper configured before it.
    ['credential.helper', ''],
    ...helpers,
  ];
  return pairs.flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

export type GitLaunch =
  | { as: 'worker'; args: string[] }
  | { as: 'server'; args: string[]; env: Record<string, string> };

/// How the server should start `git …args` in `cwd`, or null to start it as
/// it is (no worker user, or not git).
export function serverGitLaunch(file: string, args: readonly string[], cwd: string, worker: WorkerUser | null, roots: readonly string[], env: NodeJS.ProcessEnv = process.env): GitLaunch | null {
  if (!worker || !isGitBinary(file)) return null;
  const { sub, next, dir } = gitCommandOf(args, cwd);
  if (!talksToRemote(sub, next) && within(dir, roots)) return { as: 'worker', args: [...args] };
  // ssh reads core.sshCommand from config; the environment wins over it.
  return { as: 'server', args: [...hardening(), ...args], env: { GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh' } };
}
