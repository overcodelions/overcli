import { describe, expect, it } from 'vitest';
import { flowRunClaims, isRunBusy } from './flowRunClaims';
import type { FlowRun, FlowRunState } from '../shared/flows/schema';

function run(over: Partial<FlowRun> & { id: string }): FlowRun {
  return {
    flowId: 'nightly-audit',
    flowSnapshot: { name: 'Nightly audit' },
    projectPath: '/proj',
    userPrompt: 'audit the release',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done', success: true },
    createdAt: 1_000,
    attempts: [],
    ...over,
  } as unknown as FlowRun;
}

describe('isRunBusy', () => {
  const cases: Array<[FlowRunState, boolean]> = [
    [{ kind: 'running', currentStepId: 's1' }, true],
    [{ kind: 'paused', nextStepId: 's2', reason: 'needsInput' }, true],
    [{ kind: 'paused', nextStepId: 's2', reason: 'failure' }, true],
    [{ kind: 'watching', watch: {} as never }, true],
    [{ kind: 'done', success: true }, false],
    [{ kind: 'aborted' }, false],
    [{ kind: 'archived' }, false],
  ];
  for (const [state, expected] of cases) {
    it(`${state.kind} is ${expected ? 'busy' : 'idle'}`, () => {
      expect(isRunBusy({ state })).toBe(expected);
    });
  }

  it('counts a paused run as busy so its resumable work is never cleared', () => {
    // A run parked on a question still owns its tree and resumes into it.
    expect(isRunBusy({ state: { kind: 'paused', nextStepId: 's', reason: 'preStep' } })).toBe(true);
  });
});

describe('flowRunClaims', () => {
  it('claims a run worktree with its producer attached', () => {
    const claims = flowRunClaims([
      run({
        id: 'r1',
        worktreePath: '/wt/r1',
        workerId: 'w1',
        workerName: 'Release Warden',
        title: 'Shift #18',
      }),
    ]);
    expect(claims).toEqual([
      {
        worktreePath: '/wt/r1',
        kind: 'run',
        runId: 'r1',
        title: 'Shift #18',
        workerId: 'w1',
        workerName: 'Release Warden',
        flowId: 'nightly-audit',
        flowName: 'Nightly audit',
        scheduleName: undefined,
        busy: false,
        finished: true,
        activeAt: 1_000,
      },
    ]);
  });

  it('claims every member tree of a workspace run', () => {
    const claims = flowRunClaims([
      run({
        id: 'r2',
        worktreePath: '/wt/root',
        workspaceWorktrees: [
          { name: 'api', projectPath: '/api', worktreePath: '/wt/api', branchName: 'b' },
          { name: 'web', projectPath: '/web', worktreePath: '/wt/web', branchName: 'b' },
        ],
      }),
    ]);
    expect(claims.map((c) => c.worktreePath)).toEqual(['/wt/root', '/wt/api', '/wt/web']);
    expect(claims.every((c) => c.runId === 'r2')).toBe(true);
  });

  it('claims nothing for a run that has no tree', () => {
    // `checkedOutLocally` clears `worktreePath` once the tree is folded into
    // the main checkout — git already removed it, so there is nothing to claim.
    expect(flowRunClaims([run({ id: 'r3' })])).toEqual([]);
  });

  it('marks a running run busy', () => {
    const [claim] = flowRunClaims([
      run({ id: 'r4', worktreePath: '/wt/r4', state: { kind: 'running', currentStepId: 's' } }),
    ]);
    expect(claim.busy).toBe(true);
    expect(claim.finished).toBe(false);
  });

  it('dates a run by its last user turn, falling back to creation', () => {
    const [withTurn] = flowRunClaims([
      run({ id: 'r5', worktreePath: '/wt/r5', lastUserTurnAt: 9_000 }),
    ]);
    const [without] = flowRunClaims([run({ id: 'r6', worktreePath: '/wt/r6' })]);
    expect(withTurn.activeAt).toBe(9_000);
    expect(without.activeAt).toBe(1_000);
  });
});
