// No capabilities for anything the server starts (Linux, `overcli serve`).
//
// With OVERCLI_WORKER_UID (or OVERCLI_TEST_UID) the entrypoint hands the
// server setuid, setgid, dac_override and kill as ambient capabilities: the
// only way a node process keeps them across exec. Ambient capabilities pass to
// every child, though: git in a cloned repo, a relayed MCP package, a
// Services process, repo tests. Any of them could read every file in the
// container or become root.
//
// So once the server holds ambient capabilities, every process it starts
// goes through `setpriv`, which clears the ambient and inheritable sets and
// sets no_new_privs (no setuid binary or file capability can grant any
// back), then execs the real command. The one exception is the server's own
// worker launch (workerUser.ts asWorkerUser), which switches user and drops
// them the same way itself.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripSecrets } from './secrets';
import { serverGitLaunch } from './serverGit';
import { SETPRIV, activeWorkerUser, asWorkerUser, switchableUsers, workerWritableRoots } from './workerUser';

export const DROP_CAPS = ['--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--'] as const;

/// The ambient capabilities in a /proc/<pid>/status.
export function ambientCaps(status: string): bigint {
  const m = /^CapAmb:\s*([0-9a-f]+)$/m.exec(status);
  return m ? BigInt(`0x${m[1]}`) : 0n;
}

/// Whether `args` to setpriv are a worker launch: a switch to one of the
/// users the server may become (the worker user, active or about to be
/// checked, or the repo-test user), no other, that drops every capability
/// on the way (asWorkerUser). With none configured, nothing is.
export function isWorkerLaunch(args: readonly string[], users: ReadonlyArray<{ uid: number; gid: number }> = [...(activeWorkerUser() ? [activeWorkerUser()!] : []), ...switchableUsers()]): boolean {
  const end = args.indexOf('--');
  const flags = end < 0 ? args : args.slice(0, end);
  if (!['--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs'].every((f) => flags.includes(f))) return false;
  if (flags.some((a) => /^--(?:ruid|euid|rgid|egid)=/.test(a))) return false;
  return users.some((u) =>
    u.uid > 0 && u.gid > 0
    && flags.includes(`--reuid=${u.uid}`)
    && flags.includes(`--regid=${u.gid}`)
    && !flags.some((a) => /^--(?:reuid|regid)=/.test(a) && a !== `--reuid=${u.uid}` && a !== `--regid=${u.gid}`));
}

/// `file args…` as it should start: through setpriv with no capabilities,
/// unless it is already a worker launch.
export function withoutCaps(file: string, args: readonly string[]): { file: string; args: string[] } {
  if (file === SETPRIV && isWorkerLaunch(args)) return { file, args: [...args] };
  return { file: SETPRIV, args: [...DROP_CAPS, file, ...args] };
}

/// What runs instead of a git command the server refused (serverGit.ts):
/// something that fails the way git would, with the reason on stderr.
export function refusedGitLaunch(keys: string[], dir = 'this repo'): { file: string; args: string[] } {
  const why = `overcli: not running git in ${dir}: its own config sets ${keys.join(', ')}, which could send the server's credentials elsewhere or start a program. Look in its .git/config, its worktree's config.worktree, and any file they include.`;
  return { file: '/bin/sh', args: ['-c', 'printf "%s\\n" "$1" >&2; exit 128', 'overcli-refused-git', why] };
}

/// Whether `file` names a program that exists, looked up the way exec does:
/// as a path when it has a slash, else on PATH. One that doesn't is started
/// as it is, so it fails with ENOENT as before (callers say "isn't
/// installed" on that) rather than as setpriv's exit 127. Nothing runs, so
/// nothing inherits anything.
/// Found ones are remembered (a program rarely goes away); missing ones are
/// looked for again, since a toolchain can be installed while the server runs.
export function findable(file: string, pathVar: string | undefined, cwd: string | undefined, exists: (p: string) => boolean = isExecutable): boolean {
  const key = `${file}\u0000${pathVar ?? ''}\u0000${file.includes('/') ? cwd ?? '' : ''}`;
  if (exists === isExecutable && found.has(key)) return true;
  const ok = file.includes('/')
    ? exists(path.resolve(cwd ?? process.cwd(), file))
    : (pathVar ?? '/usr/local/bin:/usr/bin:/bin').split(':').some((dir) => !!dir && exists(path.resolve(cwd ?? process.cwd(), dir, file)));
  if (ok && exists === isExecutable) {
    if (found.size >= 1024) found.clear();
    found.add(key);
  }
  return ok;
}
const found = new Set<string>();

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathOf(envPairs: unknown): string | undefined {
  if (!Array.isArray(envPairs)) return undefined;
  const pair = envPairs.find((e): e is string => typeof e === 'string' && e.startsWith('PATH='));
  return pair?.slice(5);
}

type Opts = { shell?: boolean | string } & Record<string, unknown>;

/// The overloads of spawnSync/execFileSync: (file), (file, args), (file,
/// options), (file, args, options). A shell launch becomes the shell
/// itself, so setpriv wraps the shell and not just its first word.
export function normalize(file: string, a?: unknown, b?: unknown): { file: string; args: string[]; options: Opts } {
  const args = Array.isArray(a) ? a.map(String) : [];
  const options: Opts = { ...((Array.isArray(a) ? b : a) as Opts | undefined) };
  if (!options.shell) return { file, args, options };
  const shell = typeof options.shell === 'string' ? options.shell : '/bin/sh';
  delete options.shell;
  return { file: shell, args: ['-c', [file, ...args].join(' ')], options };
}

