import { afterEach, describe, expect, it, vi } from 'vitest';

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
  useWorkersStore,
} from './workersStore';
import { useFlowsStore } from './flowsStore';
import type { PortableWorker } from '@shared/flows/workerYaml';
import type { Worker, WorkerScorecard } from '@shared/flows/worker';
import { allocateTreasury } from '@shared/flows/treasury';
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
    errandBusy: {},
    errandSending: {},
    errandError: {},
    errandResult: {},
    draft: null,
    draftedFlow: null,
    hireSummary: null,
    treasury: null,
    allocation: null,
    view: 'worker',
    busy: false,
    error: null,
  });
});

/// `reload` fans out over two channels, so a per-call queue would depend on
/// the order Promise.all happens to resolve them in. Answer by channel.
function mockChannels(rows: unknown[], treasury: unknown): void {
  mockInvoke.mockImplementation(async (channel: string) =>
    channel === 'workers:treasury' ? treasury : rows,
  );
}

describe('workersStore mirror', () => {
  it('reload lands workers, nextShiftAt, scorecards and the treasury keyed by id', async () => {
    mockChannels(
      [{ worker: makeWorker(), nextShiftAt: 123, scorecard: makeScorecard({ proposed: 2 }) }],
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
    expect(s.allocation?.byWorker[0]).toMatchObject({ workerId: 'worker-1', availableUSD: 20 });
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
    const first = makeWorker({ id: 'a', name: 'A', order: 0, budgetUSDPerMonth: 10 });
    const second = makeWorker({ id: 'b', name: 'B', order: 1, budgetUSDPerMonth: 10 });
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
    expect(mockInvoke).toHaveBeenCalledWith('workers:reorder', { ids: ['b', 'a'] });
  });

  it('dropWorker lands a row at an arbitrary slot and re-prices from there', async () => {
    const a = makeWorker({ id: 'a', name: 'A', order: 0, budgetUSDPerMonth: 10 });
    const b = makeWorker({ id: 'b', name: 'B', order: 1, budgetUSDPerMonth: 10 });
    const c = makeWorker({ id: 'c', name: 'C', order: 2, budgetUSDPerMonth: 10 });
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
    expect(mockInvoke).toHaveBeenCalledWith('workers:reorder', { ids: ['c', 'a', 'b'] });
  });

  it('surfaces a rejected pot instead of pretending it landed', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: 'The monthly pool has to be more than zero.' });
    await expect(useWorkersStore.getState().setTreasury(0)).resolves.toBe(false);
    expect(useWorkersStore.getState().error).toContain('more than zero');
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
    });
    s.applyShiftProgress('worker-1', 'investigating…', ['Read']);
    expect(useWorkersStore.getState().shiftProgress['worker-1']).toEqual({
      text: 'investigating…',
      tools: ['Read'],
      task: 'shift',
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
});

describe('workersStore reset', () => {
  it('requests a full reset and clears local journal and errand residue', async () => {
    useWorkersStore.setState({
      journals: { 'worker-1': [{ id: 'j1' } as never] },
      errandBusy: { 'worker-1': false },
      errandSending: { 'worker-1': [{ id: 'send-1', text: 'old errand', at: 1 }] },
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
    expect(mockInvoke).toHaveBeenCalledWith('workers:resetMemory', { id: 'worker-1' });
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
        orchestrationId: 'orch-1',
        count: 2,
        queued: 1,
        launchedNothing: false,
        reply: 'Planned.',
      },
    });
    const task = useWorkersStore.getState().runErrand('worker-1', 'Investigate this.');
    expect(useWorkersStore.getState().errandBusy['worker-1']).toBe(true);
    await expect(task).resolves.toBe(true);
    expect(useWorkersStore.getState().errandBusy['worker-1']).toBe(false);
    expect(useWorkersStore.getState().errandResult['worker-1']).toMatchObject({ count: 2, queued: 1 });
    expect(mockInvoke).toHaveBeenCalledWith('workers:runErrand', {
      id: 'worker-1',
      instruction: 'Investigate this.',
    });

    useWorkersStore.getState().clearErrand('worker-1');
    expect(useWorkersStore.getState().errandResult['worker-1']).toBeUndefined();

    mockInvoke.mockResolvedValueOnce({ ok: false, error: 'Monthly budget spent.' });
    await expect(useWorkersStore.getState().runErrand('worker-1', 'Try again.')).resolves.toBe(false);
    expect(useWorkersStore.getState().errandError['worker-1']).toBe('Monthly budget spent.');
    useWorkersStore.getState().clearErrand('worker-1');
    expect(useWorkersStore.getState().errandError['worker-1']).toBeUndefined();
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
    useWorkersStore
      .getState()
      .applyRevision({ jobDescription: 'the new job', flow: makeFlow({ id: 'revised' }) });
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
    const w = makeWorker({ cadence: { kind: 'daily', time: '09:00', days: [1, 2] } });
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
      caps: { maxItemsPerShift: 2, runIn: 'worktree', allowExternalActions: true },
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
    expect(shared.cadence).toEqual({ kind: 'daily', time: '08:00', days: [1, 2] });
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

    const opened = await useWorkersStore
      .getState()
      .importFromFile({ projectPath: '/repo', projectPaths: ['/repo'] });
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

  it('a dismissed import dialog opens no editor and reports no error', async () => {
    mockInvoke.mockResolvedValue({ ok: true, canceled: true });
    const opened = await useWorkersStore
      .getState()
      .importFromFile({ projectPath: '/repo', projectPaths: [] });
    expect(opened).toBe(false);
    expect(useWorkersStore.getState().draft).toBeNull();
    expect(useWorkersStore.getState().error).toBeNull();
  });

  it('a file that will not parse leaves the roster alone and says why', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: "That's a flow, not a worker." });
    const opened = await useWorkersStore
      .getState()
      .importFromFile({ projectPath: '/repo', projectPaths: [] });
    expect(opened).toBe(false);
    expect(useWorkersStore.getState().draft).toBeNull();
    expect(useWorkersStore.getState().error).toBe("That's a flow, not a worker.");
  });
});
