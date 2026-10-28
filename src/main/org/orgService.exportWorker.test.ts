import { describe, expect, it } from 'vitest';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import { parseWorkerYaml, serializeWorker } from '../../shared/flows/workerYaml';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService, type PendingHire } from './orgService';
import type { WorkerTrigger } from './triggers';

const PAT = 'U0ACMEPAT';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };

const triage: Worker = {
  id: 'triage',
  name: 'Triage',
  jobDescription: 'Finds open tickets each morning and fixes the small ones.',
  projectPath: '/data/Workers',
  cadence: null,
  trust: 'trusted',
  caps: { maxItemsPerShift: 2, runIn: 'worktree', allowExternalActions: true } as Worker['caps'],
  budgetUSDPerMonth: 30,
  heartbeatModel: 'sonnet',
  flowIds: [],
  enabled: true,
  createdAt: 0,
  manager: { name: 'Pat', slackUserId: PAT },
  mcpServers: ['tracker', 'repo-host'],
  toolScopes: { tracker: { mode: 'read' }, 'repo-host': { mode: 'only', calls: ['list_prs'] } },
  knowledge: { status: 'ready', body: 'Tickets live on board 215.' },
};

const queueWatch = {
  id: 't1',
  workerId: 'triage',
  name: 'New tickets',
  kind: 'watch',
  enabled: true,
  instructions: 'Triage it.',
  deliver: [{ kind: 'slack', channel: 'C0ACME01' }, { kind: 'dm', slackUserId: PAT }],
  maxPerDay: 20,
  watch: { server: 'tracker', tool: 'search', args: { jql: 'project = ACME' }, everyMinutes: 15 },
  startsOnItsOwn: true,
  seen: ['ACME-1'],
  createdBy: 'Pat',
  createdAt: 0,
} as WorkerTrigger;

const journal: WorkerJournalEntry[] = [
  { id: 'j1', workerId: 'triage', kind: 'launched', at: 1000, title: 'ACME-1 fix login' },
  { id: 'j2', workerId: 'triage', kind: 'completed', at: 2000, title: 'ACME-1 fix login' },
  { id: 'j3', workerId: 'triage', kind: 'note', at: 3000, title: '', note: 'From Pat: skip ACME-9' },
  { id: 'j4', workerId: 'triage', kind: 'demoted', at: 4000, title: '' },
];

function harness(policy: Partial<OrgPolicy> = {}) {
  const roster = new Map<string, Worker>([[triage.id, structuredClone(triage)]]);
  const triggers: WorkerTrigger[] = [structuredClone(queueWatch)];
  const remembered: string[] = [];
  let hires: PendingHire[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [...roster.values()],
      get: (id) => roster.get(id) ?? null,
      save: (w) => {
        roster.set(w.id, w);
        return { ok: true, worker: w };
      },
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: (id) => (id === 'triage' ? journal : []),
      spentThisMonth: () => new Map(),
      workerNames: () => [...roster.values()].map((w) => w.name),
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*', budgetAllowanceUSD: 100, allowedMcpServers: ['tracker', 'repo-host'], ...policy }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => hires, save: (h) => (hires = structuredClone(h)) },
    triggers: () =>
      ({
        list: (workerId?: string) => triggers.filter((t) => !workerId || t.workerId === workerId),
        create: (input: Omit<WorkerTrigger, 'id'>) => {
          const trigger = { ...input, id: `t${triggers.length + 1}` } as WorkerTrigger;
          triggers.push(trigger);
          return { ok: true, trigger, ...(input.kind === 'webhook' ? { token: 'tok' } : {}) };
        },
      }) as never,
    tools: {
      list: () => ({ tools: [], missing: [] }),
      remember: (t) => remembered.push(...t.map((x) => x.name)),
      template: (name) => ({ name, kind: 'command', command: 'npx', args: ['-y', `${name}-mcp`], envKeys: ['API_TOKEN'], headerKeys: [] }),
      install: () => ({ ok: true }),
      uninstall: () => ({ ok: true }),
      check: async () => null,
    },
    shareWorker: (worker, carried) => ({ yaml: serializeWorker({ worker, flows: [], carried }), filename: 'triage.worker.yaml', missingFlowIds: [] }),
    importWorker: (_yaml, o) => {
      const w: Worker = { ...structuredClone(triage), id: 'landed', trust: 'probation', toolScopes: undefined, mcpServers: o.mcpServers, manager: o.extra.manager };
      roster.set(w.id, w);
      return { ok: true, worker: w };
    },
    audit: { append: () => {}, recent: () => [], all: () => [] },
    now: () => 0,
  });
  return { svc, roster, triggers, remembered };
}

