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

import { parseCron } from '../shared/flows/cron';
import { scheduleText } from '../main/org/orgService';
import { PROCESS_LIBRARY, libraryProcess, suggestTeamFor } from '../shared/org/processLibrary';
import type { ProcessField, ProcessPerson, ProcessStage } from '../shared/org/process';
import { processScheduleText, type ItemAction, type ProcessService } from '../main/org/processes';
import { imageFromDataUrl, type ProcessDraftResult, type ProcessImageInput } from '../main/org/processDraft';
import type { ModelIdResult } from '../main/backends/modelIdTest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { callerForToken, loadOrgPolicy, revokeOwnToken } from '../main/org/orgStores';
import { auditCsv } from '../main/org/retention';
import type { AskerSort, SlackConversations } from '../main/slack/conversations';
import { parseTemplates } from '../main/org/tools';
import { reachOf } from '../main/org/reach';
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
import { slackManifestForConsole } from '../main/slack/slackManifest';
import type { OrgService, SetupPublishInput, TeamPublishInput } from '../main/org/orgService';
import { AUDIENCE_ROLES, isAdmin, parseAudience, type OrgCaller } from '../shared/org/policy';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_ICON, CONSOLE_JS } from './consoleAssets';
import { registerOrgTools } from './orgMcpTools';
import { FileLinks, fileHeaders } from './fileLinks';

/// A request body larger than this is refused unread. Every legitimate body
/// here is a short JSON object.
const MAX_BODY_BYTES = 1_000_000;
/// A published worker or team carries its flows whole; only signed-in
/// callers get this far.
const MAX_PUBLISH_BYTES = 16_000_000;
/// A process drafted from a picture carries it as a data URL: 5 MB of image
/// is about 7 MB of base64.
const MAX_IMAGE_BODY_BYTES = 7_200_000;

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
  /// What people asked overgo in Slack, and each thread. Absent: the Slack
  /// page says Slack isn't on this server.
  slackConversations?: SlackConversations;
  /// Work moving between teams and people. Absent: no Processes page.
  processes?: ProcessService;
  /// Read a picture of a process into a draft (processDraft.ts). Absent:
  /// "From an image" says it isn't set up here.
  draftProcess?: (input: ProcessImageInput) => Promise<ProcessDraftResult>;
  /// Setup → Model ids' Test: one tiny prompt per id on the server's model
  /// provider (modelIdTest.ts). Absent: the page says it can't test here.
  testModelIds?: (models: string[]) => Promise<ModelIdResult[]>;
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

export function bearer(req: Pick<http.IncomingMessage, 'headers'>): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  // A prefix check, not a regex: `\s+(.+)` both take spaces, which a long
  // header of them makes slow.
  const value = h.trim();
  if (value.length <= 7 || value.slice(0, 6).toLowerCase() !== 'bearer' || !/\s/.test(value[6])) return undefined;
  return value.slice(7).trim() || undefined;
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
    // Anyone signed in: picking who owns a stage or decides at one.
    {
      method: 'GET',
      path: /^\/api\/slack-people$/,
      handle: async (_c, _b, _p, url) => {
        if (!slackPeople) return { ok: true, people: [], slack: false };
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        if (q.length < 2) return { ok: true, slack: true, people: [] };
        const all = await slackPeople();
        return { ok: true, slack: true, people: all.filter((p) => p.name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q)).slice(0, 8).map((p) => ({ id: p.id, name: p.name, handle: p.handle })) };
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

/// The operator vouches the port is published on the host's loopback only
/// (OVERCLI_PUBLISHED_ON_LOOPBACK=1, set by the compose file beside its
/// `127.0.0.1:` port). In a container every browser on that host arrives from
/// the bridge's gateway, never 127.0.0.1, so the socket alone can't tell.
const publishedOnLoopback = (): boolean => process.env.OVERCLI_PUBLISHED_ON_LOOPBACK === '1';

/// Whether a request's body crossed the wire where nobody else could read it:
/// over TLS, through a trusted proxy that saw https, or from this machine
/// itself. Never from the Host header, which any client can set.
export function privateChannel(req: Pick<http.IncomingMessage, 'socket' | 'headers'>): boolean {
  if ('encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted) return true;
  if (trustProxy()) return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  if (publishedOnLoopback()) return true;
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
    ...(t.startsOnItsOwn === true ? { startsOnItsOwn: true } : {}),
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
    ...(typeof p.startsOnItsOwn === 'boolean' ? { startsOnItsOwn: p.startsOnItsOwn } : {}),
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
/// A person as a form sends one: a name, and their Slack id when known.
function personInput(raw: unknown): ProcessPerson | undefined {
  const p = raw as { name?: unknown; slackUserId?: unknown } | null;
  const name = typeof p?.name === 'string' ? p.name.trim().slice(0, 120) : '';
  if (!name) return undefined;
  const id = typeof p?.slackUserId === 'string' && /^[UW][A-Z0-9]{6,}$/.test(p.slackUserId) ? p.slackUserId : undefined;
  return { name, ...(id ? { slackUserId: id } : {}) };
}

/// What a people stage asks for, as a form sends it.
function fieldsInput(raw: unknown): ProcessField[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const kind = r.kind === 'longText' || r.kind === 'choice' ? r.kind : 'text';
    const options = kind === 'choice' && Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).slice(0, 20).map((o) => o.trim().slice(0, 80)) : [];
    return {
      id: typeof r.id === 'string' ? r.id.trim().slice(0, 40) : '',
      label: typeof r.label === 'string' ? r.label.trim().slice(0, 120) : '',
      kind,
      ...(options.length ? { options } : {}),
      ...(r.required === true ? { required: true } : {}),
    };
  });
}

