// Services the machine runs, as opposed to services a checkout runs.
//
// A project's services come and go with its worktrees; its database usually
// doesn't. mariadb, redis and memcached were installed once, with brew or apt
// or an installer, and are started by whatever the OS uses to start things.
// When something is off — the app can't connect, the cache holds yesterday's
// data — the fix is a start, a restart, or a flush, and today that means
// remembering which of `brew services`, `systemctl` or `Get-Service` this
// machine speaks.
//
// So this speaks all three, and asks for nothing it can't get quietly: no sudo
// prompt, no UAC dialog. When the OS says no, the answer is a sentence the pane
// can show, not a silent failure.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type MachineServiceManager = 'brew' | 'systemd' | 'systemd-user' | 'windows';

export type MachineServiceStatus = 'running' | 'stopped' | 'error' | 'unknown';

export interface MachineService {
  /// Stable across refreshes — `brew:mariadb`, `systemd:postgresql@16-main`.
  id: string;
  /// What the manager calls it, and what it wants back to control it.
  name: string;
  /// The friendlier label Windows keeps alongside the service name.
  displayName?: string;
  manager: MachineServiceManager;
  status: MachineServiceStatus;
  /// Conventional port when known — a hint for the pane and for `clearCache`,
  /// not a promise; the config file may say otherwise.
  port?: number;
  /// What "clear" means for it, if anything.
  cache?: 'redis' | 'memcached';
  /// Start/stop needs rights we can't get non-interactively (system systemd
  /// units, Windows services). The UI says so up front rather than letting a
  /// button fail.
  needsAdmin?: boolean;
  user?: string;
  pid?: number;
}

export type ControlAction = 'start' | 'stop' | 'restart';

export type ControlResult = { ok: true } | { ok: false; reason: string };

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/// `execFile`, promised, and swappable — tests never shell out. Rejections
/// carry `code` (ENOENT when the program is missing) and `stderr` like Node's.
export type ExecFn = (
  file: string,
  args: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

const LIST_TIMEOUT_MS = 15_000;
/// Stopping a database can take a while to flush; a minute is generous
/// without leaving the button spinning forever.
const CONTROL_TIMEOUT_MS = 60_000;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts?.timeout ?? LIST_TIMEOUT_MS, env: opts?.env, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

// ---------------------------------------------------------------------------
// What we know about the usual suspects

interface Known {
  port?: number;
  cache?: 'redis' | 'memcached';
}

/// Keyed by the normalised name (see `serviceKey`). This doubles as the
/// allowlist for systemd and Windows, where listing everything the OS runs
/// would bury the four things a developer cares about under two hundred they
/// don't. Brew is not filtered: everything in `brew services` was installed on
/// purpose.
const KNOWN: Record<string, Known> = {
  mariadb: { port: 3306 },
  mysql: { port: 3306 },
  mysqld: { port: 3306 },
  'percona-server': { port: 3306 },
  postgresql: { port: 5432 },
  postgres: { port: 5432 },
  redis: { port: 6379, cache: 'redis' },
  'redis-server': { port: 6379, cache: 'redis' },
  'redis-stack-server': { port: 6379, cache: 'redis' },
  valkey: { port: 6379, cache: 'redis' },
  'valkey-server': { port: 6379, cache: 'redis' },
  memcached: { port: 11211, cache: 'memcached' },
  mongod: { port: 27017 },
  mongodb: { port: 27017 },
  'mongodb-community': { port: 27017 },
  rabbitmq: { port: 5672 },
  'rabbitmq-server': { port: 5672 },
  elasticsearch: { port: 9200 },
  'elasticsearch-full': { port: 9200 },
  'elasticsearch-service': { port: 9200 },
  opensearch: { port: 9200 },
  nginx: { port: 80 },
  apache2: { port: 80 },
  httpd: { port: 80 },
  docker: {},
  'com.docker': {},
  minio: { port: 9000 },
  kafka: { port: 9092 },
  zookeeper: { port: 2181 },
  'clickhouse-server': { port: 8123 },
  clickhouse: { port: 8123 },
};

/// Brew builds nginx and httpd to listen on 8080 so they run without root;
/// distro packages and Windows installers take 80.
const BREW_PORTS: Record<string, number> = { nginx: 8080, httpd: 8080 };

/// Reduces the many spellings of one daemon to the key above:
/// `postgresql@16-main.service`, `postgresql-x64-16`, `MySQL80`, `mysql@8.0`.
export function serviceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.service$/, '')
    .replace(/@.*$/, '')
    .replace(/-x(?:64|86)(?=-|$)/, '')
    .replace(/[-_]?\d+(?:\.\d+)*$/, '');
}

