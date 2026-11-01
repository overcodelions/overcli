// Workers as a user of their own (Linux, `overcli serve`).
//
// A worker that runs shell commands runs them as whatever user its CLI runs
// as. Without this, that is the server's own user, which can read the data
// directory (the secrets key, the tool gateway's key and vault) and the
// server's environment through /proc. With OVERCLI_WORKER_UID set, every
// worker CLI is launched through `setpriv` as that user instead, with no
// capabilities and no way to gain any.
//
// The layout that makes this work (deploy/entrypoint.sh sets it up):
//   - The worker shares the server's HOME, so its CLI config, MCP servers,
//     sign-ins, transcripts and worktrees stay where the server looks for
//     them. HOME and the folders in SHARED_DATA_DIRS are setgid to the
//     worker's group, and the server runs with umask 002, so what either side
//     writes there the other can change.
//   - Everything secret is written 0600 by the server, so the worker can't
//     read it. The rest of the data dir it can read, as before, but not write.
//   - The CLIs write some files 0600 (Claude's transcripts, ~/.claude.json).
//     The server keeps CAP_DAC_OVERRIDE so it can still read, move and delete
//     them. The worker gets no capabilities.
//   - Files the server writes 0600 for a worker to read (the permission
//     broker's config, attachments) and the run tool relay's socket are
//     handed to the worker's group (`shareWithWorkers`).
//
// Off by default: unset, workers run as the server, as before.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SETPRIV = '/usr/bin/setpriv';

export interface WorkerUser {
  uid: number;
  gid: number;
}

/// The worker user named by the environment, `undefined` when none is (the
/// feature is off), or why the setting can't be used.
export function workerUserFrom(env: NodeJS.ProcessEnv, serverUid: number | undefined = process.getuid?.()): WorkerUser | undefined | { error: string } {
  const uid = env.OVERCLI_WORKER_UID?.trim();
  if (!uid) return undefined;
  const gid = env.OVERCLI_WORKER_GID?.trim() || uid;
  if (!/^\d+$/.test(uid)) return { error: `OVERCLI_WORKER_UID is "${uid.slice(0, 40)}", not a number. Set it to the numeric id of a user that cannot read the server's data directory.` };
  if (Number(uid) === 0) return { error: 'OVERCLI_WORKER_UID is 0, which is root. Set it to a user that cannot read the server\'s data directory.' };
  if (!/^\d+$/.test(gid)) return { error: `OVERCLI_WORKER_GID is "${gid.slice(0, 40)}", not a number. Set it to a numeric group id, or leave it out to use the user's id.` };
  if (serverUid !== undefined && Number(uid) === serverUid) {
    return { error: `OVERCLI_WORKER_UID is ${uid}, the server's own user. Set it to a different user.` };
  }
  return { uid: Number(uid), gid: Number(gid) };
}

let active: WorkerUser | null = null;

/// The worker user for this process, or null when workers run as the server.
export function activeWorkerUser(): WorkerUser | null {
  return active;
}

/// Set by `overcli serve` once the startup check passes. Tests reset it with null.
export function setActiveWorkerUser(user: WorkerUser | null): void {
  active = user;
}

/// `command args…` run as `user`. The shell step only sets the umask (the
/// group keeps read and write, others get nothing) and then execs the
/// command, so the pid, stdio and signals are the command's own.
export function asWorkerUser(user: WorkerUser, command: string, args: readonly string[]): { command: string; args: string[] } {
  return {
    command: SETPRIV,
    args: [
      `--reuid=${user.uid}`,
      `--regid=${user.gid}`,
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      '/bin/sh',
      '-c',
      'umask 007; exec "$@"',
      'overcli-worker',
      command,
      ...args,
    ],
  };
}

/// The launch for a worker CLI: as the worker user when one is active,
/// otherwise unchanged.
export function workerLaunch(command: string, args: readonly string[]): { command: string; args: string[] } {
  return active ? asWorkerUser(active, command, args) : { command, args: [...args] };
}

