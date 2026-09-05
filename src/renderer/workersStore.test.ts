import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer store calls window.overcli.invoke for IPC. Stub the global
// before importing so the module load doesn't crash in the Node test env.
const mockInvoke = vi.fn();
(globalThis as unknown as Record<string, unknown>).window = {
  overcli: { invoke: mockInvoke },
};

import {
  draftFromContract,
  draftFromPortable,
  draftFromWorker,
  newWorkerDraft,
  selectRevise,
  useWorkersStore,
} from './workersStore';
import { useFlowsStore } from './flowsStore';
import type { PortableWorker } from '@shared/flows/workerYaml';
import type { Worker, WorkerScorecard } from '@shared/flows/worker';
import { allocateTreasury } from '@shared/flows/treasury';
import type { Flow } from '@shared/flows/schema';

/// The share file the personalization tests all import.
function importedNanny() {
  return {
    ok: true as const,
    worker: {
      name: 'Release Nanny',
      jobDescription: 'Watch the release branch and post the digest to #eng-leads.',
      cadence: { kind: 'daily', time: '08:00' },
      caps: { maxItemsPerShift: 2, runIn: 'worktree' },
      budgetUSDPerMonth: 12,
      heartbeatModel: 'cheap',
      flowIds: ['nightly-review'],
    } as unknown as PortableWorker,
    notes: {
      installedFlowIds: ['nightly-review'],
      reusedFlowIds: [],
      missingFlowIds: [],
      failedFlowIds: [],
    },
    summary: 'Added 1 flow to your library (nightly-review).',
  };
}

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
      {
        id: 'primary',
        name: 'P',
        backend: 'claude',
        model: 'claude-sonnet-5',
        kind: 'primary',
      },
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
    shiftStarting: {},
    errandBusy: {},
    errandSending: {},
    errandError: {},
    errandResult: {},
    draft: null,
    draftFromHire: false,
    pendingHire: null,
    draftedFlow: null,
    hireSummary: null,
    treasury: null,
    allocation: null,
    view: 'worker',
    busy: false,
    error: null,
    hire: {
      open: false,
      jobDescription: '',
      projectPath: '',
      projectTouched: false,
      attachments: [],
      startedAt: null,
      error: null,
    },
    revise: {},
    draftSeq: 0,
  });
});

/// `reload` fans out over two channels, so a per-call queue would depend on
/// the order Promise.all happens to resolve them in. Answer by channel.
function mockChannels(rows: unknown[], treasury: unknown): void {
  mockInvoke.mockImplementation(async (channel: string) => (channel === 'workers:treasury' ? treasury : rows));
}

