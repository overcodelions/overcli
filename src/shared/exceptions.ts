// Exceptions, pulled out of a service's output.
//
// A service that throws in a loop prints forty lines of trace a time, and a
// capped buffer of lines keeps only the newest: the first failure — usually
// the cause — scrolls out under the repeats of what it caused. So traces are
// collected as they go past, one entry per distinct exception with a count,
// and kept after their lines are gone.
//
// Pure and incremental, fed one line at a time, so the main process (which
// sees every line) and the pane (which sees them live) run the same thing.

/// Distinct exceptions kept per service. Past this the least recent goes.
export const MAX_EXCEPTIONS = 50;

/// Lines kept of any one trace. The top of a trace is what gets read.
const MAX_SAMPLE = 80;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/// A line that is a stack frame rather than a message.
///
/// Covers the JVM's `at com.acme.Thing.method(File.java:40)`, its `... 11
/// more` tail, and node's `at Object.<anonymous> (/path:1:2)` — the three
/// spellings that actually fill a log.
const FRAME = /^\s+at\s+\S|^\s*\.\.\.\s+\d+\s+more\s*$/;

const SECTION = /^\s*(Caused by|Suppressed):/;

export function isStackFrame(line: string): boolean {
  return FRAME.test(line);
}

export interface CaughtException {
  /// What makes two traces the same exception: the header and first frame
  /// with numbers taken out, and the chain of causes.
  signature: string;
  /// The line the frames hang off — usually `acme.SomeException: message`.
  header: string;
  /// The line before the header, the header, frames and causes, as first seen.
  sample: string[];
  count: number;
  firstAt: number;
  lastAt: number;
}

interface OpenTrace {
  header: string;
  frame?: string;
  sample: string[];
  causes: string[];
  truncated: number;
  at: number;
}

export interface ExceptionLog {
  items: readonly CaughtException[];
  /// The last two plain lines — a trace's header and the log record above it
  /// arrive before the first frame says they were one.
  recent: readonly string[];
  open?: OpenTrace;
}

export function emptyExceptionLog(): ExceptionLog {
  return { items: [], recent: [] };
}

export function feedException(log: ExceptionLog, raw: string, now: number): ExceptionLog {
  const text = raw.replace(ANSI, '').replace(/\s+$/, '');
  if (FRAME.test(text)) {
    const open: OpenTrace = log.open ?? {
      header: log.recent[log.recent.length - 1] ?? '',
      sample: [...log.recent],
      causes: [],
      truncated: 0,
      at: now,
    };
    return { ...log, open: extend({ ...open, frame: open.frame ?? text.trim() }, text) };
  }
  if (log.open && SECTION.test(text)) {
    return { ...log, open: extend({ ...log.open, causes: [...log.open.causes, normalize(text)] }, text) };
  }
  if (log.open) return { items: close(log.items, log.open), recent: [text] };
  return { items: log.items, recent: [...log.recent, text].slice(-2) };
}

/// Newest first, including a trace still arriving — a service that dies on
/// its last frame never prints the line that would close it.
export function listExceptions(log: ExceptionLog): CaughtException[] {
  const items = log.open ? close(log.items, log.open) : log.items;
  return [...items].sort((a, b) => b.lastAt - a.lastAt);
}

function extend(open: OpenTrace, text: string): OpenTrace {
  if (open.sample.length >= MAX_SAMPLE) return { ...open, truncated: open.truncated + 1 };
  return { ...open, sample: [...open.sample, text] };
}

function close(items: readonly CaughtException[], open: OpenTrace): CaughtException[] {
  const signature = [normalize(open.header), normalize(open.frame ?? ''), ...open.causes].join('|');
  const at = items.findIndex((item) => item.signature === signature);
  if (at >= 0) {
    const next = [...items];
    next[at] = { ...items[at], count: items[at].count + 1, lastAt: open.at };
    return next;
  }
  const sample = open.truncated > 0 ? [...open.sample, `… ${open.truncated} more lines`] : open.sample;
  const next = [
    ...items,
    { signature, header: open.header.trim(), sample, count: 1, firstAt: open.at, lastAt: open.at },
  ];
  if (next.length > MAX_EXCEPTIONS) {
    let oldest = 0;
    for (let i = 1; i < next.length; i++) if (next[i].lastAt < next[oldest].lastAt) oldest = i;
    next.splice(oldest, 1);
  }
  return next;
}

/// Ids, ports, addresses and timestamps differ between throws of the same
/// exception; they must not make it a different one.
function normalize(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+/g, '#')
    .trim();
}
