// The org control plane `overcli serve --control` listens with.
//
//   POST /mcp        MCP (Streamable HTTP, stateless) — the org tools, run as
//                    the caller the bearer token names
//   /api/*           the same operations as JSON, for the web console
//   GET /            the web console (its page is public; its data is not)
//   GET /healthz     liveness, for a container orchestrator
//
// Every data route needs `Authorization: Bearer <token>` from `overcli tokens
// create`. Nothing is served without one, and nothing a token's holder may not
// see is ever returned: each route calls `OrgService`, which applies the org
// policy for that caller.
//
// Inside a VPC this is the only inbound surface overcli has — Slack arrives
// over Socket Mode, which the daemon dials out to. Put it behind the VPN, or
// behind an HTTPS ingress when claude.ai connectors need to reach it.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { callerForToken, loadOrgPolicy, revokeOwnToken } from '../main/org/orgStores';
import { auditCsv } from '../main/org/retention';
import { parseTemplates } from '../main/org/tools';
import { DOCS_CSS, DOCS_JS, renderDocsPage } from './docsPages';
import type { SsoService } from '../main/org/sso';
import { CONNECT_COOKIE, type ConnectionsService } from '../main/org/connections';
import { TOOL_CALLBACK_PATH, TOOL_SIGNIN_COOKIE } from '../main/org/toolSignIn';
import type { TriggerService } from '../main/org/triggers';
import { fleetStatus, fleetTokensFile, fleetUrlProblem, loadFleetTokens, saveFleetToken } from '../main/org/fleet';
import { host } from '../main/host';
import { Store } from '../main/store';
import type { ScheduleTrigger } from '../shared/flows/schedule';
import { PICTURE_TONES, avatarChoices, searchPictures } from '../shared/flows/avatars';
import { FLUENT_EMOJI } from '../shared/flows/fluentEmoji';
import type { AccessService, PersonRole } from '../main/org/accessService';
import type { SlackPerson } from '../main/slack/slackApi';
import type { OrgService, SetupPublishInput, TeamPublishInput } from '../main/org/orgService';
import { isAdmin, type OrgCaller } from '../shared/org/policy';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_ICON, CONSOLE_JS } from './consoleAssets';
import { registerOrgTools } from './orgMcpTools';
import { FileLinks, fileHeaders } from './fileLinks';

/// A request body larger than this is refused unread. Every legitimate body
/// here is a short JSON object.
const MAX_BODY_BYTES = 1_000_000;
/// A published worker or team carries its flows whole; only signed-in
/// callers get this far.
const MAX_PUBLISH_BYTES = 16_000_000;

export interface ControlPlaneDeps {
  org: OrgService;
  /// Invites, join requests and pairing the overcli app. Absent: the console
  /// still works with tokens made on the server.
  access?: AccessService;
  /// People in the org's Slack, for the invite picker. Absent: no picker.
  slackPeople?: () => Promise<SlackPerson[]>;
  /// Sign-in with the company's identity provider. Absent: links and tokens only.
  sso?: SsoService;
  /// Each person's own connected accounts (their Google Drive). Absent: none.
  connections?: ConnectionsService;
  /// Workers' triggers, for the public webhook endpoint.
  triggers?: TriggerService;
  log: (line: string) => void;
  /// Injected for tests; production reads the token file.
  authenticate?: (token: string | undefined) => OrgCaller | null;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1].trim();
}

const ASSET_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
};

const PAGE_HEADERS = {
  ...ASSET_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  // Same-origin script and style only, no framing: the console holds a token.
  // img-src https: for workers' pictures, which are links (Slack fetches them too).
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data: https:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
};

type Handler = (caller: OrgCaller, body: Record<string, unknown>, params: string[], url: URL, base: string, secure: boolean) => unknown | Promise<unknown>;
type PublicHandler = (body: Record<string, unknown>, params: string[], base: string) => unknown | Promise<unknown>;

/// The console's JSON API. Every handler returns what `OrgService` returned,
/// so a refusal arrives as `{ ok: false, error }` with status 200 — it is an
/// answer, not a transport failure.
const ROLES = new Set(['member', 'hirer', 'approver', 'admin']);

/// People: invites, join requests, roles, sign-ins.
function accessRoutes(org: OrgService, access: AccessService, slackPeople?: () => Promise<SlackPerson[]>): Array<{ method: string; path: RegExp; handle: Handler }> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const role = (v: unknown): PersonRole => (ROLES.has(str(v)) ? (str(v) as PersonRole) : 'member');
  const money = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return [
    { method: 'GET', path: /^\/api\/admin\/invites$/, handle: (c) => access.invites(c) },
    // Link this sign-in to its Slack account; Slack asks that person to confirm.
    { method: 'POST', path: /^\/api\/me\/slack$/, handle: (c, b) => access.linkSlackStart(c, str(b.slackUserId)) },
    {
      method: 'POST',
      path: /^\/api\/admin\/invites$/,
      handle: (c, b, _p, _u, base) =>
        access.invite(c, { name: str(b.name), slackUserId: str(b.slackUserId) || undefined, email: str(b.email) || undefined, role: role(b.role), allowanceUSD: money(b.allowanceUSD) }, base),
    },
    { method: 'POST', path: /^\/api\/admin\/invites\/([^/]+)\/cancel$/, handle: (c, _b, [id]) => access.cancelInvite(c, id) },
    { method: 'GET', path: /^\/api\/admin\/requests$/, handle: (c) => access.requests(c) },
    {
      method: 'POST',
      path: /^\/api\/admin\/requests\/([^/]+)$/,
      handle: (c, b, [id], _u, base) => access.decideRequest(c, id, b.approve === true, base, role(b.role)),
    },
    { method: 'POST', path: /^\/api\/admin\/people\/role$/, handle: (c, b) => access.setRole(c, str(b.slackUserId), role(b.role), money(b.allowanceUSD)) },
    { method: 'POST', path: /^\/api\/admin\/people\/signout$/, handle: (c, b) => access.signOutEverywhere(c, str(b.slackUserId)) },
    { method: 'POST', path: /^\/api\/admin\/open-join$/, handle: (c, b) => access.setOpenJoin(c, b.on === true) },
    { method: 'GET', path: /^\/api\/admin\/rules$/, handle: (c) => access.rules(c) },
    {
      // The company's other servers: each one's health and spend, read with
      // an admin token from that server.
      method: 'GET',
      path: /^\/api\/admin\/fleet$/,
      handle: async (c) => {
        if (!isAdmin(loadOrgPolicy().policy, c)) return { ok: false, error: 'Only admins can see other servers.' };
        return { ok: true, servers: await fleetStatus(loadOrgPolicy().policy.fleet, loadFleetTokens(fleetTokensFile(host().dataDir()))) };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/admin\/fleet\/token$/,
      handle: (c, b) => {
        if (!isAdmin(loadOrgPolicy().policy, c)) return { ok: false, error: 'Only admins can connect other servers.' };
        const server = loadOrgPolicy().policy.fleet.find((f) => f.url === str(b.url));
        if (!server) return { ok: false, error: 'Add the server on Rules first.' };
        const bad = fleetUrlProblem(server.url);
        if (bad) return { ok: false, error: bad };
        const token = str(b.token).trim();
        if (token && !token.startsWith('ocli_')) return { ok: false, error: 'That does not look like an overcli token (ocli_…).' };
        saveFleetToken(fleetTokensFile(host().dataDir()), server.url, token || null);
        return { ok: true };
      },
    },
    {
      // Someone has left: their workers and hires to a successor, then every
      // way in closed. Workers first, so nothing is left without a manager.
      method: 'POST',
      path: /^\/api\/admin\/people\/offboard$/,
      handle: (c, b) => {
        const from = str(b.slackUserId);
        const to = (b.to ?? {}) as { name?: unknown; slackUserId?: unknown };
        const manages = org.listWorkers({ name: 'admin', admin: true }).some((w) => w.managerSlackUserId === from);
        let handed: { workers: string[]; hires: number } = { workers: [], hires: 0 };
        if (typeof to.slackUserId === 'string' && to.slackUserId) {
          const res = org.handOverAll(c, from, { name: str(to.name), slackUserId: to.slackUserId });
          if (!res.ok) return res;
          handed = res;
        } else if (manages) {
          return { ok: false, error: 'They still manage workers. Pick who takes them over.' };
        }
        const removed = access.removePerson(c, from);
        return removed.ok ? { ok: true, ...handed, signedOut: removed.signedOut } : removed;
      },
    },
    { method: 'POST', path: /^\/api\/admin\/rules$/, handle: (c, b) => access.setRules(c, b.patch && typeof b.patch === 'object' ? (b.patch as Record<string, unknown>) : {}) },
    { method: 'POST', path: /^\/api\/devices\/([^/]+)\/signout$/, handle: (c, _b, [id]) => access.signOutDevice(c, id) },
    { method: 'POST', path: /^\/api\/devices$/, handle: (c, b) => access.createDeviceKey(c, str(b.device)) },
    {
      method: 'GET',
      path: /^\/api\/admin\/slack-people$/,
      handle: async (c, _b, _p, url) => {
        if (!c.admin) return { ok: false, error: 'Only admins can invite people.' };
        if (!slackPeople) return { ok: true, people: [], slack: false };
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const all = await slackPeople();
        const hits = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q)) : all;
        return { ok: true, slack: true, people: hits.slice(0, 12) };
      },
    },
    { method: 'GET', path: /^\/api\/pair\/([A-Za-z0-9-]+)$/, handle: (c, _b, [code]) => access.pairInfo(c, code) },
    { method: 'POST', path: /^\/api\/pair\/([A-Za-z0-9-]+)$/, handle: (c, b, [code]) => access.pairDecide(c, code, b.allow === true) },
  ];
}

