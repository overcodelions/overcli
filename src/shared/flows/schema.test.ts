import { describe, expect, it } from 'vitest';
import {
  flowProjectPath,
  isWorkerRun,
  flowRunTitle,
  resolveStepModel,
  resolveStepParticipant,
  FLOW_USER_PROMPT_REF,
  DEFAULT_PARTICIPANT_ID,
} from './schema';
import type { Flow, FlowParticipant, FlowRun, FlowStep } from './schema';

function makeParticipant(overrides: Partial<FlowParticipant> = {}): FlowParticipant {
  return {
    id: 'primary',
    name: 'Primary',
    backend: 'claude',
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

function makeStep(overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    id: 'plan',
    participantId: 'primary',
    role: 'planner',
    inputs: ['user_prompt'],
    tools: [],
    output: 'plan.md',
    ...overrides,
  };
}

function makeFlow(participants: FlowParticipant[], steps: FlowStep[]): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants,
    steps,
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
  };
}

describe('FLOW_USER_PROMPT_REF', () => {
  it('is the string "user_prompt"', () => {
    expect(FLOW_USER_PROMPT_REF).toBe('user_prompt');
  });
});

describe('DEFAULT_PARTICIPANT_ID', () => {
  it('is the string "primary"', () => {
    expect(DEFAULT_PARTICIPANT_ID).toBe('primary');
  });
});

describe('resolveStepModel', () => {
  it('returns backend+model from the matching participant', () => {
    const p = makeParticipant({ id: 'primary', backend: 'claude', model: 'claude-opus-4-7' });
    const step = makeStep({ participantId: 'primary' });
    const flow = makeFlow([p], [step]);
    expect(resolveStepModel(flow, step)).toEqual({ backend: 'claude', model: 'claude-opus-4-7' });
  });

  it('returns the correct participant when multiple participants exist', () => {
    const p1 = makeParticipant({ id: 'planner', backend: 'claude', model: 'claude-opus-4-7' });
    const p2 = makeParticipant({ id: 'worker', backend: 'ollama', model: 'qwen2.5-coder:7b' });
    const step = makeStep({ participantId: 'worker' });
    const flow = makeFlow([p1, p2], [step]);
    expect(resolveStepModel(flow, step)).toEqual({ backend: 'ollama', model: 'qwen2.5-coder:7b' });
  });

  it('falls back to step.model when participantId references an unknown participant', () => {
    const p = makeParticipant({ id: 'primary' });
    const step = makeStep({
      participantId: 'ghost',
      model: { backend: 'codex', model: 'gpt-5.4' },
    });
    const flow = makeFlow([p], [step]);
    expect(resolveStepModel(flow, step)).toEqual({ backend: 'codex', model: 'gpt-5.4' });
  });

  it('falls back to step.model when participants array is empty', () => {
    const step = makeStep({
      participantId: '',
      model: { backend: 'gemini', model: 'gemini-2.5-flash' },
    });
    const flow = makeFlow([], [step]);
    expect(resolveStepModel(flow, step)).toEqual({ backend: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('returns placeholder with empty model when neither participant nor step.model is set', () => {
    const step = makeStep({ participantId: 'ghost' });
    const flow = makeFlow([], [step]);
    const result = resolveStepModel(flow, step);
    expect(result.backend).toBe('claude');
    expect(result.model).toBe('');
  });
});

describe('resolveStepParticipant', () => {
  it('returns the matching participant by id', () => {
    const p = makeParticipant({ id: 'primary', name: 'Primary' });
    const step = makeStep({ participantId: 'primary' });
    const flow = makeFlow([p], [step]);
    expect(resolveStepParticipant(flow, step)).toEqual(p);
  });

  it('returns undefined when participantId is missing', () => {
    const p = makeParticipant();
    const step = makeStep({ participantId: '' });
    // coerce to satisfy TS — testing the runtime falsy path
    (step as FlowStep & { participantId: string }).participantId = '';
    const flow = makeFlow([p], [step]);
    expect(resolveStepParticipant(flow, step)).toBeUndefined();
  });

  it('returns undefined when participantId references a participant that does not exist', () => {
    const p = makeParticipant({ id: 'primary' });
    const step = makeStep({ participantId: 'nonexistent' });
    const flow = makeFlow([p], [step]);
    expect(resolveStepParticipant(flow, step)).toBeUndefined();
  });
});

// ─── flowRunTitle ────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<FlowRun> = {}): FlowRun {
  const flow = makeFlow([makeParticipant()], [makeStep()]);
  return {
    id: 'run-1' as FlowRun['id'],
    flowId: flow.id,
    flowSnapshot: flow,
    projectPath: '/repos/app',
    userPrompt: 'fix the login bug',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'running', currentStepId: 'plan' },
    createdAt: 0,
    attempts: [],
    ...overrides,
  };
}

describe('flowRunTitle', () => {
  it('prefers the user-supplied title', () => {
    expect(flowRunTitle(makeRun({ title: 'Login work' }))).toBe('Login work');
  });

  it('falls back to the first non-empty prompt line', () => {
    const run = makeRun({ userPrompt: '\n\n  fix the login bug  \nand the logout one' });
    expect(flowRunTitle(run)).toBe('fix the login bug');
  });

  it('ignores a blank title', () => {
    expect(flowRunTitle(makeRun({ title: '   ' }))).toBe('fix the login bug');
  });

  it('falls back to the flow name when the prompt is empty', () => {
    expect(flowRunTitle(makeRun({ userPrompt: '   \n  ' }))).toBe('Test Flow');
  });

  it('prefers the batch candidate headline over the raw prompt', () => {
    const run = makeRun({
      orchestrationItemTitle: 'Fix the flaky login test',
      userPrompt: 'A very long self-contained prompt that should never be the title.',
    });
    expect(flowRunTitle(run)).toBe('Fix the flaky login test');
  });

  it('shortens a long one-line prompt at its first sentence', () => {
    const run = makeRun({
      userPrompt:
        'Replace the leftover user-visible branding in the settings screen. All the strings are in i18n files and should be swapped one by one with careful review of every key.',
    });
    expect(flowRunTitle(run)).toBe(
      'Replace the leftover user-visible branding in the settings screen.',
    );
  });

  it('cuts a sentence-less prompt at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(40).trim();
    const title = flowRunTitle(makeRun({ userPrompt: long }));
    expect(title.length).toBeLessThanOrEqual(91);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('isWorkerRun', () => {
  it('classifies only runs attributed to a worker', () => {
    expect(isWorkerRun({ workerId: 'worker-1' })).toBe(true);
    expect(isWorkerRun({ workerId: undefined })).toBe(false);
  });
});

// ─── flowProjectPath ─────────────────────────────────────────────────────────

describe('flowProjectPath', () => {
  it('recovers the project dir from a project flow path', () => {
    expect(
      flowProjectPath({ source: 'project', filePath: '/repos/app/.overcli/flows/ship.yaml' }),
    ).toBe('/repos/app');
  });

  it('returns undefined for a user flow', () => {
    expect(
      flowProjectPath({ source: 'user', filePath: '/Users/me/Library/overcli/flows/ship.yaml' }),
    ).toBeUndefined();
  });

  it('returns undefined when a project flow path has an unexpected shape', () => {
    expect(flowProjectPath({ source: 'project', filePath: '/repos/app/ship.yaml' })).toBeUndefined();
  });
});