describe('workersStore mirror', () => {
  it('reload lands workers, nextShiftAt, scorecards and the treasury keyed by id', async () => {
    mockChannels(
      [
        {
          worker: makeWorker(),
          nextShiftAt: 123,
          scorecard: makeScorecard({ proposed: 2 }),
        },
      ],
      {
        treasury: { monthlyUSD: 40 },
        allocation: allocateTreasury([makeWorker()], () => 0, 40),
      },
    );
    await useWorkersStore.getState().reload();
    const s = useWorkersStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.workers['worker-1'].name).toBe('Scout');
    expect(s.nextShiftAt['worker-1']).toBe(123);
    expect(s.scorecards['worker-1'].proposed).toBe(2);
    expect(s.treasury).toEqual({ monthlyUSD: 40 });
    expect(s.allocation?.byWorker[0]).toMatchObject({
      workerId: 'worker-1',
      availableUSD: 20,
    });
  });

  it('openWorkerDesk arrives on the desk, dropping a draft and run that would cover it', () => {
    const worker = makeWorker({ id: 'b', name: 'B' });
    useFlowsStore.setState({ activeRunId: 'run-1' });
    useWorkersStore.setState({
      workers: { 'worker-1': makeWorker(), b: worker },
      selectedWorkerId: 'worker-1',
      view: 'funds',
      draft: draftFromWorker(makeWorker()),
      deskFocus: { workerId: 'worker-1', orchestrationId: 'orch-1', at: 5 },
    });

    useWorkersStore.getState().openWorkerDesk('b');

    const s = useWorkersStore.getState();
    expect(s.selectedWorkerId).toBe('b');
    expect(s.view).toBe('worker');
    expect(s.draft).toBeNull();
    expect(s.deskFocus).toBeNull();
    expect(useFlowsStore.getState().activeRunId).toBeNull();
  });

  it('moveWorker re-prices the roster locally so the money moves with the row', async () => {
    const first = makeWorker({
      id: 'a',
      name: 'A',
      order: 0,
      budgetUSDPerMonth: 10,
    });
    const second = makeWorker({
      id: 'b',
      name: 'B',
      order: 1,
      budgetUSDPerMonth: 10,
    });
    mockInvoke.mockResolvedValue({ ok: true });
    useWorkersStore.setState({
      workers: { a: first, b: second },
      treasury: { monthlyUSD: 10 },
      // Only the top of the roster is funded — $10 between two $10 caps.
      allocation: allocateTreasury([first, second], () => 0, 10),
    });

    await useWorkersStore.getState().moveWorker('b', -1);

    const alloc = useWorkersStore.getState().allocation!;
    expect(alloc.byWorker.map((f) => f.workerId)).toEqual(['b', 'a']);
    // Not waiting on main's echo: B is funded the moment it is on top.
    expect(alloc.byWorker.map((f) => f.availableUSD)).toEqual([10, 0]);
    expect(mockInvoke).toHaveBeenCalledWith('workers:reorder', {
      ids: ['b', 'a'],
    });
  });

  it('dropWorker lands a row at an arbitrary slot and re-prices from there', async () => {
    const a = makeWorker({
      id: 'a',
      name: 'A',
      order: 0,
      budgetUSDPerMonth: 10,
    });
    const b = makeWorker({
      id: 'b',
      name: 'B',
      order: 1,
      budgetUSDPerMonth: 10,
    });
    const c = makeWorker({
      id: 'c',
      name: 'C',
      order: 2,
      budgetUSDPerMonth: 10,
    });
    mockInvoke.mockResolvedValue({ ok: true });
    useWorkersStore.setState({
      workers: { a, b, c },
      treasury: { monthlyUSD: 10 },
      allocation: allocateTreasury([a, b, c], () => 0, 10),
    });

    // Dropped in the gap above A — the whole point of dragging over nudging:
    // last to first without passing through every slot between.
    await useWorkersStore.getState().dropWorker('c', 0);

    const alloc = useWorkersStore.getState().allocation!;
    expect(alloc.byWorker.map((f) => f.workerId)).toEqual(['c', 'a', 'b']);
    expect(alloc.byWorker.map((f) => f.availableUSD)).toEqual([10, 0, 0]);
    expect(mockInvoke).toHaveBeenCalledWith('workers:reorder', {
      ids: ['c', 'a', 'b'],
    });
  });

  it('surfaces a rejected pot instead of pretending it landed', async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      error: 'The monthly pool has to be more than zero.',
    });
    await expect(useWorkersStore.getState().setTreasury(0)).resolves.toBe(false);
    expect(useWorkersStore.getState().error).toContain('more than zero');
  });

  it('lands a distributed roster and allocation from main together', async () => {
    const first = makeWorker({ id: 'a', name: 'A', budgetUSDPerMonth: 10 });
    const second = makeWorker({ id: 'b', name: 'B', budgetUSDPerMonth: 10 });
    const updated = [
      { ...first, budgetUSDPerMonth: 25 },
      { ...second, budgetUSDPerMonth: 25 },
    ];
    const allocation = allocateTreasury(updated, () => 0, 50);
    mockInvoke.mockResolvedValue({
      ok: true,
      workers: updated,
      treasury: { monthlyUSD: 50 },
      allocation,
    });
    useWorkersStore.setState({ workers: { a: first, b: second } });

    await expect(useWorkersStore.getState().distributeFunds()).resolves.toBe(true);

    expect(mockInvoke).toHaveBeenCalledWith('workers:distributeFunds');
    expect(useWorkersStore.getState().workers.a.budgetUSDPerMonth).toBe(25);
    expect(useWorkersStore.getState().workers.b.budgetUSDPerMonth).toBe(25);
    expect(useWorkersStore.getState().allocation).toEqual(allocation);
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
    useWorkersStore.setState({
      errandBusy: { 'worker-1': true },
      errandError: { 'worker-1': 'nope' },
      errandResult: {
        'worker-1': {
          orchestrationId: 'orch-1',
          count: 0,
          queued: 0,
          launchedNothing: true,
          reply: 'Nothing to do.',
        },
      },
    });
    s.removeLocal('worker-1');
    const after = useWorkersStore.getState();
    expect(after.workers['worker-1']).toBeUndefined();
    expect(after.nextShiftAt['worker-1']).toBeUndefined();
    expect(after.scorecards['worker-1']).toBeUndefined();
    expect(after.shiftProgress['worker-1']).toBeUndefined();
    expect(after.errandBusy['worker-1']).toBeUndefined();
    expect(after.errandError['worker-1']).toBeUndefined();
    expect(after.errandResult['worker-1']).toBeUndefined();
  });

  it('shift progress tracks active/clear and streamed text', () => {
    const s = useWorkersStore.getState();
    s.setShiftActive('worker-1', true);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toEqual({
      text: '',
      tools: [],
      task: 'shift',
      warm: false,
    });
    s.applyShiftProgress('worker-1', 'investigating…', ['Read']);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toEqual({
      text: 'investigating…',
      tools: ['Read'],
      task: 'shift',
      warm: false,
    });
    s.setShiftActive('worker-1', false);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toBeUndefined();
  });

  it('labels a live turn by the entry point that started it', () => {
    // The user watched their own errand being planned under the banner
    // "Working a shift". Main knows which it is, so it says so.
    const s = useWorkersStore.getState();
    s.setShiftActive('worker-1', true, 'errand');
    expect(useWorkersStore.getState().shiftProgress['worker-1']?.task).toBe('errand');
    // Streamed text must not reset the label back to the default.
    s.applyShiftProgress('worker-1', 'checking…', []);
    expect(useWorkersStore.getState().shiftProgress['worker-1']?.task).toBe('errand');
  });

  it('carries whether the live turn resumed, so the desk can stop guessing', () => {
    // "Picking up where you left off…" used to be printed off a stored
    // session for today, which is true on turns that open cold.
    const s = useWorkersStore.getState();
    s.setShiftActive('worker-1', true, 'errand', true);
    expect(useWorkersStore.getState().shiftProgress['worker-1']?.warm).toBe(true);
    s.applyShiftProgress('worker-1', 'checking…', []);
    expect(useWorkersStore.getState().shiftProgress['worker-1']?.warm).toBe(true);
  });
});

