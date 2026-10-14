import { describe, expect, it } from 'vitest';
import type { StreamEvent, ToolResultBlock, ToolUseBlock } from '@shared/types';
import { summarizeActivity, turnActivityByResult } from './TurnActivity';

const use = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({
  id,
  name,
  inputJSON: JSON.stringify(input),
});

function assistant(id: string, toolUses: ToolUseBlock[], reviewer = false): StreamEvent {
  return {
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    ...(reviewer ? { reviewer: { backend: 'codex' } } : {}),
    kind: { type: 'assistant', info: { text: '', thinking: [], toolUses, isPartial: false } },
  } as unknown as StreamEvent;
}

const result = (id: string): StreamEvent =>
  ({ id, timestamp: 0, raw: '', revision: 0, kind: { type: 'result', info: {} } }) as unknown as StreamEvent;
const user = (id: string): StreamEvent =>
  ({ id, timestamp: 0, raw: '', revision: 0, kind: { type: 'localUser', text: 'hi' } }) as unknown as StreamEvent;

describe('turnActivityByResult', () => {
  it("groups each closed turn's calls under its result, skipping reviewer calls", () => {
    const a = use('a', 'Read', { file_path: '/x' });
    const b = use('b', 'Bash', { command: 'npm test' });
    const r = use('r', 'Read', { file_path: '/y' });
    const map = turnActivityByResult([
      user('u1'),
      assistant('e1', [a]),
      assistant('e2', [b]),
      assistant('e3', [r], true),
      result('res1'),
      user('u2'),
      assistant('e4', []),
      result('res2'),
      user('u3'),
      assistant('e5', [use('c', 'Grep')]),
    ]);
    expect(map.get('res1')).toEqual([a, b]);
    expect(map.has('res2')).toBe(false);
    expect(map.size).toBe(1);
  });
});

describe('summarizeActivity', () => {
  it('counts files once and commands each time', () => {
    const uses = [
      use('1', 'Read', { file_path: '/a.ts' }),
      use('2', 'Read', { file_path: '/a.ts' }),
      use('3', 'Read', { file_path: '/b.ts' }),
      use('4', 'Grep', { pattern: 'x' }),
      use('5', 'Bash', { command: 'npm test' }),
      use('6', 'Bash', { command: 'npm run build' }),
      use('7', 'Edit', { file_path: '/a.ts' }),
      use('8', 'TodoWrite', {}),
      use('9', 'mcp__claude_ai_Slack__slack_read_channel', {}),
    ];
    expect(summarizeActivity(uses, new Map())).toBe(
      'Read 2 files · searched 1 time · ran 2 commands · changed 1 file · used Slack 1 time',
    );
  });

  it('counts files a command changed', () => {
    const results = new Map<string, ToolResultBlock>([
      [
        'b',
        {
          id: 'b',
          content: '',
          isError: false,
          fileChanges: [{ path: '/c.ts', relPath: 'c.ts', status: 'modified', additions: 1, deletions: 0 }],
        },
      ],
    ]);
    expect(summarizeActivity([use('b', 'Bash', { command: 'sed -i x c.ts' })], results)).toBe(
      'Ran 1 command · changed 1 file',
    );
  });

  it('says nothing for bookkeeping-only turns', () => {
    expect(summarizeActivity([use('t', 'TodoWrite')], new Map())).toBe('');
  });
});
