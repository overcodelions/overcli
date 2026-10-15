import { describe, expect, it } from 'vitest';
import type { StreamEvent, ToolResultBlock, ToolUseBlock } from '@shared/types';
import { digestActivity, formatElapsed, openTurnActivity, summarizeActivity, turnActivityByResult } from './TurnActivity';

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
  it("puts a message's calls on its last step's row, once, skipping reviewer calls", () => {
    const a = use('a', 'Read', { file_path: '/x' });
    const b = use('b', 'Bash', { command: 'npm test' });
    const r = use('r', 'Read', { file_path: '/y' });
    const map = turnActivityByResult([
      user('u1'),
      assistant('e1', [a]),
      result('res1a'),
      assistant('e2', [b]),
      assistant('e3', [r], true),
      result('res1b'),
      user('u2'),
      assistant('e4', []),
      result('res2'),
      user('u3'),
      assistant('e5', [use('c', 'Grep')]),
      result('res3'),
    ]);
    expect(map.get('res1b')).toEqual({ uses: [a, b], messageId: 'u1' });
    expect(map.has('res1a')).toBe(false);
    expect(map.has('res2')).toBe(false);
    expect([...map.keys()]).toEqual(['res1b', 'res3']);
  });

  it('leaves the message still being worked on to the live line', () => {
    const events = [user('u1'), assistant('e1', [use('a', 'Read')]), result('r1'), user('u2'), assistant('e2', [use('b', 'Bash')]), result('r2')];
    expect([...turnActivityByResult(events, true).keys()]).toEqual(['r1']);
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
      'Read 2 files · searched 1 time · ran 2 commands · used Slack 1 time · changed 1 file',
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

describe('openTurnActivity', () => {
  it('collects every call since the last message, across steps', () => {
    const a = use('a', 'Read', { file_path: '/x' });
    const b = use('b', 'Bash', { command: 'npm test' });
    const live = openTurnActivity([user('u1'), assistant('e1', [use('old', 'Grep')]), result('r1'), user('u2'), assistant('e2', [a]), result('r2'), assistant('e3', [b])]);
    expect(live.uses).toEqual([a, b]);
  });

  it('ignores reviewer calls', () => {
    expect(openTurnActivity([user('u1'), assistant('e1', [use('r', 'Read')], true)]).uses).toEqual([]);
  });
});

describe('formatElapsed', () => {
  it('reads as seconds, then minutes and seconds', () => {
    expect(formatElapsed(42_400)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(-5)).toBe('0s');
  });
});

describe('digestActivity', () => {
  it('names changed files in the order they changed, once each, with summed line counts', () => {
    const d = digestActivity(
      [
        use('1', 'Edit', { file_path: '/repo/b.ts', old_string: 'a\nb\n', new_string: 'a\nB\nc\n' }),
        use('2', 'Read', { file_path: '/repo/a.ts' }),
        use('3', 'Write', { file_path: '/repo/c.ts', content: 'x\ny\nz\n' }),
        use('4', 'Edit', { file_path: '/repo/b.ts', old_string: 'c\n', new_string: '' }),
      ],
      new Map(),
    );
    expect(d.changed).toEqual([
      { path: '/repo/b.ts', additions: 2, deletions: 2 },
      { path: '/repo/c.ts', additions: 3, deletions: 0 },
    ]);
    expect(d.parts).toEqual(['read 1 file']);
  });

  it("takes a command's measured counts", () => {
    const results = new Map<string, ToolResultBlock>([
      ['b', { id: 'b', content: '', isError: false, fileChanges: [{ path: '/c.ts', relPath: 'c.ts', status: 'modified', additions: 4, deletions: 1 }] }],
    ]);
    expect(digestActivity([use('b', 'Bash', { command: 'sed -i x c.ts' })], results).changed).toEqual([
      { path: '/c.ts', additions: 4, deletions: 1 },
    ]);
  });
});