describe('workersStore reset', () => {
  it('requests a full reset and clears local journal and errand residue', async () => {
    useWorkersStore.setState({
      journals: { 'worker-1': [{ id: 'j1' } as never] },
      errandBusy: { 'worker-1': false },
      errandSending: {
        'worker-1': [{ id: 'send-1', text: 'old errand', at: 1 }],
      },
      errandError: { 'worker-1': 'old error' },
      errandResult: {
        'worker-1': {
          orchestrationId: 'orch-1',
          count: 0,
          queued: 0,
          launchedNothing: true,
          reply: 'old reply',
        },
      },
    });
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      entries: 4,
      files: 6,
      shifts: 2,
      errands: 1,
      runs: 3,
    });

    await expect(useWorkersStore.getState().resetMemory('worker-1')).resolves.toEqual({
      entries: 4,
      files: 6,
      shifts: 2,
      errands: 1,
      runs: 3,
    });
    expect(mockInvoke).toHaveBeenCalledWith('workers:resetMemory', {
      id: 'worker-1',
    });
    const state = useWorkersStore.getState();
    expect(state.journals['worker-1']).toEqual([]);
    expect(state.errandBusy['worker-1']).toBeUndefined();
    expect(state.errandSending['worker-1']).toBeUndefined();
    expect(state.errandError['worker-1']).toBeUndefined();
    expect(state.errandResult['worker-1']).toBeUndefined();
  });
});

describe('workersStore errands', () => {
  it('dismisses both an errand reply and an errand error for the same worker', () => {
    useWorkersStore.setState({
      errandError: { 'worker-1': 'Monthly budget spent.' },
      errandResult: {
        'worker-1': {
          orchestrationId: 'orch-1',
          count: 0,
          queued: 0,
          launchedNothing: true,
          reply: 'Nothing suitable to launch.',
        },
      },
    });

    useWorkersStore.getState().clearErrand('worker-1');

    expect(useWorkersStore.getState().errandError['worker-1']).toBeUndefined();
    expect(useWorkersStore.getState().errandResult['worker-1']).toBeUndefined();
  });

  it('tracks per-worker busy/result/error state and can dismiss it', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      result: {
        intent: 'work',
        orchestrationId: 'orch-1',
        count: 2,
        queued: 1,
        launchedNothing: false,
        reply: 'Planned.',
      },
    });
    const task = useWorkersStore.getState().runErrand('worker-1', 'Investigate this.');
    expect(useWorkersStore.getState().errandBusy['worker-1']).toBe(true);
    expect(useWorkersStore.getState().errandSending['worker-1'][0]).toMatchObject({
      text: 'Investigate this.',
    });
    await expect(task).resolves.toBe(true);
    expect(useWorkersStore.getState().errandBusy['worker-1']).toBe(false);
    expect(useWorkersStore.getState().errandResult['worker-1']).toMatchObject({
      count: 2,
      queued: 1,
    });
    expect(mockInvoke).toHaveBeenCalledWith('workers:runErrand', {
      id: 'worker-1',
      instruction: 'Investigate this.',
    });

    useWorkersStore.getState().clearErrand('worker-1');
    expect(useWorkersStore.getState().errandResult['worker-1']).toBeUndefined();

    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: 'Monthly budget spent.',
    });
    await expect(useWorkersStore.getState().runErrand('worker-1', 'Try again.')).resolves.toBe(false);
    expect(useWorkersStore.getState().errandError['worker-1']).toBe('Monthly budget spent.');
    useWorkersStore.getState().clearErrand('worker-1');
    expect(useWorkersStore.getState().errandError['worker-1']).toBeUndefined();
  });
});

describe('workersStore save', () => {
  it('persists a riding-along flow first and wires it into an empty flowIds', async () => {
    useWorkersStore.setState({
      draft: {
        ...newWorkerDraft('/repo'),
        name: 'Scout',
        jobDescription: 'x'.repeat(30),
        flowIds: [],
      },
      draftedFlow: makeFlow(),
    });
    mockInvoke
      .mockResolvedValueOnce({ ok: true }) // flows:save
      .mockResolvedValueOnce([]) // flows:list
      .mockResolvedValueOnce({ ok: true, worker: makeWorker() }); // workers:save
    const ok = await useWorkersStore.getState().save(['/repo']);
    expect(ok).toBe(true);
    expect(mockInvoke.mock.calls[0][0]).toBe('flows:save');
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ target: 'user' });
    expect(mockInvoke.mock.calls[2][0]).toBe('workers:save');
    expect(mockInvoke.mock.calls[2][1].worker.flowIds).toEqual(['drafted-flow']);
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ok: true, worker: makeWorker() });
    await useWorkersStore.getState().save(['/repo']);
    expect(mockInvoke.mock.calls[2][1].worker.flowIds).toEqual(['drafted-flow']);
  });

  it('reloads the flow library so panes see the revised flow, not its old self', async () => {
    useFlowsStore.setState({ flows: [makeFlow({ name: 'Drafted Flow' })] });
    useWorkersStore.setState({
      draft: { ...newWorkerDraft('/repo'), flowIds: ['drafted-flow'] },
      draftedFlow: makeFlow({ name: 'Revised Flow' }),
    });
    mockInvoke
      .mockResolvedValueOnce({ ok: true }) // flows:save
      .mockResolvedValueOnce([makeFlow({ name: 'Revised Flow' })]) // flows:list
      .mockResolvedValueOnce({ ok: true, worker: makeWorker() }); // workers:save
    await useWorkersStore.getState().save(['/repo']);
    expect(mockInvoke.mock.calls[1]).toEqual(['flows:list', { projectPaths: ['/repo'] }]);
    expect(useFlowsStore.getState().flows.map((f) => f.name)).toEqual(['Revised Flow']);
  });

  it('a failed flow save blocks the worker save and surfaces the error', async () => {
    useWorkersStore.setState({
      draft: { ...newWorkerDraft('/repo'), flowIds: [] },
      draftedFlow: makeFlow(),
    });
    mockInvoke.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    const ok = await useWorkersStore.getState().save(['/repo']);
    expect(ok).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(useWorkersStore.getState().error).toBe('disk full');
    // The draft survives so nothing typed is lost.
    expect(useWorkersStore.getState().draft).not.toBeNull();
  });

  it('applyRevision patches the draft and parks the revised flow', () => {
    useWorkersStore.setState({ draft: newWorkerDraft('/repo') });
    useWorkersStore.getState().applyRevision({
      jobDescription: 'the new job',
      flow: makeFlow({ id: 'revised' }),
    });
    const s = useWorkersStore.getState();
    expect(s.draft?.jobDescription).toBe('the new job');
    expect(s.draftedFlow?.id).toBe('revised');
  });
});

