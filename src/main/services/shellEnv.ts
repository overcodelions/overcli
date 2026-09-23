// The environment the user's own shell would give a service.
//
// A Mac app opened from the Dock, Finder or Spotlight is started by launchd,
// not by a shell, so nothing in `~/.zprofile` or `~/.zshrc` reaches it:
// no JAVA_HOME, no AWS_PROFILE, a PATH without sdkman, nvm or Homebrew.
// A service started the way it was under a terminal — Tilt, a script — then
// fails in ways that look like its own fault. So ask the login shell once,
// the way an editor does, and start services with what it says.
//
// The shell prints the environment by running this same binary as plain node
// (`ELECTRON_RUN_AS_NODE`), which is the one way to get it back exactly —
// `env` output cannot carry a value with a newline in it. Between markers,
// because an interactive shell's rc files print whatever they like.
//
// Best effort throughout: a shell that hangs, errors or prints nonsense
// leaves services with the environment they had before this existed.

import { spawn } from 'node:child_process';
import os from 'node:os';

/// Long enough for a slow rc file (nvm alone can take a second or two), short
/// enough that a shell stuck on a prompt does not hold a start up for long.
const SHELL_ENV_TIMEOUT_MS = 10_000;

/// What the shell's own run leaves behind that says nothing about the user:
/// the node-mode switch this module sets, and where the shell happened to be.
/// A service gets its real working directory from the spawn, and a stale
/// `PWD` beside it confuses the scripts that read it.
const DROPPED = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'PWD', 'OLDPWD', 'SHLVL', '_']);

let cached: Promise<Record<string, string> | undefined> | undefined;

/// The login shell's environment, read once per app run. `undefined` where
/// there is nothing to read (Windows, no shell) or it could not be read.
export function shellEnv(): Promise<Record<string, string> | undefined> {
  cached ??= readShellEnv().catch((error: unknown) => {
    console.warn(`[services] could not read the login shell's environment: ${(error as Error)?.message ?? error}`);
    return undefined;
  });
  return cached;
}

export async function readShellEnv(
  opts: { shell?: string; execPath?: string; timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<Record<string, string> | undefined> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return undefined;
  const shell = opts.shell ?? process.env.SHELL ?? defaultShell();
  if (!shell) return undefined;
  const execPath = opts.execPath ?? process.execPath;
  const mark = `__overcli_env_${Math.random().toString(36).slice(2)}__`;
  const script = `'${execPath.replace(/'/g, `'\\''`)}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...shellFlags(shell), script], {
      // Nothing to read: an rc file waiting on a prompt then gets EOF at once
      // instead of the timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      detached: true,
    });
    let out = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error(`${shell} took longer than ${Math.round((opts.timeoutMs ?? SHELL_ENV_TIMEOUT_MS) / 1000)}s`));
    }, opts.timeoutMs ?? SHELL_ENV_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    // Drained, not shown: rc files are noisy on stderr and none of it matters.
    child.stderr.resume();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });

  return parseShellEnv(stdout, mark);
}

/// The environment between the markers, minus what only the probe put there.
export function parseShellEnv(stdout: string, mark: string): Record<string, string> | undefined {
  const start = stdout.indexOf(mark);
  const end = stdout.lastIndexOf(mark);
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start + mark.length, end));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && !DROPPED.has(key)) out[key] = value;
  }
  return out;
}

/// `-i` so `.zshrc`/`.bashrc` run — where JAVA_HOME and nvm usually live —
/// and `-l` so the profile does too. csh-family shells take no `-l` with `-c`.
export function shellFlags(shell: string): string[] {
  const name = shell.split('/').pop() ?? '';
  if (name === 'csh' || name === 'tcsh') return ['-ic'];
  return ['-i', '-l', '-c'];
}

function defaultShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}
