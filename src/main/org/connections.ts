// People's own accounts, connected to overcli: today, Google Drive.
//
// Each person signs in to Google once (OAuth 2.0 authorization code with
// PKCE) and "Save to Google Drive" on a team task's files then saves into
// *their* Drive, as them — not through a shared tool on the server.
//
//   start      the console asks for Google's consent page; the server keeps
//              a single-use state for ten minutes, bound to the person who
//              asked and to their browser (a cookie the console can't read)
//   callback   Google sends the browser back to /oauth/google/callback; the
//              server swaps the code for a refresh token over TLS and keeps
//              it, encrypted, in org/connections.json
//   upload     a short-lived access token from the refresh token, then a
//              multipart upload into an "overcli" folder in their Drive
//
// The app's OAuth client (id and secret) is the admin's to add once, on
// Setup → Secrets. The refresh tokens are encrypted with AES-256-GCM under a
// key kept in the secrets service (OVERCLI_CONNECTIONS_KEY), never in the
// server's environment where a worker could read it.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OrgCaller } from '../../shared/org/policy';

export const GOOGLE_CLIENT_ID_ENV = 'GOOGLE_OAUTH_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET_ENV = 'GOOGLE_OAUTH_CLIENT_SECRET';
export const CONNECTIONS_KEY_SECRET = 'OVERCLI_CONNECTIONS_KEY';
/// The cookie that ties a Google sign-in to the browser that started it.
export const CONNECT_COOKIE = 'ocli_connect';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'overcli';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/// drive.file and nothing wider: overcli sees and changes only the files it
/// made itself, never the rest of a person's Drive. That is all saving needs,
/// and Google treats it as a non-sensitive scope, so the app needs no
/// security review to use it.
const SCOPE = `openid email ${DRIVE_SCOPE}`;
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 5_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const AAD = Buffer.from('overcli-connections-v1');

export const NOT_CONFIGURED_WHY = 'An admin needs to add Google sign-in (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on Setup → Secrets).';
const RECONNECT = 'Reconnect Google Drive';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ConnectionsDeps {
  /// The org dir: connections.json lives here, and the fallback key file.
  dir(): string;
  /// org.json's publicUrl, when set: the one address Google sends people back to.
  publicUrl(): string | undefined;
  /// GOOGLE_OAUTH_CLIENT_ID / _SECRET: the secrets service applies stored
  /// ones to the environment, so the environment is where both are read.
  env?: NodeJS.ProcessEnv;
  /// Secrets kept out of the environment: the encryption key. Absent, or a
  /// store that can't take it (read-only, managed by Terraform): a key file.
  privateSecrets?: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<boolean>;
  };
  fetchImpl?: FetchLike;
  now?(): number;
  log?(message: string): void;
}

export interface ConnectionRow {
  provider: 'google';
  label: string;
  /// Whether the app side is set up, so a person can connect at all.
  ready: boolean;
  why?: string;
  /// The exact address to register on the OAuth client, for admins.
  redirectUri?: string;
  connected: boolean;
  account?: string;
  connectedAt?: number;
}

interface StoredConnection {
  provider: 'google';
  /// slackUserId, else the caller's name.
  person: string;
  email: string;
  /// Empty once Google has ended the grant (invalid_grant).
  refreshToken: string;
  scope: string;
  connectedAt: number;
  folderId?: string;
  endedAt?: number;
}

interface Flow {
  person: string;
  verifier: string;
  /// sha256 of the browser cookie set when the flow started.
  browser: string;
  next: string;
  redirectUri: string;
  at: number;
}

/// Why a callback failed, as a short code the console turns into words.
/// Never Google's own text, and never a token.
export type CallbackError = 'denied' | 'expired' | 'browser' | 'not-configured' | 'exchange' | 'no-email' | 'no-refresh-token' | 'scope' | 'server';

export function personKey(caller: Pick<OrgCaller, 'slackUserId' | 'name'>): string {
  return caller.slackUserId || `name:${caller.name}`;
}