describe('draft factories', () => {
  it('keeps new and historical workers conservative by default', () => {
    expect(newWorkerDraft('/repo').caps.allowExternalActions).toBe(false);
    expect(draftFromWorker(makeWorker()).caps.allowExternalActions).not.toBe(true);
  });

  it('draftFromWorker copies without sharing nested references', () => {
    const w = makeWorker({
      cadence: { kind: 'daily', time: '09:00', days: [1, 2] },
    });
    const d = draftFromWorker(w);
    (d.cadence as { days: number[] }).days.push(6);
    d.flowIds.push('other');
    expect(w.cadence).toEqual({ kind: 'daily', time: '09:00', days: [1, 2] });
    expect(w.flowIds).toEqual(['fix-it']);
  });

  it('draftFromPortable keeps only the flows this library can supply', () => {
    const shared: PortableWorker = {
      name: 'Release Nanny',
      jobDescription: 'Watch the release branch and report what is not green.',
      cadence: { kind: 'daily', time: '08:00' },
      caps: {
        maxItemsPerShift: 2,
        runIn: 'worktree',
        allowExternalActions: true,
      },
      budgetUSDPerMonth: 12,
      heartbeatModel: 'cheap',
      flowIds: ['here', 'gone'],
    };
    const d = draftFromPortable(shared, '/repo', ['here', 'unrelated']);
    expect(d).toMatchObject({
      name: 'Release Nanny',
      projectPath: '/repo',
      flowIds: ['here'],
      enabled: true,
    });
    // Nothing about the sender's employment came along.
    expect('id' in d).toBe(false);
    expect(d.caps.runIn).toBe('worktree');
    expect(d.caps.allowExternalActions).toBe(false);
  });

  it('draftFromPortable does not share nested references with the file it read', () => {
    const shared: PortableWorker = {
      name: 'N',
      jobDescription: 'Twenty characters of job description, at least.',
      cadence: { kind: 'daily', time: '08:00', days: [1, 2] },
      caps: { maxItemsPerShift: 2, runIn: 'worktree' },
      budgetUSDPerMonth: 12,
      heartbeatModel: 'cheap',
      flowIds: ['here'],
    };
    const d = draftFromPortable(shared, '/repo', ['here']);
    (d.cadence as { days: number[] }).days.push(6);
    expect(shared.cadence).toEqual({
      kind: 'daily',
      time: '08:00',
      days: [1, 2],
    });
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

describe('sharing a worker', () => {
  it('shareYaml hands back the document and the flows it could not embed', async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      yaml: 'kind: worker\n',
      filename: 'w.worker.yaml',
      missingFlowIds: ['gone'],
    });
    const res = await useWorkersStore.getState().shareYaml('worker-1');
    expect(res).toEqual({ yaml: 'kind: worker\n', missingFlowIds: ['gone'] });
    expect(useWorkersStore.getState().error).toBeNull();
  });

  it('shareYaml surfaces a failure instead of returning half a file', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: 'No such worker.' });
    expect(await useWorkersStore.getState().shareYaml('nope')).toBeNull();
    expect(useWorkersStore.getState().error).toBe('No such worker.');
  });

  it('shareToFile treats a dismissed dialog as neither a path nor an error', async () => {
    mockInvoke.mockResolvedValue({ ok: true, filePath: null });
    expect(await useWorkersStore.getState().shareToFile('worker-1')).toBeNull();
    expect(useWorkersStore.getState().error).toBeNull();
  });

  it('import opens the editor on the arriving worker, on this project', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'workers:importFromFile') {
        return {
          ok: true,
          worker: {
            name: 'Release Nanny',
            jobDescription: 'Watch the release branch and report what is not green.',
            cadence: { kind: 'daily', time: '08:00' },
            caps: { maxItemsPerShift: 2, runIn: 'worktree' },
            budgetUSDPerMonth: 12,
            heartbeatModel: 'cheap',
            flowIds: ['nightly-review'],
          },
          notes: {
            installedFlowIds: ['nightly-review'],
            reusedFlowIds: [],
            missingFlowIds: [],
            failedFlowIds: [],
          },
          summary: 'Added 1 flow to your library (nightly-review).',
        };
      }
      if (channel === 'flows:list') return [makeFlow({ id: 'nightly-review' })];
      return [];
    });

    const opened = await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: ['/repo'] });
    expect(opened).toBe(true);
    const s = useWorkersStore.getState();
    expect(s.draft).toMatchObject({
      name: 'Release Nanny',
      projectPath: '/repo',
      flowIds: ['nightly-review'],
    });
    // The editor's flow picker has to know about the flow that just arrived.
    expect(useFlowsStore.getState().flows.map((f) => f.id)).toContain('nightly-review');
    expect(s.hireSummary).toContain('Imported Release Nanny.');
    expect(s.hireSummary).toContain('nightly-review');
  });

  it('import starts the personalization scan on the arriving worker', async () => {
    mockInvoke.mockImplementation(async (channel: string, args: any) => {
      if (channel === 'workers:importFromFile') return importedNanny();
      if (channel === 'flows:list') return [makeFlow({ id: 'nightly-review' })];
      if (channel === 'workers:personalizeScan') {
        expect(args).toMatchObject({ name: 'Release Nanny', flowId: 'nightly-review' });
        return {
          ok: true,
          note: 'This worker names its owner in two places.',
          questions: [
            {
              key: 'digest_channel',
              label: 'Digest channel',
              found: '#eng-leads',
              question: 'Which channel?',
              answer: '#platform',
              fromProfile: true,
            },
          ],
        };
      }
      return [];
    });

    await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: ['/repo'] });
    // The scan is fired and not awaited, so let its promise settle.
    await Promise.resolve();
    await Promise.resolve();

    const p = useWorkersStore.getState().personalize!;
    expect(p.scanning).toBe(false);
    expect(p.workerName).toBe('Release Nanny');
    // Prefilled by main from the profile — the second import asks less.
    expect(p.questions[0]).toMatchObject({ answer: '#platform', fromProfile: true });
  });

  it('personalization routes the answers through the reviser and remembers them', async () => {
    const seen: Array<{ channel: string; args: any }> = [];
    mockInvoke.mockImplementation(async (channel: string, args: any) => {
      seen.push({ channel, args });
      if (channel === 'workers:importFromFile') return importedNanny();
      if (channel === 'flows:list') return [makeFlow({ id: 'nightly-review' })];
      if (channel === 'workers:personalizeScan') {
        return {
          ok: true,
          note: '',
          questions: [
            {
              key: 'digest_channel',
              label: 'Digest channel',
              found: '#eng-leads',
              question: 'Which channel?',
              answer: '',
            },
            { key: 'timezone', label: 'Timezone', found: 'PT', question: 'Which timezone?', answer: '' },
          ],
        };
      }
      if (channel === 'workers:rememberProfile') return { ok: true, profile: { facts: [] } };
      if (channel === 'workers:reviseFromPrompt') {
        return {
          ok: true,
          jobDescription: 'Watch the release branch and report to #platform.',
          note: 'Re-pointed the digest at #platform.',
        };
      }
      return [];
    });

    await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: ['/repo'] });
    await Promise.resolve();
    await Promise.resolve();

    useWorkersStore.getState().answerPersonalize('digest_channel', '#platform');
    // Left blank on purpose: an unanswered row must not reach the reviser.
    await useWorkersStore.getState().applyPersonalize();

    const revise = seen.find((c) => c.channel === 'workers:reviseFromPrompt')!;
    expect(revise.args.instruction).toContain('Digest channel: currently "#eng-leads" — mine is "#platform".');
    expect(revise.args.instruction).not.toContain('Timezone');

    // Remembered whatever the revision then did, so a failed turn doesn't
    // also lose what the user typed.
    const remember = seen.find((c) => c.channel === 'workers:rememberProfile')!;
    expect(remember.args.questions.find((q: any) => q.key === 'digest_channel').answer).toBe('#platform');

    const s = useWorkersStore.getState();
    expect(s.draft!.jobDescription).toContain('#platform');
    expect(s.personalize!.appliedNote).toContain('Re-pointed');
    expect(s.personalize!.applying).toBe(false);
  });

  it('personalizing with every row blank asks for nothing and runs no turn', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'workers:importFromFile') return importedNanny();
      if (channel === 'flows:list') return [makeFlow({ id: 'nightly-review' })];
      if (channel === 'workers:personalizeScan')
        return {
          ok: true,
          note: '',
          questions: [
            { key: 'timezone', label: 'Timezone', found: 'PT', question: 'Which timezone?', answer: '' },
          ],
        };
      return [];
    });
    await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: ['/repo'] });
    await Promise.resolve();
    await Promise.resolve();

    mockInvoke.mockClear();
    await useWorkersStore.getState().applyPersonalize();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(useWorkersStore.getState().personalize!.error).toContain('Answer at least one');
  });

  it('hiring as sent drops the panel and changes nothing', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'workers:importFromFile') return importedNanny();
      if (channel === 'flows:list') return [makeFlow({ id: 'nightly-review' })];
      if (channel === 'workers:personalizeScan')
        return {
          ok: true,
          note: '',
          questions: [
            { key: 'timezone', label: 'Timezone', found: 'PT', question: 'Which timezone?', answer: '' },
          ],
        };
      return [];
    });
    await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: ['/repo'] });
    await Promise.resolve();
    await Promise.resolve();

    const before = useWorkersStore.getState().draft!.jobDescription;
    useWorkersStore.getState().dismissPersonalize();
    expect(useWorkersStore.getState().personalize).toBeNull();
    expect(useWorkersStore.getState().draft!.jobDescription).toBe(before);
  });

  it('a dismissed import dialog opens no editor and reports no error', async () => {
    mockInvoke.mockResolvedValue({ ok: true, canceled: true });
    const opened = await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: [] });
    expect(opened).toBe(false);
    expect(useWorkersStore.getState().draft).toBeNull();
    expect(useWorkersStore.getState().error).toBeNull();
  });

  it('a file that will not parse leaves the roster alone and says why', async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      error: "That's a flow, not a worker.",
    });
    const opened = await useWorkersStore.getState().importFromFile({ projectPath: '/repo', projectPaths: [] });
    expect(opened).toBe(false);
    expect(useWorkersStore.getState().draft).toBeNull();
    expect(useWorkersStore.getState().error).toBe("That's a flow, not a worker.");
  });
});

