import { afterEach, describe, expect, it, vi } from 'vitest';

// The renderer store calls window.overcli.invoke for IPC. Stub the global
// before importing so the module load doesn't crash in the Node test env.
const mockInvoke = vi.fn();
(globalThis as unknown as Record<string, unknown>).window = {
  overcli: { invoke: mockInvoke },
};

import {
  draftFromContract,
  draftFromWorker,
  newWorkerDraft,
  useWorkersStore,
} from './workersStore';
import type { Worker, WorkerScorecard } from '@shared/flows/worker';
import type { Flow } from '@shared/flows/schema';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'worker-1',
    name: 'Scout',
    jobDescription: 'Find valuable maintenance work each morning and propose it.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'probation',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 20,
    heartbeatModel: 'cheap-model',
    flowIds: ['fix-it'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function makeScorecard(overrides: Partial<WorkerScorecard> = {}): WorkerScorecard {
  return {
    proposed: 0,
    approved: 0,
    rejected: 0,
    completed: 0,
    failed: 0,
    spentThisMonthUSD: 0,
    costPerCompletedUSD: null,
    rejectionStreak: 0,
    ...overrides,
  };
}

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'drafted-flow',
    name: 'Drafted Flow',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'P', backend: 'claude', model: 'claude-sonnet-5', kind: 'primary' },
    ],
    steps: [
      {
        id: 's1',
        participantId: 'primary',
        role: 'implementer',
        inputs: ['user_prompt'],
        tools: ['Read'],
        output: 'out.md',
      },
    ],
    source: 'user',
    filePath: '',
    ...overrides,
  };
}

afterEach(() => {
  mockInvoke.mockReset();
  useWorkersStore.setState({
    loaded: false,
    workers: {},
    nextShiftAt: {},
    scorecards: {},
    journals: {},
    shiftProgress: {},
    draft: null,
    draftedFlow: null,
    hireSummary: null,
    busy: false,
    error: null,
  });
});

describe('workersStore mirror', () => {
  it('reload lands workers, nextShiftAt, and scorecards keyed by id', async () => {
    mockInvoke.mockResolvedValueOnce([
      { worker: makeWorker(), nextShiftAt: 123, scorecard: makeScorecard({ proposed: 2 }) },
    ]);
    await useWorkersStore.getState().reload();
    const s = useWorkersStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.workers['worker-1'].name).toBe('Scout');
    expect(s.nextShiftAt['worker-1']).toBe(123);
    expect(s.scorecards['worker-1'].proposed).toBe(2);
  });

  it('applyUpdate patches one worker without touching the rest', () => {
    const s = useWorkersStore.getState();
    s.applyUpdate(makeWorker(), 1, makeScorecard());
    s.applyUpdate(makeWorker({ id: 'worker-2', name: 'Warden' }), 2, makeScorecard());
    s.applyUpdate(makeWorker({ name: 'Scout II' }), 3, makeScorecard({ approved: 1 }));
    const after = useWorkersStore.getState();
    expect(after.workers['worker-1'].name).toBe('Scout II');
    expect(after.workers['worker-2'].name).toBe('Warden');
    expect(after.nextShiftAt['worker-1']).toBe(3);
    expect(after.scorecards['worker-1'].approved).toBe(1);
  });

  it('removeLocal evicts every per-worker map', () => {
    const s = useWorkersStore.getState();
    s.applyUpdate(makeWorker(), 1, makeScorecard());
    s.setShiftActive('worker-1', true);
    s.removeLocal('worker-1');
    const after = useWorkersStore.getState();
    expect(after.workers['worker-1']).toBeUndefined();
    expect(after.nextShiftAt['worker-1']).toBeUndefined();
    expect(after.scorecards['worker-1']).toBeUndefined();
    expect(after.shiftProgress['worker-1']).toBeUndefined();
  });

  it('shift progress tracks active/clear and streamed text', () => {
    const s = useWorkersStore.getState();
    s.setShiftActive('worker-1', true);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toEqual({ text: '', tools: [] });
    s.applyShiftProgress('worker-1', 'investigating…', ['Read']);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toEqual({
      text: 'investigating…',
      tools: ['Read'],
    });
    s.setShiftActive('worker-1', false);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toBeUndefined();
  });
});

