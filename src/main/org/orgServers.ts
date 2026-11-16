// The org servers this app is signed in to.
//
// Each is an entry in AppSettings.orgServers with its own token in the
// keychain. The first keeps the id `primary` and the keychain key the app
// used before there could be several (`org-control-token`), so an app signed
// in before this change stays signed in. Main owns the list: Settings and the
// Org tab change it through IPC, and a settings save from the renderer keeps
// main's copy (index.ts), so a stale renderer can't undo a sign-in.
//
// `orgServerUrl` stays in step with the default server, for the pieces that
// only ever knew one.

import type { AppSettings, OrgServerEntry } from '../../shared/types';
import { host } from '../host';
import { log } from '../diagnostics';
import { Store } from '../store';
import { ORG_TOKEN_ENV, ORG_TOKEN_KEY, normalizeOrgUrl } from './orgClient';

export const PRIMARY_ID = 'primary';
const SIGN_IN_FIRST = 'Sign this app in to your org first: Settings → Your orgs. No org server yet? The guide there shows how to run one.';

/// The list as stored, or made from the single server of before.
export function orgServersIn(settings: AppSettings): OrgServerEntry[] {
  if (Array.isArray(settings.orgServers)) return settings.orgServers.filter((e) => e && typeof e.id === 'string' && typeof e.url === 'string');
  const url = settings.orgServerUrl ? normalizeOrgUrl(settings.orgServerUrl) : null;
  return url?.ok ? [{ id: PRIMARY_ID, url: url.url, ...(settings.orgInChats ? { inChats: true } : {}) }] : [];
}

export function defaultServerIdIn(settings: AppSettings, list = orgServersIn(settings)): string | undefined {
  return list.find((e) => e.id === settings.orgDefaultServerId)?.id ?? list[0]?.id;
}

export function orgTokenKey(id: string): string {
  return id === PRIMARY_ID ? ORG_TOKEN_KEY : `${ORG_TOKEN_KEY}:${id}`;
}

