// Turning a process's raw output into something that looks like the terminal
// it came from.
//
// A dev server's output is full of ANSI escape sequences — `concurrently`
// colours each child's prefix, vite bolds its URL, tsc timestamps in grey.
// Printed as text those become `[36m[vite][39m`, which is both ugly and
// actively harder to read than the terminal the user was comparing it against.
//
// This is a deliberately small SGR parser: colours, bold, dim, reset. Cursor
// movement, scroll regions and the rest of the terminal's repertoire are not
// handled and not needed — nothing here is a terminal emulator, it is a log
// view that should stop showing escape codes.
//
// The escape character itself appears literally in the two patterns below,
// which is how a regex literal has to carry it; everything else about them
// is ordinary.

export interface AnsiSegment {
  text: string;
  /// Resolved CSS colour, or undefined for the default foreground.
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/// The 16 basic colours, picked to sit on the app's dark and light surfaces
/// rather than the terminal's pure black. Anything more exotic (256-colour,
/// truecolor) is parsed and dropped rather than approximated badly.
const COLORS: Record<number, string> = {
  30: '#5c5c66', // black — invisible as true black, so it is a dark grey
  31: '#f87171',
  32: '#4ade80',
  33: '#fbbf24',
  34: '#7c8bff',
  35: '#c084fc',
  36: '#22d3ee',
  37: '#d4d4d8',
  90: '#8a8a94',
  91: '#fca5a5',
  92: '#86efac',
  93: '#fcd34d',
  94: '#a5b4fc',
  95: '#d8b4fe',
  96: '#67e8f9',
  97: '#fafafa',
};

/// A colour instruction: `ESC [ ... m`.
const SGR = /\[([0-9;]*)m/g;

/// Everything else an escape sequence can be — cursor moves, erase-line, an
/// OSC title change, a charset switch. Dropped whole rather than
/// half-rendered. `m` is deliberately absent from the terminator set so a
/// colour instruction survives this pass to be parsed below.
const OTHER_ESCAPES = /\[[0-9;?]*[A-HJKSTfhlsu]|\][^]*|[()][AB0]/g;

/// Split a line into styled runs.
export function parseAnsi(line: string): AnsiSegment[] {
  const cleaned = line.replace(OTHER_ESCAPES, '');
  SGR.lastIndex = 0;

  const segments: AnsiSegment[] = [];
  let style: Omit<AnsiSegment, 'text'> = {};
  let index = 0;

  for (const match of cleaned.matchAll(SGR)) {
    const text = cleaned.slice(index, match.index);
    if (text) segments.push({ text, ...style });
    style = applyCodes(style, match[1]);
    index = (match.index ?? 0) + match[0].length;
  }

  const tail = cleaned.slice(index);
  if (tail || segments.length === 0) segments.push({ text: tail, ...style });
  return segments;
}

function applyCodes(style: Omit<AnsiSegment, 'text'>, raw: string): Omit<AnsiSegment, 'text'> {
  // A bare `ESC [ m` means reset, same as `ESC [ 0 m`.
  const codes = raw === '' ? [0] : raw.split(';').map((c) => Number.parseInt(c, 10) || 0);
  let next = { ...style };

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) (next.bold = false), (next.dim = false);
    else if (code === 39) next.color = undefined;
    else if (COLORS[code]) next.color = COLORS[code];
    // 256-colour and truecolor are ONE instruction carrying arguments. Consume
    // them, or the arguments get read as further codes and the rest of the
    // line silently loses its styling.
    else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
  }
  return next;
}

/// The line with every escape sequence removed — what search and filtering
/// match against, so a query never has to know about colour.
export function stripAnsi(line: string): string {
  return parseAnsi(line)
    .map((s) => s.text)
    .join('');
}

/// A carriage return means the process rewrote the line in place — a progress
/// bar, a spinner. Only the last version was ever visible in the terminal, so
/// only the last version belongs in the log.
export function collapseCarriageReturns(line: string): string {
  const parts = line.split('\r');
  return parts[parts.length - 1];
}
