// Where one run of a service ends and the next begins.
//
// A restart appends to the last run's output rather than clearing it — the
// failure you restarted after is often the thing you want to compare against.
// So the supervisor writes a line at each start and each end, and the pane
// reads them back to put a divider between runs and to fold the old ones away.
// Folding is also what keeps a long history cheap: a folded run is counted,
// never filtered, grouped or drawn.
//
// The same lines go to the log file, where an agent reading it later needs the
// same boundaries. Built and parsed here so the two sides cannot drift.

export interface RunStart {
  /// Local wall-clock time, HH:MM:SS. Absent on lines written before it was
  /// recorded.
  time?: string;
  ref: string;
  cwd: string;
  command: string;
}

export interface RunEnd {
  status: 'failed' | 'stopped' | 'done';
  exitCode?: number;
  /// How long the run lasted, already formatted ("16s", "4m 02s").
  duration?: string;
  error?: string;
}

const SEP = ' · ';

export function startLine(start: RunStart): string {
  return `── start ${[start.time, start.ref, start.cwd, start.command].filter((p) => p !== undefined).join(SEP)} ──`;
}

export function endLine(end: RunEnd): string {
  const parts = [
    end.status,
    end.exitCode !== undefined ? `exit ${end.exitCode}` : '',
    end.duration ? `after ${end.duration}` : '',
    end.error ?? '',
  ].filter(Boolean);
  return `── ${parts.join(SEP)} ──`;
}

const TIME = /^\d{2}:\d{2}:\d{2}$/;

export function parseStart(line: string): RunStart | null {
  if (!line.startsWith('── start ') || !line.endsWith(' ──')) return null;
  const parts = line.slice('── start '.length, -' ──'.length).split(SEP);
  const time = TIME.test(parts[0] ?? '') ? parts.shift() : undefined;
  if (parts.length < 3) return null;
  // The command is last and may itself contain the separator.
  const [ref, cwd, ...command] = parts;
  return { time, ref, cwd, command: command.join(SEP) };
}

export function parseEnd(line: string): RunEnd | null {
  const match = /^── (failed|stopped|done)(?: · (.*))? ──$/.exec(line);
  if (!match) return null;
  const end: RunEnd = { status: match[1] as RunEnd['status'] };
  const rest: string[] = [];
  for (const part of (match[2] ?? '').split(SEP).filter(Boolean)) {
    const exit = /^exit (-?\d+)$/.exec(part);
    if (exit && end.exitCode === undefined) end.exitCode = Number(exit[1]);
    else if (part.startsWith('after ') && end.duration === undefined) end.duration = part.slice(6);
    else rest.push(part);
  }
  if (rest.length > 0) end.error = rest.join(SEP);
  return end;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function clockTime(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface Run {
  /// First line of the run: its start marker, or 0 for output before any.
  from: number;
  /// One past its last line.
  to: number;
  start: RunStart | null;
  end: RunEnd | null;
}

/// The log, cut at each start marker. Output before the first marker — a log
/// trimmed past its start, or written before markers reached the pane — is a
/// run of its own with no start.
export function splitRuns(lines: readonly string[]): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].startsWith('── start ') ? parseStart(lines[i]) : null;
    if (start || !current) {
      if (current) current.to = i;
      current = { from: i, to: lines.length, start, end: null };
      runs.push(current);
      continue;
    }
    if (lines[i].startsWith('── ')) {
      const end = parseEnd(lines[i]);
      if (end) current.end = end;
    }
  }
  return runs;
}