/// Drafting a contract and revising a worker are minutes-long CLI turns, and
/// the screens they were launched from unmount on every tab switch. Both live
/// on the store precisely so leaving is free — these are the tests that the
/// leaving is actually free.
describe('hiring in the background', () => {
  const CONTRACT = {
    name: 'Scout',
    jobDescription: 'Find valuable maintenance work each morning and propose it.',
    cadence: { kind: 'daily' as const, time: '09:00' },
    maxItemsPerShift: 3,
    budgetUSDPerMonth: 20,
    heartbeatModel: 'cheap-model',
  };

  it('keeps the form and the in-flight turn when the screen is closed', async () => {
    let land: (v: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((r) => (land = r)));
    useWorkersStore.getState().openHire('/repo');
    useWorkersStore.getState().patchHire({ jobDescription: 'Watch the tickets.' });
    const task = useWorkersStore.getState().startHire();
    expect(useWorkersStore.getState().hire.startedAt).not.toBeNull();

    // The user walks away mid-draft: the screen goes, the turn stays.
    useWorkersStore.getState().closeHire();
    expect(useWorkersStore.getState().hire.open).toBe(false);
    expect(useWorkersStore.getState().hire.startedAt).not.toBeNull();
    expect(useWorkersStore.getState().hire.jobDescription).toBe('Watch the tickets.');

    land({ ok: true, contract: CONTRACT, summary: 'A ticket watcher.' });
    await task;
    // It landed in the editor with nobody watching.
    expect(useWorkersStore.getState().draft?.name).toBe('Scout');
    expect(useWorkersStore.getState().hireSummary).toBe('A ticket watcher.');
    expect(useWorkersStore.getState().hire.startedAt).toBeNull();
  });

  it('sends attached files with the job description', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      contract: CONTRACT,
      summary: '',
    });
    useWorkersStore.getState().openHire('/repo');
    useWorkersStore.getState().patchHire({
      jobDescription: 'Build what the spec says.',
      attachments: [
        {
          id: 'a1',
          mimeType: 'application/pdf',
          dataBase64: 'x',
          label: 'spec.pdf',
        },
      ],
    });
    await useWorkersStore.getState().startHire();
    expect(mockInvoke).toHaveBeenCalledWith('workers:draftFromPrompt', {
      jobDescription: 'Build what the spec says.',
      attachments: [
        {
          id: 'a1',
          mimeType: 'application/pdf',
          dataBase64: 'x',
          label: 'spec.pdf',
        },
      ],
    });
  });

  it('will not start a second draft while one is running', async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));
    useWorkersStore.getState().openHire('/repo');
    useWorkersStore.getState().patchHire({ jobDescription: 'Watch the tickets.' });
    void useWorkersStore.getState().startHire();
    await useWorkersStore.getState().startHire();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