/// Give the worker's group the owner's access to a file, directory or socket
/// the server made for a worker to use. A no-op when workers run as the server.
export function shareWithWorkers(target: string): void {
  if (!active) return;
  const mode = fs.statSync(target).mode & 0o777;
  fs.chownSync(target, -1, active.gid);
  fs.chmodSync(target, (mode & 0o707) | ((mode & 0o700) >> 3));
}

// ---- the startup check ------------------------------------------------------

/// Linux capability bits the server needs to launch and look after workers.
const CAP_DAC_OVERRIDE = 1;
const CAP_SETGID = 6;
const CAP_SETUID = 7;

/// The server's effective capabilities, from /proc/self/status.
export function effectiveCaps(status: string): bigint {
  const m = /^CapEff:\s*([0-9a-f]+)$/m.exec(status);
  return m ? BigInt(`0x${m[1]}`) : 0n;
}

/// What the server lacks to run workers as another user, or undefined.
export function missingServerCaps(caps: bigint): string | undefined {
  const need: Array<[number, string]> = [[CAP_SETUID, 'setuid'], [CAP_SETGID, 'setgid'], [CAP_DAC_OVERRIDE, 'dac_override']];
  const missing = need.filter(([bit]) => (caps & (1n << BigInt(bit))) === 0n).map(([, name]) => name);
  return missing.length ? missing.join(', ') : undefined;
}

export interface WorkerProbe {
  /// Files the worker must NOT be able to read. Missing ones are skipped.
  secrets: string[];
  /// Directories the worker must be able to write.
  writable: string[];
  /// The server's pid: the worker must not read its environment.
  serverPid: number;
  /// A worker CLI to run with --version, when one is installed.
  cli?: string;
}

/// Runs as the worker user; prints one `ok …` or `FAIL …` line per check.
export const PROBE_SCRIPT = [
  'IFS="',
  '"',
  'if grep -Eq "^CapEff:[[:space:]]*0+$" /proc/self/status; then echo "ok has no capabilities"; else echo "FAIL still has capabilities"; fi',
  'for f in $PROBE_SECRETS; do [ -e "$f" ] || continue; if cat "$f" >/dev/null 2>&1; then echo "FAIL can read $f"; else echo "ok cannot read $f"; fi; done',
  'if cat "/proc/$PROBE_PID/environ" >/dev/null 2>&1; then echo "FAIL can read the server\'s environment"; else echo "ok cannot read the server\'s environment"; fi',
  'for d in $PROBE_WRITABLE; do t="$d/.overcli-worker-probe-$$"; if : > "$t" 2>/dev/null && rm -f "$t"; then echo "ok can write $d"; else echo "FAIL cannot write $d"; fi; done',
  'if [ -n "$PROBE_CLI" ]; then if "$PROBE_CLI" --version >/dev/null 2>&1; then echo "ok can run $PROBE_CLI"; else echo "FAIL cannot run $PROBE_CLI"; fi; fi',
].join('\n');

export interface ProbeResult {
  ok: boolean;
  lines: string[];
}

/// Read the probe's output. Any FAIL, or no output at all, fails it.
export function readProbe(stdout: string): ProbeResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith('ok ')), lines };
}

type ExecFile = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }, cb: (err: Error | null, stdout: string) => void) => unknown;

/// Run the probe as `user`. Its environment carries only PATH and the probe's
/// own inputs, never the server's secrets.
export function runWorkerProbe(user: WorkerUser, probe: WorkerProbe, exec: ExecFile = execFile as unknown as ExecFile): Promise<ProbeResult> {
  const { command, args } = asWorkerUser(user, '/bin/sh', ['-c', PROBE_SCRIPT]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PROBE_SECRETS: probe.secrets.join('\n'),
    PROBE_WRITABLE: probe.writable.join('\n'),
    PROBE_PID: String(probe.serverPid),
    PROBE_CLI: probe.cli ?? '',
  };
  return new Promise((resolve) => {
    try {
      exec(command, args, { env, timeout: 60_000 }, (err, stdout) => {
        const res = readProbe(stdout ?? '');
        if (err && res.ok) resolve({ ok: false, lines: [...res.lines, `FAIL the check exited badly: ${err.message}`] });
        else if (!res.lines.length) resolve({ ok: false, lines: [`FAIL could not start as user ${user.uid}: ${err?.message ?? 'no output'}`] });
        else resolve(res);
      });
    } catch (err) {
      resolve({ ok: false, lines: [`FAIL could not start as user ${user.uid}: ${err instanceof Error ? err.message : String(err)}`] });
    }
  });
}

