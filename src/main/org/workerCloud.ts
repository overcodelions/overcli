// Workers' cloud access: a role of their own, never the server's.
//
// The server reaches the cloud through the role it is hosted with (the EC2
// instance role, the ECS task role): Secrets Manager, Bedrock, its own stack.
// A worker's shell, and every tool its CLI starts, used to find that same role
// through the SDK's default chain, so a worker that ran `aws` could read every
// org secret. Now, on `overcli serve`:
//
//   - A worker's process starts with the server's cloud credentials stripped
//     (CLOUD_CREDENTIAL_VARS), the metadata service switched off for the SDKs,
//     and the shared config and credentials files pointed at an empty one, so
//     no profile on the box reaches the server's role either.
//   - The server assumes the role the worker is given (OVERGO_AWSWORKER_ROLE,
//     or OVERGO_AWSWORKER_ROLE_<NAME> for a worker set to <NAME>) and hands it
//     out through the container credentials endpoint the SDKs and the CLI
//     already know (AWS_CONTAINER_CREDENTIALS_FULL_URI), on loopback, behind a
//     token that names the run. Each request is judged when it arrives: a
//     worker moved to another role, or retired, gets the change at once.
//   - The session is named after the worker, so CloudTrail says which worker
//     made each call.
//   - A role that is the server's own is refused, whatever the setting says.
//
// The SDK env switch is not a wall: a worker can unset it. The deploy blocks
// the metadata service for the worker user at the host's firewall
// (deploy/aws/overcli.yaml), which is.
//
// The model is separate: Claude on Bedrock goes through bedrockProxy.ts, signed
// with the server's role, so a worker's data role needs no Bedrock access.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const WORKER_ROLE_SECRET = 'OVERGO_AWSWORKER_ROLE';
const NAMED_ROLE_SECRET = /^OVERGO_AWSWORKER_ROLE_([A-Z0-9]{1,30})$/;
/// A worker's `cloudRole` that gives it no cloud access at all.
export const NO_CLOUD_ROLE = 'none';
/// What the console calls the role from OVERGO_AWSWORKER_ROLE.
export const DEFAULT_CLOUD_ROLE = 'default';

/// The names an admin may set on Setup → Secrets for worker roles.
export function isWorkerRoleSecret(name: string): boolean {
  return name === WORKER_ROLE_SECRET || NAMED_ROLE_SECRET.test(name);
}

/// The secret holding a worker's role ARN: the default one when it names
/// none, null when it is set to no cloud access.
export function roleSecretFor(cloudRole: string | undefined): string | null {
  const r = cloudRole?.trim();
  if (!r || r.toLowerCase() === DEFAULT_CLOUD_ROLE) return WORKER_ROLE_SECRET;
  if (r.toLowerCase() === NO_CLOUD_ROLE) return null;
  return `${WORKER_ROLE_SECRET}_${r.toUpperCase()}`;
}

/// A `cloudRole` as given in a patch: null to clear it (back to the default),
/// or the name to keep, or why it can't be one.
export function normalizeCloudRole(input: unknown): { ok: true; role: string | null } | { ok: false; error: string } {
  if (input === null || input === undefined || input === '' || String(input).toLowerCase() === DEFAULT_CLOUD_ROLE) return { ok: true, role: null };
  const r = String(input).trim();
  if (r.toLowerCase() === NO_CLOUD_ROLE) return { ok: true, role: NO_CLOUD_ROLE };
  if (!/^[A-Za-z0-9]{1,30}$/.test(r)) return { ok: false, error: 'A cloud role is a short name of letters and digits, like QA, matching a secret OVERGO_AWSWORKER_ROLE_QA.' };
  return { ok: true, role: r.toUpperCase() };
}

export interface CloudRoleChoice {
  /// `default`, or the <NAME> of OVERGO_AWSWORKER_ROLE_<NAME>.
  name: string;
  secret: string;
  arn: string;
}

/// The worker roles set up on this server, the default first.
export function cloudRoleChoices(env: NodeJS.ProcessEnv): CloudRoleChoice[] {
  const out: CloudRoleChoice[] = [];
  const def = env[WORKER_ROLE_SECRET]?.trim();
  if (def) out.push({ name: DEFAULT_CLOUD_ROLE, secret: WORKER_ROLE_SECRET, arn: def });
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    const m = NAMED_ROLE_SECRET.exec(k);
    if (m && v?.trim()) out.push({ name: m[1], secret: k, arn: v.trim() });
  }
  return out;
}

const ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]{1,64})$/;

/// An IAM role ARN's account and role name, or null when it isn't one.
export function parseRoleArn(arn: string): { account: string; name: string } | null {
  const m = ROLE_ARN.exec(arn.trim());
  return m ? { account: m[1], name: m[2] } : null;
}