/// The routes anyone may call: opening an invite, and the app's half of
/// pairing. Each is rate-limited per address, and grants nothing on its own:
/// an invite code or a person's confirmation is the credential.
function publicRoutes(access: AccessService): Array<{ method: string; path: RegExp; handle: PublicHandler }> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return [
    { method: 'GET', path: /^\/api\/join\/([A-Za-z0-9_-]{10,100})$/, handle: (_b, [code]) => access.inviteInfo(code) },
    { method: 'POST', path: /^\/api\/join\/([A-Za-z0-9_-]{10,100})$/, handle: (b, [code]) => access.redeem(code, str(b.device) || 'Browser') },
    { method: 'POST', path: /^\/api\/pair\/start$/, handle: (b, _p, base) => access.pairStart(str(b.device), base) },
    { method: 'POST', path: /^\/api\/pair\/poll$/, handle: (b) => access.pairPoll(str(b.pairId), str(b.pollSecret)) },
  ];
}

/// A small fixed window per client address, for the public routes. A pairing
/// poll every two seconds stays well inside it; guessing codes does not.
function rateLimiter(perMinute: number): (key: string) => boolean {
  const hits = new Map<string, { at: number; n: number }>();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.at > 60_000) {
      // Forget finished windows, not live ones: clearing the lot would hand
      // a guesser a fresh minute by flooding it with addresses.
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.at > 60_000) hits.delete(k);
      hits.set(key, { at: now, n: 1 });
      return true;
    }
    h.n++;
    return h.n <= perMinute;
  };
}

/// Forwarded headers are only believed behind a proxy the operator vouched
/// for (OVERCLI_TRUST_PROXY=1); otherwise any client could set them.
const trustProxy = (): boolean => process.env.OVERCLI_TRUST_PROXY === '1';

/// Who is asking, for rate limits: the proxy's view of the client when it is
/// trusted, else the socket.
function clientKey(req: http.IncomingMessage): string {
  const fwd = trustProxy() ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || 'unknown';
}

/// Whether a request's body crossed the wire where nobody else could read it:
/// over TLS, through a trusted proxy that saw https, or from this machine
/// itself. Never from the Host header, which any client can set.
function privateChannel(req: http.IncomingMessage): boolean {
  if ('encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted) return true;
  if (trustProxy()) return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/// A desktop's setup, as sent: kept to plain shapes and sane sizes.
function setupInput(b: Record<string, unknown>): SetupPublishInput {
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const pairs = (v: unknown): Record<string, string> =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => /^[A-Za-z0-9_-]{1,100}$/.test(k) && typeof x === 'string' && x.length <= 4000).slice(0, 30) as Array<[string, string]>)
      : {};
  const keysRaw = b.keys && typeof b.keys === 'object' && !Array.isArray(b.keys) ? (b.keys as Record<string, unknown>) : {};
  return {
    tools: parseTemplates(b.tools),
    repos: arr(b.repos).slice(0, 100).flatMap((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = s(o.name, 100);
      if (!name) return [];
      const url = s(o.url, 500);
      const localPath = s(o.localPath, 1000);
      return [{ name, ...(url ? { url } : {}), ...(localPath && localPath.startsWith('/') ? { localPath } : {}) }];
    }),
    workspaces: arr(b.workspaces).slice(0, 30).flatMap((w) => {
      const o = (w ?? {}) as Record<string, unknown>;
      const name = s(o.name, 80);
      if (!name) return [];
      const instructions = s(o.instructions, 8000);
      return [{ name, repos: arr(o.repos).filter((x): x is string => typeof x === 'string' && x.length <= 100).slice(0, 30), ...(instructions ? { instructions } : {}) }];
    }),
    keys: Object.fromEntries(
      Object.entries(keysRaw)
        .slice(0, 30)
        .map(([name, v]) => {
          const o = (v ?? {}) as Record<string, unknown>;
          return [name, { env: pairs(o.env), headers: pairs(o.headers) }];
        }),
    ),
  };
}

/// Where this request reached us, as the person's browser sees it — the base
/// for links handed back to them.
function originOf(req: http.IncomingMessage): string {
  const fwdProto = trustProxy() ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
  const proto = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : 'encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const host = String((trustProxy() ? req.headers['x-forwarded-host'] : undefined) ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? `${proto}://${host}` : 'http://localhost';
}

/// The app's display face, read once from the bundled file. The console
/// falls back to the system face when it is not there.
let fontCache: Buffer | null | undefined;
function brandFont(): Buffer | null {
  if (fontCache !== undefined) return fontCache;
  const candidates = [
    path.join(__dirname, '../../src/renderer/fonts/BricolageGrotesque-latin.woff2'),
    path.join(__dirname, '../renderer/fonts/BricolageGrotesque-latin.woff2'),
    path.join(process.cwd(), 'src/renderer/fonts/BricolageGrotesque-latin.woff2'),
  ];
  fontCache = null;
  for (const file of candidates) {
    try {
      fontCache = fs.readFileSync(file);
      break;
    } catch {
      // try the next
    }
  }
  return fontCache;
}

const CHECKPOINT_KEYS = ['askFirst', 'reviewBeforeChallenge', 'finalReview', 'approveRoomWork'] as const;

