// Databases published from overdb — Setup → Databases.
//
// A connection someone published from overdb waits here until an admin
// finishes it. Finishing writes it into the connections file and
// (re)installs the overdb tool — overdb's headless MCP server, reading
// that file — with every finished connection's password in the tool's
// env. That env is the only place a password lives: the file, the offer
// and the audit log carry its variable's NAME.
//
// Its own module so the org service only hands off to it: the org service
// is where most server work lands, and this should merge in without
// touching it beyond a few lines.

import { randomUUID } from 'node:crypto';

import { canHire, isAdmin, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OVERDB_FILE_VERSION, OVERDB_TOOL, parseOverdbConnection, type OverdbConnection, type OverdbConnectionsFile } from '../../shared/overdbConnection';
import type { ToolInput } from './tools';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// A database connection published from overdb, waiting for an admin to
/// finish it: the password typed in, or the server's AWS role granted.
/// See src/shared/overdbConnection.ts.
export interface OverdbOffer {
  id: string;
  by: string;
  slackUserId?: string;
  at: number;
  connection: OverdbConnection;
}

/// One line of the overdb tool's query log.
export interface OverdbQuery {
  at: string;
  worker?: string;
  conversation?: string;
  tool: string;
  connection: string;
  ok: boolean;
  ms: number;
  sql?: string;
  params?: number;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

export { OVERDB_TOOL };
export const OVERDB_CONNECTIONS_FILE = 'overdb-connections.json';

/// What the org service passes in: its stores, and the overdb install.
export interface OverdbDeps {
  /// Database connections published from overdb, waiting for an admin.
  overdbOffers?: { load(): { offers: OverdbOffer[] }; save(value: { offers: OverdbOffer[] }): void };
  /// The finished ones, in the very file overdb's headless server reads.
  overdbConnections?: { load(): OverdbConnectionsFile; save(value: OverdbConnectionsFile): void };
  /// Where overdb's headless server is here (null: not installed), the
  /// connections file's path, and the overdb tool's env as installed —
  /// the passwords, which only the tool's own config holds.
  overdb?: { headlessPath(): string | null; connectionsFile(): string; toolEnv(): Record<string, string>; queryLogFile(): string; readQueryLog(): string };
  tools?: {
    install(input: ToolInput): { ok: true } | { ok: false; error: string };
  };
}

/// What it borrows from the org service: who may do what, the audit log, the clock.
export interface OverdbHost {
  policy(): OrgPolicy;
  record(caller: OrgCaller, what: string): void;
  now(): number;
}

export class OverdbOrg {
  constructor(
    private readonly deps: OverdbDeps,
    private readonly host: OverdbHost,
  ) {}

  private memoryOverdbOffers: OverdbOffer[] = [];
  private memoryOverdbFile: OverdbConnectionsFile = { version: OVERDB_FILE_VERSION, connections: [] };
  private loadOverdbOffers(): OverdbOffer[] {
    return this.deps.overdbOffers ? this.deps.overdbOffers.load().offers : this.memoryOverdbOffers;
  }
  private saveOverdbOffers(offers: OverdbOffer[]): void {
    if (this.deps.overdbOffers) this.deps.overdbOffers.save({ offers });
    else this.memoryOverdbOffers = offers;
  }
  private loadOverdbFile(): OverdbConnectionsFile {
    return this.deps.overdbConnections ? this.deps.overdbConnections.load() : this.memoryOverdbFile;
  }
  private saveOverdbFile(file: OverdbConnectionsFile): void {
    if (this.deps.overdbConnections) this.deps.overdbConnections.save(file);
    else this.memoryOverdbFile = file;
  }

  /// The env the overdb tool should have for these connections: the
  /// passwords they name, and nothing a removed connection left behind.
  private overdbEnv(connections: OverdbConnection[], current: Record<string, string>): Record<string, string> {
    const wanted = new Set(connections.flatMap((c) => (c.credential.source === 'secret' ? [c.credential.env] : [])));
    return Object.fromEntries(Object.entries(current).filter(([k]) => wanted.has(k)));
  }

  private installOverdb(connections: OverdbConnection[], env: Record<string, string>): Result {
    const overdb = this.deps.overdb;
    const tools = this.deps.tools;
    if (!overdb || !tools) return { ok: false, error: 'Databases cannot be managed on this server.' };
    const headless = overdb.headlessPath();
    if (!headless) return { ok: false, error: "overdb isn't installed on this server. Set OVERDB_HEADLESS to the path of overdb's dist/mcp/headless.js." };
    return tools.install({
      name: OVERDB_TOOL,
      kind: 'command',
      command: 'node',
      args: [headless, '--connections', overdb.connectionsFile(), '--query-log', overdb.queryLogFile()],
      env: this.overdbEnv(connections, env),
    });
  }

  publishOverdbConnection(caller: OrgCaller, input: { connection: unknown }): Result<{ waiting: true }> {
    if (!canHire(this.host.policy(), caller) && !isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only people who may hire workers can publish a database.' };
    const parsed = parseOverdbConnection(input.connection);
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    const c = parsed.connection;
    const offer: OverdbOffer = { id: randomUUID(), by: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}), at: this.host.now(), connection: c };
    // The same person publishing the same connection again replaces what they sent.
    const same = (o: OverdbOffer) => o.connection.id === c.id && (caller.slackUserId ? o.slackUserId === caller.slackUserId : !o.slackUserId && o.by === caller.name);
    this.saveOverdbOffers([...this.loadOverdbOffers().filter((o) => !same(o)), offer].slice(-50));
    this.host.record(caller, `Published the ${c.env} database ${c.name} (${c.engine}) from overdb, for an admin to finish.`);
    return { ok: true, waiting: true };
  }

