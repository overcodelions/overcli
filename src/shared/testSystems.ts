// Apps workers test: what Setup → Apps to test keeps for each.
//
// A worker that QAs an app needs a browser that is already signed in, on the
// right environment, without ever holding the password. Each app here says
// where it lives (one address, and a pattern for per-ticket feature
// environments), when an environment is ready, how the server signs in, and
// what to check. The credentials are not here: they sit in the test-systems
// tool's sealed env (toolEnvVault.ts), under the names `credentialEnv` gives.

export const TEST_SYSTEMS_TOOL = 'test-systems';
export const TEST_SYSTEMS_FILE = 'test-systems.json';
export const TEST_SYSTEMS_VERSION = 1;

/// How the server signs in, never the model.
export type TestSignIn =
  /// A login page: the server fills these fields (CSS selectors) and submits.
  /// In order: the username, the extra fields, `nextButton` (a login split
  /// over two screens), the password. `codeField`, with an authenticator
  /// secret, takes a six-digit code, on the same page or the next.
  | {
      kind: 'form';
      loginPath: string;
      userField: string;
      passwordField: string;
      submit: string;
      codeField?: string;
      nextButton?: string;
      extra?: ExtraField[];
      signedOutPath?: string;
    }
  /// A test-only login endpoint: POSTed `{ username, password }`, with the key
  /// as a bearer token when one is set. Its cookies (and, with `tokenKey`, the
  /// `token` in its JSON put in local storage under that key) are the session.
  | { kind: 'endpoint'; path: string; tokenKey?: string; signedOutPath?: string }
  /// No sign-in: a public page, or a feature environment that needs none.
  | { kind: 'none' };

/// Another thing a login page wants: a company or tenant code, a region, a
/// "remember me" box. A secret one's value sits in the tool's sealed env
/// (`extraEnv`), never here.
export interface ExtraField {
  label: string;
  /// From the label: names a secret value's env var.
  key: string;
  selector: string;
  action: 'fill' | 'select' | 'check';
  /// A plain value: typed, or the option picked.
  value?: string;
  secret?: boolean;
}

export const MAX_EXTRA_FIELDS = 6;

export interface TestSystem {
  /// Lowercase, digits and dashes; names its credentials' env vars.
  id: string;
  name: string;
  /// The environment used when none is named, e.g. https://staging.billing.acme.dev.
  url: string;
  /// Per-ticket environments: an address with `{env}` in its host, e.g.
  /// https://{env}.feature.billing.acme.dev. A branch or ticket key becomes `{env}`.
  envPattern?: string;
  /// Polled until it answers 2xx before anything else: a feature environment
  /// still building would look like a broken app.
  healthPath?: string;
  /// How long to wait for that, in seconds.
  readyTimeoutSec?: number;
  signIn: TestSignIn;
  /// What to check and what never to touch: given to the worker on opening it.
  guide: string;
  /// Worker names that may open it. Empty: every worker with the tool.
  workers: string[];
}

export interface TestSystemsFile {
  version: number;
  systems: TestSystem[];
}

/// Where a system's credentials sit in the tool's sealed env.
function envBase(id: string): string {
  return `OVERCLI_TS_${id.toUpperCase().split('-').join('_')}`;
}

/// Where a system's secret extra field's value sits; every one starts with `extraEnvPrefix`.
export function extraEnv(id: string, key: string): string {
  return `${extraEnvPrefix(id)}${key.toUpperCase().split('-').join('_')}`;
}

export function extraEnvPrefix(id: string): string {
  return `${envBase(id)}_X_`;
}

/// The env vars a system's credentials may use: the four, and its secret extra fields'.
export function systemEnvNames(system: TestSystem): string[] {
  const extra = system.signIn.kind === 'form' ? (system.signIn.extra ?? []).filter((e) => e.secret).map((e) => extraEnv(system.id, e.key)) : [];
  return [...Object.values(credentialEnv(system.id)), ...extra];
}

export function credentialEnv(id: string): { user: string; password: string; code: string; key: string } {
  const base = envBase(id);
  return { user: `${base}_USER`, password: `${base}_PASSWORD`, code: `${base}_TOTP`, key: `${base}_KEY` };
}

