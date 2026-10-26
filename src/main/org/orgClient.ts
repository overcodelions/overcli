// Talking to an org's control plane from somewhere else: the desktop app
// publishing a worker you built, or `overcli workers push` from a laptop.
//
// The control plane's own API, over HTTPS, with a person's token — the same
// door the console uses, so publishing is a hire like any other: the org's
// rules apply, you become the worker's manager, and anything over your
// allowance waits for an approver.

import { host } from '../host';
import { log } from '../diagnostics';

import type { ProcessDef, ProcessPerson, ProcessStage } from '../../shared/org/process';
import type { ToolTemplate } from './tools';
import type { ConnectionPush } from '../../shared/overdbConnection';

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
    return { ok: false, error: 'That is not a URL. It looks like https://overgo.acme.internal:7420' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    return { ok: false, error: 'Use https:// — your token would travel in the clear over http to another machine.' };
  }
  // 0.0.0.0 is a server's "every interface", shown by mistake: this machine.
  if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
  return { ok: true, url: `${u.protocol}//${u.host}` };
}

/// Why a request never got an answer, in words someone can act on.
export function unreachable(base: string, err: unknown): string {
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  if (code === 'ECONNREFUSED') return `Nothing is answering at ${base}. Is overcli serve running there? If it just started, try again in a few seconds.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not find ${base}. Check the address in Settings → Your org.`;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `${base} dropped the connection. If the server was restarting, try again.`;
  return `Could not reach the org server at ${base}${code ? ` (${code})` : ''}.`;
}

/// Where to connect for `base`. `localhost` can resolve to ::1 first, and
/// `overcli serve` listens on 127.0.0.1 only; a browser falls back to IPv4 on
/// its own, Node's fetch does not. Links shown to people keep `localhost`.
export function dialable(base: string): string {
  try {
    const u = new URL(base);
    if (u.hostname !== 'localhost') return base;
    u.hostname = '127.0.0.1';
    return `${u.protocol}//${u.host}`;
  } catch {
    return base;
  }
}

async function call<T>(base: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${dialable(base)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, error: 'The org server did not accept your token. Ask an admin for a new one.', status: 401 };
    if (!res.ok) return { ok: false, error: `The org server answered HTTP ${res.status}.`, status: res.status };
    const data = (await res.json()) as T & { ok?: boolean; error?: string };
    if (data && typeof data === 'object' && data.ok === false) return { ok: false, error: data.error ?? 'The org server refused.', status: res.status };
    return { ok: true, data };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'The org server did not answer in time.' : unreachable(base, err) };
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
  /// The worker's id here, so a team published later finds this copy.
  localId?: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await call<{ hired?: { name: string }; hire: { status: string; reasons?: string[]; contract?: { name: string } } }>(
    base,
    token,
    'POST',
    '/api/publish',
    { yaml, options, tools, ...(localId ? { localId } : {}) },
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

/// A team, with its members' share files, onto the org. Members the org
/// already has (published from here before) are reused; the team itself is
/// updated in place when published again.
export interface TeamPublishPayload {
  localId: string;
  name: string;
  purpose?: string;
  budgetUSDPerTask: number;
  checkpoints?: Record<string, boolean>;
  piecesAskFirst?: boolean;
  members: Array<{ localId: string; role: string; yaml: string; tools?: ToolTemplate[] }>;
}

export async function publishTeamToOrg(base: string, token: string, team: TeamPublishPayload): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await call<{ team?: { name: string }; updated: boolean; added: string[]; reused: string[]; waitingOn: string[] }>(base, token, 'POST', '/api/publish/team', team);
  if (!res.ok) return res;
  const d = res.data;
  const list = (names: string[]) => names.join(', ');
  const parts = [
    d.team ? `${d.team.name} is ${d.updated ? 'updated' : 'on the org'}.` : `${team.name} is waiting for ${list(d.waitingOn)} to be approved, then it's made.`,
    d.added.length ? `Added ${list(d.added)}, on probation with you as manager.` : '',
    d.reused.length ? `${list(d.reused)} ${d.reused.length === 1 ? 'was' : 'were'} already there.` : '',
    d.team ? 'Members work in their own projects there until you pick one on the console.' : '',
  ];
  return { ok: true, message: parts.filter(Boolean).join(' ') };
}

/// A process onto the org. Team stages name the team by its id here
/// (`localTeamId`); the server maps each to the copy published from this
/// desktop, so the teams go up first.
export interface ProcessPublishPayload {
  localId: string;
  name: string;
  purpose?: string;
  owner?: ProcessPerson;
  stages: Array<Omit<ProcessStage, 'teamId'> & { localTeamId?: string; teamName?: string }>;
}

