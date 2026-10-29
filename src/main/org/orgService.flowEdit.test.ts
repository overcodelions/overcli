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