function stagesInput(raw: unknown): ProcessStage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const kind = r.kind === 'people' ? 'people' : r.kind === 'worker' ? 'worker' : 'team';
    const owner = personInput(r.owner);
    const approvers = Array.isArray(r.approvers) ? r.approvers.map(personInput).filter((p): p is ProcessPerson => !!p).slice(0, 20) : [];
    const groups = Array.isArray(r.approverGroups)
      ? (r.approverGroups as Array<{ id?: unknown; name?: unknown }>)
          .filter((g) => typeof g?.id === 'string' && typeof g.name === 'string')
          .slice(0, 10)
          .map((g) => ({ id: (g.id as string).slice(0, 120), name: (g.name as string).slice(0, 120) }))
      : [];
    const fields = fieldsInput(r.fields);
    return {
      id: str(r.id, 40),
      name: str(r.name, 80),
      kind,
      ...(kind === 'team' && str(r.teamId, 80) ? { teamId: str(r.teamId, 80) } : {}),
      ...(kind === 'worker' && str(r.workerId, 80) ? { workerId: str(r.workerId, 80) } : {}),
      ...(owner ? { owner } : {}),
      ...(kind === 'people' ? { approvers, ...(groups.length ? { approverGroups: groups } : {}) } : {}),
      ...(kind === 'people' && r.mode === 'input' ? { mode: 'input' } : {}),
      ...(kind === 'people' && fields.length ? { fields } : {}),
      ...(kind === 'people' && (r.needs === 'all' || (typeof r.needs === 'number' && Number.isInteger(r.needs) && r.needs > 1)) ? { needs: r.needs } : {}),
      ...(str(r.ask, 2000) ? { ask: str(r.ask, 2000) } : {}),
      ...(str(r.sendBackTo, 40) ? { sendBackTo: str(r.sendBackTo, 40) } : {}),
      ...(str(r.why, 600) ? { why: str(r.why, 600) } : {}),
      ...(kind !== 'people' && typeof r.delayDays === 'number' && r.delayDays > 0 ? { delayDays: Math.round(r.delayDays) } : {}),
      ...(kind !== 'people' && r.repeat && typeof r.repeat === 'object' && Number((r.repeat as { times?: unknown }).times) > 1
        ? { repeat: { everyDays: Math.round(Number((r.repeat as { everyDays?: unknown }).everyDays)), times: Math.round(Number((r.repeat as { times?: unknown }).times)) } }
        : {}),
    } as ProcessStage;
  });
}