/// An id for a newly added server, from its address: `acme-example-com`.
export function newServerId(list: readonly OrgServerEntry[], url: string): string {
  if (!list.length) return PRIMARY_ID;
  let base = 'org';
  try {
    const u = new URL(url);
    base = `${u.hostname}${u.port ? `-${u.port}` : ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
  } catch {
    // normalizeOrgUrl checked it already; 'org' will do.
  }
  let id = base;
  for (let n = 2; list.some((e) => e.id === id) || id === PRIMARY_ID; n++) id = `${base}-${n}`;
  return id;
}

/// The MCP server name each entry is in chats: `overgo` while there is only
/// one server, `overgo-<org>` once there are several, so a model can tell
/// which org "Mario" is on. Unique, and only [a-z0-9-].
export function chatToolNames(list: readonly OrgServerEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  if (list.length === 1) return out.set(list[0].id, 'overgo');
  const taken = new Set<string>();
  for (const e of list) {
    const slug = (e.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || e.id.slice(0, 30);
    let name = `overgo-${slug}`;
    for (let n = 2; taken.has(name); n++) name = `overgo-${slug}-${n}`;
    taken.add(name);
    out.set(e.id, name);
  }
  return out;
}

// ---- stored state ---------------------------------------------------------

let changed: ((settings: AppSettings) => void) | null = null;

/// Told whenever main changes the list, so the renderer's copy can follow.
export function onOrgServersChanged(fn: ((settings: AppSettings) => void) | null): void {
  changed = fn;
}

export function listOrgServers(): OrgServerEntry[] {
  return orgServersIn(Store.load().settings);
}

export function defaultServerId(): string | undefined {
  return defaultServerIdIn(Store.load().settings);
}

/// Save the list, keeping `orgServerUrl` on the default server.
export function saveOrgServers(list: OrgServerEntry[], defaultId?: string): AppSettings {
  const current = Store.load().settings;
  const def = list.find((e) => e.id === (defaultId ?? current.orgDefaultServerId))?.id ?? list[0]?.id;
  const next: AppSettings = { ...current, orgServers: list, orgDefaultServerId: def, orgServerUrl: list.find((e) => e.id === def)?.url };
  delete next.orgInChats;
  if (!def) delete next.orgDefaultServerId;
  if (!next.orgServerUrl) delete next.orgServerUrl;
  Store.saveSettings(next);
  changed?.(next);
  return next;
}

export function updateOrgServer(id: string, patch: Partial<Omit<OrgServerEntry, 'id'>>): boolean {
  const list = listOrgServers();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return false;
  list[i] = { ...list[i], ...patch };
  saveOrgServers(list);
  return true;
}

/// The token for a server: $OVERCLI_ORG_TOKEN for the default one, else the keychain.
export function orgTokenFor(id: string): string | null {
  try {
    const fromEnv = process.env[ORG_TOKEN_ENV]?.trim();
    if (fromEnv && id === defaultServerId()) return fromEnv;
    return host().secrets.get(orgTokenKey(id))?.trim() || null;
  } catch (err) {
    log('warn', 'org', `Could not read the org token for ${id}: ${String(err)}`);
    return null;
  }
}

export function tokenFromEnv(id: string): boolean {
  return !!process.env[ORG_TOKEN_ENV]?.trim() && id === defaultServerId();
}

/// Keep a sign-in: the token in the keychain, the server on the list (the
/// same entry again for an address already there). Returns the entry, or why not.
export function rememberSignIn(rawUrl: string, token: string, about: { org?: string; name?: string } = {}): { ok: true; entry: OrgServerEntry } | { ok: false; error: string } {
  const url = normalizeOrgUrl(rawUrl);
  if (!url.ok) return url;
  const list = listOrgServers();
  const existing = list.find((e) => e.url === url.url);
  const entry: OrgServerEntry = { ...(existing ?? { id: newServerId(list, url.url), url: url.url }), ...(about.org ? { name: about.org } : {}), ...(about.name ? { who: about.name } : {}) };
  try {
    if (!host().secrets.set(orgTokenKey(entry.id), token)) return { ok: false, error: 'This build cannot store the sign-in — set $OVERCLI_ORG_TOKEN instead.' };
  } catch (err) {
    return { ok: false, error: `Could not save the sign-in: ${String(err)}` };
  }
  saveOrgServers(existing ? list.map((e) => (e.id === entry.id ? entry : e)) : [...list, entry]);
  return { ok: true, entry };
}

/// Forget a server's token (signed out); with `remove`, the entry too.
export function forgetOrgServer(id: string, remove = false): boolean {
  let ok = true;
  try {
    ok = host().secrets.set(orgTokenKey(id), null);
  } catch {
    ok = false;
  }
  const list = listOrgServers();
  if (remove) saveOrgServers(list.filter((e) => e.id !== id));
  else if (list.some((e) => e.id === id && e.inChats)) updateOrgServer(id, { inChats: false });
  return ok;
}

/// A server to call: the one named, or the default. `signIn` when signing in fixes it.
export function orgServerAccess(id?: string): { ok: true; entry: OrgServerEntry; url: string; token: string } | { ok: false; error: string; signIn: true } {
  const list = listOrgServers();
  const entry = id ? list.find((e) => e.id === id) : list.find((e) => e.id === defaultServerId());
  if (!entry) return { ok: false, error: id ? 'That org server is no longer on your list: Settings → Your orgs.' : SIGN_IN_FIRST, signIn: true };
  const url = normalizeOrgUrl(entry.url);
  if (!url.ok) return { ...url, signIn: true };
  const token = orgTokenFor(entry.id);
  if (!token) return { ok: false, error: `Sign in to ${entry.name ?? entry.url} again: Settings → Your orgs.`, signIn: true };
  return { ok: true, entry, url: url.url, token };
}
