import { describe, expect, it } from 'vitest';

import type { Flow } from './schema';
import {
  gotoCandidateStepIds,
  reachableInputRefs,
  stepHasTool,
  validateFlow,
} from './validation';

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants: [
      {
        id: 'primary',
        name: 'Claude Sonnet 4.6',
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        kind: 'primary',
      },
    ],
    steps: [
      {
        id: 'plan',
        participantId: 'primary',
        role: 'planner',
        inputs: ['user_prompt'],
        tools: ['Read'],
        output: 'plan.md',
      },
      {
        id: 'build',
        participantId: 'primary',
        role: 'implementer',
        inputs: ['plan.md'],
        tools: ['Read', 'Edit'],
        output: 'diff',
      },
      {
        id: 'review',
        participantId: 'primary',
        role: 'reviewer',
        inputs: ['diff'],
        tools: ['Read'],
        output: 'review.md',
      },
    ],
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
    ...overrides,
  };
}

describe('validateFlow', () => {
  it('rejects an empty name', () => {
    const result = validateFlow(makeFlow({ name: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a name containing only whitespace', () => {
    const result = validateFlow(makeFlow({ name: '   ' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a missing id', () => {
    const result = validateFlow(makeFlow({ id: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects an id that does not match the slug regex', () => {
    const result = validateFlow(makeFlow({ id: 'Bad Id' }));
    expect(result.ok).toBe(false);
  });

  it('rejects when input is not user_prompt', () => {
    const result = validateFlow(makeFlow({ input: 'ticket' as Flow['input'] }));
    expect(result.ok).toBe(false);
  });

  it('rejects when steps is empty', () => {
    const result = validateFlow(makeFlow({ steps: [] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a step with an empty id', () => {
    const flow = makeFlow();
    flow.steps[0].id = '';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a step id that does not match the slug regex', () => {
    const flow = makeFlow();
    flow.steps[0].id = 'Step 1';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a participant missing a backend', () => {
    const flow = makeFlow();
    flow.participants[0].backend = '' as Flow['participants'][number]['backend'];
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a participant missing a model', () => {
    const flow = makeFlow();
    flow.participants[0].model = '';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a participant using an unsupported premium model', () => {
    const flow = makeFlow();
    flow.participants[0].model = 'claude-fantasy-99';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a step referencing an unknown participant', () => {
    const flow = makeFlow();
    flow.steps[0].participantId = 'nope';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a custom role with no systemPromptOverride', () => {
    const flow = makeFlow();
    flow.steps[0].role = 'custom';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('accepts a custom role when systemPromptOverride is non-empty', () => {
    const flow = makeFlow();
    flow.steps[0].role = 'custom';
    flow.steps[0].systemPromptOverride = 'Do the planned work.';
    const result = validateFlow(flow);
    expect(result.ok).toBe(true);
  });

  it('rejects a step with an empty output', () => {
    const flow = makeFlow();
    flow.steps[0].output = '';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a step output containing forbidden characters', () => {
    const flow = makeFlow();
    flow.steps[0].output = 'has space.md';
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects a step that references an artifact produced by a later step', () => {
    const flow = makeFlow();
    flow.steps[0].inputs = ['review.md'];
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects rebound missing critic.model', () => {
    const flow = makeFlow();
    flow.steps[0].rebound = {
      critic: { backend: 'claude', model: '' },
      mode: 'review',
      maxIters: 1,
    };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects rebound with maxIters of 0', () => {
    const flow = makeFlow();
    flow.steps[0].rebound = {
      critic: { backend: 'claude', model: 'claude-opus-4-7' },
      mode: 'review',
      maxIters: 0,
    };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects on_fail goto missing target', () => {
    const flow = makeFlow();
    flow.steps[0].onFail = { action: 'goto', target: '', maxRetries: 1 };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('rejects on_fail goto maxRetries below 1', () => {
    const flow = makeFlow();
    flow.steps[0].onFail = { action: 'goto', target: 'build', maxRetries: 0 };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
  });

  it('accepts on_fail abort with no other fields', () => {
    const flow = makeFlow();
    flow.steps[0].onFail = { action: 'abort' };
    const result = validateFlow(flow);
    expect(result.ok).toBe(true);
  });

  it('allows two steps that produce the same artifact name', () => {
    const flow = makeFlow();
    flow.steps[1].output = 'plan.md';
    flow.steps[2].inputs = ['plan.md'];
    const result = validateFlow(flow);
    expect(result.ok).toBe(true);
  });
});

describe('reachableInputRefs', () => {
  it('returns just user_prompt for stepIndex 0', () => {
    expect(reachableInputRefs(makeFlow(), 0)).toEqual(['user_prompt']);
  });

  it('accumulates each prior step output in order', () => {
    expect(reachableInputRefs(makeFlow(), 2)).toEqual(['user_prompt', 'plan.md', 'diff']);
  });

  it('clamps an out-of-range stepIndex to the flow length', () => {
    expect(reachableInputRefs(makeFlow(), 99)).toEqual(['user_prompt', 'plan.md', 'diff', 'review.md']);
  });
});

describe('gotoCandidateStepIds', () => {
  it('returns every step id except the one at the supplied index', () => {
    expect(gotoCandidateStepIds(makeFlow(), 1)).toEqual(['plan', 'review']);
  });
});

describe('stepHasTool', () => {
  it('returns true when the tool id is in step.tools and false otherwise', () => {
    const step = makeFlow().steps[0];
    expect(stepHasTool(step, 'Read')).toBe(true);
    expect(stepHasTool(step, 'Bash')).toBe(false);
  });
});
