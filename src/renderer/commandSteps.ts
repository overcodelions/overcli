// A shell command as the steps it is made of, one per line, for reading.
//
// A stored command is one line — that is what an import brings and what
// `sh -c` is handed. Three hundred characters of `a; until b; do c; done; exec
// d` in a box is where the typo hides, so the editor shows it broken after each
// `;`, `;;`, `&&` and `||`, with the separator left at the end of its line.
//
// A break is only made where the separator is followed by exactly one space,
// and joining puts that one space back, so an untouched command saves as the
// very same string — even if the reading of quotes here is wrong somewhere.
// Anything that would read misleadingly split stays one line: a heredoc, a
// comment, unbalanced quotes, a trailing backslash, or newlines already in it.

/// The steps of a one-line command. A command it cannot split safely comes
/// back whole, as the only step.
export function splitSteps(line: string): string[] {
  if (line.includes('\n')) return [line];
  const steps: string[] = [];
  let start = 0;
  let quote: '"' | "'" | '`' | null = null;
  let depth = 0; // inside $( … )

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '$' && line[i + 1] === '(') {
      depth++;
      i++;
      continue;
    }
    if (depth > 0) {
      if (ch === ')') depth--;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return [line];
    if (ch === '<' && line[i + 1] === '<') return [line];

    const width = line.startsWith(';;', i) || line.startsWith('&&', i) || line.startsWith('||', i)
      ? 2
      : ch === ';'
        ? 1
        : 0;
    if (width === 0) continue;
    const end = i + width;
    if (line[end] === ' ' && end + 1 < line.length && line[end + 1] !== ' ') {
      steps.push(line.slice(start, end));
      start = end + 1;
    }
    i = end - 1;
  }

  if (quote || depth > 0 || line.endsWith('\\')) return [line];
  steps.push(line.slice(start));
  return steps;
}

/// A line ending in one of these already runs on into the next.
const RUNS_ON = /(?:[;&|]|(?:^|\s)(?:do|then|else|in|\{|\())$/;

/// The lines of the editor as the one-line command that is saved. A line
/// someone added without a separator becomes its own step.
export function joinSteps(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  let out = '';
  for (const [i, line] of lines.entries()) {
    if (i === 0) {
      out = line;
    } else if (out.endsWith('\\')) {
      out = `${out.slice(0, -1).trimEnd()} ${line.trimStart()}`;
    } else {
      out += (RUNS_ON.test(out) ? ' ' : '; ') + line.trimStart();
    }
  }
  return out;
}
