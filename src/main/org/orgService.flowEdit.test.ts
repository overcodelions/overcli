import { describe, expect, it } from 'vitest';
import type { Flow, FlowStep } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import type { Backend } from '../../shared/types';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService } from './orgService';
import { serializeFlow } from '../../shared/flows/yaml';

const PAT = 'U0ACMEPAT';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };
const admin: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Finds open tickets each morning and fixes the small ones.',
    projectPath: '/data/Workers',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'claude-sonnet-5',
    heartbeatBackend: 'claude',
    flowIds: ['fix'],
    enabled: true,
    createdAt: 0,
    manager: { name: 'Pat', slackUserId: PAT },
    ...over,
  };
}

function modelFlow(id: string, participants: Array<{ backend: Backend; model: string; name: string }>): Flow {
  return {
    id,
    name: `Flow ${id}`,
    input: 'user_prompt',
    source: 'user',
    filePath: `/data/flows/${id}.yaml`,
    participants: participants.map((p, i) => ({ id: `p${i}`, kind: i === 0 ? 'primary' : 'reviewer', ...p })),
    steps: [{ id: 'step_1', participantId: 'p0', prompt: 'Do it.' }],
  } as unknown as Flow;
}

function harness(roster: Worker[], flows: Flow[], revise: (f: Flow, ask: string) => { ok: true; flow: Flow } | { ok: false; error: string } = (f) => ({ ok: true, flow: f }), healthy: Backend[] = ['claude']) {
  const workers = new Map(roster.map((w) => [w.id, w]));
  const library = new Map(flows.map((f) => [f.id, f]));
  const saved: Flow[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [...workers.values()],
      get: (id) => workers.get(id) ?? null,
      save: (w) => {
        workers.set(w.id, w);
        return { ok: true, worker: w };
      },
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [...workers.values()].map((w) => w.name),
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    reviseFlow: async ({ flow, ask }) => revise(flow, ask),
    models: {
      flows: (ids) => ids.flatMap((id) => library.get(id) ?? []),
      save: (f) => {
        saved.push(f);
        library.set(f.id, f);
        return { ok: true };
      },
      healthy: async () => healthy,
    },
    audit: { append: () => {}, recent: () => [], all: () => [] },
    now: () => 0,
  });
  return { svc, workers, saved };
}

void modelFlow;

const step = (id: string, over: Partial<FlowStep> = {}): FlowStep => ({ id, participantId: 'primary', role: 'implementer', inputs: ['user_prompt'], tools: ['Read', 'Edit'], output: `${id}.md`, ...over });
const fix: Flow = {
  id: 'fix',
  name: 'Fix',
  input: 'user_prompt',
  participants: [{ id: 'primary', name: 'Claude', backend: 'claude', model: 'claude-sonnet-5-5', kind: 'primary' }],
  steps: [step('plan'), step('change')],
  source: 'user',
  filePath: '/data/flows/fix.yaml',
};
// The model's answer to "check it before you finish".
const addCheck = (f: Flow) => ({ ok: true as const, flow: { ...f, steps: [...f.steps, step('check')] } });

