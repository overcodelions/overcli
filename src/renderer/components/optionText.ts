// Parsing a pasted block of startup options, renderer-side.
//
// The engine does the same parse when it stores them; this copy exists so a
// dialog can show what it understood BEFORE anything is saved. Kept in one
// place rather than inline in two components, because the two have to agree
// about what a `#` means.

import type { ServiceOption } from '@shared/services';

/// `-Dkey=value`, `--flag=value`, or a bare `--flag`, one per line or space
/// separated. A `#` comments out the rest of its line — the scripts people
/// paste from are shell scripts, and half of every one of them is commentary.
export function parseOptionText(text: string): ServiceOption[] {
  const out: ServiceOption[] = [];
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

  for (const token of stripped.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const cleaned = token.replace(/^['"]|['"]$/g, '').trim();
    if (!cleaned) continue;
    const eq = cleaned.indexOf('=');
    if (eq === -1) {
      out.push({ key: cleaned });
      continue;
    }
    out.push({
      key: cleaned.slice(0, eq),
      value: cleaned.slice(eq + 1).replace(/^['"]|['"]$/g, ''),
    });
  }
  return out;
}

/// Options back as editable text, one per line.
export function optionsToText(options: readonly ServiceOption[]): string {
  return options.map((o) => (o.value === undefined ? o.key : `${o.key}=${o.value}`)).join('\n');
}
