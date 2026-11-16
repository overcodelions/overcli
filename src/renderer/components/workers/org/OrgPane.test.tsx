// @vitest-environment jsdom
//
// The Org tab's front page: what waits on you across every org server in
// one list, each worker under its server, and each decision sent to the
// server it came from.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgPane } from './OrgPane';
import { useOrgTab } from './orgTabStore';

const invoke = vi.fn();
let extraPrimary: Array<ReturnType<typeof worker>> = [];
let host: HTMLDivElement;
let root: Root;

const servers = [
  { id: 'primary', url: 'https://overgo.acme.example', name: 'Acme', isDefault: true, tokenConfigured: true, fromEnv: false, chatTool: 'overgo-acme', me: { org: 'Acme', name: 'Pat', canHire: true } },
  { id: 'labs', url: 'https://labs.acme.example', name: 'Acme Labs', isDefault: false, tokenConfigured: true, fromEnv: false, chatTool: 'overgo-acme-labs', me: { org: 'Acme Labs', name: 'Pat', canHire: false } },
];
const worker = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, tagline: `${name} keeps acme tidy`, enabled: true, trust: 'trusted', visibility: 'org', budgetUSDPerMonth: 20, spentThisMonthUSD: 4.5,
  month: { runs: 3, failed: 0, pullRequests: 1 }, last30: { jobs: 3, failed: 0, prior: 1 }, waiting: 0, youManage: true, state: 'idle', schedule: 'When asked', ...over,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: { invoke: typeof invoke } }).overcli = { invoke };
  invoke.mockReset();
  extraPrimary = [];
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  invoke.mockImplementation(async (channel: string, args?: { serverId: string; method: string; path: string }) => {
    if (channel === 'org:servers') return servers;
    if (channel !== 'org:call') return null;
    if (args!.method === 'POST') return { ok: true, data: { ok: true } };
    if (args!.path === '/api/proposals')
      return { ok: true, data: args!.serverId === 'labs' ? [{ batchId: 'b-1', workerId: 'lin', workerName: 'Lin', at: Date.now() - 60_000, task: 'shift', items: [{ candidateId: 'c1', title: 'Refresh the acme price sheet' }, { candidateId: 'c2', title: 'Tidy the acme backlog' }] }] : [] };
    if (args!.path === '/api/today') return { ok: true, data: { org: 'Acme', delivered: args!.serverId === 'primary' ? [{ entryId: 'e-1', workerId: 'mario', workerName: 'Mario', title: 'fixed conflicts on PR #114', at: Date.now() - 3_600_000 }] : [], crew: [], spend: { spentUSD: 9, projectedUSD: 20 } } };
    if (args!.path === '/api/inflight') return { ok: true, data: { items: [] } };
    if (args!.path.startsWith('/api/work?')) return { ok: true, data: [] };
    if (args!.path === '/api/workers/mario/tuning') return { ok: true, data: { score: { runs: [{ result: 'good' }, { result: 'rough' }, { result: 'failed' }], verdict: { kind: 'worse' } }, reviews: [] } };
    if (args!.path.endsWith('/tuning')) return { ok: true, data: { score: { runs: [], verdict: { kind: 'early' } }, reviews: [] } };
    if (args!.path === '/api/workers') return { ok: true, data: args!.serverId === 'primary' ? [worker('mario', 'Mario', { waiting: 1, state: 'waiting' }), ...extraPrimary] : [worker('lin', 'Lin')] };
    if (args!.path === '/api/waiting')
      return {
        ok: true,
        data: args!.serverId === 'primary' ? [{ runId: 'r-1', workerId: 'mario', workerName: 'Mario', kind: 'approval', title: 'Push the acme checkout fix', stepId: 'push', since: Date.now() - 120_000, reaches: ['pushes a branch'] }] : [],
      };
    return { ok: false, error: 'not in this test' };
  });
  useOrgTab.setState({ servers: [], loaded: false, workers: {}, waiting: {}, proposals: {}, desktop: {}, today: {}, inflight: {}, work: {}, trends: {}, errors: {}, selected: null, filter: 'all' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe('OrgPane', () => {
  it('says how the day stands, and shows what needs you across servers', async () => {
    act(() => root.render(<OrgPane />));
    await settle();
    const text = host.textContent ?? '';
    expect(text).toContain('2 things need you');
    expect(text).toContain('Push the acme checkout fix');
    expect(text).toContain('Refresh the acme price sheet');
    expect(text).toContain('Delivered, 7 days');
    expect(text).toContain('Mario');
    expect(text).toContain('Lin');
  });

  it('rates delivered work, shows each worker’s recent runs, and opens a worker on Tuning from Worth a look', async () => {
    act(() => root.render(<OrgPane />));
    await settle();
    await settle();
    const useful = [...host.querySelectorAll('button')].find((x) => x.textContent === 'Useful')!;
    await act(async () => useful.click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/rate', body: { entryId: 'e-1', useful: true } });
    expect(host.querySelector('[aria-label="Last 3 runs"]')).toBeTruthy();
    expect(host.textContent).toContain('Worse since its last change');
    const look = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes('Improve it on Tuning'))!;
    await act(async () => look.click());
    expect(useOrgTab.getState().selected).toEqual({ serverId: 'primary', workerId: 'mario', tab: 'tuning' });
  });

  it('sends an approval to the server it came from', async () => {
    act(() => root.render(<OrgPane />));
    await settle();
    const approve = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!;
    await act(async () => approve.click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/approval', body: { runId: 'r-1', approve: true } });
  });

  it('opens a worker\'s page on its own server', async () => {
    act(() => root.render(<OrgPane />));
    await settle();
    const lin = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Lin'))!;
    await act(async () => lin.click());
    await settle();
    expect(useOrgTab.getState().selected).toEqual({ serverId: 'labs', workerId: 'lin' });
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'labs', method: 'GET', path: '/api/workers/lin/detail' });
  });
});

describe('proposed work', () => {
  it('approves what is ticked and skips the rest, on its own server', async () => {
    act(() => root.render(<OrgPane />));
    await settle();
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    await act(async () => boxes[1].click());
    const approve = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve 1')!;
    await act(async () => approve.click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'labs', method: 'POST', path: '/api/proposals/b-1', body: { approve: ['c1'], skip: ['c2'] } });
  });
});

