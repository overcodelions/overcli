// Remote tools that sign in through a browser, signed in once for the org.
//
// A remote MCP server can ask for OAuth instead of a pasted token. A worker on
// a server can't open a browser, so an admin signs in on the tool's behalf,
// once, from Setup → Tools, and every worker given the tool acts as that
// account (a service or bot account is best):
//
//   discover   POST the server unauthenticated; a 401 names its protected-
//              resource metadata, which names the authorization server, whose
//              metadata names the endpoints (MCP authorization spec)
//   register   dynamic client registration when the server offers it; else
//              the admin pastes a client id and secret made on the service
//   start      PKCE, a single-use state for ten minutes, bound to the admin's
//              browser by a cookie the console can't read
//   callback   the code for tokens; the refresh token is kept encrypted in
//              org/tool-signins.json, and the tool is installed with the
//              access token as its Authorization header
//   refresh    every minute, a token within half an hour of expiring is
//              renewed and the header rewritten, so a run that starts always
//              has at least that long
//
// The access token sits in the CLIs' MCP config, as a pasted token does; the
// refresh token never leaves the sealed file. It is sealed with the same key
// as people's own connections (connections.ts).

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OrgCaller } from '../../shared/org/policy';
import { safeHash } from './connections';

/// The cookie that ties a tool sign-in to the browser that started it.
export const TOOL_SIGNIN_COOKIE = 'ocli_tool';
export const TOOL_CALLBACK_PATH = '/oauth/tools/callback';

const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 200;
/// Renew a token this close to expiring, so every run starts with at least this long.
const REFRESH_AHEAD_MS = 30 * 60 * 1000;
const TICK_MS = 60 * 1000;
const AAD = Buffer.from('overcli-tool-signins-v1');
const PROTOCOL_VERSION = '2025-06-18';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ToolSignInDeps {
  /// The org dir: tool-signins.json lives here.
  dir(): string;
  /// org.json's publicUrl, when set: the one address the service sends people back to.
  publicUrl(): string | undefined;
  /// The key people's connections are sealed with.
  sealKey(): Promise<Buffer>;
  /// Install (or rewrite) the tool with this bearer token.
  install(name: string, url: string, token: string): Result;
  /// The URL a tool is installed with now, if it is installed at all.
  installedUrl(name: string): string | undefined;
  fetchImpl?: FetchLike;
  now?(): number;
  log?(message: string): void;
}

/// How a remote server wants to be signed in to.
export type Discovery =
  | { ok: true; signIn: 'none' }
  | { ok: true; signIn: 'token' }
  | { ok: true; signIn: 'oauth'; issuer: string; registers: boolean; redirectUri: string };

/// What the console shows about a signed-in tool. Never a token.
export interface SignInSummary {
  by: string;
  at: number;
  issuer: string;
  expiresAt?: number;
  /// The service ended it, or it could not be renewed: sign in again.
  ended?: boolean;
  why?: string;
}

export type ToolCallbackError = 'denied' | 'expired' | 'browser' | 'exchange' | 'install' | 'server';

interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  authMethods?: string[];
  scopesSupported?: string[];
}

interface ServerInfo {
  resource: string;
  scope?: string;
  as: AuthServer;
}

type AuthMethod = 'none' | 'post' | 'basic';

interface Client {
  issuer: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  authMethod: AuthMethod;
}

interface StoredSignIn {
  name: string;
  url: string;
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  client: Client;
  refreshToken: string;
  expiresAt?: number;
  scope?: string;
  by: string;
  at: number;
  endedAt?: number;
  why?: string;
}

interface Doc {
  signIns: StoredSignIn[];
  /// Clients registered with each service, reused on the next sign-in.
  clients: Client[];
}

interface Flow {
  name: string;
  url: string;
  info: ServerInfo;
  client: Client;
  verifier: string;
  browser: string;
  by: string;
  next: string;
  at: number;
}