export class ConnectionsService {
  private flows = new Map<string, Flow>();
  private tokens = new Map<string, { token: string; until: number }>();
  private key: Buffer | null = null;
  private keyLoading: Promise<Buffer> | null = null;
  private folderLoading = new Map<string, Promise<Result<{ folderId: string }>>>();

  constructor(private readonly deps: ConnectionsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    return (this.deps.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  private client(): { id: string; secret: string } | null {
    const id = this.env()[GOOGLE_CLIENT_ID_ENV]?.trim();
    const secret = this.env()[GOOGLE_CLIENT_SECRET_ENV]?.trim();
    return id && secret ? { id, secret } : null;
  }

  /// Whether people can connect Google here at all.
  configured(): boolean {
    return !!this.client();
  }

  redirectUri(base: string): string {
    return `${(this.deps.publicUrl() ?? base).replace(/\/+$/, '')}/oauth/google/callback`;
  }

  // ---- STORE ---------------------------------------------------------------

  private file(): string {
    return path.join(this.deps.dir(), 'connections.json');
  }

  /// The key the store is sealed with: the secrets service's, else a key
  /// file. Made on first use. Once found it stays for the process, so a blip
  /// reading Secrets Manager can't swap it for a new one mid-flight. Tool
  /// sign-ins (toolSignIn.ts) are sealed with it too.
  async encryptionKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (!this.keyLoading) {
      this.keyLoading = this.resolveKey().then(
        (k) => (this.key = k),
        (err) => {
          this.keyLoading = null;
          throw err;
        },
      );
    }
    return this.keyLoading;
  }

  private async resolveKey(): Promise<Buffer> {
    const valid = (v: string | undefined) => (v && /^[0-9a-f]{64}$/.test(v.trim()) ? Buffer.from(v.trim(), 'hex') : null);
    const keyFile = path.join(this.deps.dir(), 'connections.key');
    const secrets = this.deps.privateSecrets;
    // A read that fails throws rather than falling through to a fresh key,
    // which would leave every stored connection unreadable.
    const stored = secrets ? valid(await secrets.get(CONNECTIONS_KEY_SECRET)) : null;
    if (stored) return stored;
    let fromFile: Buffer | null = null;
    try {
      fromFile = valid(fs.readFileSync(keyFile, 'utf8'));
    } catch {
      // none yet
    }
    if (fromFile) return fromFile;
    const fresh = randomBytes(32);
    if (secrets && (await secrets.set(CONNECTIONS_KEY_SECRET, fresh.toString('hex')).catch(() => false))) return fresh;
    // No secrets service, or one that can't take it (read-only): a key file
    // only this user can read, in the org dir. That puts the key on the same
    // disk as what it seals — no worse than the file secrets store, and it
    // still keeps tokens out of a copied connections.json or a backup of it
    // alone.
    this.deps.log?.('connections: keeping the encryption key in a file beside connections.json; the secrets store could not take it.');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, fresh.toString('hex'), { mode: 0o600 });
    return fresh;
  }

