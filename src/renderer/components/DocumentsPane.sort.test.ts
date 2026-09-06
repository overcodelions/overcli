import { describe, expect, it } from 'vitest';

import { initialsOf, sortEntries } from './DocumentsPane';
import type { DocumentEntry } from '@shared/types';

function entry(name: string, over: Partial<DocumentEntry> = {}): DocumentEntry {
  return { name, path: `/p/${name}`, isDir: false, sizeBytes: 1, mtimeMs: 0, ...over };
}

const names = (entries: readonly DocumentEntry[]) => entries.map((e) => e.name);

describe('sortEntries', () => {
  it('puts folders first whatever the order', () => {
    const list = [
      entry('brief.md', { mtimeMs: 900 }),
      entry('Archive', { isDir: true, mtimeMs: 1 }),
      entry('notes.md', { mtimeMs: 500 }),
    ];
    for (const key of ['recent', 'name', 'kind'] as const) {
      expect(names(sortEntries(list, key))[0]).toBe('Archive');
    }
  });

  it('sorts newest first on recent', () => {
    const list = [entry('old.md', { mtimeMs: 1 }), entry('new.md', { mtimeMs: 900 })];
    expect(names(sortEntries(list, 'recent'))).toEqual(['new.md', 'old.md']);
  });

  it('falls back to name when two documents share an mtime', () => {
    const list = [entry('b.md', { mtimeMs: 5 }), entry('a.md', { mtimeMs: 5 })];
    expect(names(sortEntries(list, 'recent'))).toEqual(['a.md', 'b.md']);
  });

  it('sorts by name case-insensitively and numerically', () => {
    const list = [entry('Draft 10.md'), entry('draft 2.md'), entry('Apple.md')];
    expect(names(sortEntries(list, 'name'))).toEqual(['Apple.md', 'draft 2.md', 'Draft 10.md']);
  });

  it('groups by kind and names within each group', () => {
    const list = [entry('z.csv'), entry('b.md'), entry('a.csv'), entry('a.md')];
    // Document before Spreadsheet, each group alphabetical.
    expect(names(sortEntries(list, 'kind'))).toEqual(['a.md', 'b.md', 'a.csv', 'z.csv']);
  });

  it('does not mutate its input', () => {
    const list = [entry('b.md', { mtimeMs: 1 }), entry('a.md', { mtimeMs: 9 })];
    sortEntries(list, 'name');
    expect(names(list)).toEqual(['b.md', 'a.md']);
  });
});

describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Release Warden')).toBe('RW');
  });

  it('keeps a single letter for a one-word name', () => {
    expect(initialsOf('Cassandra')).toBe('C');
  });

  it('ignores a third word', () => {
    expect(initialsOf('the release warden')).toBe('TR');
  });

  it('survives a blank name rather than throwing', () => {
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});
