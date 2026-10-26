import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bearer, createControlPlane, listenControlPlane, parseCadence, privateChannel } from './controlPlane';
import { parseArgs, parseControlAddress } from './args';
import type { OrgService } from '../main/org/orgService';
import type { OrgCaller } from '../shared/org/policy';

const PAT: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

/// Records which caller each call ran as, so the tests can prove the token,
/// not the request, decides who is acting.
function fakeOrg() {
  const calls: Array<{ op: string; caller: string; args?: unknown }> = [];
  const org = {
    whoami: (c: OrgCaller) => ({ name: c.name, admin: c.admin, canHire: false }),
    listWorkers: (c: OrgCaller) => {
      calls.push({ op: 'listWorkers', caller: c.name });
      return [{ id: 'w1', name: 'Ana' }];
    },
    listWaiting: () => [],
    report: (c: OrgCaller, days: number) => {
      calls.push({ op: 'report', caller: c.name, args: { days } });
      return { ok: true, report: { days } };
    },
    workerRuns: (c: OrgCaller, id: string, opts: unknown) => {
      calls.push({ op: 'workerRuns', caller: c.name, args: { id, opts } });
      return { ok: true, runs: [], nextBefore: null, total: 0 };
    },
    workerFeed: (c: OrgCaller, id: string, opts: unknown) => {
      calls.push({ op: 'workerFeed', caller: c.name, args: { id, opts } });
      return { ok: true, from: 0, to: 1, asks: [], delivered: [], questions: [], history: [], older: false };
    },
    publishSetup: (c: OrgCaller, input: unknown, secure: boolean) => {
      calls.push({ op: 'publishSetup', caller: c.name, args: { input, secure } });
      return { ok: true, installed: [], offered: { tools: 0, repos: 0, workspaces: 0 } };
    },
    runFiles: (c: OrgCaller, runId: string) => {
      calls.push({ op: 'runFiles', caller: c.name, args: { runId } });
      return { ok: true, files: [{ name: 'reports/acme.html', bytes: 20 }] };
    },
    workerFileList: (c: OrgCaller, workerId: string) => {
      calls.push({ op: 'workerFileList', caller: c.name, args: { workerId } });
      return { ok: true, files: [{ name: '2026-10-19-errand-acme/acme-summary.html', bytes: 30, at: 1 }] };
    },
    workerFile: (c: OrgCaller, workerId: string, name: string) => {
      calls.push({ op: 'workerFile', caller: c.name, args: { workerId, name } });
      return { ok: true, name, data: Buffer.from('<h1>Acme summary</h1>') };
    },
    runFile: (c: OrgCaller, runId: string, name: string) => {
      calls.push({ op: 'runFile', caller: c.name, args: { runId, name } });
      return { ok: true, name, data: Buffer.from('<h1>Acme weekly</h1>') };
    },
    teamRoom: (c: OrgCaller, id: string, action: unknown) => {
      calls.push({ op: 'teamRoom', caller: c.name, args: { id, action } });
      return { ok: true };
    },
    teamTaskPage: (c: OrgCaller, id: string) => {
      calls.push({ op: 'teamTaskPage', caller: c.name, args: { id } });
      return { ok: true, team: { id: 'team-1', name: 'Council', members: [] }, task: { id } };
    },
    teamTaskFiles: async (c: OrgCaller, id: string) => {
      calls.push({ op: 'teamTaskFiles', caller: c.name, args: { id } });
      return { ok: true, files: [], destinations: [{ id: 'library', label: 'Library', kind: 'library', ready: true }] };
    },
    keepTeamFiles: (c: OrgCaller, id: string, names: unknown) => {
      calls.push({ op: 'keepTeamFiles', caller: c.name, args: { id, names } });
      return { ok: true, kept: 1 };
    },
    saveTeamFiles: async (c: OrgCaller, id: string, names: unknown, destination: string) => {
      calls.push({ op: 'saveTeamFiles', caller: c.name, args: { id, names, destination } });
      return { ok: true, saved: [{ name: 'plan.md' }], failed: [] };
    },
    teamTaskZip: (c: OrgCaller, id: string) => {
      calls.push({ op: 'teamTaskZip', caller: c.name, args: { id } });
      return id === 'empty' ? { ok: false, error: 'This task has no files yet.' } : { ok: true, filename: 'roadmap-ranking.zip', data: Buffer.from('PK-acme') };
    },
    answer: (c: OrgCaller, runId: string, answer: string) => {
      calls.push({ op: 'answer', caller: c.name, args: { runId, answer } });
      return { ok: false, error: "Only this worker's manager can do that." };
    },
    databases: {
      approveOverdbConnection: (c: OrgCaller, id: string, password: string | undefined, secure: boolean) => {
        calls.push({ op: 'approveOverdbConnection', caller: c.name, args: { id, password, secure } });
        return { ok: true };
      },
      publishOverdbConnection: (c: OrgCaller, input: unknown) => {
        calls.push({ op: 'publishOverdbConnection', caller: c.name, args: input });
        return { ok: true, waiting: true };
      },
    },
  } as unknown as OrgService;
  return { org, calls };
}