/// A team published from the app or `overcli teams push`.
function teamPublishInput(b: Record<string, unknown>): TeamPublishInput {
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const checkpoints = b.checkpoints && typeof b.checkpoints === 'object' ? (b.checkpoints as Record<string, unknown>) : {};
  return {
    localId: s(b.localId, 64),
    name: s(b.name, 80),
    purpose: s(b.purpose, 500),
    budgetUSDPerTask: typeof b.budgetUSDPerTask === 'number' ? b.budgetUSDPerTask : NaN,
    checkpoints: Object.fromEntries(CHECKPOINT_KEYS.filter((k) => typeof checkpoints[k] === 'boolean').map((k) => [k, checkpoints[k] as boolean])),
    ...(b.piecesAskFirst === false ? { piecesAskFirst: false } : {}),
    members: (Array.isArray(b.members) ? b.members : []).slice(0, 20).map((m) => {
      const o = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
      return { localId: s(o.localId, 64), role: s(o.role, 200), yaml: s(o.yaml, 2_000_000), tools: parseTemplates(o.tools) };
    }),
  };
}

/// A team made in the console from workers already here.
function teamInput(b: Record<string, unknown>): Parameters<OrgService['makeTeam']>[1] {
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const cp = b.checkpoints && typeof b.checkpoints === 'object' ? (b.checkpoints as Record<string, unknown>) : null;
  return {
    ...(cp
      ? {
          checkpoints: {
            askFirst: cp.askFirst !== false,
            reviewBeforeChallenge: cp.reviewBeforeChallenge === true,
            finalReview: cp.finalReview !== false,
            approveRoomWork: cp.approveRoomWork !== false,
          },
        }
      : {}),
    name: s(b.name, 80),
    purpose: s(b.purpose, 500),
    budgetUSDPerTask: typeof b.budgetUSDPerTask === 'number' ? b.budgetUSDPerTask : NaN,
    members: (Array.isArray(b.members) ? b.members : []).slice(0, 20).map((m) => {
      const o = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
      return { workerId: s(o.workerId, 64), role: s(o.role, 200) };
    }),
    ...(s(b.workIn, 80) ? { workIn: s(b.workIn, 80) } : {}),
  };
}

/// A trigger from the console or MCP, cut to the fields it may set.
function triggerInput(raw: unknown): Parameters<OrgService['createTrigger']>[2] {
  const t = (raw ?? {}) as Record<string, any>;
  const text = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const kind = t.kind === 'webhook' || t.kind === 'slack' ? t.kind : 'watch';
  const deliver = (Array.isArray(t.deliver) ? t.deliver : [])
    .slice(0, 6)
    .map((d: any) =>
      d?.kind === 'slack'
        ? { kind: 'slack' as const, channel: text(d.channel, 20) }
        : d?.kind === 'thread'
          ? { kind: 'thread' as const }
          : d?.kind === 'worker'
            ? { kind: 'worker' as const, text: text(d.text, 1000) }
            : // A DM always goes to whoever sets the trigger up; the server fills it in.
              d?.kind === 'dm'
              ? { kind: 'dm' as const, slackUserId: '' }
              : null,
    )
    .filter(Boolean);
  const w = (t.watch ?? {}) as Record<string, any>;
  const s = (t.slack ?? {}) as Record<string, any>;
  return {
    name: text(t.name, 120),
    kind,
    instructions: text(t.instructions),
    deliver,
    maxPerDay: Number(t.maxPerDay) || 50,
    ...(t.notifyOnly === true ? { notifyOnly: true } : {}),
    ...(kind === 'watch'
      ? {
          watch: {
            server: text(w.server, 64),
            tool: text(w.tool, 120),
            args: w.args && typeof w.args === 'object' && !Array.isArray(w.args) ? (w.args as Record<string, unknown>) : {},
            everyMinutes: Number(w.everyMinutes) || 15,
            ...(text(w.itemsPath, 120) ? { itemsPath: text(w.itemsPath, 120) } : {}),
            ...(text(w.idPath, 120) ? { idPath: text(w.idPath, 120) } : {}),
            ...(text(w.changes, 120) ? { changes: text(w.changes, 120) } : {}),
            ...(Array.isArray(w.tracked) ? { tracked: (w.tracked as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 200) } : {}),
          },
        }
      : {}),
    ...(kind === 'slack'
      ? { slack: { channel: text(s.channel, 20), on: s.on === 'mention' || s.on === 'reaction' ? s.on : 'message', ...(text(s.reaction, 60) ? { reaction: text(s.reaction, 60).replace(/:/g, '') } : {}), ...(text(s.contains, 200) ? { contains: text(s.contains, 200) } : {}) } }
      : {}),
    ...(kind === 'webhook' && text(t.webhook?.idPath, 120) ? { webhook: { idPath: text(t.webhook.idPath, 120) } } : {}),
  } as Parameters<OrgService['createTrigger']>[2];
}

function triggerPatch(raw: unknown): Parameters<OrgService['updateTrigger']>[2] {
  const p = (raw ?? {}) as Record<string, unknown>;
  const full = triggerInput({ kind: 'watch', ...p });
  return {
    ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
    ...(typeof p.name === 'string' ? { name: full.name } : {}),
    ...(typeof p.instructions === 'string' ? { instructions: full.instructions } : {}),
    ...(Array.isArray(p.deliver) ? { deliver: full.deliver } : {}),
    ...(p.maxPerDay !== undefined ? { maxPerDay: full.maxPerDay } : {}),
    ...(p.watch ? { watch: full.watch } : {}),
    ...(typeof p.notifyOnly === 'boolean' ? { notifyOnly: p.notifyOnly } : {}),
    ...(p.slack ? { slack: triggerInput({ kind: 'slack', slack: p.slack }).slack } : {}),
  };
}

/// A handler's answer that is a file to download rather than JSON.
const CSV = '__csv';
/// The same, for a zip: `{ filename, data }`.
const ZIP = '__zip';
/// A Set-Cookie header to send with a JSON answer, taken off the answer.
const COOKIE = '__cookie';

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/// A person's own accounts: list, connect (Google's consent page, with a
/// cookie tying the sign-in to this browser) and disconnect.
function connectionRoutes(connections: ConnectionsService): Array<{ method: string; path: RegExp; handle: Handler }> {
  return [
    { method: 'GET', path: /^\/api\/connections$/, handle: async (c, _b, _p, _u, base) => ({ ok: true, connections: await connections.list(c, base) }) },
    {
      method: 'POST',
      path: /^\/api\/connections\/google\/start$/,
      handle: (c, b, _p, _u, base) => {
        const started = connections.start(c, { next: typeof b.next === 'string' ? b.next : undefined, base });
        if (!started.ok) return started;
        // Only the callback reads it; scripts can't; ten minutes, like the state.
        const cookie = `${CONNECT_COOKIE}=${started.browserKey}; Path=/oauth/google/; HttpOnly; SameSite=Lax; Max-Age=600${base.startsWith('https:') ? '; Secure' : ''}`;
        return { ok: true, url: started.url, [COOKIE]: cookie };
      },
    },
    { method: 'POST', path: /^\/api\/connections\/google\/disconnect$/, handle: (c) => connections.disconnect(c, 'google') },
  ];
}

