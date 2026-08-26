import { describe, expect, it } from 'vitest';
import { changedLinesKey, parseChangedLines } from './changedLines';

const diff = (...lines: string[]) => lines.join('\n');

describe('parseChangedLines', () => {
  it('returns nothing for an empty diff', () => {
    expect(parseChangedLines('')).toEqual({ changed: [], deletedAt: [] });
    expect(parseChangedLines('   \n')).toEqual({ changed: [], deletedAt: [] });
  });

  it('marks pure insertions as added, in new-file line numbers', () => {
    const marks = parseChangedLines(
      diff(
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,2 +1,4 @@',
        ' one',
        '+two',
        '+three',
        ' four',
      ),
    );
    expect(marks.changed).toEqual([
      { line: 2, kind: 'added' },
      { line: 3, kind: 'added' },
    ]);
    expect(marks.deletedAt).toEqual([]);
  });

  it('marks a replaced line as modified, not added', () => {
    const marks = parseChangedLines(
      diff('@@ -1,3 +1,3 @@', ' one', '-old', '+new', ' three'),
    );
    expect(marks.changed).toEqual([{ line: 2, kind: 'modified' }]);
  });

  it('records a seam where lines were removed and nothing replaced them', () => {
    const marks = parseChangedLines(
      diff('@@ -1,4 +1,2 @@', ' one', '-two', '-three', ' four'),
    );
    expect(marks.changed).toEqual([]);
    // `four` is line 2 in the new file and is where the removal landed.
    expect(marks.deletedAt).toEqual([2]);
  });

  it('keeps additions and deletions in separate runs apart', () => {
    const marks = parseChangedLines(
      diff(
        '@@ -1,6 +1,5 @@',
        ' one',
        '-two',
        ' three',
        '+four',
        ' five',
        '-six',
        ' seven',
      ),
    );
    expect(marks.changed).toEqual([{ line: 3, kind: 'added' }]);
    expect(marks.deletedAt).toEqual([2, 5]);
  });

  it('honours the offset of a later hunk', () => {
    const marks = parseChangedLines(
      diff(
        '@@ -1,2 +1,2 @@',
        ' one',
        ' two',
        '@@ -40,3 +40,4 @@ function thing() {',
        ' forty',
        '+new line',
        ' forty-one',
      ),
    );
    expect(marks.changed).toEqual([{ line: 41, kind: 'added' }]);
  });

  it('treats an untracked --no-index add as all-added', () => {
    const marks = parseChangedLines(
      diff(
        'diff --git a/dev/null b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,3 @@',
        '+one',
        '+two',
        '+three',
      ),
    );
    expect(marks.changed).toEqual([
      { line: 1, kind: 'added' },
      { line: 2, kind: 'added' },
      { line: 3, kind: 'added' },
    ]);
  });

  it('ignores the no-newline marker and blank context lines', () => {
    const marks = parseChangedLines(
      diff('@@ -1,3 +1,3 @@', ' one', '', '-old', '+new', '\\ No newline at end of file'),
    );
    expect(marks.changed).toEqual([{ line: 3, kind: 'modified' }]);
  });

  it('drops a deletion seam that lands on a line the edit also added', () => {
    const marks = parseChangedLines(
      diff('@@ -1,3 +1,2 @@', '+added', '-gone', '-also gone', ' tail'),
    );
    expect(marks.changed).toEqual([{ line: 1, kind: 'modified' }]);
    expect(marks.deletedAt).toEqual([]);
  });

  it('clamps a whole-file deletion to line 1', () => {
    const marks = parseChangedLines(diff('@@ -1,2 +0,0 @@', '-one', '-two'));
    expect(marks.changed).toEqual([]);
    expect(marks.deletedAt).toEqual([1]);
  });
});

describe('changedLinesKey', () => {
  it('is empty for no marks', () => {
    expect(changedLinesKey(null)).toBe('');
  });

  it('distinguishes kind changes on the same line', () => {
    const a = changedLinesKey({ changed: [{ line: 3, kind: 'added' }], deletedAt: [] });
    const b = changedLinesKey({ changed: [{ line: 3, kind: 'modified' }], deletedAt: [] });
    expect(a).not.toBe(b);
  });

  it('matches for equal marks', () => {
    const marks = { changed: [{ line: 1, kind: 'added' as const }], deletedAt: [4] };
    expect(changedLinesKey(marks)).toBe(changedLinesKey({ ...marks }));
  });
});
