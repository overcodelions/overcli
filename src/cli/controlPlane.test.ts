import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlPlane, listenControlPlane, parseCadence } from './controlPlane';
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
    answer: (c: OrgCaller, runId: string, answer: string) => {
      calls.push({ op: 'answer', caller: c.name, args: { runId, answer } });
      return { ok: false, error: "Only this worker's manager can do that." };
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

describe('control plane HTTP', () => {
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
