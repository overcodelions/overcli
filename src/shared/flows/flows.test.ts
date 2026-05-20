// Phase 1 tests: schema round-trip, validation, role prompt resolution.
// The point of these is the on-disk YAML → typed Flow → back to YAML
// cycle stays faithful for the sample flow that drives the runtime, and
// that validation catches the broken-flow cases that callers rely on.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSystemPrompt } from './roles';
import { parseFlowYaml, serializeFlow } from './yaml';
import { reachableInputRefs, validateFlow } from './validation';
import type { Flow } from './schema';

const SAMPLE_PATH = join(__dirname, 'examples', 'solve-ticket.yaml');
const SAMPLE_YAML = readFileSync(SAMPLE_PATH, 'utf8');

function parseSample(): Flow {
  const flow = parseFlowYaml({
    yaml: SAMPLE_YAML,
    id: 'solve-ticket',
    source: 'user',
    filePath: SAMPLE_PATH,
  });
  if (!flow) throw new Error('failed to parse sample yaml');
  return flow;
}

describe('flow yaml round-trip', () => {
  it('parses the sample flow', () => {
    const flow = parseSample();
    expect(flow.name).toBe('Solve a ticket end-to-end');
    expect(flow.steps).toHaveLength(5);
    expect(flow.steps[0].id).toBe('plan');
    expect(flow.steps[0].role).toBe('planner');
    expect(flow.steps[0].model).toEqual({ backend: 'claude', model: 'claude-opus-4-7' });
    expect(flow.steps[0].rebound?.critic.model).toBe('claude-sonnet-4-6');
    expect(flow.steps[0].rebound?.maxIters).toBe(3);
  });

  it('preserves on_fail goto', () => {
    const flow = parseSample();
    const review = flow.steps[2];
    expect(review.onFail).toEqual({ action: 'goto', target: 'build', maxRetries: 2 });
  });

  it('preserves pause_before on shipper', () => {
    const flow = parseSample();
    expect(flow.steps[4].pauseBefore).toBe(true);
  });

  it('round-trips through serialize without losing structure', () => {
    const flow = parseSample();
    const out = serializeFlow(flow);
    const reparsed = parseFlowYaml({
      yaml: out,
      id: flow.id,
      source: flow.source,
      filePath: flow.filePath,
    });
    expect(reparsed).not.toBeNull();
    expect(reparsed!.name).toBe(flow.name);
    expect(reparsed!.steps).toHaveLength(flow.steps.length);
    for (let i = 0; i < flow.steps.length; i++) {
      expect(reparsed!.steps[i].id).toBe(flow.steps[i].id);
      expect(reparsed!.steps[i].output).toBe(flow.steps[i].output);
      expect(reparsed!.steps[i].role).toBe(flow.steps[i].role);
      // After serialize+reparse the step references its participant by id;
      // verify the resolved backend+model matches the original step's
      // model rather than expecting the legacy `step.model` field.
      const origStep = flow.steps[i];
      const origModel =
        origStep.model
        ?? flow.participants.find(p => p.id === origStep.participantId);
      const reparsedStep = reparsed!.steps[i];
      const reparsedParticipant = reparsed!.participants.find(
        (p) => p.id === reparsedStep.participantId,
      );
      expect(reparsedParticipant?.backend).toBe(origModel?.backend);
      expect(reparsedParticipant?.model).toBe(origModel?.model);
      expect(reparsedStep.inputs).toEqual(origStep.inputs);
      expect(reparsedStep.tools).toEqual(origStep.tools);
      expect(reparsedStep.pauseBefore ?? false).toBe(origStep.pauseBefore ?? false);
    }
  });

  it('accepts the compact "backend:model" string form for model', () => {
    const yaml = `
name: compact
input: user_prompt
steps:
  - id: only
    model: claude:claude-opus-4-7
    role: planner
    inputs: [user_prompt]
    tools: []
    output: out.md
`;
    const flow = parseFlowYaml({ yaml, id: 'c', source: 'user', filePath: '/tmp/c' });
    expect(flow?.steps[0].model).toEqual({ backend: 'claude', model: 'claude-opus-4-7' });
  });

  it('returns null on unparseable yaml', () => {
    const bad = parseFlowYaml({ yaml: ': :::', id: 'b', source: 'user', filePath: '/tmp/b' });
    // yaml is forgiving — accept either null or a Flow whose validation will fail.
    if (bad) {
      const v = validateFlow(bad);
      expect(v.ok).toBe(false);
    }
  });
});

describe('flow validation', () => {
  it('passes the sample flow', () => {
    const flow = parseSample();
    const result = validateFlow(flow);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  });

  it('rejects an unknown input ref', () => {
    const flow = parseSample();
    flow.steps[1].inputs = ['user_prompt', 'nonexistent.md'];
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.path === 'steps[1].inputs[1]')).toBe(true);
  });

  it('rejects an unknown goto target', () => {
    const flow = parseSample();
    flow.steps[2].onFail = { action: 'goto', target: 'does-not-exist', maxRetries: 2 };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.path === 'steps[2].onFail.target')).toBe(true);
  });

  it('rejects a flow with no step consuming user_prompt', () => {
    const flow = parseSample();
    flow.steps[0].inputs = []; // remove the user_prompt consumer
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.path === 'steps')).toBe(true);
  });

  it('rejects pause_before on the first step', () => {
    const flow = parseSample();
    flow.steps[0].pauseBefore = true;
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.path === 'steps[0].pauseBefore')).toBe(true);
  });

  it('rejects duplicate step ids', () => {
    const flow = parseSample();
    flow.steps[1].id = flow.steps[0].id;
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.path === 'steps[1].id')).toBe(true);
  });
});

describe('reachableInputRefs', () => {
  it('returns user_prompt for step 0 and accumulates outputs after', () => {
    const flow = parseSample();
    expect(reachableInputRefs(flow, 0)).toEqual(['user_prompt']);
    expect(reachableInputRefs(flow, 1)).toEqual(['user_prompt', 'plan.md']);
    expect(reachableInputRefs(flow, 2)).toEqual(['user_prompt', 'plan.md', 'diff']);
  });
});

describe('role prompts', () => {
  it('includes the artifact contract', () => {
    const sys = resolveSystemPrompt({ role: 'planner', outputName: 'plan.md' });
    expect(sys).toContain('PLANNER');
    expect(sys).toContain('<output name="plan.md">');
  });

  it('uses the override for custom role', () => {
    const sys = resolveSystemPrompt({
      role: 'custom',
      override: 'You are a haiku poet.',
      outputName: 'poem.md',
    });
    expect(sys).toContain('haiku poet');
    expect(sys).toContain('<output name="poem.md">');
  });
});