export class ToolSignIn {
  private flows = new Map<string, Flow>();
  private view: Record<string, SignInSummary> = {};
  private refreshing = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ToolSignInDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    return (this.deps.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  redirectUri(base: string): string {
    return `${(this.deps.publicUrl() ?? base).replace(/\/+$/, '')}${TOOL_CALLBACK_PATH}`;
  }

  // ---- STORE ---------------------------------------------------------------

  private file(): string {
    return path.join(this.deps.dir(), 'tool-signins.json');
  }

  private async load(): Promise<Doc> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(), 'utf8');
    } catch {
      // None yet: no key is made until there is something to seal.
      return { signIns: [], clients: [] };
    }
    const doc = JSON.parse(raw) as { version?: number; iv?: string; tag?: string; data?: string };
    if (doc.version !== 1 || !doc.iv || !doc.tag || !doc.data) return { signIns: [], clients: [] };
    const key = await this.deps.sealKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
      const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]).toString('utf8')) as Partial<Doc>;
      const out = { signIns: Array.isArray(plain.signIns) ? plain.signIns : [], clients: Array.isArray(plain.clients) ? plain.clients : [] };
      this.remember(out);
      return out;
    } catch {
      throw new Error('tool-signins.json could not be read: the key does not match it, or it was changed.');
    }
  }

  private async save(doc: Doc): Promise<void> {
    const key = await this.deps.sealKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
    const sealed = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const file = this.file();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(sealed), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    this.remember(doc);
  }

  private remember(doc: Doc): void {
    this.view = Object.fromEntries(
      doc.signIns.map((s) => [
        s.name,
        {
          by: s.by,
          at: s.at,
          issuer: s.issuer,
          ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
          ...(s.endedAt ? { ended: true } : {}),
          ...(s.why ? { why: s.why } : {}),
        },
      ]),
    );
  }

  private async mutate(fn: (doc: Doc) => void): Promise<void> {
    const doc = await this.load();
    fn(doc);
    await this.save(doc);
  }

  /// Which installed tools are signed in, by name.
  summaries(): Record<string, SignInSummary> {
    return this.view;
  }

  // ---- DISCOVERY -----------------------------------------------------------

  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /// The authorization server's metadata, at each place the spec allows.
  private async authServer(issuer: string): Promise<AuthServer | null> {
    const u = new URL(issuer);
    const p = u.pathname.replace(/\/+$/, '');
    const candidates = p
      ? [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`]
      : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
    for (const at of candidates) {
      const m = await this.json(at);
      if (!m) continue;
      const authorizationEndpoint = endpoint(m.authorization_endpoint);
      const tokenEndpoint = endpoint(m.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint) continue;
      const methods = strings(m.code_challenge_methods_supported);
      // PKCE with S256 or not at all.
      if (methods && !methods.includes('S256')) return null;
      const registrationEndpoint = endpoint(m.registration_endpoint);
      const revocationEndpoint = endpoint(m.revocation_endpoint);
      const authMethods = strings(m.token_endpoint_auth_methods_supported);
      const scopesSupported = strings(m.scopes_supported);
      return {
        issuer: typeof m.issuer === 'string' ? m.issuer : issuer,
        authorizationEndpoint,
        tokenEndpoint,
        ...(registrationEndpoint ? { registrationEndpoint } : {}),
        ...(revocationEndpoint ? { revocationEndpoint } : {}),
        ...(authMethods ? { authMethods } : {}),
        ...(scopesSupported ? { scopesSupported } : {}),
      };
    }
    return null;
  }

  /// How `url` signs in: not at all, a pasted token, or OAuth (and where).
  private async probe(url: string): Promise<{ kind: 'none' } | { kind: 'token' } | { kind: 'oauth'; info: ServerInfo } | { kind: 'error'; error: string }> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { kind: 'error', error: 'That is not a web address.' };
    }
    if (!secure(target)) return { kind: 'error', error: 'Use an https:// address.' };
    let res: Response;
    try {
      res = await this.fetch(target.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'overcli', version: '1' } } }),
      });
    } catch (err) {
      return { kind: 'error', error: `The server did not answer: ${err instanceof Error ? err.message : String(err)}` };
    }
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { kind: 'none' };
    if (res.status !== 401 && res.status !== 403) return { kind: 'error', error: `The server answered HTTP ${res.status}. Check the address.` };
    const challenge = res.headers.get('www-authenticate') ?? '';
    const named = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
    const scopeHint = /scope="([^"]+)"/i.exec(challenge)?.[1];
    const p = target.pathname.replace(/\/+$/, '');
    const prmUrls = [named, `${target.origin}/.well-known/oauth-protected-resource${p}`, `${target.origin}/.well-known/oauth-protected-resource`].filter(
      (x, i, all): x is string => !!x && all.indexOf(x) === i,
    );
    let prm: Record<string, unknown> | null = null;
    for (const at of prmUrls) {
      if (!endpoint(at)) continue;
      prm = await this.json(at);
      if (prm) break;
    }
    // A protected resource names its own address; one that names another
    // server's isn't describing this one.
    const resource = typeof prm?.resource === 'string' && endpoint(prm.resource) && new URL(prm.resource).origin === target.origin ? prm.resource : canonical(target);
    const issuers = strings(prm?.authorization_servers) ?? [];
    // Servers from before protected-resource metadata are their own
    // authorization server. No metadata anywhere: it wants a pasted token.
    const as = await this.authServer(issuers.find((i) => endpoint(i)) ?? target.origin);
    if (!as) return { kind: 'token' };
    const prmScopes = strings(prm?.scopes_supported);
    let scope = scopeHint ?? prmScopes?.join(' ');
    // Renewing needs a refresh token, which some services only grant for this.
    if (scope && as.scopesSupported?.includes('offline_access') && !scope.split(' ').includes('offline_access')) scope += ' offline_access';
    return { kind: 'oauth', info: { resource, ...(scope ? { scope } : {}), as } };
  }

  /// How a server signs in, for the install form.
  async discover(url: string, base: string): Promise<Discovery | { ok: false; error: string }> {
    const found = await this.probe(url);
    if (found.kind === 'error') return { ok: false, error: found.error };
    if (found.kind === 'none') return { ok: true, signIn: 'none' };
    if (found.kind === 'token') return { ok: true, signIn: 'token' };
    return { ok: true, signIn: 'oauth', issuer: new URL(found.info.as.issuer).host, registers: !!found.info.as.registrationEndpoint, redirectUri: this.redirectUri(base) };
  }

  /// A client for this service: one registered before, else a new
  /// registration, else the id and secret the admin made there.
  private async client(as: AuthServer, redirectUri: string, given: { clientId?: string; clientSecret?: string }, doc: Doc): Promise<Result<{ client: Client }>> {
    if (given.clientId?.trim()) {
      const secret = given.clientSecret?.trim();
      // RFC 8414: no list means client_secret_basic.
      const authMethod: AuthMethod = !secret ? 'none' : !as.authMethods || as.authMethods.includes('client_secret_basic') ? 'basic' : 'post';
      return { ok: true, client: { issuer: as.issuer, redirectUri, clientId: given.clientId.trim(), ...(secret ? { clientSecret: secret } : {}), authMethod } };
    }
    const known = doc.clients.find((c) => c.issuer === as.issuer && c.redirectUri === redirectUri);
    if (known) return { ok: true, client: known };
    if (!as.registrationEndpoint) return { ok: false, error: `${new URL(as.issuer).host} doesn't let apps register themselves. Make an OAuth app there with the redirect address below, then paste its client ID (and secret).` };
    let host = 'overcli';
    try {
      host = `overcli (${new URL(redirectUri).host})`;
    } catch {
      // keep the plain name
    }
    const reg = await this.json(as.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: host, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    const clientId = typeof reg?.client_id === 'string' ? reg.client_id : '';
    if (!clientId) return { ok: false, error: `${new URL(as.issuer).host} would not register overcli as an app. Make an OAuth app there and paste its client ID instead.` };
    const secret = typeof reg?.client_secret === 'string' ? reg.client_secret : undefined;
    const said = typeof reg?.token_endpoint_auth_method === 'string' ? reg.token_endpoint_auth_method : secret ? 'client_secret_basic' : 'none';
    const client: Client = { issuer: as.issuer, redirectUri, clientId, ...(secret ? { clientSecret: secret } : {}), authMethod: said === 'client_secret_post' ? 'post' : said === 'none' || !secret ? 'none' : 'basic' };
    return { ok: true, client };
  }

  // ---- SIGNING IN ----------------------------------------------------------

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.flows) if (now - v.at > FLOW_TTL_MS) this.flows.delete(k);
  }

  /// The service's sign-in page for this tool, and the cookie value the
  /// browser must bring back with it.
  async start(caller: OrgCaller, input: { name: string; url: string; base: string; next?: string; clientId?: string; clientSecret?: string }): Promise<Result<{ url: string; browserKey: string }>> {
    this.prune();
    if (this.flows.size > MAX_FLOWS) return { ok: false, error: 'Too many sign-ins in progress. Try again in a few minutes.' };
    const found = await this.probe(input.url);
    if (found.kind === 'error') return { ok: false, error: found.error };
    if (found.kind === 'none') return { ok: false, error: 'This server needs no sign-in. Install it as it is.' };
    if (found.kind === 'token') return { ok: false, error: 'This server wants a token rather than a sign-in. Paste it as a header.' };
    const { info } = found;
    const redirectUri = this.redirectUri(input.base);
    let doc: Doc;
    try {
      doc = await this.load();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Signing in again keeps the client the admin pasted the first time.
    const previous = doc.signIns.find((s) => s.name === input.name && s.issuer === info.as.issuer && s.client.redirectUri === redirectUri);
    const got = previous && !input.clientId ? { ok: true as const, client: previous.client } : await this.client(info.as, redirectUri, input, doc);
    if (!got.ok) return got;
    if (!doc.clients.some((c) => c.issuer === got.client.issuer && c.redirectUri === redirectUri && c.clientId === got.client.clientId) && !input.clientId) {
      await this.mutate((d) => {
        d.clients = d.clients.filter((c) => !(c.issuer === got.client.issuer && c.redirectUri === redirectUri));
        d.clients.push(got.client);
      });
    }
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const browserKey = randomBytes(24).toString('base64url');
    // As installing writes it, so the tick can tell it's still the same tool.
    this.flows.set(state, { name: input.name, url: new URL(input.url).toString(), info, client: got.client, verifier, browser: sha256(browserKey), by: caller.name, next: safeHash(input.next), at: this.now() });
    const url = new URL(info.as.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', got.client.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', info.resource);
    if (info.scope) url.searchParams.set('scope', info.scope);
    return { ok: true, url: url.toString(), browserKey };
  }

  private async token(
    at: string,
    client: Client,
    params: Record<string, string>,
  ): Promise<{ ok: true; access: string; refresh?: string; expiresIn?: number; scope?: string } | { ok: false; error: string; ended: boolean }> {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (client.authMethod === 'basic' && client.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
    } else {
      body.set('client_id', client.clientId);
      if (client.authMethod === 'post' && client.clientSecret) body.set('client_secret', client.clientSecret);
    }
    let res: Response;
    let json: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    try {
      res = await this.fetch(at, { method: 'POST', headers, body });
      json = (await res.json().catch(() => ({}))) as typeof json;
    } catch (err) {
      return { ok: false, error: `The service did not answer: ${err instanceof Error ? err.message : String(err)}`, ended: false };
    }
    if (!res.ok || !json.access_token) {
      return { ok: false, error: `The service would not sign in (HTTP ${res.status}${json.error ? `, ${json.error}` : ''}).`, ended: json.error === 'invalid_grant' || json.error === 'invalid_client' || json.error === 'unauthorized_client' };
    }
    return {
      ok: true,
      access: json.access_token,
      ...(json.refresh_token ? { refresh: json.refresh_token } : {}),
      ...(typeof json.expires_in === 'number' ? { expiresIn: json.expires_in } : {}),
      ...(json.scope ? { scope: json.scope } : {}),
    };
  }

  /// The service sent the browser back. Where to send it next, and on
  /// success which tool was signed in (and by whom) for the audit log.
  async callback(query: URLSearchParams, browserKey: string | undefined): Promise<{ location: string; ok: boolean; reason?: ToolCallbackError; name?: string; by?: string }> {
    this.prune();
    const state = query.get('state') ?? '';
    const flow = state ? this.flows.get(state) : undefined;
    if (flow) this.flows.delete(state);
    const back = flow?.next || '#setup/tools';
    const fail = (reason: ToolCallbackError) => ({ ok: false, reason, location: `/${back}${back.includes('?') ? '&' : '?'}signin-error=${reason}${flow ? `&tool=${encodeURIComponent(flow.name)}` : ''}` });
    if (query.get('error')) return fail(query.get('error') === 'access_denied' ? 'denied' : 'exchange');
    if (!flow) return fail('expired');
    // The browser that finishes must be the one that started, so a sign-in
    // link sent to someone else can't put their account on this server.
    if (!browserKey || !sameHash(sha256(browserKey), flow.browser)) return fail('browser');
    const code = query.get('code');
    if (!code) return fail('exchange');
    const got = await this.token(flow.info.as.tokenEndpoint, flow.client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.client.redirectUri,
      code_verifier: flow.verifier,
      resource: flow.info.resource,
    });
    if (!got.ok) {
      this.deps.log?.(`tool sign-in: ${flow.name}: ${got.error}`);
      return fail('exchange');
    }
    const installed = this.deps.install(flow.name, flow.url, got.access);
    if (!installed.ok) {
      this.deps.log?.(`tool sign-in: could not install ${flow.name}: ${installed.error}`);
      return fail('install');
    }
    try {
      await this.mutate((doc) => {
        doc.signIns = doc.signIns.filter((s) => s.name !== flow.name);
        doc.signIns.push({
          name: flow.name,
          url: flow.url,
          resource: flow.info.resource,
          issuer: new URL(flow.info.as.issuer).host,
          tokenEndpoint: flow.info.as.tokenEndpoint,
          ...(flow.info.as.revocationEndpoint ? { revocationEndpoint: flow.info.as.revocationEndpoint } : {}),
          client: flow.client,
          refreshToken: got.refresh ?? '',
          ...(got.expiresIn ? { expiresAt: this.now() + got.expiresIn * 1000 } : {}),
          ...(got.scope ? { scope: got.scope } : {}),
          by: flow.by,
          at: this.now(),
          // Without a refresh token it works until the access token runs out.
          ...(!got.refresh && got.expiresIn ? { why: 'The service gave no way to renew this sign-in, so it lasts until the token runs out.' } : {}),
        });
      });
    } catch (err) {
      this.deps.log?.(`tool sign-in: could not keep ${flow.name}'s sign-in: ${err instanceof Error ? err.message : String(err)}`);
      return fail('server');
    }
    this.deps.log?.(`tool sign-in: ${flow.by} signed ${flow.name} in to ${new URL(flow.info.as.issuer).host}.`);
    return { ok: true, name: flow.name, by: flow.by, location: `/${back}${back.includes('?') ? '&' : '?'}signedin=${encodeURIComponent(flow.name)}` };
  }

  // ---- KEEPING IT FRESH ----------------------------------------------------

  /// Renew one tool's token now, and rewrite its header.
  private refreshOne(name: string): Promise<void> {
    const running = this.refreshing.get(name);
    if (running) return running;
    const job = (async () => {
      const doc = await this.load();
      const s = doc.signIns.find((x) => x.name === name);
      if (!s || s.endedAt || !s.refreshToken) return;
      const got = await this.token(s.tokenEndpoint, s.client, { grant_type: 'refresh_token', refresh_token: s.refreshToken, resource: s.resource });
      if (!got.ok) {
        if (got.ended) {
          await this.mutate((d) => {
            const x = d.signIns.find((y) => y.name === name);
            if (x) Object.assign(x, { refreshToken: '', endedAt: this.now(), why: `${s.issuer} ended this sign-in. Sign in again.` });
          });
          this.deps.log?.(`tool sign-in: ${s.issuer} ended ${name}'s sign-in.`);
        } else {
          this.deps.log?.(`tool sign-in: could not renew ${name}: ${got.error}`);
        }
        return;
      }
      const installed = this.deps.install(s.name, s.url, got.access);
      if (!installed.ok) this.deps.log?.(`tool sign-in: could not rewrite ${name}: ${installed.error}`);
      await this.mutate((d) => {
        const x = d.signIns.find((y) => y.name === name);
        if (!x) return;
        // Services that rotate refresh tokens send a new one each time.
        if (got.refresh) x.refreshToken = got.refresh;
        if (got.expiresIn) x.expiresAt = this.now() + got.expiresIn * 1000;
        else delete x.expiresAt;
        delete x.why;
      });
    })()
      .catch((err) => this.deps.log?.(`tool sign-in: renewing ${name} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.refreshing.delete(name));
    this.refreshing.set(name, job);
    return job;
  }

  /// Renew what is close to running out; forget tools that were removed or
  /// reinstalled some other way.
  async tick(): Promise<void> {
    if (!fs.existsSync(this.file())) return;
    const doc = await this.load();
    const gone = doc.signIns.filter((s) => !sameUrl(this.deps.installedUrl(s.name), s.url)).map((s) => s.name);
    if (gone.length) await this.mutate((d) => (d.signIns = d.signIns.filter((s) => !gone.includes(s.name))));
    const now = this.now();
    for (const s of doc.signIns) {
      if (gone.includes(s.name) || s.endedAt) continue;
      if (!s.refreshToken) {
        if (s.expiresAt && s.expiresAt <= now) {
          await this.mutate((d) => {
            const x = d.signIns.find((y) => y.name === s.name);
            if (x) Object.assign(x, { endedAt: now, why: 'The sign-in ran out. Sign in again.' });
          });
        }
        continue;
      }
      if (!s.expiresAt || s.expiresAt - now < REFRESH_AHEAD_MS) await this.refreshOne(s.name);
    }
  }

  /// Renew on a timer. The first tick runs at once: after a restart the
  /// header on disk may be hours old.
  keepFresh(): void {
    if (this.timer) return;
    const run = () => void this.tick().catch((err) => this.deps.log?.(`tool sign-in: ${err instanceof Error ? err.message : String(err)}`));
    run();
    this.timer = setInterval(run, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /// The tool was removed: drop its sign-in, and end it at the service when
  /// the service says how.
  async forget(name: string): Promise<void> {
    if (!fs.existsSync(this.file())) return;
    const doc = await this.load();
    const s = doc.signIns.find((x) => x.name === name);
    if (!s) return;
    if (s.revocationEndpoint && s.refreshToken) {
      try {
        const body = new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.client.clientId });
        await this.fetch(s.revocationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      } catch {
        // best effort: the admin can end it at the service
      }
    }
    await this.mutate((d) => (d.signIns = d.signIns.filter((x) => x.name !== name)));
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/// https, or http to this machine (a server on the same host, in testing).
function secure(u: URL): boolean {
  return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'));
}

function endpoint(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    return secure(new URL(v)) ? v : null;
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/// The server's address as the resource it is: no fragment, no trailing slash.
function canonical(u: URL): string {
  const c = new URL(u.toString());
  c.hash = '';
  return c.toString().replace(/\/$/, '');
}

function sameUrl(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
}
