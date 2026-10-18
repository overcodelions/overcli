// Talking to an org's control plane from somewhere else: the desktop app
// publishing a worker you built, or `overcli workers push` from a laptop.
//
// The control plane's own API, over HTTPS, with a person's token — the same
// door the console uses, so publishing is a hire like any other: the org's
// rules apply, you become the worker's manager, and anything over your
// allowance waits for an approver.

import { host } from '../host';
import { log } from '../diagnostics';

import type { ToolTemplate } from './tools';

export const ORG_TOKEN_KEY = 'org-control-token';
export const ORG_TOKEN_ENV = 'OVERCLI_ORG_TOKEN';
export const ORG_URL_ENV = 'OVERCLI_ORG_URL';

const TIMEOUT_MS = 20_000;

export function configuredOrgToken(): string | null {
  try {
    const fromEnv = process.env[ORG_TOKEN_ENV]?.trim();
    if (fromEnv) return fromEnv;
    return host().secrets.get(ORG_TOKEN_KEY)?.trim() || null;
  } catch (err) {
    log('warn', 'org', `Could not read the org token: ${String(err)}`);
    return null;
  }
}

/// The control plane's base URL, checked: https, or http only to this machine.
/// A token sent in the clear to another host is a token anyone on the path has.
export function normalizeOrgUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'That is not a URL. It looks like https://overcli.acme.internal:7420' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    return { ok: false, error: 'Use https:// — your token would travel in the clear over http to another machine.' };
  }
  return { ok: true, url: `${u.protocol}//${u.host}` };
}

async function call<T>(base: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, error: 'The org server did not accept your token. Ask an admin for a new one.' };
    if (!res.ok) return { ok: false, error: `The org server answered HTTP ${res.status}.` };
    const data = (await res.json()) as T & { ok?: boolean; error?: string };
    if (data && typeof data === 'object' && data.ok === false) return { ok: false, error: data.error ?? 'The org server refused.' };
    return { ok: true, data };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'The org server did not answer in time.' : `Could not reach the org server: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export function whoamiAt(base: string, token: string) {
  return call<{ org: string; name: string; admin: boolean; canHire: boolean }>(base, token, 'GET', '/api/whoami');
}

export async function publishToOrg(
  base: string,
  token: string,
  yaml: string,
  options: { reportsTo?: string; visibility?: 'private' | 'team' | 'org'; projectPath?: string } = {},
  tools: ToolTemplate[] = [],
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await call<{ hired?: { name: string }; hire: { status: string; reasons?: string[]; contract?: { name: string } } }>(
    base,
    token,
    'POST',
    '/api/publish',
    { yaml, options, tools },
  );
  if (!res.ok) return res;
  const name = res.data.hired?.name ?? res.data.hire.contract?.name ?? 'The worker';
  return {
    ok: true,
    message: res.data.hired
      ? `${name} is on the org's roster. You're its manager; it starts on probation.`
      : `${name} is waiting for an approver: ${(res.data.hire.reasons ?? []).join(' ')}`,
  };
}

async function callPublic<T>(base: string, path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 429) return { ok: false, error: 'Too many tries. Wait a minute.' };
    if (!res.ok) return { ok: false, error: `The org server answered HTTP ${res.status}.` };
    const data = (await res.json()) as T & { ok?: boolean; error?: string };
    if (data && typeof data === 'object' && data.ok === false) return { ok: false, error: data.error ?? 'The org server refused.' };
    return { ok: true, data };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'The org server did not answer in time.' : `Could not reach the org server: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/// An invite link pasted into the app, as `{ base, code }`, or null when the
/// text is just a server address.
export function parseInviteLink(raw: string): { base: string; code: string } | null {
  try {
    const u = new URL(raw.trim());
    const m = /^\/join\/([A-Za-z0-9_-]{10,100})$/.exec(u.pathname);
    return m ? { base: `${u.protocol}//${u.host}`, code: m[1] } : null;
  } catch {
    return null;
  }
}

/// Sign this app's own token out on the server, so it stops working there
/// and not only here.
export function signOutAt(base: string, token: string) {
  return call<{ ok: boolean }>(base, token, 'POST', '/api/signout');
}

export function redeemInvite(base: string, code: string, device: string) {
  return callPublic<{ token: string; name: string; org: string }>(base, `/api/join/${encodeURIComponent(code)}`, { device });
}

export function startPairing(base: string, device: string) {
  return callPublic<{ pairId: string; userCode: string; pollSecret: string; verifyUrl: string; expiresAt: number }>(base, '/api/pair/start', { device });
}

export function pollPairing(base: string, pairId: string, pollSecret: string) {
  return callPublic<{ status: 'waiting' | 'denied' | 'expired' } | { status: 'signedIn'; token: string; name: string; org: string }>(
    base,
    '/api/pair/poll',
    { pairId, pollSecret },
  );
}
