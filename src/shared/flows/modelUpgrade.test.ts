import { describe, expect, it } from 'vitest';

import type { Flow, FlowStep } from './schema';
import {
  applyFlowModelUpgrade,
  isModelDerivedName,
  modelUpgradeSkipKey,
  pendingModelUpgrades,
  planFlowModelUpgrade,
  shortModelChangeLabel,
} from './modelUpgrade';

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

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: 'f',
    name: 'F',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'Claude Opus 5', backend: 'claude', model: 'claude-opus-5', kind: 'primary' },
      { id: 'local', name: 'Local', backend: 'ollama', model: 'qwen2.5-coder:32b', kind: 'worker' },
    ],
    steps: [
      step({ id: 'plan' }),
      step({
        id: 'build',
        participantId: 'local',
        rebound: {
          critic: { backend: 'claude', model: 'claude-sonnet-4-6' },
          mode: 'review',
          maxIters: 2,
        },
      }),
    ],
    source: 'user',
    filePath: '/tmp/f.yaml',
    ...over,
  };
}

describe('planFlowModelUpgrade', () => {
  it('finds every stale pin, participants and critics alike', () => {
    expect(planFlowModelUpgrade(flow())).toEqual([
      { backend: 'claude', from: 'claude-opus-5', to: 'claude-opus-5-5', where: ['Claude Opus 5'] },
      { backend: 'claude', from: 'claude-sonnet-4-6', to: 'claude-sonnet-5', where: ['build critic'] },
    ]);
  });

  it('groups one model used in several places into one change', () => {
    const f = flow({
      steps: [
        step({
          id: 'plan',
          rebound: { critic: { backend: 'claude', model: 'claude-opus-5' }, mode: 'review', maxIters: 1 },
        }),
      ],
    });
    const changes = planFlowModelUpgrade(f);
    expect(changes).toHaveLength(1);
    expect(changes[0].where).toEqual(['Claude Opus 5', 'plan critic']);
  });

  it('has nothing to say about a current flow or local models', () => {
    const f = flow({
      participants: [
        { id: 'primary', name: 'P', backend: 'claude', model: 'claude-opus-5-5' },
        { id: 'local', name: 'L', backend: 'ollama', model: 'qwen2.5-coder:7b' },
      ],
      steps: [step({ id: 'plan' })],
    });
    expect(planFlowModelUpgrade(f)).toEqual([]);
  });
});

describe('pendingModelUpgrades', () => {
  it('skips generated flows', () => {
    expect(pendingModelUpgrades([flow({ source: 'generated' })])).toEqual([]);
  });

  it('drops pairs the user declined, and the flow once nothing is left', () => {
    const f = flow();
    const [opus, sonnet] = planFlowModelUpgrade(f);
    const one = pendingModelUpgrades([f], [modelUpgradeSkipKey(f, opus)]);
    expect(one[0].changes.map((c) => c.from)).toEqual(['claude-sonnet-4-6']);
    const none = pendingModelUpgrades(
      [f],
      [modelUpgradeSkipKey(f, opus), modelUpgradeSkipKey(f, sonnet)],
    );
    expect(none).toEqual([]);
  });

  it('offers a declined model again once a newer target ships', () => {
    const f = flow();
    const stale = modelUpgradeSkipKey(f, { backend: 'claude', from: 'claude-opus-5', to: 'claude-opus-5-2' });
    expect(pendingModelUpgrades([f], [stale])[0].changes.map((c) => c.from)).toContain('claude-opus-5');
  });
});

describe('applyFlowModelUpgrade', () => {
  it('moves participants, legacy step models and critics', () => {
    const f = flow({
      steps: [
        step({ id: 'plan', model: { backend: 'claude', model: 'claude-opus-5' } }),
        flow().steps[1],
      ],
    });
    const out = applyFlowModelUpgrade(f, planFlowModelUpgrade(f));
    expect(out.participants[0].model).toBe('claude-opus-5-5');
    expect(out.participants[1]).toBe(f.participants[1]);
    expect(out.steps[0].model).toEqual({ backend: 'claude', model: 'claude-opus-5-5' });
    expect(out.steps[1].rebound?.critic.model).toBe('claude-sonnet-5');
    expect(out.steps[1].rebound?.maxIters).toBe(2);
  });

  it('renames a participant still wearing its default label, but not a custom one', () => {
    const f = flow({
      participants: [
        { id: 'primary', name: 'Claude Opus 5', backend: 'claude', model: 'claude-opus-5' },
        { id: 'critic', name: 'Grumpy reviewer', backend: 'claude', model: 'claude-opus-5' },
      ],
      steps: [step({ id: 'plan' })],
    });
    const out = applyFlowModelUpgrade(f, planFlowModelUpgrade(f));
    expect(out.participants.map((p) => p.name)).toEqual(['Claude Opus 5.5', 'Grumpy reviewer']);
  });

  it('only applies the changes it was handed', () => {
    const f = flow();
    const [, sonnet] = planFlowModelUpgrade(f);
    const out = applyFlowModelUpgrade(f, [sonnet]);
    expect(out.participants[0].model).toBe('claude-opus-5');
    expect(out.steps[1].rebound?.critic.model).toBe('claude-sonnet-5');
  });
});

describe('isModelDerivedName', () => {
  it('matches every spelling of a model label', () => {
    expect(isModelDerivedName('Claude Opus 4.8', 'claude', 'claude-opus-4-8')).toBe(true);
    expect(isModelDerivedName('Claude opus 4 8', 'claude', 'claude-opus-4-8')).toBe(true);
    expect(isModelDerivedName('claude-opus-4-8', 'claude', 'claude-opus-4-8')).toBe(true);
    expect(isModelDerivedName('GPT-5.6 Sol', 'codex', 'gpt-5.6-sol')).toBe(true);
  });

  it('matches a label a version behind its model', () => {
    // Dead-code finder: named for 4.7, lifted to 4.8 on load.
    expect(isModelDerivedName('Claude opus 4 7', 'claude', 'claude-opus-4-8')).toBe(true);
  });

  it('leaves names the user wrote', () => {
    expect(isModelDerivedName('Reviewer', 'claude', 'claude-opus-5')).toBe(false);
    expect(isModelDerivedName('Claude Opus', 'claude', 'claude-opus-5')).toBe(false);
    expect(isModelDerivedName('Claude Sonnet 4.6', 'claude', 'claude-opus-5')).toBe(false);
  });

  it('renames a stale auto-name on upgrade', () => {
    const f = flow({
      participants: [{ id: 'p', name: 'Claude opus 4 7', backend: 'claude', model: 'claude-opus-4-8' }],
      steps: [step({ id: 'plan', participantId: 'p' })],
    });
    expect(applyFlowModelUpgrade(f, planFlowModelUpgrade(f)).participants[0].name).toBe('Claude Opus 5.5');
  });
});

describe('shortModelChangeLabel', () => {
  it('says only what changes', () => {
    expect(shortModelChangeLabel({ backend: 'claude', from: 'claude-opus-5', to: 'claude-opus-5-5' })).toBe(
      'Opus 5 → 5.5',
    );
    expect(shortModelChangeLabel({ backend: 'claude', from: 'claude-opus-4-8', to: 'claude-opus-5-5' })).toBe(
      'Opus 4.8 → 5.5',
    );
    expect(
      shortModelChangeLabel({ backend: 'gemini', from: 'gemini-3.6-flash', to: 'gemini-3.7-flash' }),
    ).toBe('Gemini 3.6 Flash → 3.7 Flash');
  });
});
