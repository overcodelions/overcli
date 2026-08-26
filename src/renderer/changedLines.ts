// Turn a unified diff into per-line marks for the FILE view's gutter.
//
// The diff view already answers "what changed"; this answers the other
// half of the question — "where am I in the file, and is this line new?"
// — so you can scroll real code with the surrounding context intact and
// still see the run's work stand out.
//
// Everything here is expressed in NEW-file line numbers, because that's
// the document CodeMirror is showing.

export type ChangeKind = 'added' | 'modified';

export interface LineChange {
  line: number;
  kind: ChangeKind;
}

export interface ChangedLines {
  /// Lines present in the new file, in ascending order, no duplicates.
  changed: LineChange[];
  /// New-file line numbers that have removed lines sitting immediately
  /// above them. A pure deletion leaves nothing to tint, so the gutter
  /// marks the seam instead. Ascending, no duplicates.
  deletedAt: number[];
}

const EMPTY: ChangedLines = { changed: [], deletedAt: [] };

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/// Parse a single file's `git diff` output. Multi-file diffs are accepted
/// (the file editor only ever asks git for one path, but a stray second
/// block shouldn't corrupt the marks) — every hunk contributes, since the
/// caller has already scoped the diff to the file on screen.
export function parseChangedLines(diffText: string): ChangedLines {
  if (!diffText.trim()) return EMPTY;
  const changed = new Map<number, ChangeKind>();
  const deletedAt = new Set<number>();
  // New-file cursor: the line number the next context/added line will get.
  let newLine = 0;
  let inHunk = false;
  // A "run" is a contiguous block of -/+ lines. Pairing removals with the
  // additions that follow them is what separates a rewritten line
  // (modified) from a genuinely new one (added) — the same grouping every
  // editor's change gutter uses.
  let runRemoved = 0;
  let runAdded: number[] = [];

  const flushRun = () => {
    if (runAdded.length) {
      const kind: ChangeKind = runRemoved > 0 ? 'modified' : 'added';
      // A line already marked 'modified' by an earlier run stays that way;
      // 'modified' is the stronger claim and runs never overlap anyway.
      for (const ln of runAdded) if (changed.get(ln) !== 'modified') changed.set(ln, kind);
    } else if (runRemoved > 0) {
      // Nothing replaced the removed lines, so mark the seam: the line
      // that now sits where they used to be. At end-of-file that's past
      // the last line, so fall back to the line above it.
      deletedAt.add(Math.max(1, newLine));
    }
    runRemoved = 0;
    runAdded = [];
  };

  for (const raw of diffText.split('\n')) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      flushRun();
      newLine = Number(hunk[1]);
      // `@@ -x,y +0,0 @@` marks a file emptied out; there is no line 0 to
      // point at, so clamp the cursor into the document.
      if (newLine < 1) newLine = 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // A second file's header ends the current one's hunks.
    if (raw.startsWith('diff --git ')) {
      flushRun();
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      runAdded.push(newLine);
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      runRemoved += 1;
      continue;
    }
    // "\ No newline at end of file" annotates the line before it and
    // consumes no line number of its own.
    if (raw.startsWith('\\')) continue;
    flushRun();
    // Context lines (' ') advance the cursor. Git also emits a bare empty
    // string for a blank context line, and the trailing split('\n') gives
    // one at the very end — advancing on it is harmless.
    newLine += 1;
  }
  flushRun();

  if (!changed.size && !deletedAt.size) return EMPTY;
  return {
    changed: [...changed.entries()]
      .map(([line, kind]) => ({ line, kind }))
      .sort((a, b) => a.line - b.line),
    // A deletion seam that lands on a line the same edit also added is
    // already told by the green bar; drop it rather than stack two marks.
    deletedAt: [...deletedAt].filter((ln) => !changed.has(ln)).sort((a, b) => a - b),
  };
}

/// Cheap identity for the marks, so the editor can skip a dispatch when a
/// re-fetched diff says exactly what the last one did.
export function changedLinesKey(marks: ChangedLines | null): string {
  if (!marks) return '';
  return `${marks.changed.map((c) => `${c.line}${c.kind[0]}`).join(',')}|${marks.deletedAt.join(',')}`;
}
