// Runs `aws sso login` for one profile or SSO session and reports the
// outcome, so an expired token can be refreshed from the AWS card's Manage
// panel instead of sending the user to a terminal.
//
// Shaped after mcpLogin.ts: a long-lived child, output accumulated from both
// pipes, the first URL handed to the caller, and every terminal path
// (clean exit, non-zero exit, spawn error, timeout) settling the promise
// exactly once — otherwise the IPC handler hangs forever.
//
// `--no-browser` is load-bearing, not a nicety. Without it aws-cli opens the
// verification URL itself AND we open it from `onUrl` — two tabs on the same
// URL. The one retry below drops the flag for a CLI too old to know it, and
// drops `onUrl` in the same step for exactly that reason.
//
// `aws` can't go through backendPaths.ts (that module is keyed to the
// `Backend` union), so binary resolution follows git.ts: explicit candidates,
// because an app launched from Finder inherits a minimal PATH.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AwsSsoLoginResult } from '../shared/types';
import { isSafeAwsName } from './awsProfiles';

export type AwsSsoKind = 'profile' | 'sso-session';

/// Absolute path to an `aws` binary, or null when none is found. Null rather
/// than a bare 'aws' fallback on purpose: the panel needs to be able to say
/// "AWS CLI not found" instead of offering a button that ENOENTs.
export function resolveAwsBinary(): string | null {
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          process.env['ProgramFiles']
            ? path.join(process.env['ProgramFiles'], 'Amazon', 'AWSCLIV2', 'aws.exe')
            : '',
          'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
          'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe',
        ]
      : [
          '/opt/homebrew/bin/aws',
          '/usr/local/bin/aws',
          '/opt/homebrew/opt/awscli/bin/aws',
          '/usr/bin/aws',
          `${home}/.local/bin/aws`,
        ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function awsEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const home = os.homedir();
  const extras =
    process.platform === 'win32'
      ? [
          process.env['ProgramFiles']
            ? path.join(process.env['ProgramFiles'], 'Amazon', 'AWSCLIV2')
            : '',
        ]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', `${home}/.local/bin`];
  const current = env.PATH ?? '';
  env.PATH = [...extras, ...current.split(path.delimiter)].filter(Boolean).join(path.delimiter);
  return env;
}

export function awsSsoLoginArgs(target: string, kind: AwsSsoKind, noBrowser: boolean): string[] {
  return [
    'sso',
    'login',
    kind === 'profile' ? '--profile' : '--sso-session',
    target,
    ...(noBrowser ? ['--no-browser'] : []),
  ];
}

/// The equivalent shell line, for the Terminal fallback and for the copyable
/// block on failure.
///
/// The target is always double-quoted — profile names may contain spaces
/// (`EU Prod`). `isSafeAwsName` has already excluded everything that could
/// break out of those quotes, so this stays a plain interpolation.
export function awsSsoLoginCommand(binary: string, target: string, kind: AwsSsoKind): string {
  const bin = binary.includes(' ') ? `"${binary}"` : binary;
  const flag = kind === 'profile' ? '--profile' : '--sso-session';
  return `${bin} sso login ${flag} "${target}"`;
}

// aws-cli prints "Unknown options: --no-browser"; older argparse builds say
// "unrecognized arguments: --no-browser".
const UNKNOWN_NO_BROWSER = /unknown options?:.*--no-browser|unrecognized arguments?:.*--no-browser/i;

export function runAwsSsoLogin(opts: {
  binary: string;
  target: string;
  kind: AwsSsoKind;
  env: NodeJS.ProcessEnv;
  /// Fired once with the first URL seen in output, so the caller can open it.
  onUrl?: (url: string) => void;
  /// Generous by default: an SSO sign-in with MFA routinely outlasts the
  /// 180s mcpLogin allows.
  timeoutMs?: number;
  noBrowser?: boolean;
}): Promise<AwsSsoLoginResult> {
  const { binary, target, kind, env, onUrl, timeoutMs = 300_000, noBrowser = true } = opts;

  // The handler validates too; this is the belt to that braces, so the
  // function is safe to call from anywhere.
  if (!isSafeAwsName(target)) {
    return Promise.resolve({
      ok: false,
      error: `"${target}" isn't a name overcli will pass to a command.`,
    });
  }

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let urlOpened = false;

    const child = spawn(binary, awsSsoLoginArgs(target, kind, noBrowser), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      if (!urlOpened && onUrl) {
        const m = text.match(/https?:\/\/[^\s'"]+/);
        if (m) {
          urlOpened = true;
          onUrl(m[0]);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const finish = (result: AwsSsoLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({
        ok: false,
        error: `Sign-in timed out after ${Math.round(timeoutMs / 1000)}s. Finish it in the browser, or run this yourself:`,
        output,
      });
    }, timeoutMs);

    child.on('error', (err) => finish({ ok: false, error: err.message, output }));
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, output });
        return;
      }
      // One retry, only for the flag this CLI doesn't know, and without
      // `onUrl` — that build opens its own browser, so passing the callback
      // on would produce the double tab `--no-browser` exists to avoid.
      if (noBrowser && UNKNOWN_NO_BROWSER.test(output)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(
          runAwsSsoLogin({ binary, target, kind, env, timeoutMs, noBrowser: false }),
        );
        return;
      }
      finish({
        ok: false,
        error: firstUsefulLine(output) ?? `aws sso login exited with code ${code}.`,
        output,
      });
    });
  });
}

/// aws-cli puts the actual reason on its own line, usually last. Prefer it
/// over the bare exit code, which tells the user nothing.
function firstUsefulLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /error|denied|expired|invalid|unknown/i.test(l));
  return err ?? null;
}