function auditQuery(url: URL, limit: number): { limit: number; from?: number; to?: number; query?: string } {
  const n = (k: string) => {
    const v = Number(url.searchParams.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const q = url.searchParams.get('q')?.trim();
  return { limit: n('limit') ?? limit, ...(n('from') ? { from: n('from') } : {}), ...(n('to') ? { to: n('to') } : {}), ...(q ? { query: q.slice(0, 200) } : {}) };
}

/// A schedule from the console: null ("when asked"), or a daily/interval
/// trigger with sane fields. Anything else is undefined — refused. The worker
/// engine validates the rest (no faster than its minimum interval).
export function parseCadence(raw: unknown): ScheduleTrigger | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.days) ? r.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) : undefined;
  if (r.kind === 'daily' && typeof r.time === 'string' && /^\d{2}:\d{2}$/.test(r.time)) {
    return { kind: 'daily', time: r.time, ...(days && days.length ? { days } : {}) };
  }
  if (r.kind === 'interval' && typeof r.everyMinutes === 'number' && Number.isFinite(r.everyMinutes)) {
    const w = r.window as { start?: unknown; end?: unknown } | undefined;
    const hhmm = (v: unknown): v is string => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
    const window = w && hhmm(w.start) && hhmm(w.end) ? { start: w.start, end: w.end } : undefined;
    return { kind: 'interval', everyMinutes: Math.round(r.everyMinutes), ...(days && days.length ? { days } : {}), ...(window ? { window } : {}) };
  }
  return undefined;
}

/// Where workers may work: what the hire offer's "Works in" picker lists.
function workPlaces(): Array<{ name: string; path: string }> {
  const store = Store.load();
  return [
    ...store.workspaces.map((w) => ({ name: w.name, path: w.rootPath })),
    ...store.projects.map((p) => ({ name: p.name, path: p.path })),
  ];
}

