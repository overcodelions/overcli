import { describe, expect, it } from 'vitest';

import { addConversationEnv, conversationEnv } from './runEnv';

describe('conversationEnv', () => {
  it('adds what each extender gives a run, and skips one that throws', () => {
    const undoA = addConversationEnv((id) => ({ A: `a-${id}` }));
    const undoB = addConversationEnv(() => { throw new Error('broken'); });
    const undoC = addConversationEnv((id): Record<string, string> => (id === 'c1' ? { C: 'c' } : {}));
    try {
      expect(conversationEnv('c1')).toEqual({ A: 'a-c1', C: 'c' });
      expect(conversationEnv('c2')).toEqual({ A: 'a-c2' });
    } finally {
      undoA();
      undoB();
      undoC();
    }
    expect(conversationEnv('c1')).toEqual({});
  });
});
