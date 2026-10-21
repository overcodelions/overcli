import { describe, expect, it } from 'vitest';
import type { StreamEvent, StreamEventKind } from '@shared/types';
import type { FileChangeSummary } from './components/ChangesBar';
import { splitOwnChanges, touchedPaths } from './conversationTouchedFiles';

function ev(kind: StreamEventKind): StreamEvent {
  return { kind } as StreamEvent;
}

function change(path: string): FileChangeSummary {
  return { path, status: ' M', additions: 1, deletions: 0 };
}

describe('touchedPaths', () => {
  it('collects edits, patches and measured command changes', () => {
    const events = [
      ev({
        type: 'assistant',
        info: {
          model: null,
          text: '',
          thinking: [],
          toolUses: [
            { id: '1', name: 'Edit', inputJSON: '{}', filePath: '/repo/src/a.ts' },
            { id: '2', name: 'Read', inputJSON: '{}', filePath: '/repo/src/read-only.ts' },
          ],
        },
      }),
      ev({
        type: 'patchApply',
        info: {
          id: 'p',
          success: true,
          files: [
            { id: 'f', path: 'src/b.ts', kind: 'move', movedFrom: 'src/old.ts', additions: 0, deletions: 0 },
          ],
        },
      }),
      ev({
        type: 'toolResult',
        results: [
          {
            id: '3',
            content: '',
            isError: false,
            fileChanges: [
              { path: '/repo/c.ts', relPath: 'c.ts', status: 'modified', additions: 1, deletions: 1 },
            ],
          },
        ],
      }),
    ];
    expect([...touchedPaths(events)].sort()).toEqual(
      ['/repo/c.ts', '/repo/src/a.ts', 'src/b.ts', 'src/old.ts'].sort(),
    );
  });
});

describe('splitOwnChanges', () => {
  it('keeps only the files this conversation touched and counts the rest', () => {
    const changes = [change('src/a.ts'), change('src/b.ts'), change('README.md')];
    const { own, others } = splitOwnChanges(changes, new Set(['/repo/src/a.ts']));
    expect(own.map((c) => c.path)).toEqual(['src/a.ts']);
    expect(others).toBe(2);
  });

  it('does not match on a partial file name', () => {
    const { own } = splitOwnChanges([change('src/a.ts')], new Set(['/repo/src/aa.ts']));
    expect(own).toEqual([]);
  });

  it('matches cwd-relative paths', () => {
    const { own } = splitOwnChanges([change('src/b.ts')], new Set(['./src/b.ts']));
    expect(own).toHaveLength(1);
  });

  it('matches workspace rows whose member prefix differs from the folder name', () => {
    const { own } = splitOwnChanges(
      [change('api/src/x.ts')],
      new Set(['/code/acme-api-service/src/x.ts']),
    );
    expect(own).toHaveLength(1);
  });
});
