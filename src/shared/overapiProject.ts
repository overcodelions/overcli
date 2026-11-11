// An API overapi publishes to the org, through this app.
//
// overapi owns the format (its src/shared/overgo.ts and project.ts); this is
// the reading end, kept in step the way overdbConnection.ts is with overdb.
// A push is one project — the API's tools and how to call them — trimmed to
// the one environment the server should serve, plus the NAMES of the
// variables that environment reads. It never carries a secret: overapi's
// project file only ever names variables, and the admin types their values
// into the console.
//
// overgo writes an approved project to `org/overapi/<name>.json` and runs
// overapi's CLI on it as it is (`node dist/cli/index.js serve FILE --env E`),
// so the project is checked here only as deep as the server relies on it —
// the name it files it under, the environment and where it points, the
// variables it reads and what each tool may do — and carried as published.
//
// overapi drops each one into `~/.overcli/inbox/apis/`, a folder of its own
// for the same reason as overdb's connections: overapi offers to publish only
// once that folder exists, so this app creating it is the whole handshake.

export const API_PUSH_VERSION = 1;
export const API_PUSH_KIND = 'overapi-project';
/// A project with hundreds of tools is a few hundred kilobytes. Anything
/// near this is not one.
export const API_PUSH_MAX_BYTES = 4 * 1024 * 1024;
/// Every published API is a tool of its own, named after the project.
export const OVERAPI_TOOL_PREFIX = 'overapi-';

export type OverapiSafety = 'read' | 'write' | 'destructive';
export type OverapiAuth =
  | { type: 'none' }
  | { type: 'bearer'; tokenVar: string }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; valueVar: string }
  | { type: 'basic'; userVar: string; passVar: string }
  | { type: 'wsse'; userVar: string; passVar: string }
  /// Sign in by running one of the API's own requests (overapi's
  /// "log in with a request"): the tool with id `toolId` runs first, its
  /// response's token is sent on every other call. Its credentials are
  /// `${SECRET}`s in that tool's saved values — listed in the push's secrets.
  | { type: 'login'; toolId: string; from: 'body' | 'header'; path: string; sendAs: 'bearer' | 'header' | 'query' | 'cookie'; name?: string; refreshMinutes?: number };

export interface OverapiEnv {
  name: string;
  baseUrl: string;
  auth: OverapiAuth;
  /// Write and destructive tools are hidden from agents unless this is on.
  allowWrites: boolean;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface OverapiTool {
  name: string;
  method: string;
  path: string;
  safety: OverapiSafety;
  enabled?: boolean;
  description?: string;
  [key: string]: unknown;
}

/// The part of overapi's Project this app reads. The rest (params, body
/// modes, instructions) is carried for overapi's CLI, never interpreted.
export interface OverapiProject {
  overapi: 1;
  name: string;
  title?: string;
  description?: string;
  envs: OverapiEnv[];
  tools: OverapiTool[];
  [key: string]: unknown;
}

export interface ApiPush {
  version: typeof API_PUSH_VERSION;
  kind: typeof API_PUSH_KIND;
  id: string;
  createdAt: string;
  /// The environment the server should serve.
  env: string;
  /// Variable names the server must be given values for.
  secrets: string[];
  project: OverapiProject;
}

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
/// Lower-case, [a-z0-9-]: what overapi's slug makes, and safe as a file name.
const PROJECT_NAME_RE = /^[a-z0-9-]+$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SAFETY: readonly OverapiSafety[] = ['read', 'write', 'destructive'];

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function overapiToolName(projectName: string): string {
  return `${OVERAPI_TOOL_PREFIX}${projectName}`;
}

/// Every variable an environment's auth and headers read — overapi's envVars.
/// A login sign-in reads none itself: its credentials live on its request.
export function overapiEnvVars(env: OverapiEnv): string[] {
  const out = new Set<string>();
  const a = env.auth;
  if (a.type === 'bearer') out.add(a.tokenVar);
  if (a.type === 'apiKey') out.add(a.valueVar);
  if (a.type === 'basic' || a.type === 'wsse') {
    out.add(a.userVar);
    out.add(a.passVar);
  }
  for (const v of Object.values(env.headers ?? {})) {
    for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]);
  }
  return [...out].filter(Boolean);
}

