import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OrgSso } from '../../shared/org/policy';
import { SsoService } from './sso';

const ISSUER = 'https://idp.acme.example';
const CLIENT = 'overcli-console';
const BASE = 'https://overcli.acme.example';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function idToken(claims: Record<string, unknown>, opts: { key?: typeof privateKey; kid?: string } = {}): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function harness(over: { sso?: Partial<OrgSso>; people?: Record<string, string>; token?: (nonce: string) => string } = {}) {
  const now = 1_800_000_000_000;
  const minted: string[] = [];
  let lastNonce = '';
  const sso: OrgSso = { issuer: ISSUER, clientId: CLIENT, allowedDomains: [], required: false, ...over.sso };
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
    }
    if (url === `${ISSUER}/keys`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')).toBeTruthy();
      expect(body.get('redirect_uri')).toBe(`${BASE}/sso/callback`);
      const claims = { iss: ISSUER, aud: CLIENT, exp: now / 1000 + 300, iat: now / 1000, nonce: lastNonce, email: 'Pat@Acme.com', email_verified: true, name: 'Pat Lee' };
      return Response.json({ id_token: over.token ? over.token(lastNonce) : idToken(claims) });
    }
    return new Response('nope', { status: 404 });
  };
  const svc = new SsoService({
    sso: () => sso,
    publicUrl: () => BASE,
    resolvePerson: async (email) => (over.people ?? { 'pat@acme.com': 'U0ACMEPAT' })[email] ? { slackUserId: (over.people ?? { 'pat@acme.com': 'U0ACMEPAT' })[email] } : null,
    signIn: (p) => {
      minted.push(`${p.slackUserId}:${p.name}:${p.email}`);
      return { token: `ocli_sso_${minted.length}` };
    },
    fetchImpl: fetchImpl as never,
    now: () => now,
  });
  const begin = async (next = '/') => {
    const started = await svc.start(next);
    if (!started.ok) throw new Error(started.error);
    const url = new URL(started.url);
    lastNonce = url.searchParams.get('nonce')!;
    return { url, state: url.searchParams.get('state')! };
  };
  return { svc, minted, begin, now };
}

describe('company sign-in', () => {
  it('sends the browser to the provider with PKCE, and signs in the person the token names', async () => {
    const h = harness();
    const { url, state } = await h.begin('/pair?code=ABC-DEF');
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/sso/callback`);
    const back = await h.svc.callback(new URLSearchParams({ code: 'c', state }));
    expect(back).toMatchObject({ ok: true, next: '/pair?code=ABC-DEF' });
    expect(h.minted).toEqual(['U0ACMEPAT:Pat Lee:pat@acme.com']);
    if (!back.ok) return;
    expect(h.svc.redeem(back.handoff)).toEqual({ ok: true, token: 'ocli_sso_1', name: 'Pat Lee' });
    expect(h.svc.redeem(back.handoff).ok).toBe(false);
  });

  it('uses a state once', async () => {
    const h = harness();
    const { state } = await h.begin();
    expect((await h.svc.callback(new URLSearchParams({ code: 'c', state }))).ok).toBe(true);
    expect((await h.svc.callback(new URLSearchParams({ code: 'c', state }))).ok).toBe(false);
  });

  it('refuses a token signed with another key, for another app, or for another sign-in', async () => {
    const base = { iss: ISSUER, exp: 1_800_000_300, email: 'pat@acme.com' };
    const cases: Array<(nonce: string) => string> = [
      (nonce) => idToken({ ...base, aud: CLIENT, nonce }, { key: other.privateKey }),
      (nonce) => idToken({ ...base, aud: 'someone-else', nonce }),
      () => idToken({ ...base, aud: CLIENT, nonce: 'stale' }),
      (nonce) => idToken({ ...base, aud: CLIENT, nonce, exp: 1_700_000_000 }),
      (nonce) => idToken({ ...base, aud: CLIENT, nonce, iss: 'https://evil.example' }),
    ];
    for (const token of cases) {
      const h = harness({ token });
      const { state } = await h.begin();
      expect((await h.svc.callback(new URLSearchParams({ code: 'c', state }))).ok).toBe(false);
      expect(h.minted).toEqual([]);
    }
  });

  it('keeps out other domains and people it cannot place', async () => {
    const narrow = harness({ sso: { allowedDomains: ['acme.org'] } });
    const a = await narrow.begin();
    expect(await narrow.svc.callback(new URLSearchParams({ code: 'c', state: a.state }))).toMatchObject({ ok: false, error: expect.stringMatching(/acme.com addresses/) });
    const stranger = harness({ people: {} });
    const b = await stranger.begin();
    expect(await stranger.svc.callback(new URLSearchParams({ code: 'c', state: b.state }))).toMatchObject({ ok: false, error: expect.stringMatching(/doesn't know who that is/) });
  });

  it('never redirects off the server afterwards', async () => {
    const h = harness();
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const { state } = await h.begin(next);
      expect(await h.svc.callback(new URLSearchParams({ code: 'c', state }))).toMatchObject({ ok: true, next: '/' });
    }
  });
});