  overdbConnections(caller: OrgCaller): Result<{
    headless: string | null;
    offers: Array<OverdbOffer & { hasPassword: boolean; replaces: boolean }>;
    connections: Array<OverdbConnection & { hasPassword: boolean }>;
  }> {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const env = this.deps.overdb?.toolEnv() ?? {};
    const live = this.loadOverdbFile().connections;
    const hasPassword = (c: OverdbConnection) => c.credential.source !== 'secret' || Boolean(env[c.credential.env]);
    return {
      ok: true,
      headless: this.deps.overdb?.headlessPath() ?? null,
      offers: this.loadOverdbOffers()
        .slice()
        .reverse()
        .map((o) => ({ ...o, hasPassword: hasPassword(o.connection), replaces: live.some((c) => c.id === o.connection.id) })),
      connections: live.map((c) => ({ ...c, hasPassword: hasPassword(c) })),
    };
  }

  /// Finish a published connection. A password only travels like a tool's
  /// keys do (`secure`: TLS, a trusted proxy that saw https, or this
  /// machine), and goes straight into the tool's env.
  approveOverdbConnection(caller: OrgCaller, offerId: string, password: string | undefined, secure: boolean): Result {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const offer = this.loadOverdbOffers().find((o) => o.id === offerId);
    if (!offer) return { ok: false, error: 'No such database.' };
    const c = offer.connection;
    const file = this.loadOverdbFile();
    if (file.connections.some((x) => x.id !== c.id && x.name.toLowerCase() === c.name.toLowerCase())) {
      return { ok: false, error: `A different database called ${c.name} is already set up. Remove it first.` };
    }
    const env = { ...(this.deps.overdb?.toolEnv() ?? {}) };
    if (c.credential.source === 'secret') {
      const name = c.credential.env;
      if (file.connections.some((x) => x.id !== c.id && x.credential.source === 'secret' && x.credential.env === name)) {
        return { ok: false, error: `${name} already holds another database's password.` };
      }
      if (password) {
        if (!secure) return { ok: false, error: 'Passwords only travel over https, or to a server on this same machine.' };
        env[name] = password;
      } else if (!env[name]) {
        return { ok: false, error: `${c.name} needs its password.` };
      }
    }
    const next: OverdbConnectionsFile = { version: OVERDB_FILE_VERSION, connections: [...file.connections.filter((x) => x.id !== c.id), c] };
    const installed = this.installOverdb(next.connections, env);
    if (!installed.ok) return installed;
    this.saveOverdbFile(next);
    this.saveOverdbOffers(this.loadOverdbOffers().filter((o) => o.id !== offerId));
    this.host.record(caller, `Set up the ${c.env} database ${c.name} from ${offer.by}'s overdb for the ${OVERDB_TOOL} tool${password ? `, with its password in ${(c.credential as { env: string }).env}` : ''}.`);
    return { ok: true };
  }

  dismissOverdbOffer(caller: OrgCaller, offerId: string): Result {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const all = this.loadOverdbOffers();
    if (!all.some((o) => o.id === offerId)) return { ok: false, error: 'No such database.' };
    this.saveOverdbOffers(all.filter((o) => o.id !== offerId));
    return { ok: true };
  }

  /// What workers asked of the databases, newest first: the tool, the SQL,
  /// how many rows and how it went — never the rows. Written by the overdb
  /// tool itself (overdbBinding.ts says whose run it was).
  overdbQueries(caller: OrgCaller, limit = 200): Result<{ queries: OverdbQuery[] }> {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can see what workers asked of the databases.' };
    const raw = this.deps.overdb?.readQueryLog() ?? '';
    const queries: OverdbQuery[] = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && queries.length < limit; i--) {
      if (!lines[i].trim()) continue;
      try {
        const q = JSON.parse(lines[i]) as OverdbQuery;
        if (q && typeof q.tool === 'string' && typeof q.at === 'string') queries.push(q);
      } catch {
        // A line cut short by a crash: skip it.
      }
    }
    return { ok: true, queries };
  }

  /// Take a finished connection away from workers, and its password with it.
  removeOverdbConnection(caller: OrgCaller, connectionId: string): Result {
    if (!isAdmin(this.host.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const file = this.loadOverdbFile();
    const gone = file.connections.find((c) => c.id === connectionId);
    if (!gone) return { ok: false, error: 'No such database.' };
    const next: OverdbConnectionsFile = { version: OVERDB_FILE_VERSION, connections: file.connections.filter((c) => c.id !== connectionId) };
    const installed = this.installOverdb(next.connections, this.deps.overdb?.toolEnv() ?? {});
    if (!installed.ok) return installed;
    this.saveOverdbFile(next);
    this.host.record(caller, `Removed the ${gone.env} database ${gone.name} from the ${OVERDB_TOOL} tool.`);
    return { ok: true };
  }
}
