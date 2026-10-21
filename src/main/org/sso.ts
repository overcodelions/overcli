// Signing in with the company's identity provider (OpenID Connect).
//
// The authorization-code flow with PKCE, as Okta, Entra ID, Google and the
// rest all speak it. The browser goes to the provider, comes back to
// /sso/callback with a code, and the server swaps the code for an ID token
// over TLS, checks the token's signature against the provider's published
// keys, its issuer, audience, expiry and nonce, and reads the email.
//
// overcli knows people by their Slack member id, so an email becomes a
// person through org.json's `people` map, or by asking Slack. Who may sign in
// at all is the provider's to decide (assign the app to the people who
// should have it) narrowed by `allowedDomains`.
//
// Nothing here holds a session. A successful sign-in mints an ordinary
// token, handed to the console through a one-time code so the token itself
// never appears in a URL.

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import type { OrgSso } from '../../shared/org/policy';

export const SSO_CLIENT_SECRET_ENV = 'OVERCLI_SSO_CLIENT_SECRET';
const FLOW_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 120;

type JsonWebKey = { kty?: string; kid?: string; [k: string]: unknown };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface SsoDeps {
  sso(): OrgSso | undefined;
  /// Where the provider sends people back: org.json's publicUrl.
  publicUrl(): string | undefined;
  clientSecret?(): string | undefined;
  /// Who an email is: org.json's `people`, then Slack.
  resolvePerson(email: string): Promise<{ slackUserId: string; name?: string } | null>;
  /// Mint the browser's sign-in.
  signIn(person: { slackUserId: string; name: string; email: string }): { token: string };
  fetchImpl?: FetchLike;
  now?(): number;
}

export type SsoResult<T> = { ok: true } & T;
export type SsoError = { ok: false; error: string };

export class SsoService {
  private flows = new Map<string, { verifier: string; nonce: string; next: string; at: number }>();
  private handoffs = new Map<string, { token: string; name: string; at: number }>();
  private discovery: { issuer: string; doc: Discovery; at: number } | null = null;
  private keys: { uri: string; keys: JsonWebKey[]; at: number } | null = null;

