import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import type { Flow } from './schema';
import { parseFlowYaml, serializeFlow, yamlHasComments } from './yaml';

function parseInline(yaml: string) {
  return parseFlowYaml({
    yaml,
    id: 'test-flow',
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
  });
}

function minimalFlow(overrides: Partial<Flow> = {}): Flow {
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
        id: 'step_1',
        participantId: 'primary',
        role: 'planner',
        inputs: ['user_prompt'],
        tools: [],
        output: 'plan.md',
      },
    ],
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
    ...overrides,
  };
}

describe('parseFlowYaml', () => {
  it('returns null for a non-object YAML body', () => {
    expect(parseInline('hello')).toBeNull();
  });

  it('returns null for empty YAML', () => {
    expect(parseInline('')).toBeNull();
  });

  it('defaults missing step ids by index', () => {
    const flow = parseInline(`
name: Missing ids
steps:
  - model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    output: one.md
  - model: { backend: claude, model: claude-sonnet-4-6 }
    role: reviewer
    output: two.md
`);
    expect(flow?.steps.map(s => s.id)).toEqual(['step_1', 'step_2']);
  });

  it('maps system_prompt to systemPromptOverride', () => {
    const flow = parseInline(`
name: Prompts
steps:
  - id: with_prompt
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: custom
    system_prompt: Custom instructions
    output: custom.md
  - id: missing_prompt
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    output: missing.md
  - id: empty_prompt
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: custom
    system_prompt: "   "
    output: empty.md
`);
    expect(flow?.steps[0].systemPromptOverride).toBe('Custom instructions');
    expect(flow?.steps[1].systemPromptOverride).toBeUndefined();
    expect(flow?.steps[2].systemPromptOverride).toBeUndefined();
  });

  it('maps permission_mode to permissionMode', () => {
    const flow = parseInline(`
name: Permission
steps:
  - id: step
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    permission_mode: bypassPermissions
    output: plan.md
`);
    expect(flow?.steps[0].permissionMode).toBe('bypassPermissions');
  });

  it('maps pause_before to pauseBefore and defaults absent keys to false', () => {
    const flow = parseInline(`
name: Pause
steps:
  - id: paused
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    pause_before: true
    output: paused.md
  - id: unpaused
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: reviewer
    output: unpaused.md
`);
    expect(flow?.steps[0].pauseBefore).toBe(true);
    expect(flow?.steps[1].pauseBefore).toBe(false);
  });

  it('parses rebound.persona when set', () => {
    const flow = parseInline(`
name: Rebound
steps:
  - id: review
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    rebound:
      critic: { backend: claude, model: claude-opus-4-7 }
      mode: review
      max_iters: 2
      persona: rebound-reviewer
    output: plan.md
  - id: no_persona
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: reviewer
    rebound:
      critic: { backend: claude, model: claude-opus-4-7 }
    output: review.md
`);
    expect(flow?.steps[0].rebound?.persona).toBe('rebound-reviewer');
    expect(flow?.steps[1].rebound?.persona).toBeUndefined();
  });

  it('returns undefined for rebound when no critic.model is provided', () => {
    const flow = parseInline(`
name: Rebound
steps:
  - id: step
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    rebound:
      critic: { backend: claude }
    output: plan.md
`);
    expect(flow?.steps[0].rebound).toBeUndefined();
  });

  it('parses on_fail abort', () => {
    const flow = parseInline(`
name: Abort
steps:
  - id: step
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    on_fail: { action: abort }
    output: plan.md
`);
    expect(flow?.steps[0].onFail).toEqual({ action: 'abort' });
  });

  it('parses on_fail pause', () => {
    const flow = parseInline(`
name: Pause
steps:
  - id: step
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    on_fail: { action: pause }
    output: plan.md
`);
    expect(flow?.steps[0].onFail).toEqual({ action: 'pause' });
  });

  it('returns undefined for on_fail with an unknown action', () => {
    const flow = parseInline(`
name: Unknown
steps:
  - id: step
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    on_fail: { action: retry_forever }
    output: plan.md
`);
    expect(flow?.steps[0].onFail).toBeUndefined();
  });
});

describe('serializeFlow', () => {
  it('omits optional keys when their values are not set', () => {
    const obj = parse(serializeFlow(minimalFlow()));
    expect(obj).not.toHaveProperty('description');
    expect(obj.steps[0]).not.toHaveProperty('system_prompt');
    expect(obj.steps[0]).not.toHaveProperty('permission_mode');
    expect(obj.steps[0]).not.toHaveProperty('rebound');
    expect(obj.steps[0]).not.toHaveProperty('on_fail');
    expect(obj.steps[0]).not.toHaveProperty('pause_before');
  });

  it('emits pause_before when pauseBefore is true', () => {
    const flow = minimalFlow({
      steps: [{ ...minimalFlow().steps[0], pauseBefore: true }],
    });
    const obj = parse(serializeFlow(flow));
    expect(obj.steps[0].pause_before).toBe(true);
  });

  it('emits on_fail.action for an abort action', () => {
    const flow = minimalFlow({
      steps: [{ ...minimalFlow().steps[0], onFail: { action: 'abort' } }],
    });
    const obj = parse(serializeFlow(flow));
    expect(obj.steps[0].on_fail.action).toBe('abort');
  });
});

describe('yamlHasComments', () => {
  it('returns true for a YAML body starting with a comment line', () => {
    expect(yamlHasComments('# comment\nname: Test')).toBe(true);
  });

  it('returns true for an inline comment after a value', () => {
    expect(yamlHasComments('name: Test # comment')).toBe(true);
  });

  it('returns false for a YAML body with no comments', () => {
    expect(yamlHasComments('name: Test\nsteps: []')).toBe(false);
  });
});