/// Folders under the data dir a worker's CLI writes to: the clones, the
/// default project, the workspace and coordinator roots runs work in, each
/// worker's own folder, team tasks' files, and run attachments.
export const SHARED_DATA_DIRS = ['repos', 'projects', 'workspaces', 'coordinators', 'worker-files', 'team-files', 'flow-attachments'] as const;

/// The secret files under the data dir a worker must not read, and the
/// directories it must be able to write.
export function probeTargets(dataDir: string, home: string): Pick<WorkerProbe, 'secrets' | 'writable'> {
  const org = path.join(dataDir, 'org');
  return {
    secrets: [
      path.join(dataDir, 'secrets.key'),
      path.join(dataDir, 'secrets.enc'),
      path.join(dataDir, 'org.json'),
      path.join(org, 'tool-gateway.key'),
      path.join(org, 'tool-gateway.json'),
      path.join(org, 'tool-env.json'),
      path.join(org, 'connections.key'),
      path.join(org, 'connections.json'),
      path.join(org, 'tool-signins.json'),
      path.join(org, 'tokens.json'),
      path.join(org, 'fleet-tokens.json'),
      path.join(org, 'overdb-connections.json'),
      path.join(dataDir, 'services', 'machine-secrets.json'),
    ],
    // The folders deploy/entrypoint.sh shares with the worker's group.
    writable: [home, ...SHARED_DATA_DIRS.map((d) => path.join(dataDir, d))],
  };
}

/// Turn workers-as-their-own-user on for this server, after checking it can
/// work: the setting, the host, the server's capabilities, then a probe run
/// as the worker. Returns the lines to log, and ok: false when the server
/// should not start (the operator asked for it and it can't be had).
export async function enableWorkerUser(opts: {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  home: string;
  cli?: string;
  /// The server's own uid; tests pass one so the host running them doesn't matter.
  serverUid?: number;
  readStatus?: () => string;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  exec?: ExecFile;
}): Promise<{ ok: boolean; lines: string[] }> {
  const parsed = workerUserFrom(opts.env, 'serverUid' in opts ? opts.serverUid : process.getuid?.());
  if (parsed === undefined) {
    setActiveWorkerUser(null);
    return { ok: true, lines: [] };
  }
  if ('error' in parsed) return { ok: false, lines: [parsed.error] };
  if ((opts.platform ?? process.platform) !== 'linux') return { ok: false, lines: ['OVERCLI_WORKER_UID only works on Linux. Unset it to run workers as the server.'] };
  if (!(opts.exists ?? fs.existsSync)(SETPRIV)) return { ok: false, lines: [`OVERCLI_WORKER_UID needs ${SETPRIV} (util-linux), which isn't installed.`] };
  const status = (opts.readStatus ?? (() => fs.readFileSync('/proc/self/status', 'utf8')))();
  const missing = missingServerCaps(effectiveCaps(status));
  if (missing) {
    return { ok: false, lines: [`OVERCLI_WORKER_UID is set, but the server can't switch user: it lacks ${missing}. In Docker, start the container as root (user: "0") and let the image's entrypoint hand the server those capabilities. See deploy/docs/security.md.`] };
  }
  const probe = await runWorkerProbe(parsed, { ...probeTargets(opts.dataDir, opts.home), serverPid: process.pid, cli: opts.cli }, opts.exec);
  const lines = probe.lines.map((l) => `worker user ${parsed.uid}: ${l}`);
  if (!probe.ok) return { ok: false, lines: [...lines, 'OVERCLI_WORKER_UID is set but the check above failed, so the server will not start. Fix it, or unset OVERCLI_WORKER_UID to run workers as the server.'] };
  setActiveWorkerUser(parsed);
  return { ok: true, lines: [...lines, `workers run as user ${parsed.uid} (group ${parsed.gid})`] };
}
