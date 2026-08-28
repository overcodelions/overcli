import { describe, expect, it } from 'vitest';

import type { Flow } from '../shared/flows/schema';
import { applyModelOverrides, workerIdFromName } from './run';

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: 'f',
    name: 'F',
    input: 'user_prompt',
    participants: [
      { id: 'planner', name: 'Planner', backend: 'claude', model: 'claude-sonnet-4-6' },
      { id: 'builder', name: 'Builder', backend: 'ollama', model: 'qwen2.5-coder' },
    ],
    steps: [
      { id: 's1', participantId: 'planner', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
    ],
    source: 'user',
    filePath: '/tmp/f.yaml',
    ...over,
  };
}

describe('workerIdFromName', () => {
  it('is stable, so a second CI run finds the first run’s journal', () => {
    expect(workerIdFromName('Release Nanny')).toBe(workerIdFromName('Release Nanny'));
  });

  it('slugs punctuation and case away', () => {
    expect(workerIdFromName('Release  Nanny!')).toBe('cli-release-nanny');
  });

  it('still produces an id for a name with nothing slug-able in it', () => {
    expect(workerIdFromName('!!!')).toBe('cli-worker');
  });
});

describe('applyModelOverrides', () => {
  it('is a no-op with no overrides, and does not copy the flow', () => {
    const f = flow();
    const out = applyModelOverrides(f, []);
    expect(out.flow).toBe(f);
    expect(out.changed).toEqual([]);
  });

  it('swaps every participant on the named backend', () => {
    const { flow: next, changed } = applyModelOverrides(flow(), [
      { from: 'ollama', to: 'claude:claude-sonnet-4-6' },
    ]);
    expect(next.participants.find((p) => p.id === 'builder')).toMatchObject({
      backend: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('builder');
  });

  it('leaves other participants alone', () => {
    const { flow: next } = applyModelOverrides(flow(), [{ from: 'ollama', to: 'claude:x' }]);
    expect(next.participants.find((p) => p.id === 'planner')).toMatchObject({
      backend: 'claude',
      model: 'claude-sonnet-4-6',
    });
  });

  it('does not mutate the flow it was given', () => {
    const f = flow();
    applyModelOverrides(f, [{ from: 'ollama', to: 'claude:x' }]);
    expect(f.participants.find((p) => p.id === 'builder')?.backend).toBe('ollama');
  });

  it('keeps the existing model when the override names a backend only', () => {
    const { flow: next } = applyModelOverrides(flow(), [{ from: 'ollama', to: 'claude' }]);
    expect(next.participants.find((p) => p.id === 'builder')).toMatchObject({
      backend: 'claude',
      model: 'qwen2.5-coder',
    });
  });
});