const ENV_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/// Lowercase letters, digits and single dashes, at most `max` long: a branch
/// ("feat/BILL-123 Export") becomes an environment name ("feat-bill-123-export").
export function slugify(text: string, max = 63): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (ok) out += ch;
    else if (out && !out.endsWith('-')) out += '-';
    if (out.length >= max) break;
  }
  out = out.slice(0, max);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out;
}

function httpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

function withoutTrailingSlash(u: URL): string {
  let p = u.pathname;
  while (p.endsWith('/')) p = p.slice(0, -1);
  return `${u.origin}${p}`;
}

const PLACEHOLDER = 'env-placeholder-x';

/// The host of an env pattern, split around `{env}`, or null when `{env}`
/// isn't once in the host of a valid address.
function patternHost(pattern: string): { protocol: string; before: string; after: string; path: string } | null {
  if (pattern.split('{env}').length !== 2) return null;
  const u = httpUrl(pattern.replace('{env}', PLACEHOLDER));
  if (!u) return null;
  const at = u.host.indexOf(PLACEHOLDER);
  if (at < 0) return null;
  let path = u.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  return { protocol: u.protocol, before: u.host.slice(0, at), after: u.host.slice(at + PLACEHOLDER.length), path };
}

/// The address to open for `environment`: none, the system's own address; a
/// name (a branch, a ticket key), the pattern filled in; a full address, only
/// when it is the system's own or one of its pattern's. Credentials only ever
/// go to an address this returns.
export function resolveEnvironment(system: TestSystem, environment?: string): { ok: true; base: string; env?: string } | { ok: false; error: string } {
  const raw = (environment ?? '').trim();
  if (!raw) return { ok: true, base: system.url };
  const pattern = system.envPattern ? patternHost(system.envPattern) : null;
  const asUrl = raw.includes('://') ? httpUrl(raw) : null;
  if (raw.includes('://')) {
    if (!asUrl) return { ok: false, error: `“${raw}” isn’t an address ${system.name} can be opened at.` };
    const own = httpUrl(system.url);
    if (own && asUrl.origin === own.origin) return { ok: true, base: system.url };
    if (pattern && asUrl.protocol === pattern.protocol && asUrl.host.startsWith(pattern.before) && asUrl.host.endsWith(pattern.after)) {
      const env = asUrl.host.slice(pattern.before.length, asUrl.host.length - pattern.after.length);
      if (ENV_NAME.test(env)) return { ok: true, base: `${pattern.protocol}//${pattern.before}${env}${pattern.after}${pattern.path}`, env };
    }
    return { ok: false, error: `${asUrl.origin} isn’t one of ${system.name}’s environments, so nothing is sent there.` };
  }
  if (!pattern || !system.envPattern) return { ok: false, error: `${system.name} has one environment, ${system.url}. Leave the environment out.` };
  const env = slugify(raw);
  if (!ENV_NAME.test(env)) return { ok: false, error: `“${raw}” doesn’t make an environment name.` };
  return { ok: true, base: `${pattern.protocol}//${pattern.before}${env}${pattern.after}${pattern.path}`, env };
}

/// Where a signed-out browser lands: the system's sign-in page, unless it says otherwise.
export function signedOutPath(system: TestSystem): string | null {
  const s = system.signIn;
  if (s.kind === 'none') return null;
  return s.signedOutPath || (s.kind === 'form' ? s.loginPath : null);
}