describe('how a worker works, changed by saying so', () => {
  it('shows its flows as steps, with who else runs them', () => {
    const res = harness([worker('triage'), worker('scout', { manager: { name: 'Sam', slackUserId: 'U0ACMESAM' } })], [fix]).svc.workerFlows(pat, 'Triage');
    expect(res).toMatchObject({ ok: true, canChange: true, flows: [{ id: 'fix', usual: true, sharedWith: ['Scout'], othersNotYours: ['Scout'], steps: [{ label: 'Plan' }, { label: 'Change' }] }] });
  });

  it('suggests without saving, then saves in place when nobody else runs it', async () => {
    const h = harness([worker('triage')], [fix], addCheck);
    const s = await h.svc.suggestFlow(pat, 'Triage', 'fix', 'check it before you finish');
    if (!s.ok) throw new Error(s.error);
    expect(s.changes).toEqual(['Adds “Check” after “Change”.']);
    expect(h.saved).toHaveLength(0);
    const saved = h.svc.saveFlowEdit(pat, 'Triage', 'fix', s.yaml, false);
    expect(saved).toMatchObject({ ok: true, flowId: 'fix', copied: false });
    expect(h.saved[0].steps.map((x) => x.id)).toEqual(['plan', 'change', 'check']);
  });

  it('undoes an applied step change from its suggestion, in one go', async () => {
    const h = harness([worker('triage')], [fix], addCheck);
    const s = await h.svc.suggestFlow(pat, 'Triage', 'fix', 'check it before you finish');
    if (!s.ok) throw new Error(s.error);
    h.svc.saveFlowEdit(pat, 'Triage', 'fix', s.yaml, false);
    let reviews = [{ id: 'a', workerId: [...h.workers.keys()][0], at: 0, by: 'Pat', summary: '', looked: { runs: 0, answers: 0 }, suggestions: [{ id: 's1', area: 'flow', flowId: 'fix', title: 'T', why: '', change: 'C', runs: [], state: 'applied', appliedAt: 0 }] }];
    (h.svc as unknown as { deps: Record<string, unknown> }).deps.reviews = { list: () => reviews, save: (r: typeof reviews) => (reviews = structuredClone(r)) };
    expect(h.svc.undoSuggestion(pat, 'Triage', 'a', 's1')).toEqual({ ok: true });
    expect(h.saved.at(-1)!.steps.map((x) => x.id)).toEqual(['plan', 'change']);
    expect(reviews[0].suggestions[0].state).toBe('dismissed');
  });

  it('gives it its own copy of a flow others run, unless told to change it for everyone', async () => {
    const h = harness([worker('triage'), worker('scout')], [fix], addCheck);
    const s = await h.svc.suggestFlow(pat, 'Triage', 'fix', 'check it');
    if (!s.ok) throw new Error(s.error);
    expect(h.svc.saveFlowEdit(pat, 'Triage', 'fix', s.yaml, false)).toMatchObject({ ok: true, flowId: 'fix-triage', copied: true });
    expect(h.workers.get('triage')!.flowIds).toEqual(['fix-triage']);
    expect(h.workers.get('scout')!.flowIds).toEqual(['fix']);
    expect(h.saved[0]).toMatchObject({ id: 'fix-triage', name: 'Fix (Triage)' });
  });

  it('changes it for another manager’s worker only by an admin', async () => {
    const h = harness([worker('triage'), worker('scout', { manager: { name: 'Sam', slackUserId: 'U0ACMESAM' } })], [fix], addCheck);
    const s = await h.svc.suggestFlow(pat, 'Triage', 'fix', 'check it');
    if (!s.ok) throw new Error(s.error);
    expect(h.svc.saveFlowEdit(pat, 'Triage', 'fix', s.yaml, true)).toEqual({ ok: false, error: expect.stringContaining('Scout runs it too') });
    expect(h.svc.saveFlowEdit(admin, 'Triage', 'fix', s.yaml, true)).toMatchObject({ ok: true, flowId: 'fix', copied: false });
  });

  it('won’t save a flow sent back with a tool it never had', () => {
    const h = harness([worker('triage')], [fix]);
    const wider = serializeFlow({ ...fix, steps: [step('plan', { tools: ['Read', 'Bash'] }), step('change')] });
    expect(h.svc.saveFlowEdit(pat, 'Triage', 'fix', wider, false)).toEqual({ ok: false, error: expect.stringContaining('Bash') });
    expect(h.saved).toHaveLength(0);
  });

  it('is for its manager', async () => {
    expect((await harness([worker('triage')], [fix], addCheck).svc.suggestFlow(sam, 'Triage', 'fix', 'check it')).ok).toBe(false);
    expect(harness([worker('triage')], [fix]).svc.workerFlows(sam, 'Triage').ok).toBe(false);
  });

  it('keeps the change in its history, and restoring puts the flow back', async () => {
    const h = harness([worker('triage'), worker('scout')], [fix], addCheck);
    const s = await h.svc.suggestFlow(pat, 'Triage', 'fix', 'check it');
    if (!s.ok) throw new Error(s.error);
    h.svc.saveFlowEdit(pat, 'Triage', 'fix', s.yaml, false);
    const hist = h.svc.workerHistory(pat, 'Triage');
    if (!hist.ok) throw new Error(hist.error);
    expect(hist.versions.map((v) => v.changed[0])).toEqual(['how it works', 'how it works, as it was']);
    expect(hist.versions[0].flow?.steps.map((x) => x.label)).toEqual(['Plan', 'Change', 'Check']);
    expect(h.svc.restoreWorker(pat, 'Triage', hist.versions[1].id).ok).toBe(true);
    expect(h.workers.get('triage')!.flowIds).toEqual(['fix']);
  });
});