describe('revising in the background', () => {
  it('applies a revision that lands after the editor was left and reopened', async () => {
    let land: (v: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((r) => (land = r)));
    useWorkersStore.getState().openEditor(newWorkerDraft('/repo'));
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    const task = useWorkersStore.getState().startRevise();
    expect(useWorkersStore.getState().revise.startedAt).not.toBeNull();

    land({
      ok: true,
      jobDescription: 'Twice daily now.',
      note: 'Cadence doubled.',
    });
    await task;
    expect(useWorkersStore.getState().draft?.jobDescription).toBe('Twice daily now.');
    expect(selectRevise(useWorkersStore.getState()).note).toBe('Cadence doubled.');
    expect(selectRevise(useWorkersStore.getState()).instruction).toBe('');
  });

  it('holds a revision that finishes while the editor is closed, and lands it on reopen', async () => {
    // Clicking any worker in the roster closes the editor, so this is the
    // ordinary way to wait out a revision — not an edge case.
    let land: (v: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((r) => (land = r)));
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    const task = useWorkersStore.getState().startRevise();

    useWorkersStore.getState().closeEditor();
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/other'), id: 'worker-2' });

    land({
      ok: true,
      jobDescription: 'Twice daily now.',
      note: 'Cadence doubled.',
    });
    await task;
    // Not on the worker that happens to be open…
    expect(useWorkersStore.getState().draft?.jobDescription).not.toBe('Twice daily now.');
    expect(useWorkersStore.getState().revise['worker-1']?.pending?.workerId).toBe('worker-1');

    // …and waiting for the one it was about.
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    expect(useWorkersStore.getState().draft?.jobDescription).toBe('Twice daily now.');
    expect(selectRevise(useWorkersStore.getState()).note).toMatch(/Cadence doubled/);
    // Applied, but still only on a DRAFT — so it stays held until it is saved.
    expect(selectRevise(useWorkersStore.getState()).pending?.applied).toBe(true);
  });

  it('keeps an applied-but-unsaved revision when the editor is left again', async () => {
    // The reported loss: the revision lands, you go and look at something
    // else without pressing Save, and the draft it lived on is dropped.
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      jobDescription: 'Twice daily now.',
      note: 'Cadence doubled.',
    });
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    await useWorkersStore.getState().startRevise();
    expect(useWorkersStore.getState().draft?.jobDescription).toBe('Twice daily now.');

    useWorkersStore.getState().closeEditor();
    // Still on the books, so the roster can say a revision is ready.
    expect(useWorkersStore.getState().revise['worker-1']?.pending?.workerId).toBe('worker-1');

    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    expect(useWorkersStore.getState().draft?.jobDescription).toBe('Twice daily now.');
    expect(selectRevise(useWorkersStore.getState()).note).toMatch(/never saved/);
  });

  it('lets go of a held revision once the worker is saved', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      jobDescription: 'Twice daily now.',
      note: 'Cadence doubled.',
    });
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    await useWorkersStore.getState().startRevise();

    mockInvoke.mockResolvedValueOnce({ ok: true });
    await useWorkersStore.getState().save([]);
    expect(useWorkersStore.getState().revise['worker-1']).toBeUndefined();
  });

  it('retries a revision whose turn is wedged rather than sitting on it', async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    void useWorkersStore.getState().startRevise();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // A second Apply while it is genuinely still running changes nothing…
    void useWorkersStore.getState().startRevise();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // …but one that has been "working" for eleven minutes is stuck, and
    // pressing Apply again has to actually do something.
    useWorkersStore.getState().patchRevise({ startedAt: Date.now() - 11 * 60_000 });
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));
    void useWorkersStore.getState().startRevise();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('lands on the same worker even after its editor was closed and reopened', async () => {
    let land: (v: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((r) => (land = r)));
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    const task = useWorkersStore.getState().startRevise();

    // Away and back to the same worker: reopening is not "moving on".
    useWorkersStore.getState().closeEditor();
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });

    land({
      ok: true,
      jobDescription: 'Twice daily now.',
      note: 'Cadence doubled.',
    });
    await task;
    expect(useWorkersStore.getState().draft?.jobDescription).toBe('Twice daily now.');
    expect(selectRevise(useWorkersStore.getState()).error).toBeNull();
  });

  it('sends attached files with the instruction', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, note: 'Done.' });
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), flowIds: ['fix-it'] });
    useWorkersStore.getState().patchRevise({
      instruction: 'Make the report look like this.',
      attachments: [{ id: 'a1', mimeType: 'image/png', dataBase64: 'x', label: 'shot.png' }],
    });
    await useWorkersStore.getState().startRevise();
    expect(mockInvoke).toHaveBeenCalledWith(
      'workers:reviseFromPrompt',
      expect.objectContaining({
        instruction: 'Make the report look like this.',
        attachments: [
          {
            id: 'a1',
            mimeType: 'image/png',
            dataBase64: 'x',
            label: 'shot.png',
          },
        ],
      }),
    );
  });
  it("keeps each worker's revision to its own editor", async () => {
    // Opening somebody else mid-revision used to show THEIR editor the other
    // worker's instruction and spinner.
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useWorkersStore.getState().patchRevise({ instruction: 'Work twice a day.' });
    void useWorkersStore.getState().startRevise();

    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/other'), id: 'worker-2' });
    const open = selectRevise(useWorkersStore.getState());
    expect(open.instruction).toBe('');
    expect(open.startedAt).toBeNull();
    // …while the first one is still going, under its own key.
    expect(useWorkersStore.getState().revise['worker-1'].startedAt).not.toBeNull();
  });
});

