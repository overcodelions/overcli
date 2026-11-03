import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService, type OrgServiceDeps } from './orgService';
import type { AskRecord, Rating } from './orgStores';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const DAY = 86_400_000;
const NOW = new Date(2026, 8, 10, 12).getTime();

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Watches acme competitor sites and reports changes each week.',
    projectPath: '/repo',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

function flowRun(id: string, workerId: string, createdAt: number, over: Record<string, unknown> = {}): FlowRun {
  return {
    id,
    workerId,
    workerName: workerId,
    title: `Run ${id}`,
    flowSnapshot: { name: 'Weekly', steps: [] },
    state: { kind: 'done', success: true },
    attempts: [{ stepId: 's', startedAt: createdAt, endedAt: createdAt + 120_000, outcome: 'success' }],
    artifacts: {},
    createdAt,
    ...over,
  } as unknown as FlowRun;
}

function completed(workerId: string, id: string, at: number, runId?: string): WorkerJournalEntry {
  return { id, workerId, kind: 'completed', at, title: `Report ${id}`, ...(runId ? { runId } : {}) } as WorkerJournalEntry;
}

function ask(id: string, workerId: string, at: number, by: OrgCaller): AskRecord {
  return { id, workerId, workerName: workerId, by: by.name, ...(by.slackUserId ? { slackUserId: by.slackUserId } : {}), text: `q ${id}`, at, status: 'answered', reply: 'ok' };
}

function harness(opts: { runs?: FlowRun[]; journal?: Record<string, WorkerJournalEntry[]>; asks?: AskRecord[] } = {}) {
  const roster = [
    worker('ana', { manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org' }),
    worker('cal', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'private' }),
  ];
  const runs = opts.runs ?? [];
  let ratings: Rating[] = [];
  let asks = opts.asks ?? [];
  const deps: OrgServiceDeps = {
    workers: {
      roster: () => roster,
      get: (id) => roster.find((w) => w.id === id) ?? null,
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: (id) => opts.journal?.[id] ?? [],
      spentThisMonth: () => new Map(),
      workerNames: () => roster.map((w) => w.name),
    },
    runs: { listRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY }),
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => [], save: () => {} },
    asks: { list: () => asks, save: (a) => (asks = a) },
    ratings: { list: () => ratings, save: (r) => (ratings = r) },
    now: () => NOW,
  };
  return { svc: new OrgService(deps), ratings: () => ratings };
}

