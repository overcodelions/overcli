import { describe, expect, it } from 'vitest';

import { validateFlowYaml } from './storage';

const VALID_YAML = `
name: Test Flow
input: user_prompt
steps:
  - id: plan
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    inputs: [user_prompt]
    tools: [Read]
    output: plan.md
`;

describe('validateFlowYaml', () => {
  it('returns a parsed flow for valid YAML', () => {
    const result = validateFlowYaml({ yaml: VALID_YAML, id: 'valid-flow' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.id).toBe('valid-flow');
      expect(result.flow.name).toBe('Test Flow');
    }
  });

  it('uses untitled when no id is provided', () => {
    const result = validateFlowYaml({ yaml: VALID_YAML });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.id).toBe('untitled');
    }
  });

  it('returns a parse error when YAML does not produce a flow object', () => {
    const result = validateFlowYaml({ yaml: 'hello', id: 'bad-flow' });
    expect(result).toEqual({
      ok: false,
      errors: [{ path: '', message: 'YAML failed to parse.' }],
    });
  });

  it('returns validation errors for an invalid parsed flow', () => {
    const result = validateFlowYaml({
      yaml: `
name: Invalid Flow
input: user_prompt
steps: []
`,
      id: 'invalid-flow',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.path === 'steps')).toBe(true);
    }
  });
});
