// A database connection overdb publishes to the org, through this app.
//
// overdb owns the format (its src/shared/hostedConnection.ts); this is the
// reading end, kept in step the way handoff.ts is with overdb's handoffs.
// The record says where a database is and how the SERVER signs in to it —
// its own AWS role, or a password an admin types into the console — and
// never carries a secret. overgo keeps approved records in
// `org/overdb-connections.json`, which overdb's headless MCP server reads
// as it is (`node dist/mcp/headless.js --connections FILE`).
//
// overdb drops each one into `~/.overcli/inbox/connections/`, a folder of
// its own: the handoff inbox rejects kinds it does not know, and an older
// overcli must not file a connection under "rejected". overdb offers to
// publish only once that folder exists, so this app creating it is the
// whole of the handshake.

export const OVERDB_FILE_VERSION = 1;
/// The tool workers reach overdb's databases through.
export const OVERDB_TOOL = 'overdb';
export const CONNECTION_PUSH_KIND = 'overdb-connection';
/// A record is a few hundred bytes. Anything near this is not one.
/// A record is a few hundred bytes; its context's database map can run to a
/// few hundred kilobytes. Anything near this is neither.
export const CONNECTION_PUSH_MAX_BYTES = 4 * 1024 * 1024;

export type OverdbEngine = 'postgres' | 'mysql' | 'dynamodb';
export type OverdbEnv = 'local' | 'dev' | 'sandbox' | 'staging' | 'prod' | 'other';
export type OverdbSsl = 'disable' | 'require' | 'verify-ca' | 'verify-full';

const ENGINES: readonly OverdbEngine[] = ['postgres', 'mysql', 'dynamodb'];
const ENVS: readonly OverdbEnv[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];
const SSL: readonly OverdbSsl[] = ['disable', 'require', 'verify-ca', 'verify-full'];
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
const TEXT_FIELDS = ['variant', 'host', 'database', 'user', 'sslRootCert', 'defaultSchema', 'tableFilter', 'region'] as const;

export type OverdbCredential = { source: 'none' } | { source: 'aws-iam' } | { source: 'secret'; env: string };

export interface OverdbConnection {
  id: string;
  name: string;
  env: OverdbEnv;
  engine: OverdbEngine;
  variant?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: OverdbSsl;
  sslRootCert?: string;
  defaultSchema?: string;
  tableFilter?: string;
  region?: string;
  credential: OverdbCredential;
  /// What agents are told about this database: its tenancy rule (with the
  /// columns queries filter on), notes, and overdb's map of the code. Read
  /// by overdb's headless server as it is; carried, never interpreted here.
  context?: OverdbContext;
}

export interface OverdbMapTable {
  purpose: string;
  repo?: string;
  module?: string;
  values: Array<{ column: string; values: string[]; ref?: string }>;
  json: Array<{ column: string; shape: string; ref?: string }>;
  rules: Array<{ text: string; ref?: string }>;
}

export interface OverdbContext {
  tenant?: { schema: string; table: string; column: string; via: string[] };
  noTenant?: true;
  notes?: string;
  map?: {
    builtAt: string;
    schemas: Record<string, string>;
    tables: Record<string, OverdbMapTable>;
    links: Array<{ from: string; to: string; why: string; ref?: string }>;
  };
}

const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
const refOf = (o: Record<string, unknown>) => (text(o.ref, 500) ? { ref: o.ref } : {});

/// The same checks as overdb's parseHostedContext: a malformed part is
/// dropped, never the connection.
export function parseOverdbContext(raw: unknown): OverdbContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: OverdbContext = {};
  const t = r.tenant as Record<string, unknown> | undefined;
  if (t && text(t.schema, 200) && text(t.table, 200) && text(t.column, 200)) {
    const via = Array.isArray(t.via) ? t.via.filter((v): v is string => text(v, 200)).slice(0, 5) : [];
    out.tenant = { schema: t.schema, table: t.table, column: t.column, via };
  } else if (r.noTenant === true) out.noTenant = true;
  if (text(r.notes, 4000) && r.notes.trim()) out.notes = r.notes;
  const m = r.map as Record<string, unknown> | undefined;
  if (m && text(m.builtAt, 100) && m.tables && typeof m.tables === 'object') {
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
    const tables: Record<string, OverdbMapTable> = {};
    for (const [k, v] of Object.entries(m.tables as Record<string, unknown>).slice(0, 5000)) {
      const o = v as Record<string, unknown>;
      if (!o || typeof o !== 'object' || !text(o.purpose)) continue;
      tables[k] = {
        purpose: o.purpose,
        ...(text(o.repo, 200) ? { repo: o.repo } : {}),
        ...(text(o.module, 200) ? { module: o.module } : {}),
        values: arr(o.values).filter((x) => text(x.column, 200) && Array.isArray(x.values)).map((x) => ({ column: x.column as string, values: (x.values as unknown[]).filter((v): v is string => text(v, 200)).slice(0, 100), ...refOf(x) })),
        json: arr(o.json).filter((x) => text(x.column, 200) && text(x.shape)).map((x) => ({ column: x.column as string, shape: x.shape as string, ...refOf(x) })),
        rules: arr(o.rules).filter((x) => text(x.text)).map((x) => ({ text: x.text as string, ...refOf(x) })),
      };
    }
    const schemas = Object.fromEntries(Object.entries((m.schemas as Record<string, unknown>) ?? {}).filter((e): e is [string, string] => text(e[1], 200)));
    const links = arr(m.links).filter((x) => text(x.from, 300) && text(x.to, 300) && text(x.why)).slice(0, 20000).map((x) => ({ from: x.from as string, to: x.to as string, why: x.why as string, ...refOf(x) }));
    out.map = { builtAt: m.builtAt, schemas, tables, links };
  }
  return Object.keys(out).length ? out : undefined;
}

