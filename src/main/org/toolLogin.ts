// Whether a tool's stored keys actually sign in. A server that starts with a
// bad token still "connects": it lists its tools and then answers every
// question as an anonymous visitor would — empty — and a worker reports "no
// data" without knowing why. One read-only "who am I" call with the stored
// keys says so up front, and who it is signed in as when it works.

import { isReadOnlyMcpTool } from '../../shared/flows/mcpTools';

export interface LoginResult {
  state: 'ok' | 'rejected' | 'unreachable';
  /// Who the keys sign in as, when they do.
  as?: string;
  /// Why not, in words an admin can act on.
  reason?: string;
  at: number;
}

interface Probe {
  label: string;
  /// The settings the answer is about.
  keys: string[];
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  who(json: unknown): string | undefined;
  hint?: string;
}

const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const field = (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const ATLASSIAN_HINT = 'Use a plain API token (not one “with scopes”), made by the account whose email is in';

/// The "who am I" calls for the settings we recognise.
export function loginProbes(env: Record<string, string>): Probe[] {
  const out: Probe[] = [];
  const atlassian = (prefix: 'JIRA' | 'CONFLUENCE', label: string, path: (base: string) => string) => {
    const base = str(env[`${prefix}_URL`])?.replace(/\/+$/, '');
    if (!base || !/^https?:\/\//.test(base)) return;
    const user = str(env[`${prefix}_USERNAME`]);
    const token = str(env[`${prefix}_API_TOKEN`]);
    const pat = str(env[`${prefix}_PERSONAL_TOKEN`]);
    if (user && token) out.push({ label, keys: [`${prefix}_USERNAME`, `${prefix}_API_TOKEN`], url: path(base), headers: { Authorization: basic(user, token) }, who: (j) => str(field(j, 'displayName')) ?? str(field(j, 'emailAddress')), hint: `${ATLASSIAN_HINT} ${prefix}_USERNAME.` });
    else if (pat) out.push({ label, keys: [`${prefix}_PERSONAL_TOKEN`], url: path(base), headers: { Authorization: `Bearer ${pat}` }, who: (j) => str(field(j, 'displayName')) ?? str(field(j, 'name')) });
  };
  atlassian('JIRA', 'Jira', (b) => `${b}/rest/api/2/myself`);
  atlassian('CONFLUENCE', 'Confluence', (b) => `${/atlassian\.net$/.test(b) ? `${b}/wiki` : b}/rest/api/user/current`);
  const gh = str(env.GITHUB_PERSONAL_ACCESS_TOKEN) ?? str(env.GITHUB_TOKEN);
  if (gh) out.push({ label: 'GitHub', keys: [env.GITHUB_PERSONAL_ACCESS_TOKEN ? 'GITHUB_PERSONAL_ACCESS_TOKEN' : 'GITHUB_TOKEN'], url: 'https://api.github.com/user', headers: { Authorization: `Bearer ${gh}`, 'User-Agent': 'overcli' }, who: (j) => str(field(j, 'login')) });
  const linear = str(env.LINEAR_API_KEY);
  if (linear) out.push({ label: 'Linear', keys: ['LINEAR_API_KEY'], url: 'https://api.linear.app/graphql', method: 'POST', headers: { Authorization: linear, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { name } }' }), who: (j) => str(field(field(field(j, 'data'), 'viewer'), 'name')) });
  return out;
}

type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/// Run the recognised checks. Null: nothing here we know how to check.
export async function checkLogin(env: Record<string, string>, now: number, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 10_000): Promise<LoginResult | null> {
  const probes = loginProbes(env);
  if (!probes.length) return null;
  const who: string[] = [];
  for (const p of probes) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(p.url, { method: p.method ?? 'GET', headers: { Accept: 'application/json', ...p.headers }, ...(p.body ? { body: p.body } : {}), signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { state: 'rejected', reason: `${p.label} didn’t accept ${p.keys.join(' / ')} (${res.status}).${p.hint ? ` ${p.hint}` : ''}`, at: now };
      }
      if (res.status >= 400) return { state: 'unreachable', reason: `${p.label} answered ${res.status} to a sign-in check.`, at: now };
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Not JSON: signed in, name unknown.
      }
      // GraphQL says no with a 200 and an error.
      if (p.label === 'Linear' && !p.who(json)) return { state: 'rejected', reason: `Linear didn’t accept LINEAR_API_KEY.`, at: now };
      const name = p.who(json);
      if (name) who.push(`${name} on ${p.label}`);
    } catch (err) {
      return { state: 'unreachable', reason: `Couldn’t reach ${p.label} to check its sign-in: ${err instanceof Error ? err.message : String(err)}`, at: now };
    } finally {
      clearTimeout(timer);
    }
  }
  return { state: 'ok', ...(who.length ? { as: who.join(', ') } : {}), at: now };
}

const AUTH_FAILED = /\b(401|403)\b|unauthori[sz]ed|unauthenticated|not authenticated|must be authenticated|invalid (api )?(token|key|credentials)|authentication failed|bad credentials|access denied/i;

/// For a tool we don't recognise: call one tool that only reads and takes no
/// input, and read its answer for a refused sign-in. Weaker than a real
/// check — null when there's no such tool or nothing says either way.
export async function checkLoginByCall(
  list: () => Promise<{ ok: true; tools: Array<{ name: string; inputSchema?: unknown }> } | { ok: false; error: string }>,
  call: (tool: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>,
  serverKey: string,
  now: number,
): Promise<LoginResult | null> {
  const listed = await list();
  if (!listed.ok) return null;
  const pick = listed.tools.find((t) => {
    const required = field(t.inputSchema, 'required');
    return isReadOnlyMcpTool(`mcp__${serverKey}__${t.name}`) && (!Array.isArray(required) || required.length === 0);
  });
  if (!pick) return null;
  const res = await call(pick.name);
  const text = res.ok ? res.text : res.error;
  if (AUTH_FAILED.test(text.slice(0, 2000))) return { state: 'rejected', reason: `Asking it ${pick.name} came back refused: “${text.replace(/\s+/g, ' ').trim().slice(0, 160)}”. Check its keys.`, at: now };
  return res.ok ? { state: 'ok', at: now } : null;
}
