// Folding a stack trace down to the part someone is reading.
//
// A Spring failure is one sentence — `Could not resolve placeholder
// 'proc.database.ip'` — followed by forty lines of `at
// org.springframework.beans.factory.support...`, then `Caused by:` and forty
// more. The sentence is what anyone opens the log for, and in a raw stream it
// is a needle in its own haystack.
//
// So consecutive frames collapse into one row that says how many there are and
// opens on a click. Nothing is discarded: this changes what is on screen by
// default, never what was captured.

export interface LogRow {
  kind: 'line';
  index: number;
}

export interface FrameGroup {
  kind: 'frames';
  /// Indices into the original list, in order.
  indices: number[];
}

export type LogItem = LogRow | FrameGroup;

import { isStackFrame } from '@shared/exceptions';

export { isStackFrame };

/// How many consecutive frames are worth hiding. Two is not a wall, and
/// collapsing them costs a click to read something that was already readable.
const MIN_GROUP = 4;

/// Group a log into rows and runs of stack frames.
export function groupLog(
  lines: readonly { index: number; text: string }[],
  opts: { collapse?: boolean } = {},
): LogItem[] {
  const collapse = opts.collapse ?? true;
  const out: LogItem[] = [];
  let run: number[] = [];

  const flush = () => {
    if (run.length === 0) return;
    // A short run is not a wall; leave it as lines.
    if (collapse && run.length >= MIN_GROUP) out.push({ kind: 'frames', indices: run });
    else for (const index of run) out.push({ kind: 'line', index });
    run = [];
  };

  for (const line of lines) {
    if (isStackFrame(line.text)) {
      run.push(line.index);
      continue;
    }
    flush();
    out.push({ kind: 'line', index: line.index });
  }
  flush();
  return out;
}

/// The part of an exception line worth reading, when it is one.
///
/// `org.springframework.beans.factory.BeanDefinitionStoreException: Invalid
/// bean definition...` is thirty characters of package before the first word
/// that means anything.
export function exceptionMessage(text: string): { type: string; message: string } | null {
  const match = /(?:^|\s)((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable))(?::\s*(.*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const type = match[1].split('.').pop() ?? match[1];
  return { type, message: (match[2] ?? '').trim() };
}

/// Whether a line opens a new section of a trace, which stays visible however
/// much is folded around it — losing `Caused by:` is losing the actual cause.
export function isTraceHeader(text: string): boolean {
  return /^\s*(Caused by|Suppressed):/.test(text);
}