/// The role behind a caller identity ARN (`…:assumed-role/<role>/<session>`
/// or `…:role/<role>`), or undefined when it is a user or unknown.
export function roleOfIdentity(arn: string | undefined): { account: string; name: string } | undefined {
  if (!arn) return undefined;
  const assumed = /^arn:aws(?:-[a-z]+)*:sts::(\d{12}):assumed-role\/([\w+=,.@-]{1,64})\/[^/]+$/.exec(arn);
  if (assumed) return { account: assumed[1], name: assumed[2] };
  return parseRoleArn(arn) ?? undefined;
}

/// The session name CloudTrail shows: the worker's name, in the characters
/// a session name may hold.
export function sessionNameFor(worker: string): string {
  const clean = worker.replace(/[^\w+=,.@-]+/g, '-').replace(/^-+|-+$/g, '') || 'worker';
  return `overgo-${clean}`.slice(0, 64);
}

/// What in an environment hands out the server's own cloud identity.
export const CLOUD_CREDENTIAL_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
];

/// `env` with the server's cloud identity taken out, and the SDKs told not to
/// look for it: no metadata service, and the config files pointed at an empty
/// one (`emptyConfig`), so a profile in ~/.aws reaches nothing. The worker
/// role secrets go too; a worker has no use for the other roles' ARNs.
export function lockedCloudEnv(env: NodeJS.ProcessEnv, emptyConfig: string): NodeJS.ProcessEnv {
  const drop = new Set(CLOUD_CREDENTIAL_VARS);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (drop.has(k) || isWorkerRoleSecret(k)) continue;
    out[k] = v;
  }
  out.AWS_EC2_METADATA_DISABLED = 'true';
  out.AWS_CONFIG_FILE = emptyConfig;
  out.AWS_SHARED_CREDENTIALS_FILE = emptyConfig;
  return out;
}

/// The empty config file `lockedCloudEnv` points at: the region only, so a
/// tool that reads the file for one still finds it. Readable by the worker.
export function writeEmptyCloudConfig(dir: string, region: string | undefined): string {
  const file = path.join(dir, 'worker-cloud-config');
  const safeRegion = region && /^[a-z0-9-]{1,30}$/.test(region) ? region : undefined;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `# Written by overcli: workers get their cloud role from the server, not from a profile.\n[default]\n${safeRegion ? `region = ${safeRegion}\n` : ''}`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  return file;
}

/// Variables in a saved tool's own settings that pick its cloud identity: an
/// admin chose them, so the tool keeps them.
const EXPLICIT_CLOUD = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE'];

/// The env a saved tool starts with for a worker's run (runToolRelay.ts).
/// Those tools run as the server, so without this they would use the
/// server's role. They get the worker's role instead, like its shell does,
/// unless the tool is one of the server's own (`serverTools`: overdb and
/// test-systems, which act for the server) or its saved settings name the
/// credentials it uses.
export function relayToolCloudEnv(
  tool: string,
  env: Record<string, string>,
  toolEnv: Record<string, string>,
  opts: { serverTools: readonly string[]; emptyConfig: string; worker: Record<string, string> },
): Record<string, string> {
  if (opts.serverTools.includes(tool)) return env;
  if (EXPLICIT_CLOUD.some((k) => toolEnv[k]?.trim())) return env;
  const locked = lockedCloudEnv(env, opts.emptyConfig);
  return { ...(Object.fromEntries(Object.entries(locked).filter((e): e is [string, string] => typeof e[1] === 'string'))), ...opts.worker };
}

export interface CloudCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface WorkerCloudDeps {
  /// The worker a run's conversation belongs to, and the role it is set to.
  workerFor(conversationId: string): { name: string; cloudRole?: string } | undefined;
  /// Where the role secrets are read from: the server's environment.
  env(): NodeJS.ProcessEnv;
  /// Assume `arn` as the server, under `sessionName`.
  assume(arn: string, sessionName: string): Promise<CloudCredentials>;
  /// The server's own identity ARN (sts:GetCallerIdentity), to refuse its role.
  identity(): Promise<string | undefined>;
  log(message: string): void;
  now?(): number;
}

type Answer = { status: number; body: Record<string, unknown> };

/// Credentials are handed out until this close to their end, then renewed.
const RENEW_MS = 10 * 60_000;

/// Serves each worker run its role's credentials, on loopback.
export class WorkerCloudBroker {
  private readonly key = randomBytes(32);
  private server: http.Server | null = null;
  private port = 0;
  private readonly cache = new Map<string, { pending?: Promise<CloudCredentials>; creds?: CloudCredentials }>();
  private hosting: Promise<{ account: string; name: string } | undefined> | null = null;