describe('OrgService.workerRuns', () => {
  // Seven ended runs a day apart, the newest yesterday; every third failed.
  const runs = Array.from({ length: 7 }, (_, i) =>
    flowRun(`r${i}`, 'ana', NOW - (i + 1) * DAY, i % 3 === 2 ? { state: { kind: 'done', success: false } } : {}),
  );
  runs.push(flowRun('stop', 'ana', NOW - 10 * DAY, { state: { kind: 'aborted' } }));
  runs.push(flowRun('live', 'ana', NOW - 1000, { state: { kind: 'running', currentStepId: 's' } }));

  it('walks every ended run a page at a time, newest first', () => {
    const { svc } = harness({ runs });
    const seen: string[] = [];
    let before: number | undefined;
    let pages = 0;
    for (;;) {
      const res = svc.workerRuns(pat, 'ana', { limit: 3, ...(before != null ? { before } : {}) });
      if (!res.ok) throw new Error(res.error);
      expect(res.total).toBe(8);
      expect(res.runs.length).toBeLessThanOrEqual(3);
      seen.push(...res.runs.map((r) => r.runId));
      pages++;
      if (res.nextBefore == null) break;
      expect(res.nextBefore).toBe(res.runs[res.runs.length - 1].at);
      before = res.nextBefore;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'stop']);
  });

  it('carries the pull requests a run landed, and none for a run that landed nothing', () => {
    const body = '- Opened a pull request for acme-api: https://bitbucket.org/acme/acme-api/pull-requests/42 (branch fix/acme-null)\n- acme-web: its pull request was already open, left as it was: https://bitbucket.org/acme/acme-web/pull-requests/7 (branch fix/acme-web)';
    const landed = flowRun('pr', 'ana', NOW - 3600_000, { artifacts: { 'pull-requests.md': { name: 'pull-requests.md', body, producedAt: NOW } } } as unknown as Partial<FlowRun>);
    const { svc } = harness({ runs: [...runs, landed] });
    const res = svc.workerRuns(pat, 'ana', { limit: 2 });
    if (!res.ok) throw new Error(res.error);
    expect(res.runs[0].pullRequests).toEqual([
      { repo: 'acme-api', url: 'https://bitbucket.org/acme/acme-api/pull-requests/42', branch: 'fix/acme-null', state: 'open' },
      { repo: 'acme-web', url: 'https://bitbucket.org/acme/acme-web/pull-requests/7', branch: 'fix/acme-web', state: 'existing' },
    ]);
    expect(res.runs[1].pullRequests).toBeUndefined();
  });

  it('defaults to 50, clamps the limit, and gives null when nothing is left', () => {
    const { svc } = harness({ runs });
    const all = svc.workerRuns(pat, 'ana');
    expect(all.ok && all.runs.length).toBe(8);
    expect(all.ok && all.nextBefore).toBeNull();
    const one = svc.workerRuns(pat, 'ana', { limit: 0 });
    expect(one.ok && one.runs.length).toBe(1);
    const nan = svc.workerRuns(pat, 'ana', { limit: Number.NaN });
    expect(nan.ok && nan.runs.length).toBe(8);
    const big = svc.workerRuns(pat, 'ana', { limit: 1e6 });
    expect(big.ok && big.runs.length).toBe(8);
  });

  it('filters by outcome, counting the filtered total, and refuses an unknown one', () => {
    const { svc } = harness({ runs });
    const failed = svc.workerRuns(pat, 'ana', { outcome: 'failed' });
    if (!failed.ok) throw new Error(failed.error);
    expect(failed.runs.map((r) => r.runId)).toEqual(['r2', 'r5']);
    expect(failed.total).toBe(2);
    const stopped = svc.workerRuns(pat, 'ana', { outcome: 'stopped', before: NOW - 9 * DAY });
    expect(stopped.ok && stopped.runs.map((r) => r.outcome)).toEqual(['stopped']);
    expect(svc.workerRuns(pat, 'ana', { outcome: 'lost' })).toEqual({ ok: false, error: 'Pick done, failed or stopped.' });
  });

  it("hides someone else's private worker", () => {
    const { svc } = harness({ runs: [flowRun('c1', 'cal', NOW - DAY)] });
    expect(svc.workerRuns(pat, 'cal')).toEqual({ ok: false, error: 'No worker by that name or id that you can see.' });
    expect(svc.workerRuns(sam, 'cal').ok).toBe(true);
  });

  it('keeps the detail history at 25', () => {
    const many = Array.from({ length: 30 }, (_, i) => flowRun(`m${i}`, 'ana', NOW - (i + 1) * 60_000));
    const res = harness({ runs: many }).svc.workerDetail(pat, 'ana');
    expect(res.ok && res.history.length).toBe(25);
  });
});