/// How the server starts `file argv…` in `cwd`: git by the server's git
/// rule (serverGit.ts), as the worker or hardened; everything else without
/// capabilities. `env` comes back only when it changes.
export function launchFor(file: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): { file: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const worker = activeWorkerUser();
  const git = serverGitLaunch(file, argv, cwd, worker, workerWritableRoots(), env);
  if (git?.as === 'worker' && worker) {
    const w = asWorkerUser(worker, file, git.args, '002');
    return { file: w.command, args: w.args, env: stripSecrets(env) as NodeJS.ProcessEnv };
  }
  if (git?.as === 'server') return { ...withoutCaps(file, git.args), env: { ...env, ...git.env } };
  if (git?.as === 'refused') {
    const refused = refusedGitLaunch(git.keys, git.dir);
    return withoutCaps(refused.file, refused.args);
  }
  return withoutCaps(file, argv);
}

function fromPairs(pairs: unknown): NodeJS.ProcessEnv | undefined {
  if (!Array.isArray(pairs)) return undefined;
  const env: NodeJS.ProcessEnv = {};
  for (const p of pairs) if (typeof p === 'string') { const i = p.indexOf('='); if (i > 0) env[p.slice(0, i)] = p.slice(i + 1); }
  return env;
}

function toPairs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string').map(([k, v]) => `${k}=${v}`);
}

let installed = false;

/// Route every child process through `withoutCaps` from now on. Async
/// launches (spawn, execFile, exec, fork, and libraries built on them) all
/// start in ChildProcess.prototype.spawn, after Node has resolved the shell;
/// the sync ones are wrapped one by one.
export function dropCapsFromChildren(cp: typeof childProcess = childProcess): void {
  if (installed) return;
  installed = true;
  const proto = cp.ChildProcess.prototype as unknown as { spawn: (options: { file: string; args?: string[] }) => unknown };
  const spawn = proto.spawn;
  proto.spawn = function patchedSpawn(this: unknown, options) {
    const o = options as { file: string; args?: string[]; envPairs?: unknown; cwd?: string };
    if (o && typeof o.file === 'string' && findable(o.file, Array.isArray(o.envPairs) ? pathOf(o.envPairs) : process.env.PATH, o.cwd)) {
      const argv = options.args?.length ? options.args.slice(1) : [];
      const env = fromPairs(o.envPairs) ?? process.env;
      const next = launchFor(options.file, argv, o.cwd ?? process.cwd(), env);
      options = { ...options, file: next.file, args: [next.file, ...next.args], ...(next.env ? { envPairs: toPairs(next.env) } : {}) } as typeof options;
    }
    return spawn.call(this, options);
  };
  const spawnSync = cp.spawnSync;
  const execFileSync = cp.execFileSync;
  const wrapped = (orig: (...a: unknown[]) => unknown) => (file: string, a?: unknown, b?: unknown) => {
    const n = normalize(file, a, b);
    const env = (n.options.env ?? process.env) as NodeJS.ProcessEnv;
    if (!findable(n.file, env.PATH, n.options.cwd as string | undefined)) return orig.call(cp, file, a, b);
    const next = launchFor(n.file, n.args, (n.options.cwd as string | undefined) ?? process.cwd(), env);
    return orig.call(cp, next.file, next.args, next.env ? { ...n.options, env: next.env } : n.options);
  };
  (cp as { spawnSync: unknown }).spawnSync = wrapped(spawnSync as never);
  (cp as { execFileSync: unknown }).execFileSync = wrapped(execFileSync as never);
  (cp as { execSync: unknown }).execSync = (command: string, options?: Opts) => {
    const shell = typeof options?.shell === 'string' ? options.shell : '/bin/sh';
    const { shell: _s, ...rest } = options ?? {};
    const next = withoutCaps(shell, ['-c', command]);
    return execFileSync.call(cp, next.file, next.args, rest as never);
  };
}

/// At startup, before anything is spawned: when the server holds ambient
/// capabilities, keep them from its children. An error when they would
/// pass on and setpriv isn't there to stop it.
export function guardChildCaps(opts: {
  platform?: NodeJS.Platform;
  readStatus?: () => string;
  exists?: (p: string) => boolean;
  install?: () => void;
} = {}): { ok: true; dropping: boolean } | { ok: false; error: string } {
  if ((opts.platform ?? process.platform) !== 'linux') return { ok: true, dropping: false };
  let status: string;
  try {
    status = (opts.readStatus ?? (() => fs.readFileSync('/proc/self/status', 'utf8')))();
  } catch {
    return { ok: true, dropping: false };
  }
  if (ambientCaps(status) === 0n) return { ok: true, dropping: false };
  if (!(opts.exists ?? fs.existsSync)(SETPRIV)) {
    return { ok: false, error: `The server holds ambient capabilities, which every process it starts would inherit, and ${SETPRIV} (util-linux) isn't installed to drop them. Install it, or start the server without capabilities.` };
  }
  (opts.install ?? dropCapsFromChildren)();
  return { ok: true, dropping: true };
}
