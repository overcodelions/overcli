import { describe, it, expect } from 'vitest';
import { flowInScope, scopeCounts, sortFlows } from './flowLibraryFilters';
import { flowStarKey, type Flow } from '@shared/flows/schema';

function flow(over: Partial<Flow> & { id: string }): Flow {
  return {
    name: over.id,
    input: 'user_prompt',
    participants: [],
    steps: [{ id: 'plan' }, { id: 'build' }] as Flow['steps'],
    source: 'user',
    filePath: `/u/flows/${over.id}.yaml`,
    ...over,
  };
}

describe('flowInScope', () => {
  it('puts an archived flow in archived only, not in all', () => {
    const f = flow({ id: 'shelved', archived: true });
    expect(flowInScope(f, 'archived', { starred: [], installed: undefined })).toBe(true);
    expect(flowInScope(f, 'all', { starred: [], installed: undefined })).toBe(false);
  });

  it('puts a generated flow in generated only, not in all or mine', () => {
    const f = flow({ id: 'auto', source: 'generated' });
    expect(flowInScope(f, 'generated', { starred: [], installed: undefined })).toBe(true);
    expect(flowInScope(f, 'all', { starred: [], installed: undefined })).toBe(false);
    expect(flowInScope(f, 'mine', { starred: [], installed: undefined })).toBe(false);
  });

  it('puts a starred flow in both starred and all', () => {
    const f = flow({ id: 'my-flow' });
    const opts = { starred: [flowStarKey(f)], installed: undefined };
    expect(flowInScope(f, 'starred', opts)).toBe(true);
    expect(flowInScope(f, 'all', opts)).toBe(true);
  });
});

describe('sortFlows', () => {
  it('puts the higher usage count first, ties fall back to name order', () => {
    const a = flow({ id: 'b-flow', name: 'B flow' });
    const b = flow({ id: 'a-flow', name: 'A flow' });
    const c = flow({ id: 'c-flow', name: 'C flow' });
    const usage = { 'b-flow': { count: 5, lastAt: 0 }, 'a-flow': { count: 5, lastAt: 0 } };
    const sorted = sortFlows([a, b, c], 'usage', usage);
    expect(sorted.map((f) => f.id)).toEqual(['a-flow', 'b-flow', 'c-flow']);
  });
});

describe('scopeCounts', () => {
  it('counts all/generated/archived correctly across a mixed list', () => {
    const mine = flow({ id: 'mine' });
    const generatedFlow = flow({ id: 'gen', source: 'generated' });
    const archivedFlow = flow({ id: 'arch', archived: true });
    const counts = scopeCounts([mine, generatedFlow, archivedFlow], {
      starred: [],
      installed: undefined,
      query: '',
      tags: new Set(),
    });
    expect(counts.all).toBe(1);
    expect(counts.generated).toBe(1);
    expect(counts.archived).toBe(1);
  });
});
