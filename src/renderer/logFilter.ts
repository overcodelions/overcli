// Finding the line that matters in a few thousand.
//
// A dev server writes more in thirty seconds than anyone reads in a minute,
// and the reason someone opens the log is almost always a specific question:
// what port did it bind, why did it exit, did that request arrive. So the log
// view gets a search box and a severity filter, and both work on the text the
// user can SEE — escape sequences stripped — because nobody searches for
// `[36m`.

import { stripAnsi } from './ansi';
import { parseLogLine, type Level } from './logLine';

export type LogLevel = 'all' | 'problems';

export interface FilteredLine {
  /// Index in the original list, so "3 of 412" and jump-to-line stay honest.
  index: number;
  text: string;
  /// Ranges of the match within `text`, for highlighting.
  matches: [start: number, end: number][];
  problem: boolean;
}

/// Lines a person would call a problem. Deliberately broad and text-based:
/// every runtime spells it differently and none of them tag their output in a
/// way we could rely on.
///
/// `exception` is matched without a leading word boundary on purpose — the JVM
/// writes `java.lang.NullPointerException`, where the word never starts.
const PROBLEM =
  /\berrors?\b|\bfatal\b|exception|\bfail(ed|ure|ing)?\b|\bcannot\b|unable to|EADDRINUSE|ENOENT|already in use/i;

/// "Found 0 errors" is the commonest line in a watch build and the commonest
/// false positive; a filter that flags it is a filter nobody leaves on.
const NO_ERRORS = /\b(0|no)\s+errors?\b/i;

export function isProblem(line: string): boolean {
  if (NO_ERRORS.test(line)) return false;
  return PROBLEM.test(line);
}

/// Filter and mark up the log for display.
export function filterLog(
  lines: readonly string[],
  opts: { query?: string; level?: LogLevel; hidden?: ReadonlySet<Level> } = {},
): FilteredLine[] {
  const query = (opts.query ?? '').trim();
  const level = opts.level ?? 'all';
  const needle = query.toLowerCase();
  const out: FilteredLine[] = [];
  // The level of the record a line belongs to. A stack frame or a wrapped
  // message has no level of its own — it is part of the record above it, and
  // hiding DEBUG must not leave its frames stranded under an INFO line.
  let record: Level | undefined;

  for (let index = 0; index < lines.length; index++) {
    // Search sees what the user sees, not the escape codes behind it.
    const text = stripAnsi(lines[index]);
    if (opts.hidden && opts.hidden.size > 0) {
      const parsed = parseLogLine(text);
      if (parsed) record = parsed.level;
      // Before the first record — a banner, Gradle's own output — always shows.
      if (record !== undefined && opts.hidden.has(record)) continue;
    }
    const problem = isProblem(text);
    if (level === 'problems' && !problem) continue;

    if (!needle) {
      out.push({ index, text, matches: [], problem });
      continue;
    }

    const matches = findAll(text.toLowerCase(), needle);
    if (matches.length === 0) continue;
    out.push({ index, text, matches, problem });
  }

  return out;
}

/// Every occurrence, not just the first — a line often contains the thing you
/// searched for twice, and highlighting one of them looks like a bug.
function findAll(haystack: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push([at, at + needle.length]);
    from = at + needle.length;
    // A very long line of a repeated character should not produce a million
    // ranges to render.
    if (out.length >= 200) return out;
  }
}

/// Split a line into plain and matched runs, for rendering the highlight.
export function highlightRuns(
  text: string,
  matches: readonly [number, number][],
): { text: string; match: boolean }[] {
  if (matches.length === 0) return [{ text, match: false }];
  const runs: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of matches) {
    if (start > at) runs.push({ text: text.slice(at, start), match: false });
    runs.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), match: false });
  return runs;
}

/// How many lines were hidden, for the "showing 12 of 1,204" line. Worth
/// saying: a filtered log that looks empty is otherwise indistinguishable from
/// a service that printed nothing.
export function describeFilter(total: number, shown: number): string | null {
  if (shown === total) return null;
  return `${shown.toLocaleString()} of ${total.toLocaleString()} lines`;
}

/// Records per level, for the counts on the filter. Continuation lines are not
/// records, so a forty-line trace counts once.
export function countLevels(lines: readonly string[]): Record<Level, number> {
  const out: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
  for (const line of lines) {
    const parsed = parseLogLine(stripAnsi(line));
    if (parsed) out[parsed.level]++;
  }
  return out;
}
