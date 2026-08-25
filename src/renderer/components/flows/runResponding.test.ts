import { describe, expect, it } from 'vitest';
import { runIsResponding } from './FlowRunSidebarRow';

describe('runIsResponding', () => {
  it('spins for a paused step whose participant is streaming', () => {
    // The reported bug: a paused run you are mid-conversation with showed
    // only ⏸, so the sidebar gave no sign that a reply was being written.
    expect(runIsResponding('paused', true)).toBe(true);
  });

  it('spins for a done run you are still chatting with', () => {
    expect(runIsResponding('done', true)).toBe(true);
  });

  it('leaves a quiet paused run on its paused badge', () => {
    expect(runIsResponding('paused', false)).toBe(false);
    expect(runIsResponding('done', false)).toBe(false);
  });

  it('is not what makes a running run spin', () => {
    // `running` has its own branch — this predicate is only about runs whose
    // resting badge would otherwise claim nothing is happening.
    expect(runIsResponding('running', true)).toBe(false);
  });

  it('never spins for states that ended for good', () => {
    expect(runIsResponding('aborted', true)).toBe(false);
    expect(runIsResponding('archived', true)).toBe(false);
  });
});
