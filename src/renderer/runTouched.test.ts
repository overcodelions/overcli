import { describe, expect, it } from 'vitest';

import type { FlowRun } from '@shared/flows/schema';
import type { Project } from '@shared/types';
import { runTouchedAtFrom } from './runTouched';

describe('runTouchedAtFrom', () => {
  it('takes the latest of your last message to any participant and when you last opened the run', () => {
    const projects = [
      { id: 'p', name: 'p', path: '/p', conversations: [{ id: 'c1', lastPromptAt: 50 }, { id: 'c2', lastPromptAt: 80 }] },
    ] as unknown as Project[];
    const touched = runTouchedAtFrom(projects, [], { r: 60 });
    expect(touched({ id: 'r', conversationIds: { planner: 'c1', builder: 'c2' } } as unknown as FlowRun)).toBe(80);
    expect(touched({ id: 'r', conversationIds: { planner: 'c1' } } as unknown as FlowRun)).toBe(60);
    expect(touched({ id: 'x', conversationIds: {} } as unknown as FlowRun)).toBe(0);
  });
});
