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

import http from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { callerForToken, loadOrgPolicy } from '../main/org/orgStores';
import { Store } from '../main/store';
import type { ScheduleTrigger } from '../shared/flows/schedule';
import type { AccessService, PersonRole } from '../main/org/accessService';
import type { SlackPerson } from '../main/slack/slackApi';
import type { OrgService } from '../main/org/orgService';
import type { OrgCaller } from '../shared/org/policy';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_ICON, CONSOLE_JS } from './consoleAssets';
import { registerOrgTools } from './orgMcpTools';

/// A request body larger than this is refused unread. Every legitimate body
/// here is a short JSON object.
const MAX_BODY_BYTES = 1_000_000;

export interface ControlPlaneDeps {
  org: OrgService;
  /// Invites, join requests and pairing the overcli app. Absent: the console
  /// still works with tokens made on the server.
  access?: AccessService;
  /// People in the org's Slack, for the invite picker. Absent: no picker.
  slackPeople?: () => Promise<SlackPerson[]>;
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

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
};

type Handler = (caller: OrgCaller, body: Record<string, unknown>, params: string[], url: URL, base: string) => unknown | Promise<unknown>;
type PublicHandler = (body: Record<string, unknown>, params: string[], base: string) => unknown | Promise<unknown>;

/// The console's JSON API. Every handler returns what `OrgService` returned,
/// so a refusal arrives as `{ ok: false, error }` with status 200 — it is an
/// answer, not a transport failure.
const ROLES = new Set(['member', 'hirer', 'approver', 'admin']);

/// People: invites, join requests, roles, sign-ins.
function accessRoutes(access: AccessService, slackPeople?: () => Promise<SlackPerson[]>): Array<{ method: string; path: RegExp; handle: Handler }> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const role = (v: unknown): PersonRole => (ROLES.has(str(v)) ? (str(v) as PersonRole) : 'member');
  const money = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return [
    { method: 'GET', path: /^\/api\/admin\/invites$/, handle: (c) => access.invites(c) },
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
    { method: 'POST', path: /^\/api\/devices\/([^/]+)\/signout$/, handle: (c, _b, [id]) => access.signOutDevice(c, id) },
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
      hits.set(key, { at: now, n: 1 });
      if (hits.size > 10_000) hits.clear();
      return true;
    }
    h.n++;
    return h.n <= perMinute;
  };
}

