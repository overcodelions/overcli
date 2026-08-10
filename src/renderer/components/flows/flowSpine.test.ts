import { describe, it, expect } from 'vitest';
import { compactStepModel, flowSpineSummary, stepWrites } from './flowSpine';
import type { Flow, FlowStep } from '@shared/flows/schema';

function step(over: Partial<FlowStep> & { id: string }): FlowStep {
  return {
    participantId: 'primary',
    role: 'planner',
    inputs: ['user_prompt'],
    tools: [],
    output: `${over.id}.md`,
    ...over,
  } as FlowStep;
}

function flow(steps: FlowStep[], model = 'claude-opus-5'): Flow {
  return {
    id: 'f',
    name: 'F',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'P', backend: 'claude', model, kind: 'primary' },
    ],
    steps,
    source: 'user',
    filePath: '/tmp/f.yaml',
  };
}

describe('stepWrites', () => {
  it('is true when the permission mode pre-approves edits', () => {
    // These modes exist precisely so a step can write without asking, so
    // they settle it regardless of which tools are listed.
    expect(stepWrites(step({ id: 'a', permissionMode: 'bypassPermissions' }))).toBe(true);
    expect(stepWrites(step({ id: 'a', permissionMode: 'acceptEdits' }))).toBe(true);
  });

  it('is true for write-capable tools across backend naming conventions', () => {
    // Claude spells them Edit/Write/Bash; Ollama uses edit_file/run_shell.
    // Both have to be caught or the flow edits files unannounced.
    for (const tool of ['Edit', 'Write', 'Bash', 'edit_file', 'write_file', 'run_shell']) {
      expect(stepWrites(step({ id: 'a', tools: [tool] }))).toBe(true);
    }
  });

  it('is false for a genuinely read-only step', () => {
    expect(stepWrites(step({ id: 'a', tools: ['Read', 'Grep', 'Glob'] }))).toBe(false);
    expect(stepWrites(step({ id: 'a', tools: [] }))).toBe(false);
  });

  it('does not treat a default permission mode as permission to write', () => {
    expect(stepWrites(step({ id: 'a', permissionMode: 'default', tools: ['Read'] }))).toBe(false);
  });

  it('finds a write tool anywhere in the list, not just first', () => {
    expect(stepWrites(step({ id: 'a', tools: ['Read', 'Grep', 'Edit'] }))).toBe(true);
  });
});

describe('flowSpineSummary', () => {
  it('names the model when every step shares one', () => {
    const s = flowSpineSummary(flow([step({ id: 'a' }), step({ id: 'b' })]));
    expect(s).toBe('2 steps · opus 5 · read-only');
  });

  it('counts models instead of listing them when they differ', () => {
    // Steps resolve their model through the participant they reference, so
    // a mixed-model flow is two participants, not a per-step override.
    const f = flow([step({ id: 'a' }), step({ id: 'b', participantId: 'cheap' })]);
    f.participants.push({
      id: 'cheap',
      name: 'Sonnet',
      backend: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(flowSpineSummary(f)).toContain('2 models');
    expect(flowSpineSummary(f)).not.toContain('opus 5');
  });

  it('warns that files change when any step can write', () => {
    const f = flow([step({ id: 'a' }), step({ id: 'b', tools: ['Edit'] })]);
    expect(flowSpineSummary(f)).toContain('edits your files');
    expect(flowSpineSummary(f)).not.toContain('read-only');
  });

  it('counts critic loops and pluralises them', () => {
    const rebound = {
      critic: { backend: 'claude' as const, model: 'claude-sonnet-5' },
      mode: 'review' as const,
      maxIters: 3,
    };
    expect(flowSpineSummary(flow([step({ id: 'a', rebound })]))).toContain('1 critic loop');
    expect(
      flowSpineSummary(flow([step({ id: 'a', rebound }), step({ id: 'b', rebound })])),
    ).toContain('2 critic loops');
  });

  it('omits the loop segment entirely when there are none', () => {
    expect(flowSpineSummary(flow([step({ id: 'a' })]))).not.toContain('critic');
  });

  it('pluralises the step count', () => {
    expect(flowSpineSummary(flow([step({ id: 'a' })]))).toMatch(/^1 step ·/);
  });
});

describe('compactStepModel', () => {
  it('strips the claude prefix and restores dotted versions', () => {
    expect(compactStepModel(flow([step({ id: 'a' })], 'claude-opus-5'), step({ id: 'a' }))).toBe('opus 5');
    expect(
      compactStepModel(flow([step({ id: 'a' })], 'claude-sonnet-4-6'), step({ id: 'a' })),
    ).toBe('sonnet 4.6');
  });

  it('keeps a non-claude id as-is and drops an ollama tag suffix', () => {
    expect(compactStepModel(flow([step({ id: 'a' })], 'gpt-5.6-sol'), step({ id: 'a' }))).toBe(
      'gpt-5.6-sol',
    );
    expect(
      compactStepModel(flow([step({ id: 'a' })], 'qwen2.5-coder:14b'), step({ id: 'a' })),
    ).toBe('qwen2.5-coder');
  });
});
