import { describe, expect, it } from 'vitest';
import type { Flow, FlowParticipant, FlowRun, FlowStep } from '@shared/flows/schema';
import type { UUID } from '@shared/types';
import {
  flowConversationSources,
  focusedFlowConversationId,
  focusedParticipantId,
} from './flowFocus';

function participant(id: string, name = id): FlowParticipant {
  return { id, name, backend: 'claude', model: 'claude-sonnet-4-6' };
}

function step(id: string, participantId: string): FlowStep {
  return { id, participantId, role: 'planner', inputs: [], tools: [], output: `${id}.md` };
}

function run(over: Partial<FlowRun> = {}): FlowRun {
  const flow: Flow = {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants: [participant('primary', 'Primary'), participant('reviewer', 'Reviewer')],
    steps: [step('plan', 'primary'), step('check', 'reviewer')],
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
  };
  return {
    id: 'run-1' as UUID,
    flowId: flow.id,
    flowSnapshot: flow,
    projectPath: '/repos/app',
    userPrompt: 'fix the login bug',
    conversationIds: { primary: 'c-primary' as UUID, reviewer: 'c-reviewer' as UUID },
    artifacts: {},
    state: { kind: 'running', currentStepId: 'plan' },
    createdAt: 0,
    attempts: [],
    ...over,
  };
}

describe('focusedParticipantId', () => {
  it('follows the running step', () => {
    expect(focusedParticipantId(run({ state: { kind: 'running', currentStepId: 'check' } }))).toBe(
      'reviewer',
    );
  });

  it('follows the step a paused run would resume into', () => {
    const paused = run({ state: { kind: 'paused', nextStepId: 'check', reason: 'preStep' } });
    expect(focusedParticipantId(paused)).toBe('reviewer');
  });

  it('falls back to whoever ran last on a finished run', () => {
    const done = run({
      state: { kind: 'done', success: true },
      attempts: [{ stepId: 'plan' }, { stepId: 'check' }] as FlowRun['attempts'],
    });
    expect(focusedParticipantId(done)).toBe('reviewer');
  });

  it('is null when the run has not attempted a step', () => {
    expect(focusedParticipantId(run({ state: { kind: 'aborted' } }))).toBeNull();
  });

  it('is null when the focused step names a participant the snapshot lost', () => {
    expect(
      focusedParticipantId(run({ state: { kind: 'running', currentStepId: 'nonexistent' } })),
    ).toBeNull();
  });
});

describe('focusedFlowConversationId', () => {
  it('resolves the focused participant to its conversation', () => {
    expect(focusedFlowConversationId(run())).toBe('c-primary');
  });

  it('is null while the focused participant has yet to open one', () => {
    expect(focusedFlowConversationId(run({ conversationIds: {} }))).toBeNull();
  });
});

describe('flowConversationSources', () => {
  it('lists participants in declared order, named', () => {
    expect(flowConversationSources(run())).toEqual([
      { participantId: 'primary', name: 'Primary', conversationId: 'c-primary' },
      { participantId: 'reviewer', name: 'Reviewer', conversationId: 'c-reviewer' },
    ]);
  });

  it('omits participants that never opened a conversation', () => {
    const sources = flowConversationSources(run({ conversationIds: { reviewer: 'c-r' as UUID } }));
    expect(sources.map((s) => s.participantId)).toEqual(['reviewer']);
  });

  it('still lists a conversation whose participant is missing from the snapshot', () => {
    const sources = flowConversationSources(
      run({ conversationIds: { primary: 'c-p' as UUID, ghost: 'c-g' as UUID } }),
    );
    expect(sources.map((s) => s.name)).toEqual(['Primary', 'ghost']);
  });
});
