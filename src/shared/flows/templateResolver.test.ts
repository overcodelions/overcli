// Verifies the template-to-user-environment rebinding logic. Each case
// parses a bundled template and asserts the participants come out
// pointing at sane models for a given backend mix.

import { describe, expect, it } from 'vitest';

import { FLOW_TEMPLATES } from './templates';
import { parseFlowYaml } from './yaml';
import { resolveTemplateForUser } from './templateResolver';

function loadTemplate(id: string) {
  const t = FLOW_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`missing template ${id}`);
  const flow = parseFlowYaml({ yaml: t.yaml, id, source: 'user', filePath: '' });
  if (!flow) throw new Error(`failed to parse ${id}`);
  return flow;
}

describe('resolveTemplateForUser — build-feature template', () => {
  // The design step is a planner — it uses claude-fable-5, classified
  // 'frontier', so it resolves to fable-5 (the only frontier claude model).
  // The sonnet models are classified 'fast' (so their tokens group under
  // the run token bar's "fast" tier). That makes both the build step (fast
  // worker) and the verify step (sonnet placeholder, also 'fast') resolve
  // to the first fast claude model — claude-sonnet-5, which precedes
  // sonnet-4.6 and haiku among the 'fast' models.
  it('only-claude user: design→fable (frontier), build+verify→sonnet-5 (first fast model)', () => {
    const flow = loadTemplate('build-feature');
    const resolved = resolveTemplateForUser(flow, {
      healthyBackends: ['claude'],
      ollamaModels: [],
    });
    const byStep = new Map(resolved.steps.map((s) => [s.id, s.participantId]));
    const byParticipant = new Map(resolved.participants.map((p) => [p.id, p]));

    expect(byParticipant.get(byStep.get('design')!)?.model).toBe('claude-fable-5');
    expect(byParticipant.get(byStep.get('build')!)?.model).toBe('claude-sonnet-5');
    expect(byParticipant.get(byStep.get('verify')!)?.model).toBe('claude-sonnet-5');
    for (const p of resolved.participants) {
      expect(p.backend).toBe('claude');
    }
  });

  it('claude + ollama user: build step uses local ollama model', () => {
    const flow = loadTemplate('build-feature');
    const resolved = resolveTemplateForUser(flow, {
      healthyBackends: ['claude', 'ollama'],
      ollamaModels: ['qwen2.5-coder:32b', 'llama3.3:70b'],
    });
    const buildStep = resolved.steps.find((s) => s.id === 'build')!;
    const buildParticipant = resolved.participants.find((p) => p.id === buildStep.participantId)!;
    expect(buildParticipant.backend).toBe('ollama');
    expect(buildParticipant.model).toBe('qwen2.5-coder:32b');
  });

  it('codex-only user: thinking→gpt-5.5, fast→gpt-5.4-mini', () => {
    const flow = loadTemplate('build-feature');
    const resolved = resolveTemplateForUser(flow, {
      healthyBackends: ['codex'],
      ollamaModels: [],
    });
    const byStep = new Map(resolved.steps.map((s) => [s.id, s.participantId]));
    const byParticipant = new Map(resolved.participants.map((p) => [p.id, p]));
    expect(byParticipant.get(byStep.get('design')!)?.model).toBe('gpt-5.5');
    expect(byParticipant.get(byStep.get('build')!)?.model).toBe('gpt-5.4-mini');
  });

  it('no healthy backends: leaves participants alone', () => {
    const flow = loadTemplate('build-feature');
    const before = JSON.parse(JSON.stringify(flow));
    const resolved = resolveTemplateForUser(flow, {
      healthyBackends: [],
      ollamaModels: [],
    });
    expect(resolved.participants).toEqual(before.participants);
  });

  it('ollama healthy but no installed models: falls back to premium fast', () => {
    const flow = loadTemplate('build-feature');
    const resolved = resolveTemplateForUser(flow, {
      healthyBackends: ['claude', 'ollama'],
      ollamaModels: [],
    });
    const buildStep = resolved.steps.find((s) => s.id === 'build')!;
    const buildParticipant = resolved.participants.find((p) => p.id === buildStep.participantId)!;
    expect(buildParticipant.backend).toBe('claude');
    // First fast claude model is sonnet-5 (precedes sonnet-4.6 and haiku
    // in PREMIUM_MODELS).
    expect(buildParticipant.model).toBe('claude-sonnet-5');
  });
});

describe('resolveTemplateForUser — friendly names updated', () => {
  it('renames participants to reflect the picked model', () => {
    const flow = loadTemplate('build-feature');
    const resolved = resolveTemplateForUser(flow, {
      healthyBackends: ['claude'],
      ollamaModels: [],
    });
    const names = resolved.participants.map((p) => p.name);
    // claude-only build-feature resolves to fable (frontier, design) +
    // sonnet-5 (fast) for the remaining steps; sonnet-4.6 and haiku are no
    // longer auto-picked because sonnet-5 precedes them among 'fast' models.
    expect(names).toContain('Claude Fable 5');
    expect(names).toContain('Claude Sonnet 5');
  });
});
