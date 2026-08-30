// The exit code IS the CLI's contract with a pipeline. Nothing else it emits
// is load-bearing in the same way: a job reads the number and decides whether
// to retry, alert, or move on. `--json` is for a human reading the log
// afterwards.
//
// This maps every terminal run state to its code. The one worth understanding
// is `paused` -> 2: a run that stopped for a human is neither success nor
// failure, and a pipeline that treats it as failure will retry work that is
// sitting waiting for an approval.

import { describe, expect, it } from 'vitest';

import { useTestHost } from '../main/testHost';

useTestHost('/tmp/overcli-exitcode-tests');

import type { Flow, FlowRun } from '../shared/flows/schema';
import { EXIT, isWorkerFile, preflightFailure, summariseRun } from './run';

const flow: Flow = {
  id: 'f',
  name: 'F',
  input: 'user_prompt',
  participants: [{ id: 'p', name: 'P', backend: 'claude', model: 'm' }],
  steps: [{ id: 's1', participantId: 'p', role: 'planner', inputs: [], tools: ['Read'], output: 'o.md' }],
  source: 'user',
  filePath: '/tmp/f.yaml',
};

const base = {
  ok: false,
  kind: 'flow' as const,
  status: 'unstarted',
  exitCode: EXIT.BAD_INPUT,
  projectPath: '/repo',
  steps: [],
  artifacts: [],
  permissionDecisions: [],
  warnings: [],
};

function run(state: FlowRun['state'], over: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'r1',
    flowId: 'f',
    flowSnapshot: flow,
    projectPath: '/repo',
    userPrompt: '',
    conversationIds: {},
    artifacts: {},
    state,
    createdAt: 1,
    attempts: [],
    ...over,
  } as FlowRun;
}

function code(state: FlowRun['state'] | null, over: Partial<FlowRun> = {}) {
  return summariseRun({
    run: state ? run(state, over) : null,
    flow,
    summaryBase: base,
    decisions: [],
    warnings: [],
    runId: 'r1',
  });
}

describe('exit codes', () => {
  it('uses preflight code for staging and start failures', () => {
    expect(preflightFailure(base, { flowId: 'f' }, 'preflight-failed', 'stage').exitCode).toBe(EXIT.PREFLIGHT);
    expect(preflightFailure(base, { flowId: 'f' }, 'start-failed', 'start').exitCode).toBe(EXIT.PREFLIGHT);
  });
  it('uses preflight code and worker identity for shift failures', () => {
    const summary = preflightFailure(base, { workerId: 'w' }, 'shift-failed', 'shift');
    expect(summary.exitCode).toBe(EXIT.PREFLIGHT);
    expect(summary.workerId).toBe('w');
    expect(summary.flowId).toBeUndefined();
  });
  it('is 0 only when the run finished AND succeeded', () => {
    const s = code({ kind: 'done', success: true });
    expect(s.exitCode).toBe(EXIT.OK);
    expect(s.ok).toBe(true);
  });

  it('is 1 when the run finished and failed', () => {
    const s = code({ kind: 'done', success: false });
    expect(s.exitCode).toBe(EXIT.RUN_FAILED);
    expect(s.ok).toBe(false);
  });

  it('is 1 when the run was aborted', () => {
    expect(code({ kind: 'aborted' }).exitCode).toBe(EXIT.RUN_FAILED);
  });

  it('is 2 — not 1 — when the run needs a human', () => {
    // The distinction a pipeline acts on. Treating this as failure retries
    // work that is waiting for an approval.
    const s = code({ kind: 'paused', nextStepId: 's1', reason: 'externalAction' });
    expect(s.exitCode).toBe(EXIT.NEEDS_HUMAN);
    expect(s.status).toBe('paused:externalAction');
    expect(s.error).toContain('needs a human');
  });

  it('names the step it stopped at, so the log says where', () => {
    expect(code({ kind: 'paused', nextStepId: 's1', reason: 'riskyStep' }).error).toContain('s1');
  });

  it('is 5 when no terminal state was reached in time', () => {
    const s = code(null);
    expect(s.exitCode).toBe(EXIT.TIMEOUT);
    expect(s.status).toBe('timeout');
  });

  it('reports each step’s last attempt outcome', () => {
    const s = code({ kind: 'done', success: true }, {
      attempts: [
        { stepId: 's1', startedAt: 1, conversationId: 'c', outcome: 'error' },
        { stepId: 's1', startedAt: 2, conversationId: 'c', outcome: 'success' },
      ],
    } as Partial<FlowRun>);
    // The LAST attempt wins — a step that failed then succeeded on retry is a
    // step that succeeded.
    expect(s.steps).toEqual([{ id: 's1', status: 'success' }]);
  });

  it('marks a step that never ran rather than inventing a status', () => {
    expect(code({ kind: 'done', success: true }).steps).toEqual([{ id: 's1', status: 'not-run' }]);
  });

  it('always carries the runId, so a summary can be tied to its artifacts', () => {
    expect(code({ kind: 'done', success: true }).runId).toBe('r1');
  });
});

describe('isWorkerFile', () => {
  it('routes on the kind discriminator, not the filename', () => {
    expect(isWorkerFile('kind: worker\nname: X\n')).toBe(true);
    expect(isWorkerFile("kind: 'worker'\n")).toBe(true);
    expect(isWorkerFile('name: A flow\nsteps: []\n')).toBe(false);
  });

  it('does not match the word appearing elsewhere', () => {
    // A flow with a participant named "worker" is still a flow.
    expect(isWorkerFile('name: F\nparticipants:\n  - id: worker\n')).toBe(false);
  });
});
