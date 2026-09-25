import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diagnostics', () => ({ log: vi.fn() }));

import {
  recordMcpSeen,
  recordMcpSeenFromEvent,
  seenMcpServers,
  seenMcpTools,
  setMcpSeenFileForTests,
} from './mcpToolCache';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-seen-'));
  setMcpSeenFileForTests(path.join(dir, 'seen.json'));
});

afterEach(() => {
  setMcpSeenFileForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mcpToolCache', () => {
  it('records connected servers and MCP tools only', () => {
    recordMcpSeen(
      [
        { name: 'claude.ai Gmail', status: 'connected' },
        { name: 'aws', status: 'failed' },
      ],
      ['Read', 'mcp__claude_ai_Gmail__search_threads'],
    );
    expect(seenMcpServers()).toEqual(['claude.ai Gmail']);
    expect(seenMcpTools()).toEqual(['mcp__claude_ai_Gmail__search_threads']);
  });

  it('merges rather than replaces, and survives a restart', () => {
    recordMcpSeen([{ name: 'claude.ai Gmail', status: 'connected' }], ['mcp__claude_ai_Gmail__get_thread']);
    // A narrowed turn reports less; that is not the user disconnecting Gmail.
    recordMcpSeen([{ name: 'atlassian', status: 'connected' }], []);
    setMcpSeenFileForTests(path.join(dir, 'seen.json'));
    expect(seenMcpServers()).toEqual(['atlassian', 'claude.ai Gmail']);
    expect(seenMcpTools()).toEqual(['mcp__claude_ai_Gmail__get_thread']);
  });

  it('forgets what nothing has reported for a month', () => {
    const then = Date.now() - 40 * DAY;
    recordMcpSeen([{ name: 'old', status: 'connected' }], ['mcp__old__list_things'], then);
    recordMcpSeen([{ name: 'new', status: 'connected' }], []);
    expect(seenMcpServers()).toEqual(['new']);
    expect(seenMcpTools()).toEqual([]);
  });

  it('never throws on an init event missing its lists', () => {
    expect(() =>
      recordMcpSeenFromEvent({
        type: 'stream',
        conversationId: 'c1',
        events: [{ kind: { type: 'systemInit', info: { sessionId: 's' } } }],
      } as never),
    ).not.toThrow();
    expect(seenMcpServers()).toEqual([]);
  });

  it('reads a Claude init event off the main event stream', () => {
    recordMcpSeenFromEvent({
      type: 'stream',
      conversationId: 'c1',
      events: [
        {
          kind: {
            type: 'systemInit',
            info: {
              sessionId: 's',
              model: 'm',
              cwd: '/',
              apiKeySource: 'none',
              tools: ['mcp__claude_ai_Google_Calendar__list_events'],
              slashCommands: [],
              mcpServers: [{ name: 'claude.ai Google Calendar', status: 'connected' }],
            },
          },
        },
      ],
    } as never);
    expect(seenMcpServers()).toEqual(['claude.ai Google Calendar']);
    expect(seenMcpTools()).toEqual(['mcp__claude_ai_Google_Calendar__list_events']);
  });
});
