// Turning what someone types into argv.
//
// Services are spawned with an argument list, never through a shell — there
// are no quoting rules to get wrong and nothing typed can be interpreted as a
// pipeline. But people type a command line, because that is what they have in
// their terminal history, so the typed string has to be split the way a shell
// would split it: quotes hold a word together, and the quotes themselves are
// not part of the word.
//
// What this deliberately does NOT do is interpret. A pipe, a redirect or a
// `&&` is not an argument list and cannot be run as one, so it is detected and
// reported rather than passed through to produce a baffling failure later.

export interface ParsedCommand {
  argv: string[];
  /// Set when the line needs a shell to mean what it says.
  needsShell?: 'pipe' | 'redirect' | 'chain' | 'substitution';
}

const SHELL_ONLY: { pattern: RegExp; kind: NonNullable<ParsedCommand['needsShell']> }[] = [
  { pattern: /\|\|?/, kind: 'pipe' },
  { pattern: /[<>]/, kind: 'redirect' },
  { pattern: /&&|;/, kind: 'chain' },
  { pattern: /\$\(|`/, kind: 'substitution' },
];

/// Split a typed command line into argv.
export function parseCommandLine(text: string): ParsedCommand {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      // An empty pair of quotes is a real, empty argument.
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      i++;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (current || started) argv.push(current);

  // Only look for shell syntax OUTSIDE quotes: `-Dmessage="a && b"` is an
  // ordinary argument, not a chain.
  const unquoted = stripQuoted(text);
  const shell = SHELL_ONLY.find((s) => s.pattern.test(unquoted));

  return shell ? { argv, needsShell: shell.kind } : { argv };
}

function stripQuoted(text: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/// What to tell someone whose command needs a shell. Naming the thing that
/// cannot work beats a service that starts and does something unrecognisable.
export function describeShellNeed(kind: NonNullable<ParsedCommand['needsShell']>): string {
  switch (kind) {
    case 'pipe':
      return 'A pipe needs a shell — put the pipeline in a script and run that instead.';
    case 'redirect':
      return 'A redirect needs a shell — the output is captured here anyway.';
    case 'chain':
      return 'Two commands joined by && or ; need a shell — add them as two services, or put them in a script.';
    case 'substitution':
      return 'Command substitution needs a shell — compute the value into a machine value instead.';
  }
}

/// Render argv back as a line, quoting only what needs it. For showing a
/// stored command in a field someone can edit.
export function formatCommandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg === '' || /[\s"']/.test(arg) ? JSON.stringify(arg) : arg))
    .join(' ');
}