function known(name: string): Known | undefined {
  return KNOWN[serviceKey(name)];
}

function describe(name: string, manager: MachineServiceManager): Pick<MachineService, 'port' | 'cache'> {
  const hit = known(name);
  const port = manager === 'brew' ? (BREW_PORTS[serviceKey(name)] ?? hit?.port) : hit?.port;
  return { ...(port !== undefined ? { port } : {}), ...(hit?.cache ? { cache: hit.cache } : {}) };
}

function parseJsonArray(json: string): unknown[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return parsed;
  // PowerShell's ConvertTo-Json unwraps a one-element pipeline into an object.
  return parsed && typeof parsed === 'object' ? [parsed] : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

// ---------------------------------------------------------------------------
// brew

function brewStatus(status: string | undefined): MachineServiceStatus {
  switch (status) {
    case 'started':
      return 'running';
    // `none` is installed but never started; `scheduled` is a login item that
    // isn't up yet. Neither is running, and both start the same way.
    case 'stopped':
    case 'none':
    case 'scheduled':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

/// `brew services list --json`.
export function parseBrewServices(json: string): MachineService[] {
  const out: MachineService[] = [];
  for (const row of parseJsonArray(json)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = str(r.name);
    if (!name) continue;
    const pid = typeof r.pid === 'number' ? r.pid : undefined;
    const user = str(r.user);
    out.push({
      id: `brew:${name}`,
      name,
      manager: 'brew',
      status: brewStatus(str(r.status)),
      ...describe(name, 'brew'),
      ...(user ? { user } : {}),
      ...(pid !== undefined ? { pid } : {}),
    });
  }
  return out;
}

const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'];

/// Electron launched from Finder inherits launchd's PATH, which has no brew on
/// it — so the well-known install locations come first and PATH is the last
/// resort.
export function findBrew(exists: (p: string) => boolean = fs.existsSync): string {
  return BREW_CANDIDATES.find((p) => exists(p)) ?? 'brew';
}

/// Brew's own subcommands shell out to things beside it (and would otherwise
/// stop to auto-update in the middle of a button press).
function brewEnv(brew: string): NodeJS.ProcessEnv {
  const dir = path.isAbsolute(brew) ? path.dirname(brew) : undefined;
  return {
    ...process.env,
    HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_ANALYTICS: '1',
    ...(dir ? { PATH: [dir, process.env.PATH].filter(Boolean).join(path.delimiter) } : {}),
  };
}

// ---------------------------------------------------------------------------
// systemd

function systemdStatus(active: string | undefined, sub: string | undefined): MachineServiceStatus {
  if (active === 'active') return sub === 'exited' ? 'stopped' : 'running';
  if (active === 'failed') return 'error';
  if (active === 'inactive') return 'stopped';
  return 'unknown';
}

function systemdService(unit: string, load: string | undefined, active: string | undefined, sub: string | undefined, user: boolean): MachineService | undefined {
  if (!unit.endsWith('.service') || load === 'not-found') return undefined;
  if (!known(unit)) return undefined;
  const name = unit.replace(/\.service$/, '');
  const manager: MachineServiceManager = user ? 'systemd-user' : 'systemd';
  return {
    id: `${manager}:${name}`,
    name,
    manager,
    status: systemdStatus(active, sub),
    ...describe(name, manager),
    ...(user ? {} : { needsAdmin: true }),
  };
}

/// `systemctl [--user] list-units --type=service --all --output=json`,
/// filtered to the allowlist.
export function parseSystemdUnits(json: string, user: boolean): MachineService[] {
  const out: MachineService[] = [];
  for (const row of parseJsonArray(json)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const unit = str(r.unit);
    if (!unit) continue;
    const svc = systemdService(unit, str(r.load), str(r.active), str(r.sub), user);
    if (svc) out.push(svc);
  }
  return out;
}

/// `systemctl list-units --type=service --all --no-legend --plain`, for
/// systemd older than 246, which has no JSON output. Columns are UNIT LOAD
/// ACTIVE SUB DESCRIPTION; failed units may carry a leading `●`.
export function parseSystemdPlain(text: string, user: boolean): MachineService[] {
  const out: MachineService[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.replace(/^\s*[●*]\s*/, '').trim().split(/\s+/);
    if (cols.length < 4 || !cols[0]) continue;
    const svc = systemdService(cols[0], cols[1], cols[2], cols[3], user);
    if (svc) out.push(svc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Windows

/// `ServiceControllerStatus` serialises as its number unless the enum was
/// stringified first, and which one you get depends on the PowerShell version.
function windowsStatus(status: unknown): MachineServiceStatus {
  const s = typeof status === 'string' ? status.toLowerCase() : status;
  switch (s) {
    case 4:
    case 'running':
      return 'running';
    case 1:
    case 'stopped':
    case 7:
    case 'paused':
      return 'stopped';
    default:
      return 'unknown';
  }
}

/// PowerShell `Get-Service | Select-Object Name,DisplayName,Status,StartType |
/// ConvertTo-Json`, filtered to the allowlist.
export function parseWindowsServices(json: string): MachineService[] {
  const out: MachineService[] = [];
  for (const row of parseJsonArray(json)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = str(r.Name);
    if (!name || !known(name)) continue;
    const displayName = str(r.DisplayName);
    out.push({
      id: `windows:${name}`,
      name,
      ...(displayName ? { displayName } : {}),
      manager: 'windows',
      status: windowsStatus(r.Status),
      ...describe(name, 'windows'),
      needsAdmin: true,
    });
  }
  return out;
}

const WINDOWS_LIST_SCRIPT = 'Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress';

// ---------------------------------------------------------------------------
// Listing

export interface ListOptions {
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  exists?: (p: string) => boolean;
}

async function listBrew(exec: ExecFn, exists: (p: string) => boolean, requireInstalled: boolean): Promise<MachineService[]> {
  const brew = findBrew(exists);
  // On Linux brew is the exception; don't go hunting PATH for it.
  if (requireInstalled && brew === 'brew') return [];
  try {
    const { stdout } = await exec(brew, ['services', 'list', '--json'], { env: brewEnv(brew) });
    return parseBrewServices(stdout);
  } catch {
    return [];
  }
}

async function listSystemd(exec: ExecFn, user: boolean): Promise<MachineService[]> {
  const scope = user ? ['--user'] : [];
  const base = [...scope, 'list-units', '--type=service', '--all', '--no-pager'];
  try {
    const { stdout } = await exec('systemctl', [...base, '--output=json']);
    return parseSystemdUnits(stdout, user);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
  }
  try {
    const { stdout } = await exec('systemctl', [...base, '--no-legend', '--plain']);
    return parseSystemdPlain(stdout, user);
  } catch {
    // No systemd, or no user session bus — neither is worth an error row.
    return [];
  }
}

async function listWindows(exec: ExecFn): Promise<MachineService[]> {
  try {
    const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_SCRIPT]);
    return parseWindowsServices(stdout);
  } catch {
    return [];
  }
}

/// Everything this machine's service managers know about, as far as they'll
/// say without elevation. Never throws: a missing manager is an empty list.
export async function listMachineServices(opts: ListOptions = {}): Promise<MachineService[]> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const exists = opts.exists ?? fs.existsSync;
  switch (platform) {
    case 'darwin':
      return listBrew(exec, exists, false);
    case 'linux': {
      const [brew, system, user] = await Promise.all([
        listBrew(exec, exists, true),
        listSystemd(exec, false),
        listSystemd(exec, true),
      ]);
      return [...brew, ...system, ...user];
    }
    case 'win32':
      return listWindows(exec);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Control

export interface ControlOptions {
  exec?: ExecFn;
  exists?: (p: string) => boolean;
}

/// Service names reach a command line (and, on Windows, a PowerShell string),
/// so anything outside the characters real service names use is refused rather
/// than escaped.
const SAFE_NAME = /^[\w.@:+-]+$/;

const ACCESS_DENIED = /access (is )?denied|interactive authentication required|permission denied|PermissionDenied|cannot open .* service|not permitted/i;

const WINDOWS_VERBS: Record<ControlAction, string> = {
  start: 'Start-Service',
  stop: 'Stop-Service',
  restart: 'Restart-Service',
};

function failureText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return stderr || message;
}

/// The command a control action runs. Exported so the tests can say exactly
/// what would be run without running it.
export function controlCommand(
  service: Pick<MachineService, 'name' | 'manager'>,
  action: ControlAction,
  exists: (p: string) => boolean = fs.existsSync,
): { file: string; args: string[]; env?: NodeJS.ProcessEnv } {
  switch (service.manager) {
    case 'brew': {
      const brew = findBrew(exists);
      return { file: brew, args: ['services', action, service.name], env: brewEnv(brew) };
    }
    // --no-ask-password: without it polkit may pop an agent dialog, or hang
    // waiting on a terminal that isn't there.
    case 'systemd':
      return { file: 'systemctl', args: ['--no-ask-password', action, service.name] };
    case 'systemd-user':
      return { file: 'systemctl', args: ['--user', action, service.name] };
    case 'windows':
      return {
        file: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', `${WINDOWS_VERBS[action]} -Name '${service.name}' -ErrorAction Stop`],
      };
  }
}

/// Start, stop or restart. Elevation is never requested: when the OS refuses,
/// the reason says what to do instead.
export async function controlMachineService(
  service: Pick<MachineService, 'name' | 'manager'>,
  action: ControlAction,
  opts: ControlOptions = {},
): Promise<ControlResult> {
  if (!SAFE_NAME.test(service.name)) return { ok: false, reason: `"${service.name}" is not a service name overcli will run` };
  const exec = opts.exec ?? defaultExec;
  const { file, args, env } = controlCommand(service, action, opts.exists);
  try {
    await exec(file, args, { timeout: CONTROL_TIMEOUT_MS, ...(env ? { env } : {}) });
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, reason: `${path.basename(file)} is not installed or not on PATH` };
    }
    const text = failureText(err);
    if (ACCESS_DENIED.test(text)) {
      if (service.manager === 'windows') {
        return { ok: false, reason: `Windows needs administrator rights to ${action} ${service.name} — run overcli as administrator, or use Services (services.msc)` };
      }
      if (service.manager === 'systemd') {
        return { ok: false, reason: `${service.name} is a system service; ${action} it from a terminal with: sudo systemctl ${action} ${service.name}` };
      }
      return { ok: false, reason: `permission denied: ${text}` };
    }
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? text;
    return { ok: false, reason: `${action} ${service.name} failed: ${firstLine.trim()}` };
  }
}

// ---------------------------------------------------------------------------
// Clearing caches

export interface ClearOptions {
  /// How long to wait for a connection and a reply. Injectable so the timeout
  /// test doesn't take three seconds.
  timeoutMs?: number;
}

/// Flushes a redis or memcached over a plain socket. No redis-cli or nc: those
/// are one more thing to be missing, and both protocols are a single line.
export function clearCache(kind: 'redis' | 'memcached', port: number, host = '127.0.0.1', opts: ClearOptions = {}): Promise<ControlResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ ok: false, reason: `${port} is not a port` });
  }
  const timeoutMs = opts.timeoutMs ?? 3000;
  const request = kind === 'redis' ? '*1\r\n$8\r\nFLUSHALL\r\n' : 'flush_all\r\n';

  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = net.createConnection({ port, host });

    const finish = (result: ControlResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      const secs = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 100) / 10}s` : `${timeoutMs}ms`;
      finish({ ok: false, reason: `no answer from ${kind} on :${port} within ${secs}` });
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\r\n');
      if (end === -1) return;
      finish(interpretReply(kind, port, buffer.slice(0, end)));
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') finish({ ok: false, reason: `nothing listening on :${port}` });
      else finish({ ok: false, reason: `could not reach ${kind} on :${port}: ${err.message}` });
    });
    socket.on('close', () => finish({ ok: false, reason: `${kind} on :${port} closed the connection without answering` }));
  });
}

function interpretReply(kind: 'redis' | 'memcached', port: number, line: string): ControlResult {
  if (kind === 'redis') {
    if (line === '+OK') return { ok: true };
    if (line.startsWith('-NOAUTH')) return { ok: false, reason: `redis on :${port} requires a password; flush it with redis-cli -a` };
    if (line.startsWith('-')) return { ok: false, reason: `redis on :${port} refused: ${line.slice(1)}` };
    return { ok: false, reason: `unexpected reply from :${port} — is it redis? (${line.slice(0, 80)})` };
  }
  if (line === 'OK') return { ok: true };
  if (/^(ERROR|CLIENT_ERROR|SERVER_ERROR)/.test(line) || line.startsWith('-')) {
    return { ok: false, reason: `memcached on :${port} refused: ${line.replace(/^-/, '')}` };
  }
  return { ok: false, reason: `unexpected reply from :${port} — is it memcached? (${line.slice(0, 80)})` };
}