describe('yours and shared', () => {
  const shared = (n: number) => Array.from({ length: n }, (_, i) => worker(`s${i}`, `Shared${i}`, { youManage: false, yours: false }));
  const heading = (t: string) => [...host.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;

  it('puts your workers first and the shared ones under their own heading, folded when there are many', async () => {
    extraPrimary = shared(9);
    act(() => root.render(<OrgPane />));
    await settle();
    expect(host.textContent).toContain('Your workers');
    const fold = heading('Shared with you')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain('you can ask these; changes are their managers’');
    const section = fold.closest('section')!;
    expect(section.textContent).not.toContain('Shared3');
    await act(async () => fold.click());
    expect(section.textContent).toContain('Shared3');
    expect(localStorage.getItem('overcli.org.others.home')).toBe('1');
  });

  it('shows a few shared workers open, and calls them everyone else’s for an admin', async () => {
    extraPrimary = [worker('s0', 'Nina', { youManage: true, yours: false })];
    act(() => root.render(<OrgPane />));
    await settle();
    const fold = heading('Everyone else’s')!;
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('as an admin, you can change these');
    expect(host.textContent).toContain('Nina');
  });

  it('counts only your workers as working now, when you have some', async () => {
    extraPrimary = shared(1);
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, args?: { serverId: string; method: string; path: string }) =>
      args?.path === '/api/inflight' && args.serverId === 'primary'
        ? { ok: true, data: { items: [{ id: 'r-9', kind: 'worker', workerId: 's0', who: 'Shared0', title: 'Tidy the acme wiki', since: Date.now(), at: 1, total: 3, now: 'reading' }] } }
        : base(channel, args),
    );
    act(() => root.render(<OrgPane />));
    await settle();
    expect(host.textContent).toContain('nobody is working right now');
    expect(host.textContent).not.toContain('Tidy the acme wiki');
  });
});