describe('exporting a worker', () => {
  it('carries its triggers, scopes and tools, minus DMs, seen items and secrets', () => {
    const res = harness().svc.exportWorker(pat, 'Triage');
    if (!res.ok) throw new Error(res.error);
    const parsed = parseWorkerYaml(res.yaml);
    if (!parsed.ok) throw new Error(parsed.error);
    const c = parsed.bundle.carried!;
    expect(c.toolScopes).toEqual(triage.toolScopes);
    expect(c.triggers).toEqual([
      { name: 'New tickets', kind: 'watch', enabled: true, instructions: 'Triage it.', deliver: [{ kind: 'slack', channel: 'C0ACME01' }], maxPerDay: 20, watch: queueWatch.watch },
    ]);
    expect(c.tools?.map((t) => t.name)).toEqual(['tracker', 'repo-host']);
    expect(res.yaml).not.toContain('ACME-1');
    expect(res.yaml).not.toContain('trusted');
    expect(c.knowledge).toBeUndefined();
    expect(c.journal).toBeUndefined();
    expect(res.left.join(' ')).toMatch(/1 DM destination/);
    expect(res.left.join(' ')).toMatch(/Starts on its own/);
  });

  it('brings what it learned and its journal only when asked', () => {
    const res = harness().svc.exportWorker(pat, 'Triage', { learned: true, journal: true });
    if (!res.ok) throw new Error(res.error);
    const parsed = parseWorkerYaml(res.yaml);
    const c = parsed.ok ? parsed.bundle.carried! : null;
    expect(c?.knowledge).toBe('Tickets live on board 215.');
    expect(c?.notes).toEqual([{ at: 3000, note: 'From Pat: skip ACME-9' }]);
    expect(c?.journal?.map((e) => e.kind)).toEqual(['launched', 'completed']);
  });

  it('is for its manager or an admin', () => {
    expect(harness().svc.exportWorker(sam, 'Triage').ok).toBe(false);
  });
});

describe('importing an exported worker', () => {
  it('lands its scopes and triggers and says what it brought', () => {
    const from = harness().svc.exportWorker(pat, 'Triage', { learned: true, journal: true });
    if (!from.ok) throw new Error(from.error);
    const to = harness();
    to.triggers.length = 0;
    const res = to.svc.publishWorker(pat, from.yaml);
    if (!res.ok) throw new Error(res.error);
    expect(to.roster.get('landed')!.toolScopes).toEqual(triage.toolScopes);
    expect(to.triggers).toMatchObject([{ workerId: 'landed', name: 'New tickets', createdBy: 'Pat', deliver: [{ kind: 'slack', channel: 'C0ACME01' }] }]);
    expect(to.triggers[0].startsOnItsOwn).toBeUndefined();
    expect(to.remembered).toEqual(['tracker', 'repo-host']);
    expect(res.brought).toEqual(expect.arrayContaining([expect.stringMatching(/^1 trigger: New tickets/), expect.stringMatching(/2 journal entries/)]));
  });

  it('never widens a tool past the org’s default', () => {
    const from = harness().svc.exportWorker(pat, 'Triage');
    if (!from.ok) throw new Error(from.error);
    const to = harness({ toolDefaults: { 'repo-host': { mode: 'only', calls: ['get_pr'] } } });
    const res = to.svc.publishWorker(pat, from.yaml);
    if (!res.ok) throw new Error(res.error);
    expect(to.roster.get('landed')!.toolScopes).toEqual({ tracker: { mode: 'read' } });
    expect(res.brought?.join(' ')).toMatch(/scope for repo-host was wider/);
  });
});