  private async load(): Promise<StoredConnection[]> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(), 'utf8');
    } catch {
      return [];
    }
    const doc = JSON.parse(raw) as { version?: number; iv?: string; tag?: string; data?: string };
    if (doc.version !== 1 || !doc.iv || !doc.tag || !doc.data) return [];
    const key = await this.encryptionKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]).toString('utf8');
      const list = JSON.parse(plain) as unknown;
      return Array.isArray(list) ? (list as StoredConnection[]) : [];
    } catch {
      throw new Error('connections.json could not be read: the key does not match it, or it was changed.');
    }
  }

  private async save(all: StoredConnection[]): Promise<void> {
    const key = await this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
    const doc = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const file = this.file();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private async record(person: string): Promise<StoredConnection | undefined> {
    return (await this.load()).find((c) => c.provider === 'google' && c.person === person);
  }

  private async update(person: string, mutate: (c: StoredConnection | undefined) => StoredConnection | undefined): Promise<void> {
    const all = await this.load();
    const i = all.findIndex((c) => c.provider === 'google' && c.person === person);
    const next = mutate(i >= 0 ? all[i] : undefined);
    if (i >= 0) all.splice(i, 1);
    if (next) all.push(next);
    await this.save(all);
  }

  // ---- CONNECTING ----------------------------------------------------------

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.flows) if (now - v.at > FLOW_TTL_MS) this.flows.delete(k);
  }

  /// Google's consent page for this person, and the cookie value the browser
  /// must bring back with it.
  start(caller: OrgCaller, opts: { next?: string; base: string }): Result<{ url: string; browserKey: string }> {
    const client = this.client();
    if (!client) return { ok: false, error: NOT_CONFIGURED_WHY };
    this.prune();
    if (this.flows.size > MAX_FLOWS) return { ok: false, error: 'Too many connections in progress. Try again in a minute.' };
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const browserKey = randomBytes(24).toString('base64url');
    const redirectUri = this.redirectUri(opts.base);
    this.flows.set(state, { person: personKey(caller), verifier, browser: sha256(browserKey), next: safeHash(opts.next), redirectUri, at: this.now() });
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', client.id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    // A refresh token, so saving works long after this sign-in; and consent
    // every time, so Google sends a fresh one on a reconnect too.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    return { ok: true, url: url.toString(), browserKey };
  }

  /// Google sent the browser back. Where to send it next: the console, with
  /// `connected=google` on success or a short reason on failure.
  async callback(query: URLSearchParams, browserKey: string | undefined): Promise<{ location: string; ok: boolean; reason?: CallbackError }> {
    const fail = (reason: CallbackError) => ({ ok: false, reason, location: `/#connections/google-error?reason=${reason}` });
    this.prune();
    const state = query.get('state') ?? '';
    const flow = state ? this.flows.get(state) : undefined;
    // Used once, whatever happens next.
    if (flow) this.flows.delete(state);
    if (query.get('error')) return fail(query.get('error') === 'access_denied' ? 'denied' : 'exchange');
    if (!flow) return fail('expired');
    // The browser that finishes must be the one that started: otherwise
    // someone could start a connection as themselves, send the consent link
    // to a colleague, and have the colleague's Drive land on their account.
    if (!browserKey || !sameHash(sha256(browserKey), flow.browser)) return fail('browser');
    const client = this.client();
    if (!client) return fail('not-configured');
    const code = query.get('code');
    if (!code) return fail('exchange');

    let json: { refresh_token?: string; access_token?: string; expires_in?: number; id_token?: string; scope?: string };
    try {
      const res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, client_id: client.id, client_secret: client.secret, code_verifier: flow.verifier }),
      });
      json = (await res.json().catch(() => ({}))) as typeof json;
      if (!res.ok) return fail('exchange');
    } catch {
      return fail('exchange');
    }
    // Google's granular consent lets a person untick Drive: then saving can't work.
    const scope = json.scope ?? '';
    if (!scope.split(/\s+/).includes(DRIVE_SCOPE)) return fail('scope');
    // The ID token came straight from Google's token endpoint over TLS, in
    // answer to this server's own request with its client secret, so its
    // signature needs no checking: OpenID Connect Core §3.1.3.7 allows the
    // TLS server validation to stand in for it. Its audience is still checked.
    const claims = json.id_token ? decodeClaims(json.id_token) : null;
    const email = claims && claimsFor(claims, client.id) ? String(claims.email ?? '').trim().toLowerCase() : '';
    if (!email) return fail('no-email');
    if (!json.refresh_token) return fail('no-refresh-token');
    try {
      const old = await this.record(flow.person);
      await this.update(flow.person, () => ({
        provider: 'google',
        person: flow.person,
        email,
        refreshToken: json.refresh_token!,
        scope,
        connectedAt: this.now(),
        // The same Google account keeps its folder; a different one finds its own.
        ...(old?.folderId && old.email === email ? { folderId: old.folderId } : {}),
      }));
    } catch (err) {
      this.deps.log?.(`connections: could not keep a Google connection: ${err instanceof Error ? err.message : String(err)}`);
      return fail('server');
    }
    if (json.access_token && typeof json.expires_in === 'number') this.tokens.set(flow.person, { token: json.access_token, until: this.now() + (json.expires_in - 60) * 1000 });
    else this.tokens.delete(flow.person);
    this.deps.log?.(`connections: ${flow.person} connected Google Drive.`);
    const next = flow.next || '#connections';
    return { ok: true, location: `/${next}${next.includes('?') ? '&' : '?'}connected=google` };
  }

  /// This person's connections, for the console.
  async list(caller: OrgCaller, base: string): Promise<ConnectionRow[]> {
    const configured = this.configured();
    const c = await this.record(personKey(caller)).catch(() => undefined);
    const live = !!c?.refreshToken;
    return [
      {
        provider: 'google',
        label: 'Google Drive',
        ready: configured,
        ...(!configured ? { why: NOT_CONFIGURED_WHY } : c && !live ? { why: 'Google ended this connection (access was removed, or it went unused too long). Connect again.' } : {}),
        redirectUri: this.redirectUri(base),
        connected: configured && live,
        ...(c ? { account: c.email } : {}),
        ...(c && live ? { connectedAt: c.connectedAt } : {}),
      },
    ];
  }

  /// Whether this person can save to their Drive now, and if not, why.
  async status(caller: OrgCaller): Promise<{ configured: boolean; connected: boolean; why?: string }> {
    if (!this.configured()) return { configured: false, connected: false, why: NOT_CONFIGURED_WHY };
    const c = await this.record(personKey(caller)).catch(() => undefined);
    return c?.refreshToken ? { configured: true, connected: true } : { configured: true, connected: false, why: 'Connect your Google account first.' };
  }

  async disconnect(caller: OrgCaller, provider: string): Promise<Result> {
    if (provider !== 'google') return { ok: false, error: 'No connection by that name.' };
    const person = personKey(caller);
    const c = await this.record(person);
    this.tokens.delete(person);
    if (!c) return { ok: true };
    if (c.refreshToken) {
      // Best effort: the grant ends at Google too, but a failure there must
      // not leave the token here.
      try {
        await this.fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.refreshToken }) });
      } catch {
        // offline, or Google said no: the person can remove it at myaccount.google.com
      }
    }
    await this.update(person, () => undefined);
    this.deps.log?.(`connections: ${person} disconnected Google Drive.`);
    return { ok: true };
  }

  // ---- USING ---------------------------------------------------------------

  /// A current access token for this person's Google account.
  async accessToken(caller: OrgCaller): Promise<Result<{ token: string }>> {
    const person = personKey(caller);
    const hit = this.tokens.get(person);
    if (hit && hit.until > this.now()) return { ok: true, token: hit.token };
    const client = this.client();
    if (!client) return { ok: false, error: NOT_CONFIGURED_WHY };
    const c = await this.record(person);
    if (!c?.refreshToken) return { ok: false, error: c ? RECONNECT : 'Connect your Google account first.' };
    let res: Response;
    let json: { access_token?: string; expires_in?: number; error?: string };
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: client.id, client_secret: client.secret }),
      });
      json = (await res.json().catch(() => ({}))) as typeof json;
    } catch (err) {
      return { ok: false, error: `Google did not answer: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (json.error === 'invalid_grant') {
      // Revoked, expired, or the password changed: this token is done. Keep
      // the email so the console can say which account to reconnect.
      this.tokens.delete(person);
      await this.update(person, (old) => (old ? { ...old, refreshToken: '', endedAt: this.now() } : old));
      this.deps.log?.(`connections: Google ended ${person}'s connection (invalid_grant).`);
      return { ok: false, error: RECONNECT };
    }
    if (!res.ok || !json.access_token) return { ok: false, error: `Google would not refresh the sign-in (HTTP ${res.status}${json.error ? `, ${json.error}` : ''}).` };
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.tokens.set(person, { token: json.access_token, until: this.now() + Math.max(0, ttl - 60) * 1000 });
    return { ok: true, token: json.access_token };
  }

  /// The person's "overcli" folder: remembered, else found, else made. With
  /// drive.file only folders this app made are visible, which is the point.
  private async folder(caller: OrgCaller, token: string, fresh: boolean): Promise<Result<{ folderId: string }>> {
    const person = personKey(caller);
    if (!fresh) {
      const known = (await this.record(person))?.folderId;
      if (known) return { ok: true, folderId: known };
    }
    // One lookup at a time per person, so a burst of saves makes one folder.
    const inFlight = this.folderLoading.get(person);
    if (inFlight) return inFlight;
    const job = (async (): Promise<Result<{ folderId: string }>> => {
      const auth = { Authorization: `Bearer ${token}` };
      const q = `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
      const listUrl = `${DRIVE_FILES_URL}?${new URLSearchParams({ q, spaces: 'drive', fields: 'files(id)', pageSize: '1' }).toString()}`;
      const listed = await this.fetch(listUrl, { headers: auth });
      if (!listed.ok) return { ok: false, error: `Google Drive answered HTTP ${listed.status} looking for the overcli folder.` };
      let folderId = ((await listed.json().catch(() => ({}))) as { files?: Array<{ id?: string }> }).files?.[0]?.id;
      if (!folderId) {
        const made = await this.fetch(`${DRIVE_FILES_URL}?fields=id`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
        });
        folderId = made.ok ? ((await made.json().catch(() => ({}))) as { id?: string }).id : undefined;
        if (!folderId) return { ok: false, error: `Google Drive answered HTTP ${made.status} making the overcli folder.` };
      }
      const id = folderId;
      await this.update(person, (old) => (old ? { ...old, folderId: id } : old));
      return { ok: true, folderId: id };
    })().finally(() => this.folderLoading.delete(person));
    this.folderLoading.set(person, job);
    return job;
  }

  /// Save one file into the person's Drive, in their overcli folder.
  async upload(caller: OrgCaller, file: { name: string; mimeType: string; data: Buffer }): Promise<Result<{ link?: string }>> {
    if (file.data.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'That file is too big to save to Google Drive from here.' };
    let token = await this.accessToken(caller);
    if (!token.ok) return token;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const folder = await this.folder(caller, token.token, attempt > 0);
        if (!folder.ok) return folder;
        const boundary = `overcli-${randomBytes(12).toString('hex')}`;
        const meta = { name: file.name.split('/').pop() || file.name, mimeType: file.mimeType, parents: [folder.folderId] };
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`, 'utf8'),
          file.data,
          Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
        ]);
        const res = await this.fetch(DRIVE_UPLOAD_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        if (res.ok) {
          const made = (await res.json().catch(() => ({}))) as { id?: string; webViewLink?: string };
          return { ok: true, ...(made.webViewLink ? { link: made.webViewLink } : {}) };
        }
        if (attempt === 0 && res.status === 401) {
          // The cached token went stale early: a fresh one, once.
          this.tokens.delete(personKey(caller));
          token = await this.accessToken(caller);
          if (!token.ok) return token;
          continue;
        }
        // The remembered folder was deleted: find or make it again, once.
        if (attempt === 0 && res.status === 404) continue;
        return { ok: false, error: `Google Drive refused the upload (HTTP ${res.status}).` };
      }
      return { ok: false, error: 'Google Drive refused the upload.' };
    } catch (err) {
      return { ok: false, error: `Google Drive did not answer: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/// Only a console page, as its hash: `#teams/council`. No scheme, host or
/// path, so it can't send the browser anywhere else.
export function safeHash(next: string | undefined): string {
  return typeof next === 'string' && /^#[A-Za-z0-9/_\-.~=&%?]{0,200}$/.test(next) ? next : '';
}

function decodeClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/// Google's, for this app, with an email it has verified.
function claimsFor(claims: Record<string, unknown>, clientId: string): boolean {
  const iss = String(claims.iss ?? '');
  const aud = claims.aud;
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') return false;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) return false;
  return claims.email_verified !== false && typeof claims.email === 'string';
}
