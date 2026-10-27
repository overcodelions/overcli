// Safe fetches: a worker on the org's server may open a web page without
// asking when the address came from somewhere other than itself.
//
// Reading the web is not the risk; the address is. A worker that has read a
// ticket can put it in a URL (`https://example.com/?q=<the ticket>`) and the
// fetch hands it to whoever runs that site. So what it may open is what it
// was shown: the person's ask, a search result, a link on a page it already
// read. An address it wrote itself is refused, and the refusal says to
// search for it first. The org's own sites are open, since what it knows
// going to them stays home. Loopback, private and cloud-metadata addresses
// never are: those are the server's own insides, not the web.
//
// Not covered: a public name that resolves to a private address (checking
// would mean resolving it here, and the fetch resolves it again later), and
// the sliver a worker could signal by which of the links it was shown it
// opens. Neither moves a ticket's text out.

import type { WebFetchMode } from '../shared/org/policy';

let rules: { mode(): WebFetchMode; ownDomains(): string[] } | null = null;

/// The org server says how its workers fetch. Unset (the desktop): never
/// checked here.
export function setSafeFetch(r: { mode(): WebFetchMode; ownDomains(): string[] } | null): void {
  rules = r;
}

/// Whether fetches are judged one by one here, rather than allowed outright
/// or asked about by the step.
export function fetchesChecked(): boolean {
  return rules?.mode() === 'safe';
}

/// The addresses each run or turn has been shown, by its key.
const seen = new Map<string, { urls: Set<string>; at: number }>();
const seeded = new Set<string>();
const MAX_URLS = 5000;
const FORGET_MS = 24 * 60 * 60 * 1000;

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}|\\^]+/gi;

/// One address as compared: scheme, fragment and a trailing slash left out
/// (a fetch upgrades http, and `/a/` is `/a`), the query kept: the query is
/// where a made-up address carries what it shouldn't.
export function urlKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
  return `${u.host.toLowerCase()}${path}${u.search}`;
}

/// Remember the addresses in what a run was shown: its ask, a tool's result.
/// Never the model's own words: those are what a made-up address is.
export function noteSeen(key: string, text: string): void {
  if (!text) return;
  const now = Date.now();
  for (const [k, v] of seen) if (now - v.at > FORGET_MS) { seen.delete(k); seeded.delete(k); }
  const entry = seen.get(key) ?? { urls: new Set<string>(), at: now };
  entry.at = now;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const k = urlKey(m[0].replace(/[.,;:!?*_]+$/, ''));
    if (k && entry.urls.size < MAX_URLS) entry.urls.add(k);
  }
  seen.set(key, entry);
}

/// The run's own ask, noted once.
export function seedOnce(key: string, text: string): void {
  if (seeded.has(key)) return;
  seeded.add(key);
  noteSeen(key, text);
}

export function forgetSeen(key: string): void {
  seen.delete(key);
  seeded.delete(key);
}

/// IPv4 written as IPv6 (`::ffff:a9fe:a9fe`, `::a9fe:a9fe`), back to dotted form.
function unmapV4(h: string): string {
  const m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!m) return h;
  const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/// The server's own insides, whatever anyone lists: loopback, link-local
/// (cloud metadata lives there) and the names that mean "this machine".
function neverHost(host: string): boolean {
  const h = unmapV4(host.replace(/^\[|\]$/g, '').toLowerCase());
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || /^fe80:/i.test(h)) return true;
  if (/^::ffff:(127\.|169\.254\.)/.test(h)) return true;
  return h === 'metadata.google.internal' || h === 'metadata';
}

/// Private networks and names that only mean something inside one. Open
/// only when the org lists it as its own.
function privateHost(host: string): boolean {
  const h = unmapV4(host.replace(/^\[|\]$/g, '').toLowerCase());
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^::ffff:(10\.|192\.168\.|172\.)/.test(h)) return true;
  if (/\.(local|internal|lan|corp|home|intranet)$/.test(h)) return true;
  return !h.includes('.') && !h.includes(':');
}

function ownSite(host: string, own: string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return own.some((d) => {
    const dom = d.toLowerCase().replace(/^\*?\./, '');
    return !!dom && (h === dom || h.endsWith(`.${dom}`));
  });
}

export interface FetchVerdict {
  allow: boolean;
  /// For the log and the activity view.
  why: string;
  /// What a refusal tells the model.
  note?: string;
}

/// Whether a WebFetch call may go, for the run or turn under `key`.
export function judgeFetch(key: string, input: unknown): FetchVerdict {
  const raw = input && typeof input === 'object' ? (input as { url?: unknown }).url : undefined;
  const refuse = (why: string, note: string): FetchVerdict => ({
    allow: false,
    why,
    note: `Refused by policy, not by a person: ${note} This is not a file-permission or access problem; do not retry it or work around it. Say plainly in your reply what you could not open.`,
  });
  if (typeof raw !== 'string') return refuse('no address', 'that fetch named no web address.');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return refuse('not an address', `"${raw.slice(0, 80)}" is not a web address.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return refuse('not the web', 'only http and https addresses can be opened.');
  if (u.username || u.password) return refuse('credentials in the address', 'an address with a user name or password in it can’t be opened.');
  const host = u.hostname;
  if (neverHost(host)) return refuse(`${host} is this server`, `${host} is this server or its cloud’s internals, which workers never open.`);
  if (ownSite(host, rules?.ownDomains() ?? [])) return { allow: true, why: `${host} is one of the org’s own sites` };
  if (privateHost(host)) return refuse(`${host} is a private address`, `${host} is a private network address. An admin can list it among the org’s own sites if workers should read it.`);
  const k = urlKey(raw);
  if (k && seen.get(key)?.urls.has(k)) return { allow: true, why: 'it was in the ask, a search result or a page it read' };
  return refuse(
    `${host}: an address it wrote itself`,
    `safe fetches only: ${u.host}${u.pathname.slice(0, 60)} didn’t come from the request, a search result or a page you read. Search the web for it, then open a link from the results.`,
  );
}