let server: http.Server;
let base: string;
const { org, calls } = fakeOrg();

beforeAll(async () => {
  server = createControlPlane({
    org,
    log: () => {},
    authenticate: (t) => (t === 'ocli_good' ? PAT : null),
  });
  await listenControlPlane(server, { host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('viewing as someone', () => {
  it('lets an admin read the console as one person, changes nothing, and turns everyone else away', async () => {
    const { org: o, calls: seen } = fakeOrg();
    const admin = createControlPlane({ org: o, log: () => {}, authenticate: (t) => (t === 'ocli_admin' ? { slackUserId: 'U0ACMEADM', name: 'Ada', admin: true } : t === 'ocli_good' ? PAT : null) });
    await listenControlPlane(admin, { host: '127.0.0.1', port: 0 });
    const at = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
    try {
      const as = { 'X-Overgo-View-As': 'U0ACMEPAT', 'X-Overgo-View-As-Name': encodeURIComponent('Pat') };
      const read = await fetch(`${at}/api/workers/w1/files`, { headers: { Authorization: 'Bearer ocli_admin', ...as } });
      expect(read.status).toBe(200);
      expect(seen.filter((c) => c.op === 'workerFileList').at(-1)).toMatchObject({ caller: 'Pat' });
      const write = await fetch(`${at}/api/workers/w1/update`, { method: 'POST', headers: { Authorization: 'Bearer ocli_admin', 'Content-Type': 'application/json', ...as }, body: '{}' });
      expect(write.status).toBe(403);
      const notAdmin = await fetch(`${at}/api/workers/w1/files`, { headers: { Authorization: 'Bearer ocli_good', 'X-Overgo-View-As': 'U0ACMEADM' } });
      expect(notAdmin.status).toBe(403);
    } finally {
      admin.close();
    }
  });
});

describe('control plane HTTP', () => {
  it('opens a worker’s own file by the link its Files list handed out', async () => {
    const res = await fetch(`${base}/api/workers/w1/files`, { headers: { Authorization: 'Bearer ocli_good' } });
    const listed = (await res.json()) as { files: Array<{ name: string; url: string }> };
    expect(listed.files[0].url).toMatch(/^\/files\/[A-Za-z0-9_-]{32}\/acme-summary\.html$/);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const page = await fetch(`${base}${listed.files[0].url}`, { headers: { cookie } });
    expect(await page.text()).toBe('<h1>Acme summary</h1>');
    expect(calls.filter((c) => c.op === 'workerFile').at(-1)).toEqual({ op: 'workerFile', caller: 'Pat', args: { workerId: 'w1', name: '2026-10-19-errand-acme/acme-summary.html' } });
  });

  it('opens a run file by the link its listing handed out, sandboxed, as the person who listed it', async () => {
    const res = await fetch(`${base}/api/runs/run1/files`, { headers: { Authorization: 'Bearer ocli_good' } });
    // The listing sets the cookie its links need, readable by no script.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ocli_files=[A-Za-z0-9_-]+; Path=\/files\/; HttpOnly; SameSite=Lax/);
    const cookie = { Cookie: setCookie.split(';')[0] };
    const listed = (await res.json()) as { files: Array<{ name: string; url: string }> };
    const url = listed.files[0].url;
    expect(url).toMatch(/^\/files\/[A-Za-z0-9_-]{32}\/acme\.html$/);
    // Without the lister's cookie, or with a made-up one, the link opens nothing.
    expect((await fetch(`${base}${url}`)).status).toBe(403);
    expect((await fetch(`${base}${url}`, { headers: { Cookie: 'ocli_files=someone-else' } })).status).toBe(403);
    const page = await fetch(`${base}${url}`, { headers: cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<h1>Acme weekly</h1>');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(calls.filter((c) => c.op === 'runFile').at(-1)).toEqual({ op: 'runFile', caller: 'Pat', args: { runId: 'run1', name: 'reports/acme.html' } });
    expect((await fetch(`${base}${url}?download=1`, { headers: cookie })).headers.get('content-disposition')).toBe('attachment; filename="acme.html"');
    expect((await fetch(`${base}/files/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/acme.html`)).status).toBe(404);
    // The console may frame its own files, and nothing else.
    expect((await fetch(`${base}/`)).headers.get('content-security-policy')).toMatch(/frame-src 'self'/);
  });

  it('serves the console page and its assets without a token, with a strict CSP', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('/console.js');
    expect((await fetch(`${base}/console.js`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('refuses data without a token', async () => {
    expect((await fetch(`${base}/api/workers`)).status).toBe(401);
    expect((await fetch(`${base}/api/workers`, { headers: { Authorization: 'Bearer ocli_bad' } })).status).toBe(401);
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('runs API calls as the token\'s caller and passes refusals through', async () => {
    const auth = { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' };
    const list = await (await fetch(`${base}/api/workers`, { headers: auth })).json();
    expect(list).toEqual([{ id: 'w1', name: 'Ana' }]);
    const res = await (
      await fetch(`${base}/api/answer`, { method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r1', answer: 'yes' }) })
    ).json();
    expect(res).toEqual({ ok: false, error: "Only this worker's manager can do that." });
    expect(calls.find((c) => c.op === 'answer')).toEqual({ op: 'answer', caller: 'Pat', args: { runId: 'r1', answer: 'yes' } });
  });

  it('tells a setup whether it came over a private channel, and keeps it to plain shapes', async () => {
    const auth = { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' };
    const body = {
      tools: [{ name: 'tracker', kind: 'command', command: 'npx', args: ['@acme/tracker-mcp'], envKeys: ['TRACKER_TOKEN'], headerKeys: [] }, { name: 'bad name!' }],
      repos: [{ name: 'app', url: 'https://github.com/acme/app', localPath: 'relative/not/allowed' }],
      workspaces: [{ name: 'Shop', repos: ['app', 7] }],
      keys: { tracker: { env: { TRACKER_TOKEN: 'tk', 'bad key': 'x' } } },
    };
    await fetch(`${base}/api/publish/setup`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const local = calls.filter((c) => c.op === 'publishSetup').at(-1)!.args as { input: Record<string, unknown>; secure: boolean };
    // From this machine: private, whatever the Host header says.
    expect(local.secure).toBe(true);
    expect(local.input).toEqual({
      tools: [{ name: 'tracker', kind: 'command', command: 'npx', args: ['@acme/tracker-mcp'], envKeys: ['TRACKER_TOKEN'], headerKeys: [] }],
      repos: [{ name: 'app', url: 'https://github.com/acme/app' }],
      workspaces: [{ name: 'Shop', repos: ['app'] }],
      keys: { tracker: { env: { TRACKER_TOKEN: 'tk' }, headers: {} } },
    });
    // Behind a proxy, only https counts — and a forged header doesn't, unless the proxy is trusted.
    process.env.OVERCLI_TRUST_PROXY = '1';
    try {
      await fetch(`${base}/api/publish/setup`, { method: 'POST', headers: { ...auth, 'X-Forwarded-Proto': 'http' }, body: JSON.stringify(body) });
      expect((calls.filter((c) => c.op === 'publishSetup').at(-1)!.args as { secure: boolean }).secure).toBe(false);
      await fetch(`${base}/api/publish/setup`, { method: 'POST', headers: { ...auth, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify(body) });
      expect((calls.filter((c) => c.op === 'publishSetup').at(-1)!.args as { secure: boolean }).secure).toBe(true);
    } finally {
      delete process.env.OVERCLI_TRUST_PROXY;
    }
  });

  it('takes a container gateway as local only when the port is published on loopback', () => {
    const fromGateway = { socket: { remoteAddress: '192.168.65.1' }, headers: {} } as unknown as Parameters<typeof privateChannel>[0];
    expect(privateChannel(fromGateway)).toBe(false);
    process.env.OVERCLI_PUBLISHED_ON_LOOPBACK = '1';
    try {
      expect(privateChannel(fromGateway)).toBe(true);
      // A trusted proxy's word still wins: it may be serving plain http to anyone.
      process.env.OVERCLI_TRUST_PROXY = '1';
      expect(privateChannel({ ...fromGateway, headers: { 'x-forwarded-proto': 'http' } })).toBe(false);
    } finally {
      delete process.env.OVERCLI_PUBLISHED_ON_LOOPBACK;
      delete process.env.OVERCLI_TRUST_PROXY;
    }
  });

  it('hands a database password to the service with whether it came over a private channel', async () => {
    const auth = { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' };
    await fetch(`${base}/api/overdb/offers/o%201/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'pw' }) });
    expect(calls.filter((c) => c.op === 'approveOverdbConnection').at(-1)).toEqual({ op: 'approveOverdbConnection', caller: 'Pat', args: { id: 'o 1', password: 'pw', secure: true } });
    await fetch(`${base}/api/publish/overdb-connection`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'p', connection: { name: 'x' } }) });
    expect(calls.filter((c) => c.op === 'publishOverdbConnection').at(-1)).toEqual({ op: 'publishOverdbConnection', caller: 'Pat', args: { connection: { name: 'x' } } });
  });

  it('passes the report window through, defaulting to 30 days', async () => {
    const auth = { Authorization: 'Bearer ocli_good' };
    expect(await (await fetch(`${base}/api/report?days=7`, { headers: auth })).json()).toEqual({ ok: true, report: { days: 7 } });
    expect(await (await fetch(`${base}/api/report`, { headers: auth })).json()).toEqual({ ok: true, report: { days: 30 } });
    expect(calls.filter((c) => c.op === 'report')).toEqual([
      { op: 'report', caller: 'Pat', args: { days: 7 } },
      { op: 'report', caller: 'Pat', args: { days: 30 } },
    ]);
  });

  it("passes a worker's runs and feed paging through, leaving absent or junk numbers undefined", async () => {
    const auth = { Authorization: 'Bearer ocli_good' };
    await fetch(`${base}/api/workers/Ana%20B/runs?before=1700&limit=5&outcome=failed`, { headers: auth });
    await fetch(`${base}/api/workers/w1/runs`, { headers: auth });
    await fetch(`${base}/api/workers/w1/feed?before=soon&days=7`, { headers: auth });
    await fetch(`${base}/api/workers/w1/feed`, { headers: auth });
    expect(calls.filter((c) => c.op === 'workerRuns' || c.op === 'workerFeed')).toEqual([
      { op: 'workerRuns', caller: 'Pat', args: { id: 'Ana B', opts: { before: 1700, limit: 5, outcome: 'failed' } } },
      { op: 'workerRuns', caller: 'Pat', args: { id: 'w1', opts: { before: undefined, limit: undefined, outcome: undefined } } },
      { op: 'workerFeed', caller: 'Pat', args: { id: 'w1', opts: { before: undefined, days: 7 } } },
      { op: 'workerFeed', caller: 'Pat', args: { id: 'w1', opts: { before: undefined, days: undefined } } },
    ]);
  });

  it("routes a team task's page and files, and hands the folder over as a zip", async () => {
    const auth = { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' };
    expect(await (await fetch(`${base}/api/team-tasks/task%201/page`, { headers: auth })).json()).toEqual({ ok: true, team: { id: 'team-1', name: 'Council', members: [] }, task: { id: 'task 1' } });
    expect(await (await fetch(`${base}/api/team-tasks/t1/files`, { headers: auth })).json()).toMatchObject({ ok: true, destinations: [{ id: 'library' }] });
    expect(await (await fetch(`${base}/api/team-tasks/t1/files/keep`, { method: 'POST', headers: auth, body: JSON.stringify({ names: ['plan.md'] }) })).json()).toEqual({ ok: true, kept: 1 });
    const saved = await fetch(`${base}/api/team-tasks/t1/files/save`, { method: 'POST', headers: auth, body: JSON.stringify({ names: ['plan.md'], destination: 'mcp:gdrive' }) });
    expect(await saved.json()).toEqual({ ok: true, saved: [{ name: 'plan.md' }], failed: [] });
    const zip = await fetch(`${base}/api/team-tasks/t1/files.zip`, { headers: auth });
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toBe('attachment; filename="roadmap-ranking.zip"');
    expect(Buffer.from(await zip.arrayBuffer()).toString()).toBe('PK-acme');
    expect(await (await fetch(`${base}/api/team-tasks/empty/files.zip`, { headers: auth })).json()).toEqual({ ok: false, error: 'This task has no files yet.' });
    expect((await fetch(`${base}/api/team-tasks/t1/files.zip`)).status).toBe(401);
    expect(calls.filter((c) => c.op.startsWith('team') || c.op.endsWith('TeamFiles'))).toEqual([
      { op: 'teamTaskPage', caller: 'Pat', args: { id: 'task 1' } },
      { op: 'teamTaskFiles', caller: 'Pat', args: { id: 't1' } },
      { op: 'keepTeamFiles', caller: 'Pat', args: { id: 't1', names: ['plan.md'] } },
      { op: 'saveTeamFiles', caller: 'Pat', args: { id: 't1', names: ['plan.md'], destination: 'mcp:gdrive' } },
      { op: 'teamTaskZip', caller: 'Pat', args: { id: 't1' } },
      { op: 'teamTaskZip', caller: 'Pat', args: { id: 'empty' } },
    ]);
  });

  it("routes a finished task's room: a question, another round, and the pack updated with picked changes", async () => {
    const auth = { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' };
    const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post('/api/team-tasks/t%201/room', { text: '@Eli redo the model' })).toEqual({ ok: true });
    await post('/api/team-tasks/t1/room/continue', {});
    await post('/api/team-tasks/t1/update-pack', { changes: ['Show 73% as an upper bound.', 7, '  ', 'Split cash timing out.'] });
    await post('/api/team-tasks/t1/update-pack', {});
    expect(calls.filter((c) => c.op === 'teamRoom')).toEqual([
      { op: 'teamRoom', caller: 'Pat', args: { id: 't 1', action: { kind: 'ask', text: '@Eli redo the model' } } },
      { op: 'teamRoom', caller: 'Pat', args: { id: 't1', action: { kind: 'continue' } } },
      { op: 'teamRoom', caller: 'Pat', args: { id: 't1', action: { kind: 'updatePack', changes: ['Show 73% as an upper bound.', 'Split cash timing out.'] } } },
      { op: 'teamRoom', caller: 'Pat', args: { id: 't1', action: { kind: 'updatePack' } } },
    ]);
  });

  it('serves the overcli icon', async () => {
    const res = await fetch(`${base}/icon.svg`);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await fetch(`${base}/api/answer`, { method: 'POST', headers: { Authorization: 'Bearer ocli_good' }, body: 'nope' });
    expect(res.status).toBe(400);
  });

  it('speaks MCP to a real client, as the token\'s caller', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ocli_good' } } }),
    );
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_workers', 'draft_hire', 'confirm_hire', 'answer_question', 'list_waiting']));
    const res = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toMatchObject({ name: 'Pat', admin: false });
    const refused = await client.callTool({ name: 'answer_question', arguments: { runId: 'r1', answer: 'go' } });
    expect(refused.isError).toBe(true);
    await client.close();
  });
});

describe('--control', () => {
  it('listens on loopback for a bare port', () => {
    expect(parseControlAddress('7420')).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(parseControlAddress('0.0.0.0:7420')).toEqual({ host: '0.0.0.0', port: 7420 });
    expect(parseControlAddress('[::]:7420')).toEqual({ host: '::', port: 7420 });
    expect(parseControlAddress('nope')).toHaveProperty('error');
  });

  it('parses on serve', () => {
    const parsed = parseArgs(['serve', '--control', '7420']);
    expect(parsed.ok && parsed.args.serve?.control).toEqual({ host: '127.0.0.1', port: 7420 });
  });

  it('parses org, push and projects commands', () => {
    const org = parseArgs(['org', 'init', '--name', 'Acme', '--admin', 'U0ACMEPAT', '--slack-team', 'T0ACME01']);
    expect(org.ok && org.args.org).toMatchObject({ action: 'init', name: 'Acme', admins: ['U0ACMEPAT'], slackTeamId: 'T0ACME01' });
    expect(parseArgs(['org', 'init']).ok).toBe(false);
    expect(parseArgs(['org', 'init', '--name', 'A', '--slack-team', 'acme']).ok).toBe(false);
    const push = parseArgs(['workers', 'push', 'Luke', '--to', 'https://overcli.acme.example', '--visibility', 'team']);
    expect(push.ok && push.args.workersPush).toEqual({ target: 'Luke', to: 'https://overcli.acme.example', visibility: 'team' });
    expect(parseArgs(['workers', 'push']).ok).toBe(false);
    const teamPush = parseArgs(['teams', 'push', 'Launch crew', '--to', 'https://overcli.acme.example']);
    expect(teamPush.ok && teamPush.args).toMatchObject({ command: 'teamsPush', teamsPush: { target: 'Launch crew', to: 'https://overcli.acme.example' } });
    expect(parseArgs(['teams', 'push', 'X', '--visibility', 'org']).ok).toBe(false);
    expect(parseArgs(['teams']).ok).toBe(false);
    const proj = parseArgs(['projects', 'add', '/data/repos/app', '--name', 'App']);
    expect(proj.ok && proj.args.projects).toMatchObject({ action: 'add', path: '/data/repos/app', name: 'App' });
  });

  it('parses tokens commands', () => {
    const parsed = parseArgs(['tokens', 'create', '--name', 'Pat', '--slack', 'U0ACMEPAT', '--admin']);
    expect(parsed.ok && parsed.args.tokens).toMatchObject({ action: 'create', name: 'Pat', slackUserId: 'U0ACMEPAT', admin: true });
    expect(parseArgs(['tokens', 'create']).ok).toBe(false);
    expect(parseArgs(['tokens', 'create', '--name', 'x', '--slack', '@pat']).ok).toBe(false);
  });
});

describe('parseCadence', () => {
  it('takes "when asked", daily and interval schedules, and refuses the rest', () => {
    expect(parseCadence(null)).toBeNull();
    expect(parseCadence({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] })).toEqual({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
    expect(parseCadence({ kind: 'daily', time: '09:00', days: [9, 'x'] })).toEqual({ kind: 'daily', time: '09:00' });
    expect(parseCadence({ kind: 'interval', everyMinutes: 240.4, window: { start: '08:00', end: '18:00' } })).toEqual({
      kind: 'interval',
      everyMinutes: 240,
      window: { start: '08:00', end: '18:00' },
    });
    expect(parseCadence({ kind: 'interval', everyMinutes: 60, window: { start: 'dawn', end: '18:00' } })).toEqual({ kind: 'interval', everyMinutes: 60 });
    expect(parseCadence({ kind: 'daily', time: '9am' })).toBeUndefined();
    expect(parseCadence({ kind: 'cron', expr: '* * * * *' })).toBeUndefined();
    expect(parseCadence('daily')).toBeUndefined();
    expect(parseCadence(undefined)).toBeUndefined();
  });
});

describe('connections routes', () => {
  let cserver: http.Server;
  let cbase: string;
  const seen: Array<{ op: string; caller?: string; args?: unknown }> = [];
  const connections = {
    list: async (c: OrgCaller, b: string) => {
      seen.push({ op: 'list', caller: c.name, args: { base: b } });
      return [{ provider: 'google', label: 'Google Drive', ready: true, redirectUri: `${b}/oauth/google/callback`, connected: false }];
    },
    start: (c: OrgCaller, opts: { next?: string; base: string }) => {
      seen.push({ op: 'start', caller: c.name, args: opts });
      return { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=acme', browserKey: 'acme-browser-key' };
    },
    callback: async (q: URLSearchParams, browserKey: string | undefined) => {
      seen.push({ op: 'callback', args: { state: q.get('state'), browserKey } });
      return browserKey ? { ok: true, location: '/#connections?connected=google' } : { ok: false, reason: 'browser', location: '/#connections/google-error?reason=browser' };
    },
    disconnect: async (c: OrgCaller, provider: string) => {
      seen.push({ op: 'disconnect', caller: c.name, args: { provider } });
      return { ok: true };
    },
  };

  beforeAll(async () => {
    cserver = createControlPlane({ org, connections: connections as never, log: () => {}, authenticate: (t) => (t === 'ocli_good' ? PAT : null) });
    await listenControlPlane(cserver, { host: '127.0.0.1', port: 0 });
    cbase = `http://127.0.0.1:${(cserver.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    cserver.close();
  });

  it('lists, starts and disconnects as the token’s caller, and needs a token for each', async () => {
    const auth = { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' };
    expect(await (await fetch(`${cbase}/api/connections`, { headers: auth })).json()).toEqual({
      ok: true,
      connections: [{ provider: 'google', label: 'Google Drive', ready: true, redirectUri: `${cbase}/oauth/google/callback`, connected: false }],
    });
    const started = await fetch(`${cbase}/api/connections/google/start`, { method: 'POST', headers: auth, body: JSON.stringify({ next: '#teams/council' }) });
    // The browser key goes only in a cookie for the callback, never in the JSON.
    expect(await started.json()).toEqual({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=acme' });
    expect(started.headers.get('set-cookie')).toBe('ocli_connect=acme-browser-key; Path=/oauth/google/; HttpOnly; SameSite=Lax; Max-Age=600');
    expect(await (await fetch(`${cbase}/api/connections/google/disconnect`, { method: 'POST', headers: auth })).json()).toEqual({ ok: true });
    for (const [method, p] of [['GET', '/api/connections'], ['POST', '/api/connections/google/start'], ['POST', '/api/connections/google/disconnect']]) {
      expect((await fetch(`${cbase}${p}`, { method })).status).toBe(401);
    }
    expect(seen.filter((s) => s.op !== 'callback')).toEqual([
      { op: 'list', caller: 'Pat', args: { base: cbase } },
      { op: 'start', caller: 'Pat', args: { next: '#teams/council', base: cbase } },
      { op: 'disconnect', caller: 'Pat', args: { provider: 'google' } },
    ]);
  });

  it('takes Google’s callback without a token, with the browser’s cookie, and redirects to the console', async () => {
    const back = await fetch(`${cbase}/oauth/google/callback?state=s1&code=c1`, { redirect: 'manual', headers: { Cookie: 'other=1; ocli_connect=acme-browser-key' } });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/#connections?connected=google');
    expect(back.headers.get('set-cookie')).toMatch(/^ocli_connect=; Path=\/oauth\/google\/; .*Max-Age=0/);
    const bare = await fetch(`${cbase}/oauth/google/callback?state=s2&code=c2`, { redirect: 'manual' });
    expect(bare.status).toBe(302);
    expect(bare.headers.get('location')).toBe('/#connections/google-error?reason=browser');
    expect(seen.filter((s) => s.op === 'callback')).toEqual([
      { op: 'callback', args: { state: 's1', browserKey: 'acme-browser-key' } },
      { op: 'callback', args: { state: 's2', browserKey: undefined } },
    ]);
  });

  it('has no connection routes on a host without them', async () => {
    expect((await fetch(`${base}/api/connections`, { headers: { Authorization: 'Bearer ocli_good' } })).status).toBe(404);
    expect((await fetch(`${base}/oauth/google/callback?state=x`, { redirect: 'manual' })).status).toBe(404);
  });
});

describe('tool sign-in routes', () => {
  let tserver: http.Server;
  let tbase: string;
  const seen: unknown[] = [];
  const signing = {
    ...org,
    startToolSignIn: async (c: OrgCaller, input: unknown, b: string) => {
      seen.push({ op: 'start', caller: c.name, input, base: b });
      return { ok: true, url: 'https://auth.acme.example/authorize?state=t1', browserKey: 'tool-browser-key' };
    },
    finishToolSignIn: async (q: URLSearchParams, browserKey: string | undefined) => {
      seen.push({ op: 'finish', state: q.get('state'), browserKey });
      return browserKey ? { ok: true, location: '/#setup/tools?signedin=acme' } : { ok: false, reason: 'browser', location: '/#setup/tools?signin-error=browser' };
    },
  };

  beforeAll(async () => {
    tserver = createControlPlane({ org: signing as never, log: () => {}, authenticate: (t) => (t === 'ocli_good' ? PAT : null) });
    await listenControlPlane(tserver, { host: '127.0.0.1', port: 0 });
    tbase = `http://127.0.0.1:${(tserver.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    tserver.close();
  });

  it('starts a sign-in with a cookie for the callback only, and takes the callback without a token', async () => {
    const started = await fetch(`${tbase}/api/admin/tools/signin`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ocli_good', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: { name: 'acme', url: 'https://mcp.acme.example/mcp' }, next: '#setup/tools' }),
    });
    expect(await started.json()).toEqual({ ok: true, url: 'https://auth.acme.example/authorize?state=t1' });
    expect(started.headers.get('set-cookie')).toBe('ocli_tool=tool-browser-key; Path=/oauth/tools/callback; HttpOnly; SameSite=Lax; Max-Age=600');
    expect((await fetch(`${tbase}/api/admin/tools/signin`, { method: 'POST' })).status).toBe(401);
    const back = await fetch(`${tbase}/oauth/tools/callback?state=t1&code=c`, { redirect: 'manual', headers: { Cookie: 'ocli_tool=tool-browser-key' } });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/#setup/tools?signedin=acme');
    expect(back.headers.get('set-cookie')).toMatch(/^ocli_tool=; Path=\/oauth\/tools\/callback; .*Max-Age=0/);
    expect(seen).toEqual([
      { op: 'start', caller: 'Pat', input: { name: 'acme', url: 'https://mcp.acme.example/mcp', next: '#setup/tools' }, base: tbase },
      { op: 'finish', state: 't1', browserKey: 'tool-browser-key' },
    ]);
  });
});

describe('process from a picture', () => {
  let pserver: http.Server;
  let pbase: string;
  const asked: Array<{ caller?: string; input: unknown }> = [];
  const png = 'data:image/png;base64,' + Buffer.alloc(300, 7).toString('base64');
  const draftOrg = {
    teams: () => [
      { id: 't1', name: 'Acme Legal', purpose: 'Legal review', members: [{ name: 'Lex', role: 'Counsel' }], canBrief: true },
      { id: 't2', name: 'Hidden', members: [], canBrief: false },
    ],
    listWorkers: () => [{ id: 'w1', name: 'Ana', tagline: 'Writes notes', enabled: true }, { id: 'w2', name: 'Off', tagline: '', enabled: false }],
    directory: () => ({ people: [{ name: 'Pat', slackUserId: 'U0ACMEPAT' }], groups: [] }),
  } as unknown as OrgService;
  let release: (() => void) | null = null;

  beforeAll(async () => {
    pserver = createControlPlane({
      org: draftOrg,
      processes: {} as never,
      draftProcess: async (input) => {
        asked.push({ input: { ...input, image: { mimeType: input.image.mimeType, size: input.image.size } } });
        if (input.note === 'slow') await new Promise<void>((r) => (release = r));
        return { ok: true, draft: { name: 'Contract approval', stages: [{ id: 'd1', name: 'Legal review', kind: 'team', teamId: 't1' }] }, notes: ['One branch runs in parallel.'] };
      },
      log: () => {},
      authenticate: (t) => (t === 'ocli_good' ? PAT : null),
    });
    await listenControlPlane(pserver, { host: '127.0.0.1', port: 0 });
    pbase = `http://127.0.0.1:${(pserver.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    pserver.close();
  });

  const post = (body: unknown, token = 'ocli_good') =>
    fetch(`${pbase}/api/processes/draft-from-image`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('drafts from a data URL with the teams and workers the caller can use, saving nothing', async () => {
    const res = await post({ image: png, note: 'Use Acme Legal for review' });
    expect(await res.json()).toEqual({ ok: true, draft: { name: 'Contract approval', stages: [{ id: 'd1', name: 'Legal review', kind: 'team', teamId: 't1' }] }, notes: ['One branch runs in parallel.'] });
    expect(asked.at(-1)!.input).toEqual({
      image: { mimeType: 'image/png', size: 300 },
      note: 'Use Acme Legal for review',
      teams: [{ id: 't1', name: 'Acme Legal', purpose: 'Legal review', members: [{ role: 'Counsel' }] }],
      workers: [{ id: 'w1', name: 'Ana', tagline: 'Writes notes' }],
      people: [{ name: 'Pat', slackUserId: 'U0ACMEPAT' }],
    });
  });

  it('refuses no token, a non-image and one draft on top of another', async () => {
    expect((await post({ image: png }, 'ocli_bad')).status).toBe(401);
    expect(await (await post({ image: 'data:text/plain;base64,aGk=' })).json()).toMatchObject({ ok: false });
    const before = asked.length;
    const first = post({ image: png, note: 'slow' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await (await post({ image: png })).json()).toEqual({ ok: false, error: expect.stringMatching(/already drafting/) });
    release!();
    expect(await (await first).json()).toMatchObject({ ok: true });
    expect(asked.length).toBe(before + 1);
  });

  it('takes a picture bigger than an ordinary body', async () => {
    const big = 'data:image/jpeg;base64,' + Buffer.alloc(3 * 1024 * 1024, 3).toString('base64');
    expect(await (await post({ image: big })).json()).toMatchObject({ ok: true });
  });

  it('has no such route on a host without processes', async () => {
    expect(await (await fetch(`${base}/api/processes/draft-from-image`, { method: 'POST', headers: { Authorization: 'Bearer ocli_good' }, body: '{}' })).status).toBe(404);
  });
});

describe('bearer', () => {
  const of = (authorization?: string) => bearer({ headers: authorization === undefined ? {} : { authorization } });

  it('reads the token after Bearer, however it is spaced or cased', () => {
    expect(of('Bearer ocli_abc')).toBe('ocli_abc');
    expect(of('  bearer \t ocli_abc  ')).toBe('ocli_abc');
    expect(of(undefined)).toBeUndefined();
    expect(of('Bearer')).toBeUndefined();
    expect(of('Bearer    ')).toBeUndefined();
    expect(of('Bearerocli_abc')).toBeUndefined();
    expect(of('Basic ocli_abc')).toBeUndefined();
  });

  it('answers at once for a header of nothing but spaces', () => {
    const started = Date.now();
    of(`Bearer${' '.repeat(100_000)}\n`);
    of(`Bearer${' \t'.repeat(50_000)}x\u2028`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