/// Where this request reached us, as the person's browser sees it — the base
/// for links handed back to them.
function originOf(req: http.IncomingMessage): string {
  const fwdProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : 'encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? `${proto}://${host}` : 'http://localhost';
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

function apiRoutes(org: OrgService, access?: AccessService, slackPeople?: () => Promise<SlackPerson[]>): Array<{ method: string; path: RegExp; handle: Handler }> {
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
    { method: 'POST', path: /^\/api\/publish$/, handle: (c, b) => org.publishWorker(c, str(b.yaml), hireOptions(b.options)) },
    { method: 'GET', path: /^\/api\/teams$/, handle: (c) => org.teams(c) },
    { method: 'GET', path: /^\/api\/team-tasks$/, handle: (c) => org.teamTasks(c) },
    { method: 'POST', path: /^\/api\/teams\/brief$/, handle: (c, b) => org.briefTeam(c, str(b.team), str(b.text)) },
    {
      method: 'POST',
      path: /^\/api\/team-tasks\/([^/]+)$/,
      handle: (c, b, [id]) => {
        const kind = str(b.kind);
        if (kind === 'answer') return org.decideTeamTask(c, id, { kind, answers: Array.isArray(b.answers) ? b.answers.map(String) : [str(b.answers)] });
        if (kind === 'revise') return org.decideTeamTask(c, id, { kind, feedback: str(b.feedback) });
        if (kind === 'approve' || kind === 'continue' || kind === 'cancel') return org.decideTeamTask(c, id, { kind });
        return { ok: false, error: 'Say answer, approve, revise, continue or cancel.' };
      },
    },
    { method: 'GET', path: /^\/api\/admin\/people$/, handle: (c) => org.people(c) },
    { method: 'GET', path: /^\/api\/admin\/health$/, handle: (c) => org.health(c) },
    { method: 'GET', path: /^\/api\/admin\/audit$/, handle: (c) => org.auditLog(c, 60) },
    { method: 'GET', path: /^\/api\/projects$/, handle: () => workPlaces() },
    ...(access ? accessRoutes(access, slackPeople) : []),
    { method: 'GET', path: /^\/api\/whoami$/, handle: (c) => org.whoami(c) },
    { method: 'GET', path: /^\/api\/workers$/, handle: (c) => org.listWorkers(c) },
    { method: 'GET', path: /^\/api\/workers\/([^/]+)$/, handle: (c, _b, [id]) => org.getWorker(c, decodeURIComponent(id)) },
    { method: 'GET', path: /^\/api\/chart$/, handle: (c) => org.orgChart(c) },
    { method: 'GET', path: /^\/api\/waiting$/, handle: (c) => org.listWaiting(c) },
    { method: 'GET', path: /^\/api\/hires$/, handle: (c) => org.listHires(c) },
    { method: 'POST', path: /^\/api\/answer$/, handle: (c, b) => org.answer(c, str(b.runId), str(b.answer)) },
    { method: 'POST', path: /^\/api\/approval$/, handle: (c, b) => org.decideRun(c, str(b.runId), b.approve === true) },
    { method: 'POST', path: /^\/api\/ask$/, handle: (c, b) => org.ask(c, str(b.worker), str(b.message)) },
    {
      method: 'POST',
      path: /^\/api\/workers\/([^/]+)\/paused$/,
      handle: (c, b, [id]) => org.setPaused(c, decodeURIComponent(id), b.paused === true),
    },
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
  ];
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, org: OrgService, caller: OrgCaller): Promise<void> {
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
  registerOrgTools(server, org, caller);
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
  const routes = apiRoutes(deps.org, deps.access, deps.slackPeople);
  const open = deps.access ? publicRoutes(deps.access) : [];
  const allow = rateLimiter(60);

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      try {
        if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
        // The join and pairing pages are the console too: it reads the path.
        if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/pair' || /^\/join\/[A-Za-z0-9_-]{10,100}$/.test(path))) {
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
        if (req.method === 'GET' && path === '/console.css') {
          res.writeHead(200, { ...ASSET_HEADERS, 'Content-Type': 'text/css; charset=utf-8' });
          return res.end(CONSOLE_CSS);
        }

        const base = loadOrgPolicy().policy.publicUrl ?? originOf(req);
        const openRoute = open.find((r) => r.method === req.method && r.path.test(path));
        if (openRoute) {
          if (!allow(req.socket.remoteAddress ?? 'unknown')) return send(res, 429, { ok: false, error: 'Too many tries. Wait a minute.' });
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

        const caller = authenticate(bearer(req));
        if (caller) deps.access?.noteOrigin(originOf(req));
        if (path === '/mcp') {
          if (!caller) {
            return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'A bearer token from `overcli tokens create` is required.' }, id: null }, {
              'WWW-Authenticate': 'Bearer',
            });
          }
          if (req.method !== 'POST') {
            return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
          }
          return await handleMcp(req, res, deps.org, caller);
        }

        if (path.startsWith('/api/')) {
          if (!caller) return send(res, 401, { ok: false, error: 'Sign in with a token from `overcli tokens create`.' });
          const route = routes.find((r) => r.method === req.method && r.path.test(path));
          if (!route) return send(res, 404, { ok: false, error: 'No such route.' });
          let body: Record<string, unknown> = {};
          if (req.method === 'POST') {
            try {
              const parsed = await readBody(req);
              body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
            } catch {
              return send(res, 400, { ok: false, error: 'Send a JSON object.' });
            }
          }
          const params = route.path.exec(path)!.slice(1);
          return send(res, 200, await route.handle(caller, body, params, url, base));
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