  constructor(private readonly deps: WorkerCloudDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET') return send(res, { status: 405, body: { code: 'MethodNotAllowed', message: 'GET only.' } });
      const auth = req.headers.authorization;
      void this.answer(typeof auth === 'string' ? auth : '').then((a) => send(res, a), (err) => send(res, { status: 500, body: { code: 'InternalError', message: err instanceof Error ? err.message : String(err) } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /// The token that names a run: its conversation, and the server's MAC of it.
  tokenFor(conversationId: string): string {
    const id = Buffer.from(conversationId).toString('base64url');
    return `${id}.${createHmac('sha256', this.key).update(id).digest('base64url')}`;
  }

  private conversationOf(token: string): string | undefined {
    const [id, mac] = token.split('.');
    if (!id || !mac) return undefined;
    const want = Buffer.from(createHmac('sha256', this.key).update(id).digest('base64url'));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    return Buffer.from(id, 'base64url').toString();
  }

  /// What a run's process needs to reach its worker's role. Empty before
  /// `start`.
  envFor(conversationId: string): Record<string, string> {
    if (!this.server) return {};
    return {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${this.port}/credentials`,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: this.tokenFor(conversationId),
    };
  }

  private hostingRole(): Promise<{ account: string; name: string } | undefined> {
    if (!this.hosting) {
      this.hosting = this.deps.identity().then(roleOfIdentity, (err) => {
        this.hosting = null;
        throw err;
      });
    }
    return this.hosting;
  }

  /// The role a worker gets, or why none. Exposed for the console.
  async roleFor(worker: { name: string; cloudRole?: string }): Promise<{ ok: true; arn: string; secret: string } | { ok: false; why: string }> {
    const secret = roleSecretFor(worker.cloudRole);
    if (!secret) return { ok: false, why: `${worker.name} is set to no cloud access.` };
    const arn = this.deps.env()[secret]?.trim();
    if (!arn) return { ok: false, why: `${worker.name} has no cloud role: ${secret} is not set on Setup → Secrets.` };
    const role = parseRoleArn(arn);
    if (!role) return { ok: false, why: `${secret} is not an IAM role ARN (arn:aws:iam::<account>:role/<name>).` };
    let hosting: { account: string; name: string } | undefined;
    try {
      hosting = await this.hostingRole();
    } catch (err) {
      return { ok: false, why: `The server could not check its own identity, so it hands out no role: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (hosting && hosting.name === role.name && hosting.account === role.account) {
      return { ok: false, why: `${secret} names the role this server is hosted with. Workers never get that one: give them a role of their own.` };
    }
    return { ok: true, arn, secret };
  }

  /// One credentials request, judged when it arrives.
  async answer(token: string): Promise<Answer> {
    const conversationId = this.conversationOf(token.trim());
    if (!conversationId) return { status: 403, body: { code: 'AccessDenied', message: 'Not a token this server gave out.' } };
    const worker = this.deps.workerFor(conversationId);
    if (!worker) return { status: 403, body: { code: 'AccessDenied', message: 'Only a worker\'s run gets a cloud role, and this is not one.' } };
    const role = await this.roleFor(worker);
    if (!role.ok) return { status: 403, body: { code: 'AccessDenied', message: role.why } };
    const session = sessionNameFor(worker.name);
    const key = `${role.arn}\n${session}`;
    const held = this.cache.get(key);
    let creds: CloudCredentials;
    try {
      if (held?.creds && held.creds.expiration.getTime() - this.now() > RENEW_MS) creds = held.creds;
      else if (held?.pending) creds = await held.pending;
      else {
        const entry: { pending?: Promise<CloudCredentials>; creds?: CloudCredentials } = {};
        entry.pending = this.deps.assume(role.arn, session);
        this.cache.set(key, entry);
        try {
          creds = await entry.pending;
        } catch (err) {
          this.cache.delete(key);
          throw err;
        }
        entry.creds = creds;
        delete entry.pending;
        this.deps.log(`worker-cloud: ${worker.name} took ${role.secret} (${role.arn}) as ${session}`);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.deps.log(`worker-cloud: ${worker.name} could not take ${role.secret} (${role.arn}): ${why}`);
      return { status: 403, body: { code: 'AccessDenied', message: `The server could not assume ${role.secret} for ${worker.name}: ${why}` } };
    }
    return {
      status: 200,
      body: { AccessKeyId: creds.accessKeyId, SecretAccessKey: creds.secretAccessKey, Token: creds.sessionToken, Expiration: creds.expiration.toISOString(), RoleArn: role.arn },
    };
  }
}

function send(res: http.ServerResponse, a: Answer): void {
  res.writeHead(a.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(a.body));
}