function parseAuth(raw: unknown): OverapiAuth | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const v = (x: unknown): x is string => typeof x === 'string' && ENV_VAR_RE.test(x);
  if (a.type === 'none') return { type: 'none' };
  if (a.type === 'bearer' && v(a.tokenVar)) return { type: 'bearer', tokenVar: a.tokenVar };
  if (a.type === 'apiKey' && (a.in === 'header' || a.in === 'query') && str(a.name) && v(a.valueVar)) return { type: 'apiKey', in: a.in, name: a.name, valueVar: a.valueVar };
  if (a.type === 'basic' && v(a.userVar) && v(a.passVar)) return { type: 'basic', userVar: a.userVar, passVar: a.passVar };
  if (a.type === 'wsse' && v(a.userVar) && v(a.passVar)) return { type: 'wsse', userVar: a.userVar, passVar: a.passVar };
  if (
    a.type === 'login' &&
    str(a.toolId) &&
    (a.from === 'body' || a.from === 'header') &&
    str(a.path) &&
    (a.sendAs === 'bearer' || a.sendAs === 'header' || a.sendAs === 'query' || a.sendAs === 'cookie') &&
    (a.name === undefined || typeof a.name === 'string') &&
    (a.refreshMinutes === undefined || (typeof a.refreshMinutes === 'number' && a.refreshMinutes > 0))
  ) {
    return {
      type: 'login',
      toolId: a.toolId,
      from: a.from,
      path: a.path,
      sendAs: a.sendAs,
      ...(typeof a.name === 'string' ? { name: a.name } : {}),
      ...(typeof a.refreshMinutes === 'number' ? { refreshMinutes: a.refreshMinutes } : {}),
    };
  }
  return null;
}

/// `${NAME}`s in any value — a header, a tool's saved values.
function secretRefs(v: unknown): string[] {
  return [...JSON.stringify(v ?? {}).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

/// Every variable serving this environment reads: the environment's sign-in
/// and headers, and each tool's own — its sign-in, its fixed headers and
/// the values saved on it (a login request's password). overapi's
/// secretNames, for the one environment published.
export function overapiSecretsRead(project: OverapiProject, env: OverapiEnv): string[] {
  const out = new Set(overapiEnvVars(env));
  for (const t of project.tools) {
    const a = parseAuth(t.auth);
    if (a) for (const v of overapiEnvVars({ name: '', baseUrl: '', allowWrites: false, auth: a })) out.add(v);
    for (const v of secretRefs(t.headers)) out.add(v);
    for (const v of secretRefs(t.example)) out.add(v);
  }
  return [...out].filter(Boolean);
}

/// One environment, checked where the server relies on it: where it points,
/// how it signs in, whether it lets writes through.
function parseEnv(raw: unknown): { ok: true; env: OverapiEnv } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'an environment is not an object' };
  const e = raw as Record<string, unknown>;
  if (!str(e.name) || e.name.length > 100) return { ok: false, reason: 'an environment needs a name' };
  if (!str(e.baseUrl) || !/^https?:\/\//i.test(e.baseUrl) || e.baseUrl.length > 2000) return { ok: false, reason: `${e.name} needs an http(s) base URL` };
  if (typeof e.allowWrites !== 'boolean') return { ok: false, reason: `${e.name} must say whether it allows writes` };
  const auth = parseAuth(e.auth);
  if (!auth) return { ok: false, reason: `${e.name}: auth must be none, bearer, apiKey, basic or login, naming its variables in CAPITALS` };
  if (e.headers !== undefined) {
    if (!e.headers || typeof e.headers !== 'object' || Array.isArray(e.headers)) return { ok: false, reason: `${e.name}: headers must be an object` };
    if (Object.values(e.headers).some((h) => typeof h !== 'string')) return { ok: false, reason: `${e.name}: header values must be text` };
  }
  return { ok: true, env: { ...e, name: e.name, baseUrl: e.baseUrl, allowWrites: e.allowWrites, auth } as OverapiEnv };
}

function parseProject(raw: unknown): { ok: true; project: OverapiProject } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the project is not an object' };
  const p = raw as Record<string, unknown>;
  if (p.overapi !== 1) return { ok: false, reason: 'missing "overapi": 1 — not an overapi project' };
  if (typeof p.name !== 'string' || !PROJECT_NAME_RE.test(p.name) || p.name.length > 64) return { ok: false, reason: 'the project name must be lower-case letters, digits and dashes' };
  const fail = (why: string) => ({ ok: false as const, reason: `${p.name}: ${why}` });
  if (p.title !== undefined && typeof p.title !== 'string') return fail('title must be text');
  if (!Array.isArray(p.envs) || !p.envs.length) return fail('needs an environment');
  if (!Array.isArray(p.tools) || !p.tools.length) return fail('needs at least one tool');
  if (p.tools.length > 2000) return fail('has more tools than any API needs');
  const envs: OverapiEnv[] = [];
  for (const e of p.envs) {
    const parsed = parseEnv(e);
    if (!parsed.ok) return fail(parsed.reason);
    envs.push(parsed.env);
  }
  const seen = new Set<string>();
  for (const t of p.tools as unknown[]) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return fail('a tool is not an object');
    const o = t as Record<string, unknown>;
    if (typeof o.name !== 'string' || !TOOL_NAME_RE.test(o.name)) return fail('a tool needs a name of letters, digits, _ and -');
    if (seen.has(o.name)) return fail(`two tools are called ${o.name}`);
    seen.add(o.name);
    if (typeof o.method !== 'string' || !METHODS.includes(o.method.toUpperCase())) return fail(`${o.name} needs an HTTP method`);
    if (typeof o.path !== 'string') return fail(`${o.name} needs a path`);
    // overapi treats anything but read as a write; an unknown value here
    // is a newer format, and the console must not show it as a read.
    if (!(SAFETY as readonly unknown[]).includes(o.safety)) return fail(`${o.name}: safety must be one of ${SAFETY.join(', ')}`);
  }
  // Steps that run first, and sign-ins, point at other tools by id: those
  // must be in the push, or the server would fail on the first call.
  const ids = new Set((p.tools as Record<string, unknown>[]).map((t) => t.id).filter((x): x is string => typeof x === 'string'));
  for (const t of p.tools as Record<string, unknown>[]) {
    if (t.before === undefined) continue;
    if (!Array.isArray(t.before)) return fail(`${String(t.name)}: "before" must be a list`);
    for (const b of t.before as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object' || !str(b.toolId) || (b.when !== 'always' && b.when !== 'missing') || (b.var !== undefined && typeof b.var !== 'string')) {
        return fail(`${String(t.name)}: a step that runs first must name a request and say when`);
      }
      if (!ids.has(b.toolId)) return fail(`${String(t.name)} runs ${b.toolId} first, which isn't in the push`);
    }
  }
  for (const e of envs) {
    if (e.auth.type === 'login' && !ids.has(e.auth.toolId)) return fail(`${e.name} signs in with ${e.auth.toolId}, which isn't in the push`);
  }
  return { ok: true, project: { ...p, envs } as OverapiProject };
}