describe('a worker changed by saying so once: its job, how it works, or both', () => {
  const deps = (h: ReturnType<typeof harness>) => (h.svc as unknown as { deps: Record<string, unknown> }).deps;
  const shoot = (f: Flow): Flow => ({ ...f, steps: [...f.steps, step('screenshots', { tools: ['Read', 'mcp__test-systems__open_system', 'mcp__test-systems__browser_take_screenshot'] })] });

  it('routes one ask to the job and the flow, saving nothing until asked', async () => {
    const h = harness([worker('triage')], [fix]);
    deps(h).reviseWorker = async (a: { jobDescription: string; flow?: Flow }) => ({ ok: true, jobDescription: `${a.jobDescription} Takes screenshots of what it checks.`, flow: addCheck(a.flow!).flow, note: 'Both.' });
    const r = await h.svc.reviseWorker(pat, 'Triage', 'check it and take screenshots');
    if (!r.ok) throw new Error(r.error);
    expect(r.job).toContain('Takes screenshots');
    expect(r.flow).toMatchObject({ flowId: 'fix', changes: ['Adds “Check” after “Change”.'], sharedWith: [] });
    expect(h.saved).toHaveLength(0);
    expect(h.svc.saveFlowEdit(pat, 'Triage', 'fix', r.flow!.yaml, false)).toMatchObject({ ok: true });
  });

  it('names a tool the new flow needs that the worker lacks, instead of failing', async () => {
    const h = harness([worker('triage')], [fix]);
    deps(h).reviseWorker = async (a: { flow?: Flow }) => ({ ok: true, flow: shoot(a.flow!), note: 'Flow.' });
    const r = await h.svc.reviseWorker(pat, 'Triage', 'take screenshots with test-systems');
    if (!r.ok) throw new Error(r.error);
    expect(r.needsTools).toEqual(['test-systems']);
    expect(r.flowProblem).toContain('doesn’t have yet');
    expect(r.flow).toBeUndefined();
  });

  it('counts its role’s tools as its own', async () => {
    const h = harness([worker('triage', { role: 'QA' })], [fix]);
    deps(h).policy = () => ({ ...DEFAULT_ORG_POLICY, roles: [{ name: 'QA', job: 'Tests.', tools: ['test-systems'], budgetUSDPerMonth: 100 }] });
    deps(h).reviseWorker = async (a: { flow?: Flow }) => ({ ok: true, flow: shoot(a.flow!), note: 'Flow.' });
    const r = await h.svc.reviseWorker(pat, 'Triage', 'take screenshots with test-systems');
    if (!r.ok) throw new Error(r.error);
    expect(r.needsTools).toBeUndefined();
    expect(r.flow?.changes.join(' ')).toContain('Screenshots');
    expect(h.svc.saveFlowEdit(pat, 'Triage', 'fix', r.flow!.yaml, false)).toMatchObject({ ok: true });
  });

  it('is its manager’s to ask', async () => {
    const h = harness([worker('triage')], [fix]);
    deps(h).reviseWorker = async () => ({ ok: true, jobDescription: 'x', note: '' });
    expect((await h.svc.reviseWorker(sam, 'Triage', 'do more')).ok).toBe(false);
  });
});

describe('clearing a worker setting', () => {
  it('stays cleared when the store merges an edit onto what it has, as the worker engine does', () => {
    const h = harness([worker('triage', { visibility: 'org', audience: {}, reportsTo: 'boss' })], [fix]);
    const store = (h.svc as unknown as { deps: { workers: { save: (w: Worker) => unknown } } }).deps.workers;
    store.save = (w: Worker) => {
      const merged = { ...h.workers.get(w.id)!, ...w };
      h.workers.set(w.id, merged);
      return { ok: true, worker: merged };
    };
    expect(h.svc.update(admin, 'triage', { visibility: 'org', audience: null, reportsTo: null })).toMatchObject({ ok: true });
    expect(h.workers.get('triage')!.audience).toBeUndefined();
    expect(h.workers.get('triage')!.reportsTo).toBeUndefined();
  });
});

describe('org tuning, applied', () => {
  const refusedRun = (workerId: string) =>
    ({ id: `r-${workerId}`, workerId, flowId: 'fix', createdAt: 0, attempts: [], refusedTools: ['mcp__test-systems__open_system'], flowSnapshot: fix, state: { kind: 'done', success: true } }) as unknown as Flow;

  it('is for admins, gives the refused tool, and then the suggestion is gone', () => {
    const h = harness([worker('triage')], [fix]);
    (h.svc as unknown as { deps: Record<string, unknown> }).deps.runs = { listRuns: () => [refusedRun('triage')], getRun: () => null };
    expect(h.svc.orgTuning(pat).ok).toBe(false);
    const t = h.svc.orgTuning(admin);
    if (!t.ok) throw new Error(t.error);
    expect(t.suggestions.map((s) => s.id)).toEqual(['give:test-systems']);
    expect(h.svc.applyOrgTuning(admin, 'give:test-systems')).toMatchObject({ ok: true, done: 'Give test-systems to Triage' });
    expect(h.workers.get('triage')!.mcpServers).toContain('test-systems');
    const after = h.svc.orgTuning(admin);
    expect(after.ok && after.suggestions).toEqual([]);
    expect(h.svc.applyOrgTuning(admin, 'give:test-systems').ok).toBe(false);
  });

  it('shares a worker with people who keep asking for it, keeping who it was open to, and then the suggestion is gone', () => {
    const h = harness([worker('triage', { visibility: 'org', audience: { people: ['U0KEEP'] } })], [fix]);
    const asks = [1, 2].map((i) => ({ workerId: 'triage', user: 'U0EMM', by: 'Emm', at: Date.now() - i * 1000 }));
    (h.svc as unknown as { deps: Record<string, unknown> }).deps.missedAsks = () => asks;
    const t = h.svc.orgTuning(admin);
    if (!t.ok) throw new Error(t.error);
    const s = t.suggestions.find((x) => x.action.kind === 'shareWorker')!;
    expect(s.title).toBe('Share Triage with Emm');
    expect(h.svc.applyOrgTuning(admin, s.id)).toMatchObject({ ok: true });
    expect(h.workers.get('triage')!.audience).toEqual({ people: ['U0KEEP', 'U0EMM'] });
    const after = h.svc.orgTuning(admin);
    expect(after.ok && after.suggestions.filter((x) => x.action.kind === 'shareWorker')).toEqual([]);
  });
});
