import { describe, expect, it } from 'vitest';

import type { Conversation } from '@shared/types';
import { byLatestPrompt } from './sidebarItems';

const conv = (id: string, fields: Partial<Conversation>) => ({ id, ...fields }) as Conversation;

describe('byLatestPrompt', () => {
  it('lifts a conversation continued today above newer ones left alone', () => {
    const order = byLatestPrompt([
      conv('new', { createdAt: 300, lastPromptAt: 300 }),
      conv('old-continued', { createdAt: 100, lastPromptAt: 500 }),
      conv('middle', { createdAt: 200, lastPromptAt: 200 }),
    ]);
    expect(order.map((c) => c.id)).toEqual(['old-continued', 'new', 'middle']);
  });

  it('falls back to activity, then creation, for ones that predate lastPromptAt', () => {
    const order = byLatestPrompt([
      conv('a', { createdAt: 100 }),
      conv('b', { createdAt: 50, lastActiveAt: 400 }),
    ]);
    expect(order.map((c) => c.id)).toEqual(['b', 'a']);
  });
});