/// The payload for one local process. On the desktop people are often just
/// "You"; on the org that has to be someone, so "You" becomes `me`, the
/// person the org knows this app as (or is dropped, for the owner, and the
/// server makes the publisher the owner).
export function processPublishPayload(
  def: Pick<ProcessDef, 'id' | 'name' | 'purpose' | 'owner' | 'stages'>,
  teams: ReadonlyArray<{ id: string; name: string }>,
  me?: ProcessPerson,
): { ok: true; payload: ProcessPublishPayload } | { ok: false; error: string } {
  const isYou = (p: ProcessPerson) => p.name.trim().toLowerCase() === 'you';
  const person = (p: ProcessPerson): ProcessPerson | null => (isYou(p) ? me ?? null : { name: p.name, ...(p.slackUserId ? { slackUserId: p.slackUserId } : {}) });
  const stages: ProcessPublishPayload['stages'] = [];
  for (const s of def.stages) {
    const { teamId, owner, approvers, ...rest } = s;
    const stageOwner = owner ? person(owner) : null;
    const base = { ...rest, ...(stageOwner ? { owner: stageOwner } : {}) };
    if (s.kind === 'team') {
      const team = teams.find((t) => t.id === teamId);
      if (!team) return { ok: false, error: `The team for ${s.name} is gone. Pick another, then publish.` };
      stages.push({ ...base, localTeamId: team.id, teamName: team.name });
    } else {
      const who = (approvers ?? []).map(person).filter((p): p is ProcessPerson => !!p);
      if (!who.length) return { ok: false, error: `Say who decides at ${s.name} by name before publishing: "You" means nobody on the org.` };
      stages.push({ ...base, approvers: who });
    }
  }
  const owner = person(def.owner);
  return {
    ok: true,
    payload: {
      localId: def.id,
      name: def.name,
      ...(def.purpose ? { purpose: def.purpose } : {}),
      ...(owner ? { owner } : {}),
      stages,
    },
  };
}

export async function publishProcessToOrg(base: string, token: string, payload: ProcessPublishPayload): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await call<{ process?: { name: string; stages?: unknown[] }; updated: boolean }>(base, token, 'POST', '/api/publish/process', payload);
  if (!res.ok) return res;
  const name = res.data.process?.name ?? payload.name;
  return {
    ok: true,
    message: res.data.updated
      ? `${name} is updated on the org. Items already in it carry on.`
      : `${name} is on the org. People can put work into it from the console or Slack.`,
  };
}

/// A desktop's picked setup onto the org (see setupShare.ts).
export async function publishSetupToOrg(
  base: string,
  token: string,
  payload: {
    tools: ToolTemplate[];
    repos: Array<{ name: string; url?: string; localPath?: string }>;
    workspaces: Array<{ name: string; repos: string[]; instructions?: string }>;
    keys?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
  },
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const res = await call<{ installed: string[]; offered: { tools: number; repos: number; workspaces: number } }>(base, token, 'POST', '/api/publish/setup', payload);
  if (!res.ok) return res;
  const { installed, offered } = res.data;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return {
    ok: true,
    message: [
      `Sent ${n(offered.tools, 'tool', 'tools')}, ${n(offered.repos, 'repo', 'repos')} and ${n(offered.workspaces, 'workspace', 'workspaces')}.`,
      installed.length ? `Installed ${installed.join(', ')} with the keys you sent.` : '',
      'An admin finishes the rest on the server: Setup → From desktops.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/// A database connection overdb published (src/shared/overdbConnection.ts).
/// `retry`: worth sending again later — the server was out of reach, broke,
/// or didn't know the token — as against a server that read it and said no.
export async function publishOverdbConnectionToOrg(
  base: string,
  token: string,
  push: ConnectionPush,
): Promise<{ ok: true; message: string } | { ok: false; error: string; retry: boolean }> {
  const res = await call<{ waiting: boolean }>(base, token, 'POST', '/api/publish/overdb-connection', { id: push.id, connection: push.connection });
  if (!res.ok) {
    const answered = res.status !== undefined && res.status !== 401 && res.status < 500;
    // A 404 is a server too old to take connections: worth trying again once it is updated.
    return { ok: false, error: res.error, retry: !answered || res.status === 404 };
  }
  return { ok: true, message: `${push.connection.name} is on the org server, waiting for an admin to finish it under Setup → Databases.` };
}

async function callPublic<T>(base: string, path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${dialable(base)}${path}`, {
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
    return { ok: false, error: aborted ? 'The org server did not answer in time.' : unreachable(base, err) };
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
