import { describe, expect, it } from 'vitest';
import type { Flow } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import type { Backend } from '../../shared/types';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService } from './orgService';

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

function flow(id: string, participants: Array<{ backend: Backend; model: string; name: string }>): Flow {
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

function harness(roster: Worker[], flows: Flow[], healthy: Backend[] = ['claude', 'codex']) {
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

const fix = flow('fix', [
  { backend: 'claude', model: 'claude-opus-5', name: 'Claude Opus 5' },
  { backend: 'claude', model: 'claude-opus-5-5', name: 'Reviewer' },
]);

describe('newer models for a worker', () => {
  it('offers planning and each flow its next model in the same line', async () => {
    const res = await harness([worker('triage')], [fix]).svc.modelUpgrades(pat, 'Triage');
    if (!res.ok) throw new Error(res.error);
    expect(res.planning).toMatchObject({ change: expect.stringMatching(/Sonnet 5 → .*5\.5/) });
    expect(res.flows).toMatchObject([{ id: 'fix', changes: [{ from: 'claude-opus-5', to: 'claude-opus-5-5', where: ['Claude Opus 5'] }], sharedWith: [], runsHere: [] }]);
  });

  it('says what runs on another backend here', async () => {
    const mixed = flow('fix', [{ backend: 'codex', model: 'gpt-6.1-terra', name: 'Terra' }]);
    const res = await harness([worker('triage', { heartbeatBackend: 'codex', heartbeatModel: 'gpt-6.1-terra' })], [mixed], ['claude']).svc.modelUpgrades(pat, 'Triage');
    if (!res.ok) throw new Error(res.error);
    expect(res.planning?.runsHere).toMatch(/codex isn’t signed in here, so it plans on claude/);
    expect(res.flows[0].runsHere).toEqual([expect.stringMatching(/runs as Claude/)]);
  });

  it('moves only what was ticked, renaming a name that only labelled the model', async () => {
    const h = harness([worker('triage')], [fix]);
    const res = await h.svc.upgradeModels(pat, 'Triage', { flows: ['fix'] });
    expect(res).toMatchObject({ ok: true, errors: [] });
    expect(h.workers.get('triage')!.heartbeatModel).toBe('claude-sonnet-5');
    expect(h.saved[0].participants.map((p) => [p.name, p.model])).toEqual([
      ['Claude Opus 5.5', 'claude-opus-5-5'],
      ['Reviewer', 'claude-opus-5-5'],
    ]);
    await h.svc.upgradeModels(pat, 'Triage', { planning: true });
    expect(h.workers.get('triage')!.heartbeatModel).toBe('claude-sonnet-5-5');
  });

  it('won’t move a flow for another manager’s worker', async () => {
    const roster = [worker('triage'), worker('scout', { manager: { name: 'Sam', slackUserId: 'U0ACMESAM' } })];
    const h = harness(roster, [fix]);
    const plan = await h.svc.modelUpgrades(pat, 'Triage');
    expect(plan.ok && plan.flows[0].sharedWith).toEqual(['Scout']);
    const res = await h.svc.upgradeModels(pat, 'Triage', { flows: ['fix'] });
    expect(res).toMatchObject({ ok: true, changed: [], errors: [expect.stringContaining('Scout uses it too')] });
    expect(h.saved).toHaveLength(0);
    expect((await h.svc.upgradeModels(admin, 'Triage', { flows: ['fix'] })).ok && h.saved).toHaveLength(1);
  });

  it('is for its manager', async () => {
    expect((await harness([worker('triage')], [fix]).svc.modelUpgrades(sam, 'Triage')).ok).toBe(false);
  });
});