/// The push as overapi wrote it, checked. The project is carried as
/// published, with its environments' auth rebuilt from what was checked.
export function parseApiPush(raw: unknown): { ok: true; push: ApiPush } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.kind !== API_PUSH_KIND) return { ok: false, reason: `unknown kind ${JSON.stringify(r.kind)}` };
  if (r.version !== API_PUSH_VERSION) return { ok: false, reason: `version ${String(r.version)}; this overcli reads version ${API_PUSH_VERSION}` };
  if (!str(r.id) || r.id.length > 100) return { ok: false, reason: 'needs an id' };
  if (!str(r.createdAt) || Number.isNaN(Date.parse(r.createdAt))) return { ok: false, reason: 'needs a createdAt time' };
  if (!str(r.env)) return { ok: false, reason: 'needs the environment to serve' };
  if (!Array.isArray(r.secrets) || !r.secrets.every((s): s is string => typeof s === 'string' && ENV_VAR_RE.test(s))) {
    return { ok: false, reason: 'secrets must be variable names in CAPITALS' };
  }
  const parsed = parseProject(r.project);
  if (!parsed.ok) return parsed;
  const project = parsed.project;
  const env = project.envs.find((e) => e.name === r.env);
  if (!env) return { ok: false, reason: `${project.name} has no environment called ${String(r.env)}` };
  const secrets = [...new Set(r.secrets as string[])];
  // Every variable the environment reads must be one the admin is asked
  // for: an unlisted one would be read from wherever the tool happens to run.
  const unlisted = overapiSecretsRead(project, env).filter((v) => !secrets.includes(v));
  if (unlisted.length) return { ok: false, reason: `${project.name} reads ${unlisted.join(', ')} without listing it as a secret` };
  return { ok: true, push: { version: API_PUSH_VERSION, kind: API_PUSH_KIND, id: r.id, createdAt: r.createdAt, env: r.env, secrets, project } };
}

/// The environment a push serves. Present: parseApiPush checked it.
export function pushEnv(push: Pick<ApiPush, 'env' | 'project'>): OverapiEnv {
  return push.project.envs.find((e) => e.name === push.env)!;
}
