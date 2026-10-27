// A short name for a process or a team: what `/idea lrb …` or `/team pd …`
// starts with, so nobody types "Launch review board:" in Slack.

export const SHORT_NAME_MAX = 12;

/// Words a message is likely to start with anyway: as a short name, "bug"
/// would take every "bug in the export…" for itself, and "see" every "see
/// if…". Stop-words, and the orders a request opens with.
const COMMON = new Set(
  ('a an and are as ask at be bug but by can could do does fix for from get had has have help hey hi how i idea if in into is it its let me my new no not of ok on or our please ' +
    'should so team than that the their them then there these this to us was we what when where which who why will with would yes you your ' +
    'add see run set read make check show list send find tell look give take put use try go come keep turn open close start stop move pull push ' +
    'write draft update change remove delete rename create build test deploy ship merge review post reply note file log plan book call email dm ping ' +
    'any all also back can\'t dont don\'t each every just more most much need now one only out over own same some still such too very want').split(' '),
);

/// Lowercase, trimmed: how short names are stored and compared.
export function normalizeShortName(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/// Why a short name won't do, or null.
export function checkShortName(short: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) return 'A short name is letters, numbers and dashes, with no spaces.';
  if (short.length < 2 || short.length > SHORT_NAME_MAX) return `Keep the short name between 2 and ${SHORT_NAME_MAX} characters.`;
  if (COMMON.has(short)) return `"${short}" is too common a word: messages that start with it would go there. Pick another.`;
  return null;
}

/// Its initials, offered when there are enough words to make one: "Launch review
/// board" → "lrb". Empty when they wouldn't make a good one.
export function suggestShortName(name: string): string {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return '';
  const short = words.map((w) => w[0]).join('').slice(0, SHORT_NAME_MAX);
  return checkShortName(short) ? '' : short;
}

/// Each one's short name: its own, or else its initials while nothing else
/// has them or is called that. Older first, so a new one never takes an
/// old one's: pass them in the order they were made.
export function resolveShortNames(items: ReadonlyArray<{ id: string; name: string; shortName?: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set(items.map((i) => i.name.trim().toLowerCase()));
  for (const i of items) {
    if (!i.shortName) continue;
    out.set(i.id, i.shortName);
    taken.add(i.shortName);
  }
  for (const i of items) {
    const auto = i.shortName ? '' : suggestShortName(i.name);
    if (!auto || taken.has(auto)) continue;
    out.set(i.id, auto);
    taken.add(auto);
  }
  return out;
}

/// Whether a message started with the short name, so it needs no tip.
export function usedShortName(text: string, short: string | undefined): boolean {
  return !!short && new RegExp(`^${short}(?:\\s|:|$)`, 'i').test(text.trim());
}