/// A number from the query string; missing, empty or not a number → undefined
/// (Number(null) is 0, so a bare Number() would turn "absent" into 0).
function numParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function apiRoutes(org: OrgService, access?: AccessService, slackPeople?: () => Promise<SlackPerson[]>, links: FileLinks = new FileLinks()): Array<{ method: string; path: RegExp; handle: Handler }> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const TRUST = new Set(['probation', 'trusted', 'autonomous']);
  const VIS = new Set(['private', 'team', 'org']);
  const hireOptions = (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const cadence = parseCadence(o.cadence);
    return {
      ...(cadence !== undefined ? { cadence } : {}),
      ...(typeof o.reportsTo === 'string' && o.reportsTo ? { reportsTo: o.reportsTo } : {}),
      ...(typeof o.visibility === 'string' && VIS.has(o.visibility) ? { visibility: o.visibility as 'private' | 'team' | 'org' } : {}),
      ...(typeof o.projectPath === 'string' && o.projectPath ? { projectPath: o.projectPath } : {}),
      ...(typeof o.budgetUSDPerMonth === 'number' && o.budgetUSDPerMonth > 0 ? { budgetUSDPerMonth: o.budgetUSDPerMonth } : {}),
    };
  };
  return [
    { method: 'GET', path: /^\/api\/today$/, handle: (c) => org.today(c) },
    { method: 'GET', path: /^\/api\/proposals$/, handle: (c) => org.proposals(c) },
    {
      method: 'POST',
      path: /^\/api\/proposals\/([^/]+)$/,
      handle: (c, b, [id]) =>
        org.decideProposal(c, id, {
          approve: b.approve === 'all' ? 'all' : Array.isArray(b.approve) ? b.approve.map(String) : [],
          skip: Array.isArray(b.skip) ? b.skip.map(String) : [],
        }),
    },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/run$/, handle: (c, _b, [id]) => org.runNow(c, decodeURIComponent(id)) },
    {
      method: 'GET',
      path: /^\/api\/work$/,
      handle: (c, _b, _p, url) =>
        org.work(c, { mine: url.searchParams.get('mine') === '1', days: Number(url.searchParams.get('days')) || undefined }),
    },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)\/detail$/, handle: (c, _b, [id]) => org.workerDetail(c, decodeURIComponent(id)) },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/threads$/,
      handle: (c, _b, [id], url) => org.workerThreads(c, decodeURIComponent(id), { before: numParam(url, 'before'), limit: numParam(url, 'limit') }),
    },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/journal$/,
      handle: (c, _b, [id], url) => org.workerJournal(c, decodeURIComponent(id), { before: numParam(url, 'before'), limit: numParam(url, 'limit') }),
    },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/journal$/, handle: (c, b, [id]) => org.addWorkerNote(c, decodeURIComponent(id), str(b.note)) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/journal\/forget$/, handle: (c, b, [id]) => org.forgetWorkerNote(c, decodeURIComponent(id), str(b.entryId)) },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/shifts$/,
      handle: (c, _b, [id], url) =>
        org.workerShifts(c, decodeURIComponent(id), {
          before: numParam(url, 'before'),
          limit: numParam(url, 'limit'),
          decision: url.searchParams.get('decision') ?? undefined,
        }),
    },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/runs$/,
      handle: (c, _b, [id], url) =>
        org.workerRuns(c, decodeURIComponent(id), {
          before: numParam(url, 'before'),
          limit: numParam(url, 'limit'),
          outcome: url.searchParams.get('outcome') ?? undefined,
        }),
    },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/feed$/,
      handle: (c, _b, [id], url) => org.workerFeed(c, decodeURIComponent(id), { before: numParam(url, 'before'), days: numParam(url, 'days') }),
    },
    {
      method: 'POST',
      path: /^\/api\/rate$/,
      handle: (c, b) => org.rate(c, { entryId: str(b.entryId), useful: b.useful === true, ...(typeof b.note === 'string' ? { note: b.note } : {}) }),
    },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/trust$/,
      handle: (c, b, [id]) =>
        TRUST.has(str(b.trust)) ? org.setTrust(c, decodeURIComponent(id), str(b.trust) as 'probation' | 'trusted' | 'autonomous') : { ok: false, error: 'Pick probation, trusted or autonomous.' },
    },
    { method: 'GET', path: /^\/api\/roles$/, handle: (c) => org.roles(c) },
    { method: 'POST', path: /^\/api\/roles\/hire$/, handle: (c, b) => org.hireRole(c, str(b.role), str(b.extra)) },
    { method: 'POST', path: /^\/api\/publish$/, handle: (c, b) => org.publishWorker(c, str(b.yaml), hireOptions(b.options), parseTemplates(b.tools), str(b.localId) || undefined) },
    { method: 'POST', path: /^\/api\/publish\/team$/, handle: (c, b) => org.publishTeam(c, teamPublishInput(b)) },
    { method: 'POST', path: /^\/api\/publish\/setup$/, handle: (c, b, _p, _u, _base, secure) => org.publishSetup(c, setupInput(b), secure) },
    { method: 'GET', path: /^\/api\/setup\/offers$/, handle: (c) => org.setupOffers(c) },
    { method: 'POST', path: /^\/api\/setup\/offers\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.dismissSetupOffer(c, decodeURIComponent(id)) },
    {
      method: 'POST',
      path: /^\/api\/teams$/,
      handle: (c, b) => {
        // The new members a suggestion said to hire, made along with the team.
        const hires = (Array.isArray(b.hires) ? b.hires : []).slice(0, 3).flatMap((x) => {
          const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
          return typeof o.job === 'string' ? [{ key: str(o.key).slice(0, 20), job: o.job.slice(0, 2000), role: typeof o.role === 'string' ? o.role.slice(0, 200) : '' }] : [];
        });
        // A run the console follows: made at once with no hires, else as each is hired.
        return org.startTeamRun(c, { ...teamInput(b), hires });
      },
    },
    { method: 'GET', path: /^\/api\/teams\/runs$/, handle: (c) => ({ ok: true, runs: org.teamRunsFor(c) }) },
    { method: 'GET', path: /^\/api\/teams\/runs\/([^/]+)$/, handle: (c, _b, [id]) => org.teamRun(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/teams\/runs\/([^/]+)\/retry$/, handle: (c, b, [id]) => org.retryTeamRunHire(c, decodeURIComponent(id), str(b.key)) },
    { method: 'POST', path: /^\/api\/teams\/runs\/([^/]+)\/skip$/, handle: (c, b, [id]) => org.skipTeamRunHire(c, decodeURIComponent(id), str(b.key)) },
    { method: 'POST', path: /^\/api\/teams\/suggest$/, handle: (c, b) => org.suggestTeam(c, str(b.purpose).slice(0, 1000), str(b.name).slice(0, 80)) },
    { method: 'POST', path: /^\/api\/runs\/([^/]+)\/resume$/, handle: (c, _b, [id]) => org.resumeInterrupted(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/secrets$/, handle: (c) => org.secretList(c) },
    { method: 'POST', path: /^\/api\/secrets$/, handle: (c, b) => org.setSecret(c, str(b.name), str(b.value)) },
    { method: 'POST', path: /^\/api\/secrets\/([^/]+)\/remove$/, handle: (c, _b, [name]) => org.removeSecret(c, decodeURIComponent(name)) },
    { method: 'GET', path: /^\/api\/repos$/, handle: (c) => org.repoList(c) },
    { method: 'POST', path: /^\/api\/workspaces$/, handle: (c, b) => org.createWorkspace(c, { name: str(b.name), repos: Array.isArray(b.repos) ? b.repos.map(String) : [], instructions: str(b.instructions) || undefined }) },
    { method: 'POST', path: /^\/api\/workspaces\/([^/]+)$/, handle: (c, b, [id]) => org.updateWorkspace(c, decodeURIComponent(id), { ...(Array.isArray(b.repos) ? { repos: b.repos.map(String) } : {}), ...(typeof b.instructions === 'string' ? { instructions: b.instructions } : {}) }) },
    { method: 'POST', path: /^\/api\/workspaces\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.removeWorkspace(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/team-tasks\/([^/]+)\/push$/, handle: (c, _b, [id]) => org.pushTeamCode(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/repos$/, handle: (c, b) => org.connectRepo(c, { url: str(b.url), name: str(b.name) || undefined, testCommand: str(b.testCommand) || undefined }) },
    { method: 'POST', path: /^\/api\/repos\/([^/]+)\/remove$/, handle: (c, _b, [name]) => org.disconnectRepo(c, decodeURIComponent(name)) },
    { method: 'POST', path: /^\/api\/repos\/([^/]+)\/workers$/, handle: (c, b, [name]) => org.letWorkOnRepo(c, str(b.worker), decodeURIComponent(name)) },
    { method: 'GET', path: /^\/api\/teams$/, handle: (c) => org.teams(c) },
    { method: 'GET', path: /^\/api\/now$/, handle: (c) => org.workingNow(c) },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/files$/,
      handle: (c, _b, [id]) => {
        const workerId = decodeURIComponent(id);
        const res = org.workerFileList(c, workerId);
        if (!res.ok) return res;
        return {
          ok: true,
          files: res.files.map((f) => ({ ...f, url: `/files/${links.issue({ caller: c, runId: '', workerId, name: f.name })}/${encodeURIComponent(f.name.split('/').pop() ?? 'file')}` })),
        };
      },
    },
    {
      method: 'GET',
      path: /^\/api\/runs\/([^/]+)\/files$/,
      // Each with a link to open it by: see fileLinks.ts.
      handle: (c, _b, [id]) => {
        const runId = decodeURIComponent(id);
        const res = org.runFiles(c, runId);
        if (!res.ok) return res;
        return {
          ok: true,
          files: res.files.map((f) => ({ ...f, url: `/files/${links.issue({ caller: c, runId, name: f.name })}/${encodeURIComponent(f.name.split('/').pop() ?? 'file')}` })),
        };
      },
    },
    { method: 'GET', path: /^\/api\/runs\/([^/]+)\/live$/, handle: (c, _b, [id], url) => org.runLive(c, decodeURIComponent(id), numParam(url, 'after') ?? 0) },
    {
      method: 'POST',
      path: /^\/api\/teams\/([^/]+)\/settings$/,
      handle: (c, b, [id]) => {
        const cp = b.checkpoints && typeof b.checkpoints === 'object' ? (b.checkpoints as Record<string, unknown>) : null;
        const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
        const checkpoints = cp
          ? Object.fromEntries((['askFirst', 'reviewBeforeChallenge', 'finalReview', 'approveRoomWork'] as const).flatMap((k) => (typeof cp[k] === 'boolean' ? [[k, cp[k] as boolean]] : [])))
          : undefined;
        return org.updateTeamSettings(c, decodeURIComponent(id), {
          ...(checkpoints ? { checkpoints } : {}),
          ...(flag(b.piecesAskFirst) !== undefined ? { piecesAskFirst: flag(b.piecesAskFirst) } : {}),
          ...(typeof b.budgetUSDPerTask === 'number' ? { budgetUSDPerTask: b.budgetUSDPerTask } : {}),
          ...(typeof b.guidance === 'string' ? { guidance: b.guidance } : {}),
          ...(typeof b.avatarUrl === 'string' || b.avatarUrl === null ? { avatarUrl: b.avatarUrl as string | null } : {}),
        });
      },
    },
    { method: 'POST', path: /^\/api\/teams\/([^/]+)\/refresh$/, handle: (c, b, [id]) => org.setTeamKnowledgeRefresh(c, decodeURIComponent(id), typeof b.mode === 'string' ? b.mode : '') },
    { method: 'POST', path: /^\/api\/teams\/([^/]+)\/disband$/, handle: (c, _b, [id]) => org.disbandTeam(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/teams\/([^/]+)\/delete$/, handle: (c, _b, [id]) => org.deleteTeam(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/teams\/([^/]+)\/learn$/, handle: (c, _b, [id]) => org.learnTeam(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/teams\/([^/]+)\/knowledge$/, handle: (c, _b, [id]) => org.teamKnowledge(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/teams\/([^/]+)\/page$/, handle: (c, _b, [id]) => org.teamPage(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/team-tasks\/([^/]+)\/file$/, handle: (c, _b, [id], url) => org.teamTaskFile(c, decodeURIComponent(id), url.searchParams.get('name') ?? '') },
    { method: 'GET', path: /^\/api\/team-tasks\/([^/]+)\/page$/, handle: (c, _b, [id]) => org.teamTaskPage(c, decodeURIComponent(id)) },
    {
      method: 'GET',
      path: /^\/api\/team-tasks\/([^/]+)\/files$/,
      // Each with a link to open it by, as a run's files have: an HTML report
      // shown as the page it is, in a frame the console's token can't reach.
      handle: async (c, _b, [id]) => {
        const taskId = decodeURIComponent(id);
        const res = await org.teamTaskFiles(c, taskId);
        if (!res.ok) return res;
        return {
          ...res,
          files: res.files.map((f) => ({ ...f, url: `/files/${links.issue({ caller: c, runId: '', taskId, name: f.name })}/${encodeURIComponent(f.name.split('/').pop() ?? 'file')}` })),
        };
      },
    },
    { method: 'POST', path: /^\/api\/team-tasks\/([^/]+)\/files\/keep$/, handle: (c, b, [id]) => org.keepTeamFiles(c, decodeURIComponent(id), b.names) },
    { method: 'POST', path: /^\/api\/team-tasks\/([^/]+)\/files\/save$/, handle: (c, b, [id]) => org.saveTeamFiles(c, decodeURIComponent(id), b.names, str(b.destination)) },
    {
      // The whole shared folder, as one download.
      method: 'GET',
      path: /^\/api\/team-tasks\/([^/]+)\/files\.zip$/,
      handle: (c, _b, [id]) => {
        const res = org.teamTaskZip(c, decodeURIComponent(id));
        return res.ok ? { ok: true, [ZIP]: { filename: res.filename, data: res.data } } : res;
      },
    },
    { method: 'GET', path: /^\/api\/team-tasks$/, handle: (c) => org.teamTasks(c) },
    { method: 'POST', path: /^\/api\/teams\/brief$/, handle: (c, b) => org.briefTeam(c, str(b.team), str(b.text)) },
    {
      method: 'POST',
      path: /^\/api\/team-tasks\/([^/]+)$/,
      handle: (c, b, [id]) => {
        const kind = str(b.kind);
        if (kind === 'answer') return org.decideTeamTask(c, id, { kind, answers: Array.isArray(b.answers) ? b.answers.map(String) : [str(b.answers)] });
        if (kind === 'revise') return org.decideTeamTask(c, id, { kind, feedback: str(b.feedback) });
        if (kind === 'approve' || kind === 'continue' || kind === 'cancel' || kind === 'accept' || kind === 'plan') return org.decideTeamTask(c, id, { kind });
        if (kind === 'retryPiece') return org.decideTeamTask(c, id, { kind, workerId: str(b.workerId) });
        return { ok: false, error: 'Say answer, approve, revise, continue, cancel, accept or retryPiece.' };
      },
    },
    { method: 'GET', path: /^\/api\/admin\/people$/, handle: (c) => org.people(c) },
    { method: 'GET', path: /^\/api\/admin\/health$/, handle: (c) => org.health(c) },
    { method: 'GET', path: /^\/api\/admin\/audit$/, handle: (c, _b, _p, url) => org.auditLog(c, auditQuery(url, 60)) },
    {
      // The same search, as a spreadsheet to download.
      method: 'GET',
      path: /^\/api\/admin\/audit\.csv$/,
      handle: (c, _b, _p, url) => {
        const res = org.auditLog(c, { ...auditQuery(url, 10_000), limit: 10_000 });
        return res.ok ? { ok: true, [CSV]: auditCsv([...res.entries].reverse()) } : res;
      },
    },
    { method: 'GET', path: /^\/api\/projects$/, handle: () => workPlaces() },
    ...(access ? accessRoutes(org, access, slackPeople) : []),
    { method: 'GET', path: /^\/api\/whoami$/, handle: (c) => org.whoami(c) },
    { method: 'GET', path: /^\/api\/workers$/, handle: (c) => org.listWorkers(c) },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)$/, handle: (c, _b, [id]) => org.getWorker(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/chart$/, handle: (c) => org.orgChart(c) },
    { method: 'GET', path: /^\/api\/report$/, handle: (c, _b, _p, url) => org.report(c, Number(url.searchParams.get('days') ?? 30)) },
    { method: 'GET', path: /^\/api\/waiting$/, handle: (c) => org.listWaiting(c) },
    { method: 'GET', path: /^\/api\/hires$/, handle: (c) => org.listHires(c) },
    { method: 'POST', path: /^\/api\/answer$/, handle: (c, b) => org.answer(c, str(b.runId), str(b.answer)) },
    { method: 'POST', path: /^\/api\/approval$/, handle: (c, b) => org.decideRun(c, str(b.runId), b.approve === true, b.forRun === true) },
    {
      // Returns at once: the console follows the question by id, so leaving
      // the page loses nothing.
      method: 'POST',
      path: /^\/api\/ask$/,
      handle: (c, b) => {
        const res = org.startAsk(c, str(b.worker), str(b.message), 'console', undefined, typeof b.replyTo === 'string' ? b.replyTo : undefined);
        return res.ok ? { ok: true, askId: res.askId } : res;
      },
    },
    { method: 'GET', path: /^\/api\/asks\/([^/]+)$/, handle: (c, _b, [id]) => org.askStatus(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/tools$/, handle: (c) => org.tools(c) },
    { method: 'GET', path: /^\/api\/admin\/tools\/([^/]+)\/scope$/, handle: (c, _b, [name]) => org.toolScopePage(c, decodeURIComponent(name)) },
    { method: 'POST', path: /^\/api\/admin\/tools\/([^/]+)\/scope$/, handle: (c, b, [name]) => org.setToolDefault(c, decodeURIComponent(name), b.default ?? null) },
    { method: 'GET', path: /^\/api\/tools\/([^/]+)\/calls$/, handle: (c, _b, [name]) => org.serverTools(c, decodeURIComponent(name)) },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)\/triggers$/, handle: (c, _b, [id]) => org.triggers(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/triggers$/, handle: (c, b, [id]) => org.createTrigger(c, decodeURIComponent(id), triggerInput(b.trigger)) },
    { method: 'POST', path: /^\/api\/triggers\/test$/, handle: (c, b) => org.testWatch(c, triggerInput({ kind: 'watch', watch: b.watch }).watch!) },
    { method: 'POST', path: /^\/api\/triggers\/([^/]+)\/check$/, handle: (c, _b, [id]) => org.checkTriggerNow(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/triggers\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.removeTrigger(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/triggers\/([^/]+)$/, handle: (c, b, [id]) => org.updateTrigger(c, decodeURIComponent(id), triggerPatch(b.patch)) },
    {
      method: 'GET',
      path: /^\/api\/library$/,
      handle: (c, _b, _p, url) => {
        const kind = url.searchParams.get('kind');
        const visibility = url.searchParams.get('visibility');
        return org.library(c, {
          ...(url.searchParams.get('worker') ? { workerId: url.searchParams.get('worker')! } : {}),
          ...(url.searchParams.get('q') ? { query: url.searchParams.get('q')!.slice(0, 200) } : {}),
          ...(kind === 'task' || kind === 'work' || kind === 'event' || kind === 'file' || kind === 'answer' ? { kind } : {}),
          ...(visibility === 'private' || visibility === 'team' || visibility === 'org' ? { visibility } : {}),
          ...(numParam(url, 'limit') ? { limit: Math.max(1, numParam(url, 'limit')!) } : {}),
        });
      },
    },
    { method: 'GET', path: /^\/api\/library\/([^/]+)$/, handle: (c, _b, [id]) => org.libraryItem(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/library\/([^/]+)\/rate$/, handle: (c, b, [id]) => org.rateDeliverable(c, decodeURIComponent(id), b.useful === true) },
    { method: 'POST', path: /^\/api\/admin\/tools\/check$/, handle: (c) => org.checkTools(c) },
    {
      method: 'POST',
      path: /^\/api\/admin\/tools$/,
      handle: (c, b) => {
        const t = (b.tool ?? {}) as Record<string, unknown>;
        const pairs = (v: unknown): Record<string, string> =>
          v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string') as Array<[string, string]>) : {};
        return org.installTool(c, {
          name: str(t.name),
          kind: t.kind === 'http' ? 'http' : 'command',
          command: str(t.command),
          args: Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string') : [],
          env: pairs(t.env),
          url: str(t.url),
          headers: pairs(t.headers),
        });
      },
    },
    { method: 'POST', path: /^\/api\/admin\/tools\/([^/]+)\/remove$/, handle: (c, _b, [name]) => org.uninstallTool(c, decodeURIComponent(name)) },
    { method: 'POST', path: /^\/api\/admin\/tools\/discover$/, handle: (c, b, _p, _u, base) => org.discoverToolSignIn(c, str(b.url), base) },
    {
      method: 'POST',
      path: /^\/api\/admin\/tools\/signin$/,
      handle: async (c, b, _p, _u, base) => {
        const t = (b.tool ?? {}) as Record<string, unknown>;
        const started = await org.startToolSignIn(
          c,
          { name: str(t.name), url: str(t.url), ...(typeof b.next === 'string' ? { next: b.next } : {}), ...(str(t.clientId) ? { clientId: str(t.clientId) } : {}), ...(str(t.clientSecret) ? { clientSecret: str(t.clientSecret) } : {}) },
          base,
        );
        if (!started.ok) return started;
        // Only the callback reads it; scripts can't; ten minutes, like the state.
        const cookie = `${TOOL_SIGNIN_COOKIE}=${started.browserKey}; Path=${TOOL_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${base.startsWith('https:') ? '; Secure' : ''}`;
        return { ok: true, url: started.url, [COOKIE]: cookie };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/paused$/,
      handle: (c, b, [id]) => org.setPaused(c, decodeURIComponent(id), b.paused === true),
    },
    {
      method: 'GET',
      path: /^\/api\/avatars$/,
      // Fluent pictures by search (the picks with none), or drawn avatars.
      handle: (_c, _b, _p, url) =>
        url.searchParams.get('kind') === 'drawn'
          ? { ok: true, choices: avatarChoices(() => randomBytes(6).toString('hex')) }
          : {
              ok: true,
              choices: searchPictures(
                FLUENT_EMOJI,
                (url.searchParams.get('q') ?? '').slice(0, 60),
                48,
                PICTURE_TONES.find((t) => t === url.searchParams.get('tone')),
              ).map((p) => ({ style: p.name, url: p.url })),
            },
    },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/picture\/pick$/, handle: (c, _b, [id]) => org.pickWorkerPicture(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/runs\/([^/]+)\/stop$/, handle: (c, _b, [id]) => org.stopRun(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/track$/, handle: (c, b, [id]) => org.trackItem(c, decodeURIComponent(id), str(b.item), b.on !== false) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/retire$/, handle: (c, _b, [id]) => org.retire(c, decodeURIComponent(id)) },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/update$/,
      handle: (c, b, [id]) => {
        const patch = { ...((b.patch ?? {}) as Parameters<OrgService['update']>[2]) };
        if (patch && 'cadence' in patch) {
          const cadence = parseCadence(patch.cadence);
          if (cadence === undefined) return { ok: false, error: 'That schedule is not one overcli understands.' };
          patch.cadence = cadence;
        }
        return org.update(c, decodeURIComponent(id), patch);
      },
    },
    {
      method: 'POST',
      path: /^\/api\/hires\/draft$/,
      handle: (c, b) =>
        org.draftHire(c, {
          ...(typeof b.jobDescription === 'string' ? { jobDescription: b.jobDescription } : {}),
          ...(typeof b.hireId === 'string' ? { hireId: b.hireId } : {}),
          ...(typeof b.answer === 'string' ? { answer: b.answer } : {}),
          skipQuestions: b.skipQuestions === true,
        }),
    },
    {
      method: 'POST',
      path: /^\/api\/hires\/confirm$/,
      handle: (c, b) => org.confirmHire(c, str(b.hireId), hireOptions(b.options)),
    },
    { method: 'POST', path: /^\/api\/hires\/decide$/, handle: (c, b) => org.decideHire(c, str(b.hireId), b.approve === true) },
    { method: 'POST', path: /^\/api\/hires\/cancel$/, handle: (c, b) => org.cancelHire(c, str(b.hireId)) },
  ];
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, org: OrgService, caller: OrgCaller, access?: AccessService): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    return;
  }
  // Stateless: a fresh server per request, bound to this caller. Nothing
  // about one caller's session can leak into another's.
  const server = new McpServer({ name: 'overcli-org', version: '1' });
  registerOrgTools(server, org, caller, access);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createControlPlane(deps: ControlPlaneDeps): http.Server {
  const authenticate = deps.authenticate ?? ((token) => callerForToken(token, loadOrgPolicy().policy));
  const links = new FileLinks();
  const routes = [...apiRoutes(deps.org, deps.access, deps.slackPeople, links), ...(deps.connections ? connectionRoutes(deps.connections) : [])];
  const open = [
    ...(deps.access ? publicRoutes(deps.access) : []),
    // Whether to show "Sign in with …", and the console's swap of its
    // one-time code for a token.
    { method: 'GET', path: /^\/api\/sso$/, handle: () => ({ ok: true, ...(deps.sso?.status() ?? { enabled: false, required: false }) }) },
    {
      method: 'POST',
      path: /^\/api\/sso\/redeem$/,
      handle: (b: Record<string, unknown>) => (deps.sso ? deps.sso.redeem(typeof b.code === 'string' ? b.code : '') : { ok: false, error: 'Company sign-in is not set up.' }),
    },
  ] as Array<{ method: string; path: RegExp; handle: PublicHandler }>;
  const allow = rateLimiter(60);

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      try {
        if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
        // Company sign-in: off to the provider, and back. The callback hands
        // the console a one-time code, never the token, in its URL.
        if (req.method === 'GET' && deps.sso && (path === '/sso/start' || path === '/sso/callback')) {
          if (!allow(clientKey(req))) return send(res, 429, 'Too many tries. Wait a minute.');
          const done = (q: Record<string, string>) => {
            res.writeHead(302, { Location: `/sso/done?${new URLSearchParams(q).toString()}`, 'Cache-Control': 'no-store' });
            res.end();
          };
          if (path === '/sso/start') {
            const started = await deps.sso.start(url.searchParams.get('next') ?? '/');
            if (!started.ok) return done({ error: started.error });
            res.writeHead(302, { Location: started.url, 'Cache-Control': 'no-store' });
            return res.end();
          }
          const back = await deps.sso.callback(url.searchParams);
          if (!back.ok) {
            deps.log(`control: company sign-in failed: ${back.error}`);
            return done({ error: back.error });
          }
          return done({ code: back.handoff, next: back.next });
        }
        // Back from Google's consent page, connecting someone's own Drive. No
        // token comes with a redirect: the single-use state says who, and the
        // cookie set when it started says it is the same browser.
        if (req.method === 'GET' && deps.connections && path === '/oauth/google/callback') {
          if (!allow(clientKey(req))) return send(res, 429, 'Too many tries. Wait a minute.');
          const back = await deps.connections.callback(url.searchParams, cookieValue(req.headers.cookie, CONNECT_COOKIE));
          if (!back.ok) deps.log(`control: connecting Google Drive failed (${back.reason}).`);
          res.writeHead(302, {
            Location: back.location,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Set-Cookie': `${CONNECT_COOKIE}=; Path=/oauth/google/; HttpOnly; SameSite=Lax; Max-Age=0`,
          });
          return res.end();
        }
        // Back from a tool's sign-in page, signing it in for the org. Like
        // Google's: the state says who, the cookie says the same browser.
        if (req.method === 'GET' && path === TOOL_CALLBACK_PATH) {
          if (!allow(clientKey(req))) return send(res, 429, 'Too many tries. Wait a minute.');
          const back = await deps.org.finishToolSignIn(url.searchParams, cookieValue(req.headers.cookie, TOOL_SIGNIN_COOKIE));
          if (!back.ok) deps.log(`control: signing a tool in failed (${back.reason}).`);
          res.writeHead(302, {
            Location: back.location,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Set-Cookie': `${TOOL_SIGNIN_COOKIE}=; Path=${TOOL_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`,
          });
          return res.end();
        }
        // A webhook from Jira, GitHub, a CRM or Zapier: the secret is in the
        // path, so any sender can use it. Answers fast; the work runs after.
        const hook = /^\/hooks\/([A-Za-z0-9_-]{6,40})\/([A-Za-z0-9_-]{20,80})$/.exec(path);
        if (hook && req.method === 'POST' && deps.triggers) {
          if (!allow(clientKey(req))) return send(res, 429, { ok: false, error: 'Too many events. Slow down.' });
          let body: unknown;
          try {
            body = await readBody(req);
          } catch {
            return send(res, 400, { ok: false, error: 'Send JSON.' });
          }
          const r = deps.triggers.webhook(hook[1], hook[2], body);
          return r.ok ? send(res, 202, r) : send(res, r.status, { ok: false, error: r.error });
        }
        // The join, pairing and sign-in pages are the console too: it reads the path.
        if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/pair' || path === '/sso/done' || /^\/join\/[A-Za-z0-9_-]{10,100}$/.test(path))) {
          res.writeHead(200, PAGE_HEADERS);
          return res.end(CONSOLE_HTML);
        }
        if (req.method === 'GET' && path === '/console.js') {
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' });
          return res.end(CONSOLE_JS);
        }
        if (req.method === 'GET' && path === '/icon.svg') {
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'image/svg+xml' });
          return res.end(CONSOLE_ICON);
        }
        if (req.method === 'GET' && path === '/fonts/bricolage.woff2') {
          const font = brandFont();
          if (!font) return send(res, 404, 'Not found.');
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'font/woff2' });
          return res.end(font);
        }
        if (req.method === 'GET' && path === '/docs.css') {
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'text/css; charset=utf-8' });
          return res.end(DOCS_CSS);
        }
        if (req.method === 'GET' && path === '/docs.js') {
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' });
          return res.end(DOCS_JS);
        }
        if (req.method === 'GET' && (path === '/docs' || path.startsWith('/docs/'))) {
          const page = renderDocsPage(path);
          if (!page) return send(res, 404, { ok: false, error: 'No such page in the docs.' });
          res.writeHead(200, PAGE_HEADERS);
          return res.end(page);
        }
        if (req.method === 'GET' && path === '/console.css') {
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'text/css; charset=utf-8' });
          return res.end(CONSOLE_CSS);
        }

        const base = loadOrgPolicy().policy.publicUrl ?? originOf(req);
        const openRoute = open.find((r) => r.method === req.method && r.path.test(path));
        if (openRoute) {
          if (!allow(clientKey(req))) return send(res, 429, { ok: false, error: 'Too many tries. Wait a minute.' });
          let body: Record<string, unknown> = {};
          if (req.method === 'POST') {
            try {
              const parsed = await readBody(req);
              body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
            } catch {
              return send(res, 400, { ok: false, error: 'Send a JSON object.' });
            }
          }
          return send(res, 200, await openRoute.handle(body, openRoute.path.exec(path)!.slice(1), base));
        }

        // A run's or a team task's file, by the link its listing handed out,
        // in the browser that listed it: the cookie the listing set has to
        // name the same person, so a forwarded link opens nothing for whoever
        // it went to.
        const fileLink = req.method === 'GET' ? /^\/files\/([A-Za-z0-9_-]{20,64})(?:\/[^/]*)?$/.exec(path) : null;
        if (fileLink) {
          const opened = links.open(fileLink[1], req.headers.cookie);
          if (!opened.ok && opened.why === 'elsewhere') return send(res, 403, 'This link only opens for the person it was made for. Open the file from the console.');
          const link = opened.ok ? opened.link : null;
          const got = !link ? null
            : link.workerId ? deps.org.workerFile(link.caller, link.workerId, link.name)
            : link.taskId ? (() => { const t = deps.org.teamTaskFile(link.caller, link.taskId!, link.name); return t.ok ? { ok: true as const, data: Buffer.from(t.body, 'utf8') } : t; })()
            : deps.org.runFile(link.caller, link.runId, link.name);
          if (!link || !got?.ok) return send(res, 404, link ? 'That file is no longer there.' : 'This link has expired. Open the file from the console again.');
          res.writeHead(200, fileHeaders(link.name, url.searchParams.get('download') === '1'));
          return res.end(got.data);
        }

        const caller = authenticate(bearer(req));
        // Links sent from Slack fall back to where an admin last used the
        // console. Only an admin's request counts: anyone else could aim
        // other people's sign-in links at a host of their choosing.
        if (caller && isAdmin(loadOrgPolicy().policy, caller)) deps.access?.noteOrigin(originOf(req));
        if (path === '/mcp') {
          if (!caller) {
            return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'A bearer token from `overcli tokens create` is required.' }, id: null }, {
              'WWW-Authenticate': 'Bearer',
            });
          }
          if (req.method !== 'POST') {
            return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
          }
          return await handleMcp(req, res, deps.org, caller, deps.access);
        }

        if (path.startsWith('/api/')) {
          if (!caller) return send(res, 401, { ok: false, error: 'You are signed out. Open your sign-in link again, or type /overcli join in Slack.' });
          // This browser's or app's own sign-out: the token stops working
          // here, not just on the device.
          if (req.method === 'POST' && path === '/api/signout') return send(res, 200, { ok: revokeOwnToken(bearer(req)!) });
          const route = routes.find((r) => r.method === req.method && r.path.test(path));
          if (!route) return send(res, 404, { ok: false, error: 'No such route.' });
          let body: Record<string, unknown> = {};
          if (req.method === 'POST') {
            try {
              const parsed = await readBody(req, path.startsWith('/api/publish') ? MAX_PUBLISH_BYTES : MAX_BODY_BYTES);
              body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
            } catch {
              return send(res, 400, { ok: false, error: 'Send a JSON object.' });
            }
          }
          const params = route.path.exec(path)!.slice(1);
          const answer = await route.handle(caller, body, params, url, base, privateChannel(req));
          if (answer && typeof answer === 'object' && ZIP in answer) {
            const zip = (answer as Record<string, unknown>)[ZIP] as { filename: string; data: Buffer };
            res.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Length': String(zip.data.length),
              'Content-Disposition': `attachment; filename="${zip.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            return res.end(zip.data);
          }
          if (answer && typeof answer === 'object' && CSV in answer) {
            return send(res, 200, String((answer as Record<string, unknown>)[CSV]), {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="decision-log.csv"',
            });
          }
          // A file listing hands out links; this cookie is what lets them open,
          // in this browser, for this person only.
          const lists = /^\/api\/(?:runs|team-tasks|workers)\/[^/]+\/files$/.test(path) && answer && typeof answer === 'object' && (answer as { ok?: unknown }).ok !== false;
          if (answer && typeof answer === 'object' && COOKIE in answer) {
            const { [COOKIE]: cookie, ...rest } = answer as Record<string, unknown>;
            return send(res, 200, rest, { 'Set-Cookie': String(cookie) });
          }
          return send(res, 200, answer, lists ? { 'Set-Cookie': links.cookieFor(caller, originOf(req).startsWith('https:')) } : {});
        }
        send(res, 404, { ok: false, error: 'Not found.' });
      } catch (err) {
        deps.log(`control plane: ${req.method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) send(res, 500, { ok: false, error: 'Something went wrong on the server.' });
      }
    })();
  });
}

export function listenControlPlane(server: http.Server, address: { host: string; port: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.port, address.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
