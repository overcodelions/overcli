import { describe, it, expect } from 'vitest';
import { summarizeFlowChanges } from './flowRevisionSummary';
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

function flow(over: Partial<Flow> & { steps: FlowStep[] }): Flow {
  return {
    id: 'f',
    name: 'F',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'P', backend: 'claude', model: 'claude-opus-5', kind: 'primary' },
    ],
    source: 'user',
    filePath: '/tmp/f.yaml',
    ...over,
  };
}

describe('summarizeFlowChanges', () => {
  it('reports nothing when the flow came back identical', () => {
    const a = flow({ steps: [step({ id: 'plan' })] });
    expect(summarizeFlowChanges(a, flow({ steps: [step({ id: 'plan' })] }))).toEqual([]);
  });

  it('ignores key order and cleared-to-undefined fields', () => {
    // The live draft is built field by field and clears with `undefined`; a
    // revision is parsed fresh from YAML and just omits the key. Treating
    // those as different would flag every step as changed on every edit.
    const before = flow({ steps: [step({ id: 'plan', permissionMode: undefined })] });
    const after = flow({
      steps: [{ output: 'plan.md', id: 'plan', tools: [], role: 'planner', inputs: ['user_prompt'], participantId: 'primary' } as FlowStep],
    });
    expect(summarizeFlowChanges(before, after)).toEqual([]);
  });

  it('names added, removed, and changed steps', () => {
    const before = flow({ steps: [step({ id: 'plan' }), step({ id: 'ship' })] });
    const after = flow({
      steps: [step({ id: 'plan', tools: ['Read'] }), step({ id: 'review' })],
    });
    expect(summarizeFlowChanges(before, after)).toEqual([
      '1 step added (review)',
      '1 step removed (ship)',
      '1 step changed (plan)',
    ]);
  });

  it('does not call an insert a reorder', () => {
    // Inserting shifts every later step's position — reporting that as a
    // reorder on top of "1 step added" reads as two edits when there was one.
    const before = flow({ steps: [step({ id: 'plan' }), step({ id: 'ship' })] });
    const after = flow({
      steps: [step({ id: 'plan' }), step({ id: 'review' }), step({ id: 'ship' })],
    });
    expect(summarizeFlowChanges(before, after)).toEqual(['1 step added (review)']);
  });

  it('reports a genuine reorder of surviving steps', () => {
    const before = flow({ steps: [step({ id: 'plan' }), step({ id: 'ship' })] });
    const after = flow({ steps: [step({ id: 'ship' }), step({ id: 'plan' })] });
    expect(summarizeFlowChanges(before, after)).toEqual(['steps reordered']);
  });

  it('falls back to a coarse verdict when step ids repeat', () => {
    const dupe = flow({ steps: [step({ id: 'plan' }), step({ id: 'plan' })] });
    expect(summarizeFlowChanges(dupe, dupe)).toEqual([]);
    const after = flow({ steps: [step({ id: 'plan' }), step({ id: 'plan', tools: ['Read'] })] });
    expect(summarizeFlowChanges(dupe, after)).toEqual(['steps changed']);
  });

  it('reports header edits', () => {
    const before = flow({ steps: [step({ id: 'plan' })] });
    const after = flow({
      steps: [step({ id: 'plan' })],
      name: 'Renamed',
      description: 'now with a summary',
      tags: ['review'],
      defaultPrompt: 'the ticket url',
    });
    expect(summarizeFlowChanges(before, after)).toEqual([
      'renamed to "Renamed"',
      'description updated',
      'tags updated',
      'default prompt updated',
    ]);
  });

  it('mentions participants only when no step changed', () => {
    const before = flow({ steps: [step({ id: 'plan' })] });
    const recast: Flow['participants'] = [
      { id: 'primary', name: 'P', backend: 'codex', model: 'gpt-5.6-sol', kind: 'primary' },
    ];
    expect(summarizeFlowChanges(before, flow({ steps: [step({ id: 'plan' })], participants: recast })))
      .toEqual(['participants updated']);
    // With a step edit in the list, the cast change is already implied.
    expect(
      summarizeFlowChanges(
        before,
        flow({ steps: [step({ id: 'plan', tools: ['Read'] })], participants: recast }),
      ),
    ).toEqual(['1 step changed (plan)']);
  });
});
