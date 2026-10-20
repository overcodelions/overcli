import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { CONNECTIONS_KEY_SECRET, ConnectionsService, NOT_CONFIGURED_WHY, safeHash } from './connections';
import { OrgService } from './orgService';
import type { SavedFile } from './orgStores';

const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };
const CLIENT = 'acme-client.apps.googleusercontent.com';
const REFRESH = '1//acme-refresh-token-very-secret';
const BASE = 'https://overcli.acme.test';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ iss: 'https://accounts.google.com', aud: CLIENT, email: 'pat@acme.test', email_verified: true, ...claims })}.sig`;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (call: Call) => { status?: number; json: unknown } | undefined;

function harness(opts: { configured?: boolean; secrets?: boolean; respond?: Responder } = {}) {
  const dir = tmp('acme-connections-');
  const calls: Call[] = [];
  const secretValues: Record<string, string> = {};
  let now = 1_000_000;
  const env: NodeJS.ProcessEnv = opts.configured === false ? {} : { GOOGLE_OAUTH_CLIENT_ID: CLIENT, GOOGLE_OAUTH_CLIENT_SECRET: 'acme-client-secret' };
  let refreshes = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? raw.toString() : Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : '';
    const call: Call = { url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body };
    calls.push(call);
    const custom = opts.respond?.(call);
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
    if (custom) return reply(custom.status ?? 200, custom.json);
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        return reply(200, { access_token: 'ya29.first', expires_in: 3600, refresh_token: REFRESH, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file', id_token: idToken({}) });
      }
      refreshes++;
      return reply(200, { access_token: `ya29.refreshed-${refreshes}`, expires_in: 3600 });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return reply(200, {});
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?q=') || url.startsWith('https://www.googleapis.com/drive/v3/files?q')) return reply(200, { files: [] });
    if (url === 'https://www.googleapis.com/drive/v3/files?fields=id') return reply(200, { id: 'folder-acme' });
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) return reply(200, { id: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
    return reply(404, { error: 'unexpected' });
  };
  const svc = new ConnectionsService({
    dir: () => dir,
    publicUrl: () => undefined,
    env,
    ...(opts.secrets === false
      ? {}
      : {
          privateSecrets: {
            get: async (name: string) => secretValues[name],
            set: async (name: string, value: string) => {
              secretValues[name] = value;
              return true;
            },
          },
        }),
    fetchImpl,
    now: () => now,
  });
  const tick = (ms: number) => (now += ms);
  return { svc, dir, calls, env, secretValues, tick, refreshes: () => refreshes };
}

/// Start as Pat, then come back from Google with the code.
async function connect(h: ReturnType<typeof harness>, caller = pat, next?: string) {
  const started = h.svc.start(caller, { base: BASE, ...(next ? { next } : {}) });
  if (!started.ok) throw new Error(started.error);
  const state = new URL(started.url).searchParams.get('state')!;
  const back = await h.svc.callback(new URLSearchParams({ state, code: 'acme-code' }), started.browserKey);
  return { started, state, back };
}

describe('connecting Google Drive', () => {
  it('starts with a consent URL carrying PKCE, a state and only the drive.file scope', () => {
    const h = harness();
    const started = h.svc.start(pat, { base: BASE, next: '#teams/council' });
    if (!started.ok) throw new Error(started.error);
    const url = new URL(started.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT);
    expect(q.get('redirect_uri')).toBe(`${BASE}/oauth/google/callback`);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('include_granted_scopes')).toBe('true');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(started.browserKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Two starts, two states.
    const again = h.svc.start(pat, { base: BASE });
    expect(again.ok && new URL(again.url).searchParams.get('state')).not.toBe(q.get('state'));
  });

  it('refuses to start until an admin adds the OAuth client', async () => {
    const h = harness({ configured: false });
    expect(h.svc.start(pat, { base: BASE })).toEqual({ ok: false, error: NOT_CONFIGURED_WHY });
    expect(await h.svc.list(pat, BASE)).toEqual([
      { provider: 'google', label: 'Google Drive', ready: false, why: NOT_CONFIGURED_WHY, redirectUri: `${BASE}/oauth/google/callback`, connected: false },
    ]);
  });

  it('only takes a console hash as where to go after', () => {
    expect(safeHash('#teams/council?tab=files')).toBe('#teams/council?tab=files');
    expect(safeHash('https://evil.example/#x')).toBe('');
    expect(safeHash('//evil.example')).toBe('');
    expect(safeHash('#x\r\nSet-Cookie: a=b')).toBe('');
    expect(safeHash('#javascript:alert(1)')).toBe('');
    expect(safeHash(undefined)).toBe('');
  });

  it('rejects an unknown, expired or reused state, and a different browser', async () => {
    const h = harness();
    expect(await h.svc.callback(new URLSearchParams({ state: 'made-up', code: 'c' }), 'k')).toEqual({ ok: false, reason: 'expired', location: '/#connections/google-error?reason=expired' });

    const late = h.svc.start(pat, { base: BASE });
    if (!late.ok) throw new Error(late.error);
    h.tick(11 * 60 * 1000);
    const lateState = new URL(late.url).searchParams.get('state')!;
    expect((await h.svc.callback(new URLSearchParams({ state: lateState, code: 'c' }), late.browserKey)).reason).toBe('expired');

    const other = h.svc.start(pat, { base: BASE });
    if (!other.ok) throw new Error(other.error);
    const otherState = new URL(other.url).searchParams.get('state')!;
    expect((await h.svc.callback(new URLSearchParams({ state: otherState, code: 'c' }), 'someone-elses-cookie')).reason).toBe('browser');
    // A failed try still uses the state up.
    expect((await h.svc.callback(new URLSearchParams({ state: otherState, code: 'c' }), other.browserKey)).reason).toBe('expired');

    const { state, started, back } = await connect(h);
    expect(back.ok).toBe(true);
    expect((await h.svc.callback(new URLSearchParams({ state, code: 'acme-code' }), started.browserKey)).reason).toBe('expired');
    // Only the one good callback reached Google.
    expect(h.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it("says when Google was told no, without echoing what Google said", async () => {
    const h = harness();
    const started = h.svc.start(pat, { base: BASE });
    if (!started.ok) throw new Error(started.error);
    const state = new URL(started.url).searchParams.get('state')!;
    const back = await h.svc.callback(new URLSearchParams({ state, error: 'access_denied', error_description: '<script>x</script>' }), started.browserKey);
    expect(back).toEqual({ ok: false, reason: 'denied', location: '/#connections/google-error?reason=denied' });
  });

  it('stores the connection encrypted, sends the browser back to where it was, and lists it', async () => {
    const h = harness();
    const { back } = await connect(h, pat, '#teams/council');
    expect(back).toEqual({ ok: true, location: '/#teams/council?connected=google' });
    const exchange = h.calls.find((c) => c.url.endsWith('/token'))!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(`${BASE}/oauth/google/callback`);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get('client_secret')).toBe('acme-client-secret');

    const file = path.join(h.dir, 'connections.json');
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(REFRESH);
    expect(onDisk).not.toContain('pat@acme.test');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The key went to the secrets service, not a file.
    expect(h.secretValues[CONNECTIONS_KEY_SECRET]).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(h.dir, 'connections.key'))).toBe(false);

    expect(await h.svc.list(pat, BASE)).toEqual([
      { provider: 'google', label: 'Google Drive', ready: true, redirectUri: `${BASE}/oauth/google/callback`, connected: true, account: 'pat@acme.test', connectedAt: 1_000_000 },
    ]);
    expect((await h.svc.list(sam, BASE))[0]).toMatchObject({ ready: true, connected: false });
    expect((await h.svc.list(sam, BASE))[0].account).toBeUndefined();
  });

  it('defaults to the connections page after, and checks the verifier against the challenge', async () => {
    const h = harness();
    const started = h.svc.start(pat, { base: BASE });
    if (!started.ok) throw new Error(started.error);
    const q = new URL(started.url).searchParams;
    const back = await h.svc.callback(new URLSearchParams({ state: q.get('state')!, code: 'acme-code' }), started.browserKey);
    expect(back.location).toBe('/#connections?connected=google');
    const verifier = new URLSearchParams(h.calls.find((c) => c.url.endsWith('/token'))!.body).get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(q.get('code_challenge'));
  });

  it('keeps the key in a 0600 file when there is no secrets store', async () => {
    const h = harness({ secrets: false });
    await connect(h);
    const keyFile = path.join(h.dir, 'connections.key');
    expect(fs.readFileSync(keyFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect((await h.svc.list(pat, BASE))[0].connected).toBe(true);
  });

  it('refuses a token without the Drive scope, or for a different app', async () => {
    const noDrive = harness({ respond: (c) => (c.url.endsWith('/token') ? { json: { access_token: 'a', refresh_token: REFRESH, scope: 'openid email', id_token: idToken({}) } } : undefined) });
    expect((await connect(noDrive)).back.reason).toBe('scope');
    const otherApp = harness({ respond: (c) => (c.url.endsWith('/token') ? { json: { access_token: 'a', refresh_token: REFRESH, scope: 'https://www.googleapis.com/auth/drive.file', id_token: idToken({ aud: 'someone-else' }) } } : undefined) });
    expect((await connect(otherApp)).back.reason).toBe('no-email');
    expect(fs.existsSync(path.join(otherApp.dir, 'connections.json'))).toBe(false);
  });
});

describe('using a connection', () => {
  it('refreshes the access token and caches it until a minute before it expires', async () => {
    const h = harness();
    await connect(h);
    h.tick(3600 * 1000); // the token from the exchange has run out
    const a = await h.svc.accessToken(pat);
    expect(a).toEqual({ ok: true, token: 'ya29.refreshed-1' });
    const refresh = h.calls.filter((c) => c.url.endsWith('/token')).at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toEqual({ grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT, client_secret: 'acme-client-secret' });
    h.tick(3500 * 1000);
    expect(await h.svc.accessToken(pat)).toEqual({ ok: true, token: 'ya29.refreshed-1' });
    h.tick(60 * 1000);
    expect(await h.svc.accessToken(pat)).toEqual({ ok: true, token: 'ya29.refreshed-2' });
    expect(h.refreshes()).toBe(2);
    expect(await h.svc.accessToken(sam)).toEqual({ ok: false, error: 'Connect your Google account first.' });
  });

  it('marks the connection ended when Google says invalid_grant', async () => {
    let revoked = false;
    const h = harness({ respond: (c) => (revoked && c.url.endsWith('/token') ? { status: 400, json: { error: 'invalid_grant' } } : undefined) });
    await connect(h);
    h.tick(3600 * 1000);
    revoked = true;
    expect(await h.svc.accessToken(pat)).toEqual({ ok: false, error: 'Reconnect Google Drive' });
    const [row] = await h.svc.list(pat, BASE);
    expect(row).toMatchObject({ connected: false, account: 'pat@acme.test' });
    expect(row.why).toMatch(/Connect again/);
    expect(await h.svc.status(pat)).toEqual({ configured: true, connected: false, why: 'Connect your Google account first.' });
    expect(await h.svc.accessToken(pat)).toEqual({ ok: false, error: 'Reconnect Google Drive' });
  });

  it('makes the overcli folder once, then uploads into it as the person', async () => {
    const h = harness();
    await connect(h);
    const up = await h.svc.upload(pat, { name: 'pieces/plan.md', mimeType: 'text/markdown', data: Buffer.from('# Acme plan\nShip it.') });
    expect(up).toEqual({ ok: true, link: 'https://drive.google.com/file/d/file-1/view' });
    const listed = h.calls.find((c) => c.url.startsWith('https://www.googleapis.com/drive/v3/files?q'))!;
    expect(new URL(listed.url).searchParams.get('q')).toBe("name='overcli' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const made = h.calls.find((c) => c.url === 'https://www.googleapis.com/drive/v3/files?fields=id')!;
    expect(JSON.parse(made.body)).toEqual({ name: 'overcli', mimeType: 'application/vnd.google-apps.folder' });
    const upload = h.calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/'))!;
    expect(upload.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink');
    expect(upload.headers.Authorization).toBe('Bearer ya29.first');
    expect(upload.headers['Content-Type']).toMatch(/^multipart\/related; boundary=overcli-[0-9a-f]+$/);
    expect(upload.body).toContain('"name":"plan.md"');
    expect(upload.body).toContain('"parents":["folder-acme"]');
    expect(upload.body).toContain('Content-Type: text/markdown\r\n\r\n# Acme plan\nShip it.');

    await h.svc.upload(pat, { name: 'two.md', mimeType: 'text/markdown', data: Buffer.from('two') });
    expect(h.calls.filter((c) => c.url === 'https://www.googleapis.com/drive/v3/files?fields=id')).toHaveLength(1);
    expect(h.calls.filter((c) => c.url.startsWith('https://www.googleapis.com/drive/v3/files?q'))).toHaveLength(1);
    expect(h.calls.filter((c) => c.url.startsWith('https://www.googleapis.com/upload/'))).toHaveLength(2);
    // The folder id is kept sealed with the rest.
    expect(fs.readFileSync(path.join(h.dir, 'connections.json'), 'utf8')).not.toContain('folder-acme');
  });

  it('uses a folder it made before, found by the search', async () => {
    const h = harness({ respond: (c) => (c.url.startsWith('https://www.googleapis.com/drive/v3/files?q') ? { json: { files: [{ id: 'folder-old' }] } } : undefined) });
    await connect(h);
    await h.svc.upload(pat, { name: 'a.md', mimeType: 'text/markdown', data: Buffer.from('a') });
    expect(h.calls.some((c) => c.url === 'https://www.googleapis.com/drive/v3/files?fields=id')).toBe(false);
    expect(h.calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/'))!.body).toContain('"parents":["folder-old"]');
  });

  it('disconnects: revokes at Google and forgets it here', async () => {
    const h = harness();
    await connect(h);
    expect(await h.svc.disconnect(pat, 'google')).toEqual({ ok: true });
    const revoke = h.calls.find((c) => c.url === 'https://oauth2.googleapis.com/revoke')!;
    expect(new URLSearchParams(revoke.body).get('token')).toBe(REFRESH);
    expect((await h.svc.list(pat, BASE))[0]).toMatchObject({ connected: false });
    expect((await h.svc.list(pat, BASE))[0].account).toBeUndefined();
    expect(await h.svc.accessToken(pat)).toEqual({ ok: false, error: 'Connect your Google account first.' });
    expect(await h.svc.disconnect(pat, 'dropbox')).toEqual({ ok: false, error: 'No connection by that name.' });
  });

  it('still forgets the connection when revoking fails', async () => {
    const h = harness({ respond: (c) => (c.url.endsWith('/revoke') ? { status: 500, json: {} } : undefined) });
    await connect(h);
    expect(await h.svc.disconnect(pat, 'google')).toEqual({ ok: true });
    expect((await h.svc.list(pat, BASE))[0].connected).toBe(false);
  });
});

// ---- TEAM FILES INTO YOUR OWN DRIVE ----------------------------------------

const triage: Worker = {
  id: 'triage',
  name: 'Triage',
  jobDescription: 'Scores roadmap items for delivery risk.',
  projectPath: '/data/Workers',
  cadence: null,
  trust: 'probation',
  caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
  budgetUSDPerMonth: 20,
  heartbeatModel: 'sonnet',
  flowIds: ['triage-flow'],
  enabled: true,
  createdAt: 0,
  manager: { name: 'Pat', slackUserId: pat.slackUserId! },
};

function org(connections: ConnectionsService | undefined) {
  const root = tmp('acme-team-task-');
  fs.writeFileSync(path.join(root, 'plan.md'), '# The plan\nScore, then write it up.');
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  const task = {
    id: 'task-1',
    teamId: 'team-1',
    teamName: 'Council',
    brief: 'Rank the roadmap',
    title: 'Roadmap ranking',
    status: 'running',
    createdAt: 500,
    updatedAt: 2_000,
    stageIndex: 0,
    spentUSD: 0,
    budgetUSD: 40,
    folder: root,
    requestedBy: { name: 'Pat', slackUserId: pat.slackUserId },
    files: [],
    stages: [],
  };
  let saved: SavedFile[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [triage],
      get: (id) => (id === triage.id ? triage : null),
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [triage.name],
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    // Everyone sees the team, so Sam's view can be compared with Pat's.
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*', admins: ['U0ACMESAM'] }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    teams: {
      list: () => ({
        teams: [{ id: 'team-1', name: 'Council', purpose: 'Rank things', budgetUSDPerTask: 40, members: [{ workerId: 'triage', role: 'delivery' }], createdAt: 0 }],
        tasks: [task],
      }) as never,
      brief: () => ({ ok: false, error: 'no' }),
      answer: () => ({ ok: true }),
      approve: () => ({ ok: true }),
      revise: () => ({ ok: true }),
      continueTask: () => ({ ok: true }),
      cancel: () => ({ ok: true }),
    },
    teamFiles: { kept: () => [], saveKept: () => {}, saved: () => saved, saveSaved: (all) => (saved = structuredClone(all)) },
    ...(connections ? { connections } : {}),
    now: () => 9_000_000,
  });
  return { svc, saved: () => saved };
}

describe("a team task's files, into your own Google Drive", () => {
  it('offers "Your Google Drive", ready only for the person who connected, in place of the placeholder', async () => {
    const h = harness();
    await connect(h);
    const o = org(h.svc);
    const forPat = await o.svc.teamTaskFiles(pat, 'task-1');
    const forSam = await o.svc.teamTaskFiles({ ...sam, admin: true }, 'task-1');
    if (!forPat.ok || !forSam.ok) throw new Error('not visible');
    expect(forPat.destinations).toEqual([
      { id: 'library', label: 'Library', kind: 'library', ready: true },
      { id: 'google:me', label: 'Your Google Drive', kind: 'drive', ready: true },
      { id: 'sharepoint', label: 'SharePoint', kind: 'sharepoint', ready: false, why: 'Install a SharePoint or OneDrive tool on Setup → Tools' },
    ]);
    expect(forSam.destinations.find((d) => d.id === 'google:me')).toEqual({ id: 'google:me', label: 'Your Google Drive', kind: 'drive', ready: false, why: 'Connect your Google account first.' });
    expect(forPat.destinations.some((d) => d.id === 'drive')).toBe(false);
  });

  it("says an admin must add the client when the app isn't set up, and keeps the placeholder off with no connections at all", async () => {
    const h = harness({ configured: false });
    const files = await org(h.svc).svc.teamTaskFiles(pat, 'task-1');
    if (!files.ok) throw new Error(files.error);
    expect(files.destinations.find((d) => d.id === 'google:me')).toEqual({ id: 'google:me', label: 'Your Google Drive', kind: 'drive', ready: false, why: NOT_CONFIGURED_WHY });
    const without = await org(undefined).svc.teamTaskFiles(pat, 'task-1');
    if (!without.ok) throw new Error(without.error);
    expect(without.destinations.map((d) => d.id)).toEqual(['library', 'drive', 'sharepoint']);
  });

  it('saves text files into the caller’s Drive and records the link; a binary file fails as through a tool', async () => {
    const h = harness();
    await connect(h);
    const o = org(h.svc);
    const res = await o.svc.saveTeamFiles(pat, 'task-1', ['plan.md', 'logo.png', 'nope.md'], 'google:me');
    expect(res).toEqual({
      ok: true,
      saved: [{ name: 'plan.md', link: 'https://drive.google.com/file/d/file-1/view' }],
      failed: [
        { name: 'logo.png', error: 'Only text files can be saved to Your Google Drive for now.' },
        { name: 'nope.md', error: 'No such file in this task.' },
      ],
    });
    expect(o.saved()).toEqual([
      { taskId: 'task-1', name: 'plan.md', destination: 'google:me', label: 'Your Google Drive', at: 9_000_000, link: 'https://drive.google.com/file/d/file-1/view', by: 'Pat', person: 'U0ACMEPAT' },
    ]);
    const upload = h.calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/'))!;
    expect(upload.body).toContain('Content-Type: text/markdown\r\n\r\n# The plan');
    // Pat sees where it went; Sam doesn't see Pat's Drive link.
    const forPat = await o.svc.teamTaskFiles(pat, 'task-1');
    const forSam = await o.svc.teamTaskFiles({ ...sam, admin: true }, 'task-1');
    if (!forPat.ok || !forSam.ok) throw new Error('not visible');
    expect(forPat.files.find((f) => f.name === 'plan.md')!.kept.saved).toEqual([{ destination: 'google:me', label: 'Your Google Drive', at: 9_000_000, link: 'https://drive.google.com/file/d/file-1/view' }]);
    expect(forSam.files.find((f) => f.name === 'plan.md')!.kept.saved).toEqual([]);
  });

  it('refuses before uploading anything when the caller has not connected', async () => {
    const h = harness();
    const res = await org(h.svc).svc.saveTeamFiles(pat, 'task-1', ['plan.md'], 'google:me');
    expect(res).toEqual({ ok: false, error: 'Connect your Google account first.' });
    expect(h.calls).toHaveLength(0);
  });
});