describe('workersStore save', () => {
  it('persists a riding-along flow first and wires it into an empty flowIds', async () => {
    useWorkersStore.setState({
      draft: { ...newWorkerDraft('/repo'), name: 'Scout', jobDescription: 'x'.repeat(30), flowIds: [] },
      draftedFlow: makeFlow(),
    });
    mockInvoke
      .mockResolvedValueOnce({ ok: true }) // flows:save
      .mockResolvedValueOnce({ ok: true, worker: makeWorker() }); // workers:save
    const ok = await useWorkersStore.getState().save();
    expect(ok).toBe(true);
    expect(mockInvoke.mock.calls[0][0]).toBe('flows:save');
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ target: 'user' });
    expect(mockInvoke.mock.calls[1][0]).toBe('workers:save');
    expect(mockInvoke.mock.calls[1][1].worker.flowIds).toEqual(['drafted-flow']);
    // Editor closed, ride-along cleared.
    expect(useWorkersStore.getState().draft).toBeNull();
    expect(useWorkersStore.getState().draftedFlow).toBeNull();
  });

  it('keeps existing flowIds when the ride-along is a revision of that flow', async () => {
    useWorkersStore.setState({
      draft: { ...newWorkerDraft('/repo'), flowIds: ['drafted-flow'] },
      draftedFlow: makeFlow(),
    });
    mockInvoke
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, worker: makeWorker() });
    await useWorkersStore.getState().save();
    expect(mockInvoke.mock.calls[1][1].worker.flowIds).toEqual(['drafted-flow']);
  });

  it('a failed flow save blocks the worker save and surfaces the error', async () => {
    useWorkersStore.setState({
      draft: { ...newWorkerDraft('/repo'), flowIds: [] },
      draftedFlow: makeFlow(),
    });
    mockInvoke.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    const ok = await useWorkersStore.getState().save();
    expect(ok).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(useWorkersStore.getState().error).toBe('disk full');
    // The draft survives so nothing typed is lost.
    expect(useWorkersStore.getState().draft).not.toBeNull();
  });

  it('applyRevision patches the draft and parks the revised flow', () => {
    useWorkersStore.setState({ draft: newWorkerDraft('/repo') });
    useWorkersStore
      .getState()
      .applyRevision({ jobDescription: 'the new job', flow: makeFlow({ id: 'revised' }) });
    const s = useWorkersStore.getState();
    expect(s.draft?.jobDescription).toBe('the new job');
    expect(s.draftedFlow?.id).toBe('revised');
  });
});

describe('draft factories', () => {
  it('draftFromWorker copies without sharing nested references', () => {
    const w = makeWorker({ cadence: { kind: 'daily', time: '09:00', days: [1, 2] } });
    const d = draftFromWorker(w);
    (d.cadence as { days: number[] }).days.push(6);
    d.flowIds.push('other');
    expect(w.cadence).toEqual({ kind: 'daily', time: '09:00', days: [1, 2] });
    expect(w.flowIds).toEqual(['fix-it']);
  });

  it('draftFromContract starts on worktree with the given project and flow', () => {
    const d = draftFromContract(
      {
        name: 'Scout',
        jobDescription: 'Watch things and report.',
        cadence: { kind: 'daily', time: '07:00' },
        maxItemsPerShift: 2,
        budgetUSDPerMonth: 12,
        heartbeatModel: 'cheap',
      },
      '/repo',
      'fix-it',
    );
    expect(d).toMatchObject({
      projectPath: '/repo',
      flowIds: ['fix-it'],
      caps: { maxItemsPerShift: 2, runIn: 'worktree' },
      enabled: true,
    });
  });
});