describe('OrgService.workerFeed', () => {
  const runs = [
    flowRun('in', 'ana', NOW - 2 * DAY, { workerExchanges: [{ id: 'x1', stepId: 's', participantId: 'p', askedAt: NOW - 2 * DAY, question: 'Which acme region?', status: 'answered', answer: 'EU' }] }),
    flowRun('out', 'ana', NOW - 20 * DAY, { workerExchanges: [{ id: 'x2', stepId: 's', participantId: 'p', askedAt: NOW - 20 * DAY, question: 'Old question', status: 'answered' }] }),
  ];
  const journal = { ana: [completed('ana', 'old', NOW - 20 * DAY, 'out'), completed('ana', 'new', NOW - 2 * DAY, 'in')] };
  const asks = [ask('a-old', 'ana', NOW - 20 * DAY, pat), ask('a-pat', 'ana', NOW - 3 * DAY, pat), ask('a-sam', 'ana', NOW - DAY, sam)];

  it('keeps only what falls in the window, and says something older exists', () => {
    const { svc } = harness({ runs, journal, asks });
    const res = svc.workerFeed(sam, 'ana');
    if (!res.ok) throw new Error(res.error);
    expect(res.to).toBe(NOW);
    expect(res.from).toBe(NOW - 14 * DAY);
    expect(res.history.map((r) => r.runId)).toEqual(['in']);
    expect(res.delivered.map((d) => d.entryId)).toEqual(['new']);
    expect(res.questions.map((q) => q.question)).toEqual(['Which acme region?']);
    // Sam neither asked Pat's questions nor manages Ana: only his own.
    expect(res.asks.map((a) => a.id)).toEqual(['a-sam']);
    expect(res.older).toBe(true);
  });

  it("shows the manager every ask, newest first", () => {
    const res = harness({ runs, journal, asks }).svc.workerFeed(pat, 'ana');
    expect(res.ok && res.asks.map((a) => a.id)).toEqual(['a-sam', 'a-pat']);
  });

  it('pages back with before, and reports nothing older at the start', () => {
    const { svc } = harness({ runs, journal, asks });
    const back = svc.workerFeed(pat, 'ana', { before: NOW - 14 * DAY, days: 30 });
    if (!back.ok) throw new Error(back.error);
    expect(back.history.map((r) => r.runId)).toEqual(['out']);
    expect(back.delivered.map((d) => d.entryId)).toEqual(['old']);
    expect(back.asks.map((a) => a.id)).toEqual(['a-old']);
    expect(back.questions.map((q) => q.question)).toEqual(['Old question']);
    expect(back.older).toBe(false);
  });

  it('clamps days and excludes the upper bound itself', () => {
    const { svc } = harness({ runs, journal, asks });
    const res = svc.workerFeed(pat, 'ana', { before: NOW - 2 * DAY, days: 500 });
    if (!res.ok) throw new Error(res.error);
    expect(res.from).toBe(NOW - 2 * DAY - 60 * DAY);
    expect(res.history.map((r) => r.runId)).toEqual(['out']);
    expect(res.older).toBe(false);
  });

  it("hides someone else's private worker", () => {
    expect(harness({ runs, journal, asks }).svc.workerFeed(pat, 'cal')).toEqual({ ok: false, error: 'No worker by that name or id that you can see.' });
  });
});

describe('delivered work from a run without a completed entry', () => {
  const report = { name: 'competitor_update.md', body: '# Acme pricing moved\nhttps://acme.example/pricing', producedAt: NOW - DAY + 60_000, kind: 'markdown' };
  const retried = flowRun('rt', 'ana', NOW - DAY, { artifacts: { competitor_update: report }, costUSD: 1.5 });
  const failedEntry = { id: 'f1', workerId: 'ana', kind: 'failed', at: NOW - DAY + 30_000, title: 'Attempt failed', runId: 'rt' } as WorkerJournalEntry;

  it('lists a successful run whose journal only has a failed attempt', () => {
    const { svc } = harness({ runs: [retried], journal: { ana: [failedEntry] } });
    const work = svc.work(pat);
    expect(work).toMatchObject([{ entryId: 'run:rt', runId: 'rt', title: 'Run rt', costUSD: 1.5, at: NOW - DAY + 120_000 }]);
    const lib = svc.library(pat);
    expect(lib).toMatchObject([{ id: 'run:rt', kind: 'work', body: report.body, links: ['https://acme.example/pricing'] }]);
    const detail = svc.workerDetail(pat, 'ana');
    expect(detail.ok && detail.delivered.map((d) => d.entryId)).toEqual(['run:rt']);
  });

  it('does not count it twice when a completed entry covers the run', () => {
    const { svc } = harness({ runs: [retried], journal: { ana: [failedEntry, completed('ana', 'c1', NOW - DAY + 120_000, 'rt')] } });
    expect(svc.work(pat).map((w) => w.entryId)).toEqual(['c1']);
    expect(svc.library(pat).map((x) => x.id)).toEqual(['c1']);
  });

  it('leaves out failed and stopped runs', () => {
    const runs = [flowRun('bad', 'ana', NOW - DAY, { state: { kind: 'done', success: false } }), flowRun('ab', 'ana', NOW - DAY, { state: { kind: 'aborted' } })];
    expect(harness({ runs }).svc.work(pat)).toEqual([]);
  });

  it('can be rated, and the rating shows on it', () => {
    const h = harness({ runs: [retried], journal: { ana: [failedEntry] } });
    expect(h.svc.rate(pat, { entryId: 'run:rt', useful: true, note: 'good' })).toEqual({ ok: true });
    expect(h.ratings()).toMatchObject([{ entryId: 'run:rt', workerId: 'ana', useful: true, by: 'Pat', note: 'good' }]);
    expect(h.svc.work(pat)[0].rating).toEqual({ useful: true, by: 'Pat', note: 'good' });
    expect(h.svc.rate(pat, { entryId: 'run:nope', useful: true })).toEqual({ ok: false, error: 'No finished work with that id that you can see.' });
  });
});

