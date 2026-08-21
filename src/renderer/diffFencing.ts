/// Models frequently paste a unified diff into prose *without* a code fence.
/// Markdown then eats it: `-import …` lines become bullet items, the
/// `diff --git` / `index` / `---` / `+++` header collapses into one paragraph,
/// and leading whitespace on context lines is lost. Wrapping each stray diff
/// run in a ```diff fence before parsing restores it to a real, highlighted,
/// copyable code block.

const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

/// A hunk header — enough on its own to start a run, since models often paste
/// bare hunks with no file header.
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/// An unambiguous patch header. A run starting with one of these is fenced
/// even if no hunk has streamed in yet.
const RUN_START_RE = /^(?:diff --git |Index: )/;

/// Lines that may appear *inside* an already-started run.
const BODY_RE = /^(?:diff --git |Index: |index [0-9a-f]|--- |\+\+\+ |@@ |[ +-]|\\ No newline|new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch)/;

/// Wrap every unfenced unified-diff run in `source` in a ```diff fence.
/// Content already inside a fence is left untouched, so this is safe to run
/// on text that mixes fenced and unfenced code.
export function fenceStrayDiffs(source: string): string {
  if (!source) return source;
  // Fast path: nothing that could start a run.
  if (!/^(?:diff --git |Index: |--- |@@ )/m.test(source)) return source;

  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const end = diffRunEnd(lines, i);
    if (end === null) {
      out.push(line);
      continue;
    }
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    out.push('```diff');
    for (let j = i; j < end; j++) out.push(lines[j]);
    out.push('```');
    i = end - 1;
  }

  return out.join('\n');
}

/// If a diff run starts at `start`, return the exclusive end index of that
/// run; otherwise null.
function diffRunEnd(lines: string[], start: number): number | null {
  const first = lines[start];
  const startsRun =
    RUN_START_RE.test(first) ||
    HUNK_RE.test(first) ||
    (first.startsWith('--- ') && (lines[start + 1] ?? '').startsWith('+++ '));
  if (!startsRun) return null;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (FENCE_RE.test(line)) break;
    if (line.trim() === '') {
      // A blank line only continues the run if real diff content follows.
      const next = lines[end + 1];
      if (next === undefined || FENCE_RE.test(next) || !BODY_RE.test(next)) break;
      end++;
      continue;
    }
    if (!BODY_RE.test(line)) break;
    end++;
  }
  while (end > start && lines[end - 1].trim() === '') end--;

  if (RUN_START_RE.test(first)) return end;

  // No explicit patch header: require real diff shape so ordinary markdown
  // lists (`- one` / `+ two`) and thematic breaks are never swallowed.
  let hunks = 0;
  let signed = 0;
  for (let i = start; i < end; i++) {
    const l = lines[i];
    if (HUNK_RE.test(l)) hunks++;
    else if ((l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++ ') && !l.startsWith('--- ')) signed++;
  }
  if (hunks === 0 && signed < 2) return null;
  if (end - start < 2) return null;
  return end;
}
