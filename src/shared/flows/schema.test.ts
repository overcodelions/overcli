import { describe, expect, it } from 'vitest';
import {
  resolveStepModel,
  resolveStepParticipant,
  FLOW_USER_PROMPT_REF,
  DEFAULT_PARTICIPANT_ID,
} from './schema';
import type { Flow, FlowParticipant, FlowStep } from './schema';

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