describe('OrgService.runDetail', () => {
  const runs = [
    flowRun('r0', 'ana', NOW - DAY),
    flowRun('r1', 'ana', NOW - 2 * DAY, { state: { kind: 'done', success: false }, attempts: [{ stepId: 's', startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + 60_000, outcome: 'error', errorMessage: 'acme API timed out' }] }),
    flowRun('live', 'ana', NOW - 1000, { state: { kind: 'running', currentStepId: 's' } }),
    flowRun('hid', 'cal', NOW - DAY),
  ];

  it('gives the run, its worker and the worker’s last ended runs, newest first', () => {
    const { svc } = harness({ runs });
    const res = svc.runDetail(pat, 'r1');
    if (!res.ok) throw new Error(res.error);
    expect(res.worker).toEqual({ id: 'ana', name: 'Ana', enabled: true, manager: 'Pat' });
    expect(res.run).toMatchObject({ id: 'r1', state: 'failed', startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + 60_000, error: 'acme API timed out' });
    expect(res.youManage).toBe(true);
    expect(res.recent.map((r) => [r.runId, r.outcome])).toEqual([['r0', 'done'], ['r1', 'failed']]);
  });

  it('keeps a run going open-ended, and finds the thread it belongs to', () => {
    const { svc } = harness({ runs });
    const res = svc.runDetail(pat, 'live');
    if (!res.ok) throw new Error(res.error);
    expect(res.run.state).toBe('running');
    expect(res.run.endedAt).toBeUndefined();
    expect(res.thread?.runs.some((r) => r.runId === 'live')).toBe(true);
  });

  it('refuses a run whose worker the caller can’t see, and one that isn’t there', () => {
    const { svc } = harness({ runs });
    expect(svc.runDetail(pat, 'hid').ok).toBe(false);
    expect(svc.runDetail(pat, 'nope').ok).toBe(false);
    expect(svc.runDetail(sam, 'hid').ok).toBe(true);
  });
});