/// Whether a worker may open an app: every worker, or one the app names, by
/// its name now or one it went by (a rename never locks it out).
export function mayOpen(system: TestSystem, worker?: string, formerNames: readonly string[] = []): boolean {
  if (!system.workers.length) return true;
  const names = [worker, ...formerNames].filter((n): n is string => !!n && !!n.trim()).map((n) => n.trim().toLowerCase());
  if (!names.length) return false;
  return system.workers.some((x) => names.includes(x.trim().toLowerCase()));
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const path = (v: unknown): string => {
  const p = str(v, 300);
  return p && p.startsWith('/') ? p : '';
};

function parseExtraFields(input: unknown): { ok: true; fields: ExtraField[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: true, fields: [] };
  const fields: ExtraField[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const label = str(e.label, 40);
    const selector = str(e.selector, 300);
    if (!label && !selector) continue;
    if (!label || !selector) return { ok: false, error: 'Each extra field needs a name and how to find it (a CSS selector).' };
    const key = slugify(label, 20);
    if (!key) return { ok: false, error: `Give the extra field “${label}” a name with letters or digits in it.` };
    if (fields.some((f) => f.key === key)) return { ok: false, error: `Two extra fields are called ${label}.` };
    const action = e.action === 'select' || e.action === 'check' ? e.action : 'fill';
    const secret = action !== 'check' && e.secret === true;
    const value = str(e.value, 200);
    if (action !== 'check' && !secret && !value) return { ok: false, error: `Give ${label} a value, or mark it secret and set it with the test account.` };
    fields.push({ label, key, selector, action, ...(action !== 'check' && !secret ? { value } : {}), ...(secret ? { secret: true } : {}) });
  }
  if (fields.length > MAX_EXTRA_FIELDS) return { ok: false, error: `At most ${MAX_EXTRA_FIELDS} extra fields.` };
  return { ok: true, fields };
}

/// A system as typed into the console, checked. `id` comes from the name when absent.
export function parseTestSystem(input: unknown): { ok: true; system: TestSystem } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Describe the app.' };
  const o = input as Record<string, unknown>;
  const name = str(o.name, 80);
  if (!name) return { ok: false, error: 'Give the app a name.' };
  const id = str(o.id, 40) || slugify(name, 40);
  if (!ID.test(id)) return { ok: false, error: 'Give the app a name with some letters or digits in it.' };
  const url = httpUrl(str(o.url, 500));
  if (!url) return { ok: false, error: 'Its address should be a full address, like https://staging.billing.acme.dev.' };
  const envPattern = str(o.envPattern, 500);
  if (envPattern && !patternHost(envPattern)) return { ok: false, error: 'Its feature environments’ address needs {env} once in the host, like https://{env}.feature.billing.acme.dev.' };
  const healthPath = str(o.healthPath, 300);
  if (healthPath && !healthPath.startsWith('/')) return { ok: false, error: 'The health check is a path on the app, starting with /, like /health.' };
  const timeout = typeof o.readyTimeoutSec === 'number' && Number.isFinite(o.readyTimeoutSec) ? Math.round(o.readyTimeoutSec) : undefined;
  if (timeout !== undefined && (timeout < 10 || timeout > 1800)) return { ok: false, error: 'Wait between 10 seconds and 30 minutes for an environment.' };
  const s = (o.signIn && typeof o.signIn === 'object' ? o.signIn : { kind: 'none' }) as Record<string, unknown>;
  let signIn: TestSignIn;
  if (s.kind === 'form') {
    const loginPath = path(s.loginPath);
    const userField = str(s.userField, 300);
    const passwordField = str(s.passwordField, 300);
    const submit = str(s.submit, 300);
    if (!loginPath) return { ok: false, error: 'Say where the sign-in page is: a path starting with /, like /login.' };
    if (!userField || !passwordField || !submit) return { ok: false, error: 'Say how to find the username field, the password field and the sign-in button (CSS selectors, like #email).' };
    const codeField = str(s.codeField, 300);
    const nextButton = str(s.nextButton, 300);
    const out = path(s.signedOutPath);
    const extra = parseExtraFields(s.extra);
    if (!extra.ok) return extra;
    signIn = {
      kind: 'form',
      loginPath,
      userField,
      passwordField,
      submit,
      ...(codeField ? { codeField } : {}),
      ...(nextButton ? { nextButton } : {}),
      ...(extra.fields.length ? { extra: extra.fields } : {}),
      ...(out ? { signedOutPath: out } : {}),
    };
  } else if (s.kind === 'endpoint') {
    const at = path(s.path);
    if (!at) return { ok: false, error: 'Say where the test login endpoint is: a path starting with /, like /test/login.' };
    const tokenKey = str(s.tokenKey, 100);
    const out = path(s.signedOutPath);
    signIn = { kind: 'endpoint', path: at, ...(tokenKey ? { tokenKey } : {}), ...(out ? { signedOutPath: out } : {}) };
  } else {
    signIn = { kind: 'none' };
  }
  const workers = Array.isArray(o.workers) ? o.workers.map((w) => str(w, 80)).filter(Boolean).slice(0, 50) : [];
  return {
    ok: true,
    system: {
      id,
      name,
      url: withoutTrailingSlash(url),
      ...(envPattern ? { envPattern } : {}),
      ...(healthPath ? { healthPath } : {}),
      ...(timeout !== undefined ? { readyTimeoutSec: timeout } : {}),
      signIn,
      guide: str(o.guide, 4000),
      workers,
    },
  };
}
