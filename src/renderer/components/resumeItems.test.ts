import { describe, expect, it } from 'vitest';

import type { Conversation, UUID } from '@shared/types';
import { resumeItems } from './resumeItems';

const NOW = 1_700_000_000_000;

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id: id as UUID,
    name: id,
    createdAt: NOW - 60_000,
    lastActiveAt: NOW - 60_000,
    totalCostUSD: 0,
    turnCount: 3,
    currentModel: '',
    permissionMode: 'default',
    primaryBackend: 'claude',
    ...patch,
  } as Conversation;
}

describe('resumeItems', () => {
  it('orders by last activity, newest first', () => {
    const items = resumeItems(
      [conv('old', { lastActiveAt: NOW - 3_600_000 }), conv('new', { lastActiveAt: NOW - 1_000 })],
      {},
      NOW,
    );
    expect(items.map((i) => i.conv.id)).toEqual(['new', 'old']);
  });

  it('floats a running conversation whose turn was sent long ago', () => {
    const items = resumeItems(
      [conv('chat', { lastActiveAt: NOW - 60_000 }), conv('busy', { lastActiveAt: NOW - 1_800_000 })],
      { ['busy' as UUID]: { isRunning: true } },
      NOW,
    );
    expect(items.map((i) => i.conv.id)).toEqual(['busy', 'chat']);
    expect(items[0].state).toBe('running');
  });

  it('marks an unacknowledged completion as finished', () => {
    const [item] = resumeItems([conv('done')], { ['done' as UUID]: { isRunning: false, completedAt: NOW } }, NOW);
    expect(item.state).toBe('finished');
  });

  it('drops hidden conversations and never-used shells', () => {
    const items = resumeItems(
      [conv('kept'), conv('archived', { hidden: true }), conv('shell', { turnCount: 0 })],
      {},
      NOW,
    );
    expect(items.map((i) => i.conv.id)).toEqual(['kept']);
  });

  it('keeps a running shell — the first turn is in flight', () => {
    const items = resumeItems([conv('shell', { turnCount: 0 })], { ['shell' as UUID]: { isRunning: true } }, NOW);
    expect(items.map((i) => i.conv.id)).toEqual(['shell']);
  });
});