describe('searching recent work', () => {
  const report = { name: 'fix.md', body: 'Opened a pull request for ACME-5589: the login page now keeps the session.', producedAt: NOW - DAY, kind: 'markdown' as const, producedByStepId: 's' };
  const runs = [
    flowRun('login', 'ana', NOW - DAY, { userPrompt: 'Look at ticket ACME-5589 please', artifacts: { fix: report }, number: 7 }),
    flowRun('live', 'ana', NOW - 60_000, { userPrompt: 'Triage ACME-5589 again', state: { kind: 'running', currentStepId: 's' } }),
    flowRun('old', 'ana', NOW - 120 * DAY, { userPrompt: 'ACME-5589 the first time' }),
    flowRun('secret', 'cal', NOW - DAY, { userPrompt: 'ACME-5589 on the private worker' }),
    flowRun('other', 'ana', NOW - DAY, { userPrompt: 'Weekly competitor sweep' }),
  ];

  it('finds runs by what their request or output mentions, newest first, running ones included', () => {
    const hits = harness({ runs }).svc.searchWork(pat, 'acme-5589');
    expect(hits.map((x) => [x.runId, x.status])).toEqual([
      ['live', 'running'],
      ['login', 'done'],
    ]);
    expect(hits[1]).toMatchObject({ runNumber: 7, workerName: 'Ana', title: 'Run login' });
    expect(hits[1].snippet).toContain('ACME-5589');
  });

  it('needs every word, matches the run number, and ignores an empty query', () => {
    const { svc } = harness({ runs });
    expect(svc.searchWork(pat, 'acme-5589 session').map((x) => x.runId)).toEqual(['login']);
    expect(svc.searchWork(pat, '#7').map((x) => x.runId)).toEqual(['login']);
    expect(svc.searchWork(pat, '   ')).toEqual([]);
  });

  it('sees an artifact edited in place, forgets deleted runs, and holds a bounded amount of text', () => {
    const live: FlowRun[] = [flowRun('a', 'ana', NOW - DAY, { artifacts: { r: { ...report, body: 'status: open', producedAt: NOW - DAY } } })];
    const { svc } = harness({ runs: live });
    expect(svc.searchWork(pat, 'open').map((x) => x.runId)).toEqual(['a']);
    // Same length, new words: the cached text must not answer for it.
    live[0].artifacts = { r: { ...report, body: 'status: done', producedAt: NOW } };
    expect(svc.searchWork(pat, 'open')).toEqual([]);
    expect(svc.searchWork(pat, 'done').map((x) => x.runId)).toEqual(['a']);
    // Text beyond the old 50,000-character cut still finds the run.
    live[0].artifacts = { r: { ...report, body: `${'x'.repeat(120_000)} needle`, producedAt: NOW + 1 } };
    expect(svc.searchWork(pat, 'needle').map((x) => x.runId)).toEqual(['a']);
    // A run that is gone takes its text with it.
    live.length = 0;
    expect(svc.searchWork(pat, 'needle')).toEqual([]);
    expect(svc.searchCacheStats()).toEqual({ runs: 0, chars: 0 });
    // Many large runs: the newest fill the cache, the rest are read uncached, and a second search changes nothing.
    for (let i = 0; i < 400; i++) live.push(flowRun(`big${i}`, 'ana', NOW - DAY - i, { artifacts: { r: { ...report, body: 'y'.repeat(OrgService.SEARCH_ARTIFACT_CHARS), producedAt: NOW } } }));
    expect(svc.searchWork(pat, 'zzz')).toEqual([]);
    const stats = svc.searchCacheStats();
    expect(stats.chars).toBeLessThanOrEqual(OrgService.SEARCH_CACHE_CHARS);
    expect(stats.runs).toBe(Math.floor(OrgService.SEARCH_CACHE_CHARS / OrgService.SEARCH_ARTIFACT_CHARS));
    expect(svc.searchWork(pat, 'zzz')).toEqual([]);
    expect(svc.searchCacheStats()).toEqual(stats);
    // A new run arrives: it takes the place of the oldest kept, so the newest stay cached as time goes on.
    live.unshift(flowRun('fresh', 'ana', NOW - 1000, { artifacts: { r: { ...report, body: `${'v'.repeat(OrgService.SEARCH_ARTIFACT_CHARS - 6)} vivid`, producedAt: NOW } } }));
    expect(svc.searchWork(pat, 'vivid').map((x) => x.runId)).toEqual(['fresh']);
    expect(svc.searchCacheStats()).toEqual(stats);
    expect(svc.searchWork(pat, 'vivid').map((x) => x.runId)).toEqual(['fresh']);
    // One run bigger than the whole cache is searched but never kept, and throws nothing out.
    live.unshift(flowRun('huge', 'ana', NOW - 500, { artifacts: Object.fromEntries(Array.from({ length: 170 }, (_, i) => [`a${i}`, { ...report, body: 'w'.repeat(OrgService.SEARCH_ARTIFACT_CHARS), producedAt: NOW }])) }));
    expect(svc.searchWork(pat, 'www').map((x) => x.runId)).toEqual(['huge']);
    expect(svc.searchCacheStats().chars).toBeLessThanOrEqual(OrgService.SEARCH_CACHE_CHARS);
  });

  it("leaves out someone else's private worker, and reaches further back when asked", () => {
    const { svc } = harness({ runs });
    expect(svc.searchWork(pat, 'private')).toEqual([]);
    expect(svc.searchWork(sam, 'private').map((x) => x.runId)).toEqual(['secret']);
    expect(svc.searchWork(pat, 'first time')).toEqual([]);
    expect(svc.searchWork(pat, 'first time', { days: 180 }).map((x) => x.runId)).toEqual(['old']);
  });
});