describe('working a shift by hand', () => {
  it('does not hold the editor busy while the shift plans', async () => {
    // `workers:workShiftNow` resolves when the WHOLE planning turn is done —
    // minutes. Holding the one app-wide busy flag across that disabled Save
    // on every worker's editor until the shift finished.
    let finish!: (v: { ok: true }) => void;
    mockInvoke.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const pending = useWorkersStore.getState().workShiftNow('worker-1');

    expect(useWorkersStore.getState().busy).toBe(false);
    // The one thing it does hold, so the button can't be clicked twice before
    // the engine announces the shift.
    expect(useWorkersStore.getState().shiftStarting['worker-1']).toBe(true);

    finish({ ok: true });
    await pending;
    expect(useWorkersStore.getState().shiftStarting['worker-1']).toBeUndefined();
  });

  it('releases the worker and reports the error when the shift is refused', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: 'A shift is already starting.',
    });
    await useWorkersStore.getState().workShiftNow('worker-1');
    expect(useWorkersStore.getState().shiftStarting['worker-1']).toBeUndefined();
    expect(useWorkersStore.getState().error).toBe('A shift is already starting.');
  });
});

describe('navigating away from what fills the pane', () => {
  // The Workers tab draws the editor, the hire screen and a worker's flow run
  // in place of its own screens, and checks for them BEFORE it reads `view` —
  // so a destination that only set `view` moved a variable nothing on screen
  // was looking at, and the click appeared to do nothing at all.
  beforeEach(() => {
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'worker-1' });
    useFlowsStore.setState({ activeRunId: 'run-1' });
  });

  it('closes the editor and drops the run when you ask for the funds pane', () => {
    useWorkersStore.getState().showFunds();
    expect(useWorkersStore.getState().view).toBe('funds');
    expect(useWorkersStore.getState().draft).toBeNull();
    expect(useFlowsStore.getState().activeRunId).toBeNull();
  });

  it('does the same for the calendar and the report', () => {
    useWorkersStore.getState().showCalendar();
    expect(useWorkersStore.getState().view).toBe('calendar');
    expect(useWorkersStore.getState().draft).toBeNull();

    useWorkersStore.getState().openEditor(newWorkerDraft('/repo'));
    useWorkersStore.getState().showReport();
    expect(useWorkersStore.getState().view).toBe('report');
    expect(useWorkersStore.getState().draft).toBeNull();
  });

  it('opens the picked worker rather than leaving you in the editor', () => {
    useWorkersStore.getState().selectWorker('worker-2');
    expect(useWorkersStore.getState().view).toBe('worker');
    expect(useWorkersStore.getState().selectedWorkerId).toBe('worker-2');
    expect(useWorkersStore.getState().draft).toBeNull();
  });

  it('counts a re-pick of the worker already on screen, so the pane can reset to its desk', () => {
    const before = useWorkersStore.getState().selectSeq;
    useWorkersStore.getState().selectWorker('worker-2');
    useWorkersStore.getState().selectWorker('worker-2');
    expect(useWorkersStore.getState().selectSeq).toBe(before + 2);
  });
});