export interface OverdbConnectionsFile {
  version: typeof OVERDB_FILE_VERSION;
  connections: OverdbConnection[];
}

export interface ConnectionPush {
  version: typeof OVERDB_FILE_VERSION;
  kind: typeof CONNECTION_PUSH_KIND;
  id: string;
  createdAt: string;
  connection: OverdbConnection;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/// One record, checked field by field and rebuilt from what was checked —
/// a field this version does not know is dropped, not carried. The same
/// rules as overdb's parseHostedFile.
export function parseOverdbConnection(raw: unknown): { ok: true; connection: OverdbConnection } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the connection is not an object' };
  const r = raw as Record<string, unknown>;
  const label = str(r.name) ? r.name : 'the connection';
  const fail = (why: string) => ({ ok: false as const, reason: `${label}: ${why}` });
  if (!str(r.id) || !str(r.name)) return { ok: false, reason: `${label} needs an id and a name` };
  if (r.name.length > 100 || r.id.length > 100) return fail('id and name must be under 100 characters');
  if (!(ENGINES as readonly unknown[]).includes(r.engine)) return fail(`engine must be one of ${ENGINES.join(', ')}`);
  if (!(ENVS as readonly unknown[]).includes(r.env)) return fail(`env must be one of ${ENVS.join(', ')}`);
  if (r.engine !== 'dynamodb' && !str(r.host)) return fail('needs a host');
  if (r.engine === 'dynamodb' && !str(r.region)) return fail('needs a region');
  if (r.port !== undefined && !(Number.isInteger(r.port) && (r.port as number) > 0 && (r.port as number) < 65536)) {
    return fail('port must be a number from 1 to 65535');
  }
  if (r.ssl !== undefined && !(SSL as readonly unknown[]).includes(r.ssl)) return fail(`ssl must be one of ${SSL.join(', ')}`);
  for (const key of TEXT_FIELDS) {
    if (r[key] !== undefined && (typeof r[key] !== 'string' || (r[key] as string).length > 500)) return fail(`${key} must be text`);
  }
  const c = r.credential as Record<string, unknown> | undefined;
  let credential: OverdbCredential;
  if (c?.source === 'none' || c?.source === 'aws-iam') credential = { source: c.source };
  else if (c?.source === 'secret' && typeof c.env === 'string' && ENV_VAR_RE.test(c.env)) credential = { source: 'secret', env: c.env };
  else return fail('credential must be none, aws-iam, or a secret named by an environment variable');
  if (credential.source === 'aws-iam' && r.engine === 'dynamodb') return fail("DynamoDB signs in with the server's AWS role; use none");

  const connection: OverdbConnection = {
    id: r.id,
    name: r.name,
    env: r.env as OverdbEnv,
    engine: r.engine as OverdbEngine,
    ...(r.port !== undefined ? { port: r.port as number } : {}),
    ...(r.ssl !== undefined ? { ssl: r.ssl as OverdbSsl } : {}),
    credential,
  };
  const context = parseOverdbContext(r.context);
  if (context) connection.context = context;
  for (const key of TEXT_FIELDS) if (typeof r[key] === 'string' && r[key]) (connection as unknown as Record<string, unknown>)[key] = r[key];
  return { ok: true, connection };
}

export function parseConnectionPush(raw: unknown): { ok: true; push: ConnectionPush } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.kind !== CONNECTION_PUSH_KIND) return { ok: false, reason: `unknown kind ${JSON.stringify(r.kind)}` };
  if (r.version !== OVERDB_FILE_VERSION) return { ok: false, reason: `version ${String(r.version)}; this overcli reads version ${OVERDB_FILE_VERSION}` };
  if (!str(r.id) || r.id.length > 100) return { ok: false, reason: 'needs an id' };
  if (!str(r.createdAt) || Number.isNaN(Date.parse(r.createdAt))) return { ok: false, reason: 'needs a createdAt time' };
  const parsed = parseOverdbConnection(r.connection);
  if (!parsed.ok) return parsed;
  return { ok: true, push: { version: OVERDB_FILE_VERSION, kind: CONNECTION_PUSH_KIND, id: r.id, createdAt: r.createdAt, connection: parsed.connection } };
}

/// What the server needs before this connection can sign in, in a sentence.
export function overdbCredentialNote(c: OverdbConnection): string {
  switch (c.credential.source) {
    case 'aws-iam':
      return `Signs in as ${c.user ?? 'its user'} with an IAM token from this server's AWS role, which needs rds-db:connect for that user.`;
    case 'secret':
      return `Needs ${c.user ? `${c.user}'s` : 'the'} password, kept in ${c.credential.env} for the overdb tool only.`;
    case 'none':
      return c.engine === 'dynamodb' ? "Reads DynamoDB with this server's AWS role." : 'Signs in with no password.';
  }
}