  constructor(private readonly deps: SsoDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    return (this.deps.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /// Whether sign-in with the provider is on, and what the button says.
  status(): { enabled: boolean; required: boolean; provider?: string; problem?: string } {
    const sso = this.deps.sso();
    if (!sso) return { enabled: false, required: false };
    const provider = new URL(sso.issuer).hostname;
    if (!this.deps.publicUrl()) return { enabled: false, required: false, provider, problem: 'Set the console address (publicUrl) first: the provider needs a fixed address to send people back to.' };
    return { enabled: true, required: sso.required, provider };
  }

  redirectUri(): string | null {
    const base = this.deps.publicUrl();
    return base ? `${base.replace(/\/+$/, '')}/sso/callback` : null;
  }

  private async config(sso: OrgSso): Promise<Discovery> {
    if (this.discovery && this.discovery.issuer === sso.issuer && this.now() - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.doc;
    const res = await this.fetch(`${sso.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`The identity provider's configuration answered HTTP ${res.status}.`);
    const doc = (await res.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('The identity provider did not publish its endpoints.');
    if (doc.issuer.replace(/\/+$/, '') !== sso.issuer) throw new Error(`The provider says it is ${doc.issuer}, not ${sso.issuer}. Check the issuer in the rules.`);
    for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
      if (new URL(u).protocol !== 'https:') throw new Error('The identity provider published an endpoint that is not https.');
    }
    this.discovery = { issuer: sso.issuer, doc, at: this.now() };
    return doc;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.flows) if (now - v.at > FLOW_TTL_MS) this.flows.delete(k);
    for (const [k, v] of this.handoffs) if (now - v.at > HANDOFF_TTL_MS) this.handoffs.delete(k);
  }

  /// Where to send the browser to sign in.
  async start(next = '/'): Promise<SsoResult<{ url: string }> | SsoError> {
    const sso = this.deps.sso();
    const redirectUri = this.redirectUri();
    if (!sso || !redirectUri) return { ok: false, error: this.status().problem ?? 'Single sign-on is not set up.' };
    let doc: Discovery;
    try {
      doc = await this.config(sso);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.prune();
    if (this.flows.size > 5_000) return { ok: false, error: 'Too many sign-ins in progress. Try again in a minute.' };
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    this.flows.set(state, { verifier, nonce, next: safeNext(next), at: this.now() });
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', sso.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    return { ok: true, url: url.toString() };
  }

  /// The provider sent the browser back. Returns a one-time code the console
  /// swaps for its token, and where to go after.
  async callback(params: URLSearchParams): Promise<SsoResult<{ handoff: string; next: string }> | SsoError> {
    const sso = this.deps.sso();
    const redirectUri = this.redirectUri();
    if (!sso || !redirectUri) return { ok: false, error: 'Single sign-on is not set up.' };
    const providerError = params.get('error');
    if (providerError) return { ok: false, error: `The identity provider said: ${params.get('error_description') || providerError}.` };
    this.prune();
    const state = params.get('state') ?? '';
    const flow = this.flows.get(state);
    if (!flow) return { ok: false, error: 'That sign-in expired or was already used. Start again.' };
    this.flows.delete(state);
    const code = params.get('code');
    if (!code) return { ok: false, error: 'The identity provider sent no code.' };

    let claims: Record<string, unknown>;
    try {
      const doc = await this.config(sso);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: sso.clientId, code_verifier: flow.verifier });
      const secret = this.deps.clientSecret?.();
      if (secret) body.set('client_secret', secret);
      const res = await this.fetch(doc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
      const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !json.id_token) return { ok: false, error: `The identity provider refused the sign-in: ${json.error_description || json.error || `HTTP ${res.status}`}.` };
      claims = await this.verifyIdToken(json.id_token, sso, doc, flow.nonce);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email) return { ok: false, error: 'The identity provider did not share an email address. Ask an admin to add the email scope.' };
    if (claims.email_verified === false) return { ok: false, error: 'The identity provider has not verified that email address.' };
    const domain = email.split('@')[1] ?? '';
    if (sso.allowedDomains.length && !sso.allowedDomains.includes(domain)) return { ok: false, error: `${domain} addresses cannot sign in here.` };
    const person = await this.deps.resolvePerson(email);
    if (!person) {
      return { ok: false, error: `Signed in as ${email}, but overgo doesn't know who that is in Slack yet. Ask an admin to add you on Admin → Rules → Sign-in.` };
    }
    const name = (typeof claims.name === 'string' && claims.name.trim()) || person.name || email.split('@')[0];
    const { token } = this.deps.signIn({ slackUserId: person.slackUserId, name, email });
    const handoff = b64url(randomBytes(24));
    this.handoffs.set(handoff, { token, name, at: this.now() });
    return { ok: true, handoff, next: flow.next };
  }

  /// The console swaps its one-time code for the token, once.
  redeem(handoff: string): SsoResult<{ token: string; name: string }> | SsoError {
    this.prune();
    const hit = this.handoffs.get(handoff);
    if (!hit) return { ok: false, error: 'That sign-in has expired. Start again.' };
    this.handoffs.delete(handoff);
    return { ok: true, token: hit.token, name: hit.name };
  }

  private async jwks(uri: string, refresh: boolean): Promise<JsonWebKey[]> {
    if (!refresh && this.keys && this.keys.uri === uri && this.now() - this.keys.at < DISCOVERY_TTL_MS) return this.keys.keys;
    const res = await this.fetch(uri);
    if (!res.ok) throw new Error(`The identity provider's keys answered HTTP ${res.status}.`);
    const keys = ((await res.json()) as { keys?: JsonWebKey[] }).keys ?? [];
    this.keys = { uri, keys, at: this.now() };
    return keys;
  }

  private async verifyIdToken(idToken: string, sso: OrgSso, doc: Discovery, nonce: string): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('The identity provider sent a malformed ID token.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const alg = ALGS[header.alg ?? ''];
    if (!alg) throw new Error(`The ID token is signed with ${header.alg ?? 'nothing'}, which overcli does not accept.`);
    const pick = (keys: JsonWebKey[]) => keys.find((k) => (header.kid ? (k as { kid?: string }).kid === header.kid : true) && k.kty === alg.kty);
    let jwk = pick(await this.jwks(doc.jwks_uri, false));
    // Providers rotate keys; one refetch covers a key published since.
    if (!jwk) jwk = pick(await this.jwks(doc.jwks_uri, true));
    if (!jwk) throw new Error('The ID token is signed with a key the identity provider does not publish.');
    const key = createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0]);
    const ok = verifySignature(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), alg.kty === 'EC' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('The ID token signature does not check out.');

    const nowS = Math.floor(this.now() / 1000);
    const iss = String(claims.iss ?? '').replace(/\/+$/, '');
    if (iss !== sso.issuer) throw new Error('The ID token is from a different issuer.');
    const aud = claims.aud;
    if (!(aud === sso.clientId || (Array.isArray(aud) && aud.includes(sso.clientId)))) throw new Error('The ID token is for a different app.');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new Error('The ID token has expired.');
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) throw new Error('The ID token is from the future. Check the server clock.');
    if (claims.nonce !== nonce) throw new Error('The ID token does not belong to this sign-in.');
    return claims;
  }
}

const ALGS: Record<string, { hash: string; kty: 'RSA' | 'EC' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC' },
  ES384: { hash: 'sha384', kty: 'EC' },
};

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/// Only a path on this server: never an open redirect.
function safeNext(next: string): string {
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&%.]*$/.test(next) ? next : '/';
}