/// Processes: define them, put items in, decide and steer. Intake is a
/// trigger that hands each event to the process instead of a worker.
function processRoutes(processes: ProcessService, triggers: TriggerService | undefined, org: OrgService, draftProcess?: ControlPlaneDeps['draftProcess']): Array<{ method: string; path: RegExp; handle: Handler }> {
  // One picture at a time per person: each is a minute of the model's time.
  const drafting = new Set<string>();
  const intakeOf = (id: string) =>
    (triggers?.list() ?? [])
      .filter((t) => t.hand?.kind === 'process' && t.hand.processId === id)
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        enabled: t.enabled,
        ...(t.slack ? { channel: t.slack.channel } : {}),
        ...(t.watch ? { watch: { server: t.watch.server, tool: t.watch.tool, everyMinutes: t.watch.everyMinutes } } : {}),
        ...(t.lastFiredAt ? { lastFiredAt: t.lastFiredAt } : {}),
        ...(t.lastError ? { lastError: t.lastError } : {}),
      }));
  // Where a process's code lives, by a connected repo's or workspace's name.
  const codeIn = (c: OrgCaller, raw: unknown): { name: string; path: string } | null | undefined | string => {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const name = typeof raw === 'string' ? raw : typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name : '';
    const places = org.repoList(c);
    if (!places.ok) return places.error;
    const repo = places.repos.find((r) => r.name === name);
    const ws = places.workspaces.find((w) => w.name === name);
    return repo ? { name: repo.name, path: repo.path } : ws ? { name: ws.name, path: ws.rootPath } : `No connected repo or workspace called ${name}.`;
  };
  const save = (c: OrgCaller, b: Record<string, unknown>, id?: string) => {
    const code = codeIn(c, b.codeIn);
    if (typeof code === 'string') return { ok: false as const, error: code };
    return processes.save(c, {
      ...(code !== undefined ? { codeIn: code } : {}),
      ...(id ? { id } : {}),
      name: typeof b.name === 'string' ? b.name.slice(0, 120) : '',
      ...(typeof b.shortName === 'string' ? { shortName: b.shortName.slice(0, 40) } : {}),
      ...(typeof b.purpose === 'string' ? { purpose: b.purpose.slice(0, 1000) } : {}),
      ...(typeof b.about === 'string' ? { about: b.about.slice(0, 3000) } : {}),
      ...(typeof b.templateId === 'string' && libraryProcess(b.templateId) ? { templateId: b.templateId } : {}),
      ...(personInput(b.owner) ? { owner: personInput(b.owner)! } : {}),
      stages: stagesInput(b.stages),
      ...(b.access !== undefined ? { access: b.access } : {}),
    });
  };
  return [
    { method: 'GET', path: /^\/api\/processes$/, handle: (c) => ({ ok: true, processes: processes.list(c) }) },
    // Everything in flight for the Inbox: worker runs, team tasks and process
    // items in one list, and the process decisions waiting on this person.
    {
      method: 'GET',
      path: /^\/api\/inflight$/,
      handle: (c) => {
        const runs = org.runningNow(c).map((x) => ({
          kind: 'worker',
          id: x.run.runId,
          workerId: x.workerId,
          title: x.run.title,
          who: x.workerName,
          total: x.run.step.total,
          at: x.run.step.index - 1,
          now: x.run.state === 'working' ? `Step ${x.run.step.index} of ${x.run.step.total} · ${x.run.step.name.replace(/[-_]/g, ' ')}` : x.run.state === 'question' ? 'Has a question for you' : x.run.state === 'approval' ? 'Waiting for your OK' : 'Paused',
          since: x.run.startedAt,
          needsYou: x.run.state === 'question' || x.run.state === 'approval',
        }));
        const tasks = org
          .teamTasks(c)
          .filter((t) => !['done', 'failed', 'cancelled'].includes(t.status))
          .map((t) => {
            const at = Math.max(0, t.stages.findIndex((s) => s.state === 'now' || s.state === 'failed'));
            const cur = t.stages[at];
            return {
              kind: 'team',
              id: t.id,
              title: t.title,
              who: t.teamName,
              total: t.stages.length || 1,
              at: t.stages.length ? (t.stages.every((s) => s.state === 'done') ? t.stages.length : at) : 0,
              now: t.waitingOnYou ? 'Waiting on you' : t.status === 'planning' ? 'Planning' : t.status === 'queued' ? 'Next in line' : t.status === 'review' ? 'Pack ready to review' : cur ? `${cur.label}${cur.who.length ? ` · ${cur.who.join(', ')}` : ''}` : 'Working',
              since: t.updatedAt,
              needsYou: t.waitingOnYou,
              stuck: t.status === 'failed' || cur?.state === 'failed',
            };
          });
        const items = processes.inFlight(c).map((x) => ({
          kind: 'process',
          id: x.item.id,
          processId: x.processId,
          title: x.item.title,
          who: x.process,
          total: x.stages,
          at: x.item.stageIndex,
          now: `${x.item.stageName}${x.item.blocked ? ': stuck' : x.item.stageNote ? ` · ${x.item.stageNote}` : ''}`,
          since: x.item.createdAt,
          needsYou: x.decide,
          stuck: !!x.item.blocked,
        }));
        // A worker working out an answer, or what to do next, before any run
        // starts: the bar's "working" counts it, so in flight does too.
        const deciding = org
          .workingNow(c)
          .filter((x) => x.kind === 'deciding')
          .map((x) => ({ kind: 'worker', id: x.id, workerId: x.workerId, title: x.title, who: x.workerName, total: 1, at: 0, now: `Deciding · ${x.detail}`, since: x.at, needsYou: false }));
        return { ok: true, items: [...deciding, ...runs, ...tasks, ...items] };
      },
    },
    // Who can be picked to lead a stage or decide at one.
    { method: 'GET', path: /^\/api\/directory$/, handle: () => ({ ok: true, ...org.directory(), roles: AUDIENCE_ROLES.map(([id, name]) => ({ id, name })) }) },
    // The library: ways SaaS teams commonly run work, to start from.
    { method: 'GET', path: /^\/api\/process-library$/, handle: () => ({ ok: true, library: PROCESS_LIBRARY }) },
    {
      method: 'GET',
      path: /^\/api\/process-library\/([^/]+)$/,
      handle: (c, _b, [rawId]) => {
        const p = libraryProcess(decodeURIComponent(rawId));
        if (!p) return { ok: false, error: 'No such process in the library.' };
        // For each team stage: a team of yours that fits, or the crew to make one.
        const teams = org.teams(c).filter((t) => t.canBrief);
        const fits = p.stages.map((s) => {
          if (s.kind !== 'team') return { key: s.key, reviewers: s.who };
          const hit = suggestTeamFor(s, teams);
          return hit
            ? { key: s.key, team: { id: hit.team.id, name: hit.team.name }, lead: s.who }
            : { key: s.key, makeTeam: { name: s.name, purpose: s.ask, crew: s.crew ?? [] }, lead: s.who };
        });
        return { ok: true, process: p, fits };
      },
    },
    // From someone's overcli app: its stages name teams by their ids there,
    // so each must have been published first.
    {
      method: 'POST',
      path: /^\/api\/publish\/process$/,
      handle: (c, b) => {
        const localId = typeof b.localId === 'string' ? b.localId.slice(0, 80) : '';
        if (!localId) return { ok: false, error: 'Which process is this?' };
        const stages = stagesInput(b.stages);
        const raw = Array.isArray(b.stages) ? (b.stages as Array<Record<string, unknown>>) : [];
        const missing: string[] = [];
        stages.forEach((st, i) => {
          if (st.kind === 'worker') {
            const local = typeof raw[i]?.localWorkerId === 'string' ? (raw[i].localWorkerId as string) : st.workerId ?? '';
            const id = org.publishedWorkerId(local);
            if (id) st.workerId = id;
            else missing.push(typeof raw[i]?.workerName === 'string' ? (raw[i].workerName as string) : st.name);
            return;
          }
          if (st.kind !== 'team') return;
          const local = typeof raw[i]?.localTeamId === 'string' ? (raw[i].localTeamId as string) : st.teamId ?? '';
          const id = org.publishedTeamId(local);
          if (id) st.teamId = id;
          else missing.push(typeof raw[i]?.teamName === 'string' ? (raw[i].teamName as string) : st.name);
        });
        if (missing.length) return { ok: false, error: `Publish ${missing.join(', ')} to your org first: the process uses ${missing.length === 1 ? 'it' : 'them'}.` };
        return processes.save(c, {
          localId,
          name: typeof b.name === 'string' ? b.name.slice(0, 120) : '',
          ...(typeof b.purpose === 'string' ? { purpose: b.purpose.slice(0, 1000) } : {}),
          ...(personInput(b.owner) ? { owner: personInput(b.owner)! } : {}),
          stages,
          ...(b.access !== undefined ? { access: b.access } : {}),
        });
      },
    },
    { method: 'POST', path: /^\/api\/processes$/, handle: (c, b) => save(c, b) },
    // A process drafted from a picture of one, not saved: the editor opens
    // with it. Anyone who may make a process may draft one.
    {
      method: 'POST',
      path: /^\/api\/processes\/draft-from-image$/,
      handle: async (c, b) => {
        if (!draftProcess) return { ok: false, error: 'Drafting from a picture isn’t set up on this server.' };
        const image = imageFromDataUrl(b.image);
        if (!image.ok) return image;
        const who = c.slackUserId ?? c.name;
        if (drafting.has(who)) return { ok: false, error: 'You’re already drafting one. Wait for it to finish.' };
        drafting.add(who);
        try {
          const dir = org.directory();
          return await draftProcess({
            image: image.image,
            ...(typeof b.note === 'string' && b.note.trim() ? { note: b.note.slice(0, 1000) } : {}),
            teams: org.teams(c).filter((t) => t.canBrief).map((t) => ({ id: t.id, name: t.name, ...(t.purpose ? { purpose: t.purpose } : {}), members: t.members.map((m) => ({ role: m.role })) })),
            workers: org.listWorkers(c).filter((w) => w.enabled).map((w) => ({ id: w.id, name: w.name, tagline: w.tagline })),
            people: dir.people,
          });
        } finally {
          drafting.delete(who);
        }
      },
    },
    {
      method: 'GET',
      path: /^\/api\/processes\/([^/]+)$/,
      handle: (c, _b, [id]) => {
        const res = processes.get(c, decodeURIComponent(id));
        if (!res.ok) return res;
        const schedules = (res.process.schedules ?? []).map((s) => ({ ...s, nextAt: processes.nextAt(s), when: processScheduleText(s.cadence) }));
        // How work comes in names channels and tools: for whoever steers it.
        return { ...res, intake: res.process.canSteer ? intakeOf(res.process.id) : [], schedules };
      },
    },
    { method: 'POST', path: /^\/api\/processes\/([^/]+)$/, handle: (c, b, [id]) => save(c, b, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/processes\/([^/]+)\/archive$/, handle: (c, _b, [id]) => processes.archive(c, decodeURIComponent(id)) },
    {
      method: 'POST',
      path: /^\/api\/processes\/([^/]+)\/items$/,
      handle: (c, b, [id]) =>
        processes.submit({ name: c.name, ...(c.slackUserId ? { slackUserId: c.slackUserId } : {}) }, decodeURIComponent(id), {
          ...(typeof b.title === 'string' ? { title: b.title.slice(0, 200) } : {}),
          brief: typeof b.brief === 'string' ? b.brief.slice(0, 20_000) : '',
          source: b.source === 'desktop' ? 'desktop' : 'console',
          ...(c.admin ? { byAdmin: true } : {}),
        }),
    },
    {
      method: 'GET',
      path: /^\/api\/process-items\/([^/]+)\/file$/,
      handle: (c, _b, [id], url) => processes.artifactFile(c, decodeURIComponent(id), url.searchParams.get('task') ?? '', url.searchParams.get('name') ?? ''),
    },
    {
      method: 'POST',
      path: /^\/api\/process-items\/([^/]+)\/act$/,
      handle: (c, b, [id]) => {
        const action = typeof b.action === 'string' ? b.action : '';
        if (!['approve', 'sendBack', 'stop', 'retry', 'move', 'note', 'startNow'].includes(action)) return { ok: false, error: 'Unknown action.' };
        return processes.act(c, decodeURIComponent(id), action as ItemAction, {
          ...(typeof b.note === 'string' ? { note: b.note.slice(0, 2000) } : {}),
          ...(typeof b.stageIndex === 'number' ? { stageIndex: b.stageIndex } : {}),
          ...(b.answers && typeof b.answers === 'object' ? { answers: b.answers } : {}),
        });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/processes\/([^/]+)\/intake$/,
      handle: (c, b, [rawId]) => {
        const id = decodeURIComponent(rawId);
        if (!triggers) return { ok: false, error: 'Intake runs on the org server.' };
        if (!processes.canSteer(c, id)) return { ok: false, error: 'Only the process owner or an admin can change how work comes in.' };
        const proc = processes.find(id)!;
        const channel = typeof b.channel === 'string' ? b.channel.trim() : '';
        const base = { workerId: '', hand: { kind: 'process' as const, processId: id }, instructions: '', deliver: [], maxPerDay: 50, enabled: true, createdBy: c.name };
        const watch = b.kind === 'watch' ? triggerInput({ kind: 'watch', watch: b.watch }).watch : undefined;
        const res =
          b.kind === 'webhook'
            ? triggers.create({ ...base, name: `${proc.name}: posted events`, kind: 'webhook' })
            : b.kind === 'watch'
              ? watch
                ? triggers.create({ ...base, name: `${proc.name}: new items in ${watch.server}`, kind: 'watch', watch, instructions: typeof b.instructions === 'string' ? b.instructions.slice(0, 2000) : '' })
                : { ok: false as const, error: 'Pick the tool to watch and what to ask it.' }
              : triggers.create({ ...base, name: `${proc.name}: messages in a channel`, kind: 'slack', slack: { channel, on: 'message' } });
        if (!res.ok) return res;
        return { ok: true, intake: intakeOf(id), ...(res.token ? { webhookPath: `/hooks/${res.trigger.id}/${res.token}` } : {}) };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/processes\/([^/]+)\/schedules$/,
      handle: (c, b, [id]) => {
        // Monthly and quarterly are cron ("0 9 1 1,4,7,10 *"); the rest as a worker's.
        const raw = b.cadence as { kind?: unknown; expr?: unknown } | null;
        const cadence = raw?.kind === 'cron' && typeof raw.expr === 'string' && parseCron(raw.expr).ok ? { kind: 'cron' as const, expr: raw.expr } : parseCadence(b.cadence);
        if (!cadence) return { ok: false, error: 'Pick when it starts.' };
        return processes.addSchedule(c, decodeURIComponent(id), { cadence, title: typeof b.title === 'string' ? b.title.slice(0, 200) : '', brief: typeof b.brief === 'string' ? b.brief.slice(0, 10_000) : '' });
      },
    },
    { method: 'POST', path: /^\/api\/processes\/([^/]+)\/schedules\/([^/]+)\/remove$/, handle: (c, _b, [id, sid]) => processes.removeSchedule(c, decodeURIComponent(id), decodeURIComponent(sid)) },
    {
      method: 'POST',
      path: /^\/api\/process-intake\/([^/]+)\/remove$/,
      handle: (c, _b, [rawId]) => {
        const t = triggers?.get(decodeURIComponent(rawId));
        if (!t || t.hand?.kind !== 'process') return { ok: false, error: 'No such intake.' };
        if (!processes.canSteer(c, t.hand.processId)) return { ok: false, error: 'Only the process owner or an admin can change how work comes in.' };
        triggers!.remove(t.id);
        return { ok: true, intake: intakeOf(t.hand.processId) };
      },
    },
  ];
}

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

/// The Slack page: the conversations a person may see, and one thread read
/// from Slack.
function slackRoutes(convos?: SlackConversations): Array<{ method: string; path: RegExp; handle: Handler }> {
  const off = { ok: false as const, error: 'Slack is not connected on this server.' };
  return [
    {
      method: 'GET',
      path: /^\/api\/slack\/stats$/,
      handle: (c, _b, _p, url) =>
        convos?.stats(c, {
          // 0: every day kept.
          days: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : undefined,
          q: url.searchParams.get('q') ?? undefined,
          sort: (url.searchParams.get('sort') ?? undefined) as AskerSort | undefined,
          offset: Number(url.searchParams.get('offset')) || 0,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        }) ?? off,
    },
    // The Slack threads you follow, and stopping one.
    { method: 'GET', path: /^\/api\/slack\/following$/, handle: (c) => convos?.followed?.(c) ?? off },
    { method: 'POST', path: /^\/api\/slack\/following\/stop$/, handle: (c, b) => convos?.unfollow?.(c, typeof b.key === 'string' ? b.key : '') ?? off },
    { method: 'GET', path: /^\/api\/slack\/conversations$/, handle: (c, _b, _p, url) => convos?.list(c, Number(url.searchParams.get('limit')) || undefined) ?? off },
    { method: 'GET', path: /^\/api\/slack\/conversations\/([^/]+)$/, handle: (c, _b, p) => convos?.thread(c, decodeURIComponent(p[0])) ?? off },
  ];
}

/// Setup → Model ids' Test. Each id is a real model call, so admins only,
/// one batch at a time each, and a few batches a minute.
const MAX_MODEL_TESTS = 40;
function modelTestRoutes(testModelIds?: ControlPlaneDeps['testModelIds']): Array<{ method: string; path: RegExp; handle: Handler }> {
  const testing = new Set<string>();
  const allow = rateLimiter(6);
  return [
    {
      method: 'POST',
      path: /^\/api\/admin\/models\/test$/,
      handle: async (c, b) => {
        if (!isAdmin(loadOrgPolicy().policy, c)) return { ok: false, error: 'Only admins can test model ids.' };
        if (!testModelIds) return { ok: false, error: 'Testing model ids isn’t set up on this server.' };
        const models = Array.isArray(b.models) ? b.models.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean) : [];
        if (!models.length) return { ok: false, error: 'Name a model id to test.' };
        if (models.length > MAX_MODEL_TESTS) return { ok: false, error: `Test at most ${MAX_MODEL_TESTS} at once.` };
        const who = c.slackUserId ?? c.name;
        if (testing.has(who)) return { ok: false, error: 'A test is already running. Wait for it to finish.' };
        if (!allow(who)) return { ok: false, error: 'Too many tests. Wait a minute.' };
        testing.add(who);
        try {
          return { ok: true, results: await testModelIds(models) };
        } finally {
          testing.delete(who);
        }
      },
    },
  ];
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
    { method: 'GET', path: /^\/api\/tool-requests$/, handle: (c) => org.toolRequests(c) },
    { method: 'GET', path: /^\/api\/handbook$/, handle: (c) => org.handbook(c) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/learn$/, handle: (c, _b, [id]) => org.learnWorker(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)\/models$/, handle: (c, _b, [id]) => org.modelUpgrades(c, decodeURIComponent(id)) },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/models$/,
      handle: (c, b, [id]) => org.upgradeModels(c, decodeURIComponent(id), { planning: b.planning === true, flows: Array.isArray(b.flows) ? b.flows.filter((f: unknown): f is string => typeof f === 'string').slice(0, 50) : [] }),
    },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/knowledge$/,
      handle: (c, b, [id]) => org.setKnowledge(c, decodeURIComponent(id), { ...(typeof b.body === 'string' ? { body: b.body } : {}), ...(b.refresh === 'weekly' || b.refresh === 'off' ? { refresh: b.refresh } : {}) }),
    },
    { method: 'POST', path: /^\/api\/handbook$/, handle: (c, b) => org.setHandbook(c, str(b.text)) },
    { method: 'GET', path: /^\/api\/digest$/, handle: (c) => org.weeklyDigest(c) },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)\/history$/, handle: (c, _b, [id]) => org.workerHistory(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/restore$/, handle: (c, b, [id]) => org.restoreWorker(c, decodeURIComponent(id), str(b.versionId)) },
    { method: 'POST', path: /^\/api\/tools\/([^/]+)\/trouble\/clear$/, handle: (c, _b, [name]) => org.clearToolTrouble(c, decodeURIComponent(name)) },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/tools\/request$/,
      handle: (c, b, [id]) => org.requestTool(c, decodeURIComponent(id), str(b.tool), typeof b.why === 'string' ? b.why : undefined),
    },
    {
      method: 'POST',
      path: /^\/api\/tool-requests\/([^/]+)\/decide$/,
      handle: (c, b, [id]) => org.decideToolRequest(c, decodeURIComponent(id), b.give === true, typeof b.note === 'string' ? b.note : undefined),
    },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/suggest-job$/,
      handle: (c, b, [id]) => org.suggestJob(c, decodeURIComponent(id), str(b.ask), typeof b.job === 'string' ? b.job : undefined),
    },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)\/how-it-works$/, handle: (c, _b, [id]) => org.workerFlows(c, decodeURIComponent(id)) },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/how-it-works\/suggest$/,
      handle: (c, b, [id]) => org.suggestFlow(c, decodeURIComponent(id), str(b.flowId), str(b.ask), typeof b.yaml === 'string' ? b.yaml : undefined),
    },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/how-it-works$/,
      handle: (c, b, [id]) => org.saveFlowEdit(c, decodeURIComponent(id), str(b.flowId), str(b.yaml), b.everyone === true),
    },
    { method: 'GET', path: /^\/api\/roles$/, handle: (c) => org.roles(c) },
    { method: 'POST', path: /^\/api\/roles\/hire$/, handle: (c, b) => org.hireRole(c, str(b.role), str(b.extra)) },
    { method: 'POST', path: /^\/api\/publish$/, handle: (c, b) => org.publishWorker(c, str(b.yaml), hireOptions(b.options), parseTemplates(b.tools), str(b.localId) || undefined) },
    { method: 'POST', path: /^\/api\/publish\/team$/, handle: (c, b) => org.publishTeam(c, teamPublishInput(b)) },
    { method: 'POST', path: /^\/api\/publish\/setup$/, handle: (c, b, _p, _u, _base, secure) => org.publishSetup(c, setupInput(b), secure) },
    { method: 'GET', path: /^\/api\/setup\/offers$/, handle: (c) => org.setupOffers(c) },
    { method: 'POST', path: /^\/api\/setup\/offers\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.dismissSetupOffer(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/publish\/overdb-connection$/, handle: (c, b) => org.databases.publishOverdbConnection(c, { connection: b.connection }) },
    { method: 'GET', path: /^\/api\/overdb$/, handle: (c) => org.databases.overdbConnections(c) },
    { method: 'GET', path: /^\/api\/overdb\/queries$/, handle: (c) => org.databases.overdbQueries(c) },
    {
      method: 'POST',
      path: /^\/api\/overdb\/offers\/([^/]+)\/approve$/,
      handle: (c, b, [id], _u, _base, secure) => org.databases.approveOverdbConnection(c, decodeURIComponent(id), str(b.password) || undefined, secure),
    },
    { method: 'POST', path: /^\/api\/overdb\/offers\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.databases.dismissOverdbOffer(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/overdb\/connections\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.databases.removeOverdbConnection(c, decodeURIComponent(id)) },
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
    { method: 'POST', path: /^\/api\/repos\/branch-prefix$/, handle: (c, b) => org.setBranchPrefix(c, str(b.prefix)) },
    { method: 'POST', path: /^\/api\/repos\/refresh$/, handle: (c) => org.refreshRepos(c) },
    { method: 'GET', path: /^\/api\/admin\/storage$/, handle: (c) => org.storage(c) },
    { method: 'POST', path: /^\/api\/admin\/storage\/discard$/, handle: (c, b) => org.discardCheckouts(c, str(b.runId)) },
    { method: 'POST', path: /^\/api\/admin\/storage\/clear-cache$/, handle: (c) => org.clearToolCache(c) },
    { method: 'POST', path: /^\/api\/admin\/storage\/clear-build-cache$/, handle: (c) => org.clearBuildCache(c) },
    { method: 'POST', path: /^\/api\/workspaces$/, handle: (c, b) => org.createWorkspace(c, { name: str(b.name), repos: Array.isArray(b.repos) ? b.repos.map(String) : [], instructions: str(b.instructions) || undefined }) },
    { method: 'POST', path: /^\/api\/workspaces\/([^/]+)$/, handle: (c, b, [id]) => org.updateWorkspace(c, decodeURIComponent(id), { ...(Array.isArray(b.repos) ? { repos: b.repos.map(String) } : {}), ...(typeof b.instructions === 'string' ? { instructions: b.instructions } : {}) }) },
    { method: 'POST', path: /^\/api\/workspaces\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.removeWorkspace(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/team-tasks\/([^/]+)\/push$/, handle: (c, _b, [id]) => org.pushTeamCode(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/repos$/, handle: (c, b) => org.connectRepo(c, { url: str(b.url), name: str(b.name) || undefined, testCommand: str(b.testCommand) || undefined }) },
    { method: 'GET', path: /^\/api\/toolchains$/, handle: (c) => org.toolchainList(c) },
    {
      method: 'POST',
      path: /^\/api\/toolchains$/,
      handle: (c, b) => {
        const env = b.env && typeof b.env === 'object' && !Array.isArray(b.env) ? Object.fromEntries(Object.entries(b.env as Record<string, unknown>).map(([k, v]) => [k, str(v)])) : undefined;
        return org.installToolchain(c, { kit: str(b.kit), version: str(b.version), url: str(b.url) || undefined, sha256: str(b.sha256) || undefined, bin: str(b.bin) || undefined, ...(env ? { env } : {}) });
      },
    },
    { method: 'POST', path: /^\/api\/toolchains\/default$/, handle: (c, b) => org.setToolchainDefault(c, str(b.kit), str(b.version)) },
    { method: 'POST', path: /^\/api\/toolchains\/([^/]+)\/remove$/, handle: (c, _b, [id]) => org.removeToolchain(c, decodeURIComponent(id)) },
    { method: 'POST', path: /^\/api\/repos\/pr-mode$/, handle: (c, b) => org.setPrMode(c, str(b.mode)) },
    { method: 'POST', path: /^\/api\/repos\/ticket-status$/, handle: (c, b) => org.setTicketStatus(c, str(b.status)) },
    { method: 'POST', path: /^\/api\/repos\/ci-rounds$/, handle: (c, b) => org.setCiRounds(c, Number(b.rounds)) },
    { method: 'POST', path: /^\/api\/repos\/([^/]+)\/toolchain$/, handle: (c, b, [name]) => org.setRepoToolchain(c, decodeURIComponent(name), str(b.kit), str(b.version) || null) },
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
    // One run in full: its thread, what waits on it, its worker's last runs.
    { method: 'GET', path: /^\/api\/runs\/([^/]+)$/, handle: (c, _b, [id]) => org.runDetail(c, decodeURIComponent(id)) },
    // What each step of a run did: what it wrote, and its activity.
    { method: 'GET', path: /^\/api\/runs\/([^/]+)\/steps$/, handle: (c, _b, [id]) => org.runSteps(c, decodeURIComponent(id)) },
    // Push a finished run again, once what refused it is put right.
    { method: 'POST', path: /^\/api\/runs\/([^/]+)\/push$/, handle: (c, _b, [id]) => org.pushRunAgain(c, decodeURIComponent(id)) },
    // What a run has changed so far; `?diff=1` adds the diff itself.
    { method: 'GET', path: /^\/api\/runs\/([^/]+)\/changes$/, handle: (c, _b, [id], url) => org.runChanges(c, decodeURIComponent(id), url.searchParams.get('diff') === '1') },
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
          ...(b.whoCanBrief === 'managers' || b.whoCanBrief === 'team' || b.whoCanBrief === 'org' ? { whoCanBrief: b.whoCanBrief } : {}),
          ...(b.audience === null ? { audience: null } : (() => { const a = b.audience !== undefined ? parseAudience(b.audience) : null; return a?.ok ? { audience: a.audience } : {}; })()),
          ...(typeof b.budgetUSDPerTask === 'number' ? { budgetUSDPerTask: b.budgetUSDPerTask } : {}),
          ...(typeof b.guidance === 'string' ? { guidance: b.guidance } : {}),
          ...(typeof b.shortName === 'string' ? { shortName: b.shortName.slice(0, 40) } : {}),
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
    // A finished task's team: ask it something, another round, or the pack
    // rewritten with what it said (only the picked changes, when given).
    { method: 'POST', path: /^\/api\/team-tasks\/([^/]+)\/room$/, handle: (c, b, [id]) => org.teamRoom(c, decodeURIComponent(id), { kind: 'ask', text: str(b.text).slice(0, 8000) }) },
    { method: 'POST', path: /^\/api\/team-tasks\/([^/]+)\/room\/continue$/, handle: (c, _b, [id]) => org.teamRoom(c, decodeURIComponent(id), { kind: 'continue' }) },
    {
      method: 'POST',
      path: /^\/api\/team-tasks\/([^/]+)\/update-pack$/,
      handle: (c, b, [id]) =>
        org.teamRoom(c, decodeURIComponent(id), {
          kind: 'updatePack',
          ...(Array.isArray(b.changes) ? { changes: b.changes.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.slice(0, 600)).slice(0, 20) } : {}),
        }),
    },
    {
      method: 'POST',
      path: /^\/api\/team-tasks\/([^/]+)\/comment$/,
      handle: (c, b, [id]) =>
        org.commentOnTeamTask(c, decodeURIComponent(id), {
          text: str(b.text),
          ...(str(b.file) ? { file: str(b.file) } : {}),
          ...(str(b.quote) ? { quote: str(b.quote) } : {}),
          ...(b.about === 'questions' || b.about === 'plan' || b.about === 'coordinator' ? { about: b.about } : {}),
          ...(str(b.workerId) ? { workerId: str(b.workerId) } : {}),
          ...(b.redo === true ? { redo: true } : {}),
        }),
    },
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
    {
      // The Slack app to create, for Connect → Slack.
      method: 'GET',
      path: /^\/api\/admin\/slack-manifest$/,
      handle: (c) => (isAdmin(loadOrgPolicy().policy, c) ? { ok: true, ...slackManifestForConsole() } : { ok: false, error: 'Only admins can set up Slack.' }),
    },
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
    { method: 'POST', path: /^\/api\/approval$/, handle: (c, b) => org.decideRun(c, str(b.runId), b.approve === true, b.forRun === true, b.always === true) },
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
    { method: 'POST', path: /^\/api\/admin\/tools\/adopt$/, handle: (c, b) => org.useToolForConnectors(c, str(b.name)) },
    // Whether a webhook's sender could reach this console at all.
    { method: 'GET', path: /^\/api\/hooks\/reach$/, handle: async (_c, _b, _p, _u, base) => ({ ok: true, ...(await reachOf(base)) }) },
    { method: 'GET', path: /^\/api\/admin\/tools\/([^/]+)\/scope$/, handle: (c, _b, [name]) => org.toolScopePage(c, decodeURIComponent(name)) },
    { method: 'POST', path: /^\/api\/admin\/tools\/([^/]+)\/scope$/, handle: (c, b, [name]) => org.setToolDefault(c, decodeURIComponent(name), b.default ?? null) },
    { method: 'GET', path: /^\/api\/tools\/([^/]+)\/calls$/, handle: (c, _b, [name]) => org.serverTools(c, decodeURIComponent(name)) },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)\/triggers$/, handle: (c, _b, [id]) => org.triggers(c, decodeURIComponent(id)) },
    {
      method: 'GET',
      path: /^\/api\/workers\/([^/]+)\/export$/,
      handle: (c, _b, [id], url) => org.exportWorker(c, decodeURIComponent(id), { learned: url.searchParams.get('learned') === '1', journal: url.searchParams.get('journal') === '1' }),
    },
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
    {
      method: 'POST',
      path: /^\/api\/admin\/tools\/([^/]+)\/settings$/,
      handle: (c, b, [name]) => {
        const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? Object.fromEntries(Object.entries(b.values as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
        return org.updateToolSettings(c, decodeURIComponent(name), values);
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
    {
      method: 'GET',
      path: /^\/api\/watching$/,
      handle: (c, _b, _p, url) => org.watching(c, { q: url.searchParams.get('q') ?? undefined, offset: Number(url.searchParams.get('offset')) || 0, ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}) }),
    },
    { method: 'POST', path: /^\/api\/watching\/follow$/, handle: (c, b) => org.followOrSetUp(c, str(b.item).trim().toUpperCase(), b.on !== false) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/track$/, handle: (c, b, [id]) => org.trackItem(c, decodeURIComponent(id), str(b.item), b.on !== false) },
    { method: 'POST', path: /^\/api\/workers\/([^/]+)\/retire$/, handle: (c, _b, [id]) => org.retire(c, decodeURIComponent(id)) },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/update$/,
      handle: (c, b, [id]) => {
        const patch = { ...((b.patch ?? {}) as Parameters<OrgService['update']>[2]) };
        if (patch && 'audience' in patch && patch.audience !== null) {
          const a = parseAudience(patch.audience);
          if (!a.ok) return a;
          patch.audience = a.audience;
        }
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
  const routes = [
    ...apiRoutes(deps.org, deps.access, deps.slackPeople, links),
    ...(deps.connections ? connectionRoutes(deps.connections) : []),
    ...(deps.processes ? processRoutes(deps.processes, deps.triggers, deps.org, deps.draftProcess) : []),
    ...slackRoutes(deps.slackConversations),
    ...modelTestRoutes(deps.testModelIds),
  ];
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
          if (!caller) return send(res, 401, { ok: false, error: 'You are signed out. Open your sign-in link again, or type /overgo join in Slack.' });
          // This browser's or app's own sign-out: the token stops working
          // here, not just on the device.
          if (req.method === 'POST' && path === '/api/signout') return send(res, 200, { ok: revokeOwnToken(bearer(req)!) });
          const route = routes.find((r) => r.method === req.method && r.path.test(path));
          if (!route) return send(res, 404, { ok: false, error: 'No such route.' });
          // "View as": an admin seeing the console as one person sees it, to
          // check what they can see. Read only: nothing is done in their name.
          let as = caller;
          const viewAs = String(req.headers['x-overgo-view-as'] ?? '').trim();
          if (viewAs) {
            const policy = loadOrgPolicy().policy;
            if (!isAdmin(policy, caller)) return send(res, 403, { ok: false, error: 'Only admins can view the console as someone else.' });
            if (!/^[UW][A-Z0-9]{6,}$/.test(viewAs)) return send(res, 400, { ok: false, error: 'View as whom? That is not a Slack member id.' });
            if (req.method !== 'GET') return send(res, 403, { ok: false, error: "You're viewing as someone else, so nothing can be changed. Stop viewing as them to make changes." });
            let name = viewAs;
            try {
              name = decodeURIComponent(String(req.headers['x-overgo-view-as-name'] ?? '')).trim().slice(0, 80) || viewAs;
            } catch {
              // a name that doesn't decode: their id will do
            }
            const them = { slackUserId: viewAs, name, admin: false };
            as = { ...them, admin: isAdmin(policy, them) };
          }
          let body: Record<string, unknown> = {};
          if (req.method === 'POST') {
            try {
              const parsed = await readBody(req, path.startsWith('/api/publish') ? MAX_PUBLISH_BYTES : path === '/api/processes/draft-from-image' ? MAX_IMAGE_BODY_BYTES : MAX_BODY_BYTES);
              body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
            } catch {
              return send(res, 400, { ok: false, error: 'Send a JSON object.' });
            }
          }
          const params = route.path.exec(path)!.slice(1);
          const answer = await route.handle(as, body, params, url, base, privateChannel(req));
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
