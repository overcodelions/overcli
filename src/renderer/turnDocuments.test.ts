import { describe, expect, it } from 'vitest';

import { documentToReveal, documentsWrittenSince } from './turnDocuments';
import type { StreamEvent } from '@shared/types';

const TURN_START = 1_000;

function assistant(
  timestamp: number,
  uses: { name: string; filePath?: string; inputJSON?: string }[],
  extra: Partial<StreamEvent> = {},
): StreamEvent {
  return {
    id: `e${timestamp}`,
    timestamp,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: {
        model: null,
        text: '',
        thinking: [],
        toolUses: uses.map((u, i) => ({
          id: `t${timestamp}-${i}`,
          name: u.name,
          inputJSON: u.inputJSON ?? '{}',
          filePath: u.filePath,
        })),
      },
    },
    ...extra,
  } as StreamEvent;
}

describe('documentsWrittenSince', () => {
  it('collects markdown a turn wrote, oldest first', () => {
    const events = [
      assistant(1_100, [{ name: 'Write', filePath: '/repo/notes.md' }]),
      assistant(1_200, [{ name: 'Write', filePath: '/repo/docs/answer.md' }]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual([
      '/repo/notes.md',
      '/repo/docs/answer.md',
    ]);
  });

  it('reads the path out of the raw arguments when it is not pre-parsed', () => {
    const events = [
      assistant(1_100, [{ name: 'Write', inputJSON: '{"file_path":"/repo/plan.md"}' }]),
      assistant(1_150, [{ name: 'Write', inputJSON: '{"path":"/repo/adr.md"}' }]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual(['/repo/plan.md', '/repo/adr.md']);
  });

  it('survives arguments that are not valid JSON', () => {
    const events = [assistant(1_100, [{ name: 'Write', inputJSON: '{"file_path":' }])];
    expect(documentsWrittenSince(events, TURN_START)).toEqual([]);
  });

  // The whole point of the `since` bound: re-opening a conversation and
  // sending "thanks" must not resurrect a document from four turns ago.
  it('ignores anything written before this turn started', () => {
    const events = [
      assistant(900, [{ name: 'Write', filePath: '/repo/old.md' }]),
      assistant(1_100, [{ name: 'Write', filePath: '/repo/new.md' }]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual(['/repo/new.md']);
  });

  it('ignores edits to files that already existed', () => {
    const events = [
      assistant(1_100, [{ name: 'Edit', filePath: '/repo/README.md' }]),
      assistant(1_150, [{ name: 'MultiEdit', filePath: '/repo/CHANGELOG.md' }]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual([]);
  });

  it('ignores source, config and data', () => {
    const events = [
      assistant(1_100, [
        { name: 'Write', filePath: '/repo/src/index.ts' },
        { name: 'Write', filePath: '/repo/data.json' },
        { name: 'Write', filePath: '/repo/notes.txt' },
      ]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual([]);
  });

  it("ignores a subagent's working notes", () => {
    const events = [
      assistant(1_100, [{ name: 'Write', filePath: '/repo/scratch.md' }], {
        parentToolUseId: 'task-1',
      }),
      assistant(1_200, [{ name: 'Write', filePath: '/repo/answer.md' }]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual(['/repo/answer.md']);
  });

  it('dedupes a file rewritten twice in one turn', () => {
    const events = [
      assistant(1_100, [{ name: 'Write', filePath: '/repo/answer.md' }]),
      assistant(1_200, [{ name: 'Write', filePath: '/repo/answer.md' }]),
    ];
    expect(documentsWrittenSince(events, TURN_START)).toEqual(['/repo/answer.md']);
  });
});

describe('documentToReveal', () => {
  it('shows nothing when the turn wrote nothing', () => {
    expect(documentToReveal([], TURN_START)).toBeUndefined();
  });

  // An agent that writes its notes and then its answer wrote the answer last.
  it('shows the last document written', () => {
    const events = [
      assistant(1_100, [{ name: 'Write', filePath: '/repo/notes.md' }]),
      assistant(1_200, [{ name: 'Write', filePath: '/repo/answer.md' }]),
    ];
    expect(documentToReveal(events, TURN_START)).toBe('/repo/answer.md');
  });

  // A docs sweep has no single thing it "produced", and picking one of eleven
  // would be picking at random.
  it('shows nothing when the turn wrote a pile of them', () => {
    const events = [
      assistant(
        1_100,
        ['a', 'b', 'c', 'd'].map((n) => ({ name: 'Write', filePath: `/repo/${n}.md` })),
      ),
    ];
    expect(documentToReveal(events, TURN_START)).toBeUndefined();
  });
});