describe('a hire that finished while the user was elsewhere', () => {
  /// The store reaches for localStorage directly; the Node test env has none.
  function stubStorage(): Map<string, string> {
    const box = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => box.get(k) ?? null,
      setItem: (k: string, v: string) => void box.set(k, v),
      removeItem: (k: string) => void box.delete(k),
    };
    return box;
  }

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).localStorage;
  });

  function landAHire() {
    useWorkersStore.getState().openEditor(
      { ...newWorkerDraft('/repo'), name: 'Scout', jobDescription: 'x'.repeat(30) },
      { draftedFlow: makeFlow(), hireSummary: 'My read on the job', fromHire: true },
    );
  }

  it('parks the draft when the editor closes instead of dropping it', () => {
    landAHire();
    useWorkersStore.getState().closeEditor();
    const { draft, pendingHire } = useWorkersStore.getState();
    expect(draft).toBeNull();
    // The expensive halves both survive: the contract and the drafted flow.
    expect(pendingHire?.draft.name).toBe('Scout');
    expect(pendingHire?.flow?.id).toBe('drafted-flow');
    expect(pendingHire?.summary).toBe('My read on the job');
  });

  it('parks the edits made in the editor, not the draft as it landed', () => {
    landAHire();
    useWorkersStore.getState().patchDraft({ name: 'Scout II' });
    useWorkersStore.getState().closeEditor();
    expect(useWorkersStore.getState().pendingHire?.draft.name).toBe('Scout II');
  });

  it('puts a parked hire back in the editor, flow and summary included', () => {
    landAHire();
    useWorkersStore.getState().closeEditor();
    useWorkersStore.getState().resumeHire();
    const st = useWorkersStore.getState();
    expect(st.draft?.name).toBe('Scout');
    expect(st.draftedFlow?.id).toBe('drafted-flow');
    expect(st.hireSummary).toBe('My read on the job');
    // Still a hire, so closing it a second time parks it again rather than
    // losing it on the second exit.
    expect(st.draftFromHire).toBe(true);
  });

  it('leaves an existing worker\'s editor unparked', () => {
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'w1', name: 'Nanny' });
    useWorkersStore.getState().closeEditor();
    expect(useWorkersStore.getState().pendingHire).toBeNull();
  });

  it('stops waiting once the worker is actually hired', async () => {
    landAHire();
    mockInvoke
      .mockResolvedValueOnce({ ok: true }) // flows:save
      .mockResolvedValueOnce([]) // flows:list
      .mockResolvedValueOnce({ ok: true, worker: makeWorker() }); // workers:save
    await useWorkersStore.getState().save(['/repo']);
    expect(useWorkersStore.getState().pendingHire).toBeNull();
    expect(useWorkersStore.getState().draftFromHire).toBe(false);
  });

  it('keeps someone else\'s parked hire when a different worker is saved', async () => {
    landAHire();
    useWorkersStore.getState().closeEditor();
    useWorkersStore.getState().openEditor({ ...newWorkerDraft('/repo'), id: 'w1', name: 'Nanny' });
    mockInvoke.mockResolvedValueOnce({ ok: true, worker: makeWorker() });
    await useWorkersStore.getState().save(['/repo']);
    expect(useWorkersStore.getState().pendingHire?.draft.name).toBe('Scout');
  });

  it('writes the parked hire to storage, so a reload is survivable too', () => {
    const box = stubStorage();
    landAHire();
    // Parked the moment the editor opens on it, not only when it closes: the
    // review screen is where a reload actually catches you.
    expect(JSON.parse(box.get('overcli.workers.pendingHire')!).draft.name).toBe('Scout');
    useWorkersStore.getState().discardPendingHire();
    expect(box.has('overcli.workers.pendingHire')).toBe(false);
  });

  it('reads a parked hire back when the store is created fresh', async () => {
    const box = stubStorage();
    landAHire();
    useWorkersStore.getState().closeEditor();
    const stored = box.get('overcli.workers.pendingHire')!;
    vi.resetModules();
    stubStorage().set('overcli.workers.pendingHire', stored);
    const reloaded = await import('./workersStore');
    expect(reloaded.useWorkersStore.getState().pendingHire?.draft.name).toBe('Scout');
  });

  it('discards on request — the explicit no closing the editor is not', () => {
    landAHire();
    useWorkersStore.getState().closeEditor();
    useWorkersStore.getState().discardPendingHire();
    expect(useWorkersStore.getState().pendingHire).toBeNull();
  });
});
