// Naming a conversation after what it turned out to be about.
//
// A chat starts out named after its first sentence, which is instant but
// often not what you'd search for a week later ("can you look at this" is
// not a name). Once the model has replied, a fast one-shot turn writes a
// short title, and the chat is re-titled now and then as it drifts.
//
// Ticket keys and PR numbers are pulled out here, deterministically, and put
// at the front of the title — they're the thing you search for, so they're
// not left to the model's discretion.
//
// A name the person typed is never touched: `nameSource: 'user'` opts the
// conversation out, and only `'auto'` conversations are ever re-titled.

/// What the placeholder name is cut to before the model has had its say.
export const PLACEHOLDER_MAX = 48;
/// The model's part of the title (after any ref prefix).
export const TITLE_MAX = 60;

/// Upper-case prefixes that look like ticket keys but are standards,
/// encodings or model names: "UTF-8", "SHA-256", "ISO-8601", "GPT-4".
const NOT_TICKETS = new Set([
  'UTF', 'SHA', 'ISO', 'RFC', 'GPT', 'CVE', 'MD', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'IPV', 'ES', 'ECMA',
  'AES', 'RSA', 'BASE', 'WIN', 'COVID', 'X', 'IE', 'H', 'PEP', 'ID', 'UTC', 'GMT', 'CP', 'LATIN', 'ASCII',
]);

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
const PR_URL_RE = /\/pull\/(\d{1,7})\b/g;
const PR_TEXT_RE = /\b(?:PR|pull request|MR)\s*#?(\d{1,7})\b/gi;

/// Ticket keys and PR references in what the person wrote and the branch the
/// chat is on, most-mentioned first (first-mentioned breaks a tie). Only the
/// person's own words and the branch count: the model's replies name tickets
/// in passing ("unlike ACME-12, this…") far too often to be a signal.
export function findRefs(texts: string[], branch?: string): string[] {
  const counts = new Map<string, { n: number; first: number }>();
  let order = 0;
  const bump = (ref: string, weight = 1) => {
    const prev = counts.get(ref);
    if (prev) prev.n += weight;
    else counts.set(ref, { n: weight, first: order++ });
  };
  const scan = (text: string, weight = 1) => {
    for (const m of text.matchAll(TICKET_RE)) {
      if (NOT_TICKETS.has(m[1])) continue;
      // A key with a leading zero number ("ABC-007") is still a key; one
      // whose prefix is only digits after the first letter is fine too.
      bump(`${m[1]}-${m[2]}`, weight);
    }
    for (const m of text.matchAll(PR_URL_RE)) bump(`PR #${m[1]}`, weight);
    for (const m of text.matchAll(PR_TEXT_RE)) bump(`PR #${m[1]}`, weight);
  };
  // Branch names are lower-cased by convention ("feat/acme-412-retry"), so
  // they get their own case-insensitive pass. Weighted up: a chat on a
  // ticket's branch is about that ticket.
  if (branch) {
    for (const m of branch.toUpperCase().matchAll(TICKET_RE)) {
      if (!NOT_TICKETS.has(m[1])) bump(`${m[1]}-${m[2]}`, 2);
    }
  }
  for (const t of texts) scan(t);
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .map(([ref]) => ref);
}

/// The reference a title leads with: at most one ticket and one PR, ticket
/// first. Two tickets in one title stops being scannable.
export function leadingRef(refs: string[]): string | null {
  const ticket = refs.find((r) => !r.startsWith('PR #'));
  const pr = refs.find((r) => r.startsWith('PR #'));
  if (ticket && pr) return `${ticket} · ${pr}`;
  return ticket ?? pr ?? null;
}

/// "ACME-412 · Fix flaky login retry". Drops the ref from the description
/// if the model repeated it anyway.
export function composeTitle(ref: string | null, description: string): string {
  let d = description.trim();
  if (ref) {
    for (const part of ref.split(' · ')) {
      const esc = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
      d = d.replace(new RegExp(`^\\s*${esc}\\s*[:·\\-–—]?\\s*`, 'i'), '');
      d = d.replace(new RegExp(`\\s*[(\\[]?${esc}[)\\]]?\\s*$`, 'i'), '');
    }
  }
  d = d.trim();
  if (!ref) return d;
  return d ? `${ref} · ${d}` : ref;
}

/// The name before the model has replied: the first sentence, cut short.
export function placeholderName(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, PLACEHOLDER_MAX);
}

/// Should a finished turn re-title the chat? First reply always; then
/// turn 3 (the point a chat usually shows what it's really about); then
/// every 8 turns; and straight away when a ref turns up that the name
/// doesn't carry. Rare on purpose — a name that keeps moving is harder to
/// find than a slightly stale one.
export function shouldRetitle(args: {
  turnCount: number;
  titledAtTurn?: number;
  name: string;
  ref: string | null;
}): boolean {
  const { turnCount, titledAtTurn, name, ref } = args;
  if (turnCount < 1) return false;
  if (titledAtTurn === undefined) return true;
  if (ref && !ref.split(' · ').every((r) => name.includes(r))) return true;
  if (turnCount <= titledAtTurn) return false;
  if (titledAtTurn < 3) return turnCount >= 3;
  return turnCount - titledAtTurn >= 8;
}

/// The model's reply as a description, `'keep'` when it said the current
/// name still fits, or null when the reply is unusable.
export function readTitleReply(reply: string): string | 'keep' | null {
  let t = reply.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  t = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  t = t.replace(/^(?:title|name)\s*:\s*/i, '').replace(/^["'“‘`*_]+|["'”’`*_.]+$/g, '').trim();
  if (!t) return null;
  if (/^keep\b/i.test(t)) return 'keep';
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX);
    const sp = cut.lastIndexOf(' ');
    t = (sp > TITLE_MAX / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, '');
  }
  return t;
}

export const TITLE_SYSTEM_PROMPT = [
  'You name conversations between a developer and an AI coding assistant, so the developer can find them again in a long list.',
  'Write a title of 3 to 7 words saying what the conversation is about or what it set out to do: the feature, bug, file or question.',
  'Use plain sentence case, no quotes, no trailing full stop, no emoji. Prefer concrete nouns ("Retry backoff in login client") over vague ones ("Code changes").',
  'Do not include ticket keys or PR numbers; they are added separately.',
  'If you are given a current name and it still describes the conversation well, reply with exactly KEEP.',
  'Reply with the title only.',
].join('\n');

/// The user message for the naming turn. `excerpt` is already trimmed to
/// size by the caller.
export function titlePrompt(args: { current: string | null; excerpt: string }): string {
  const cur = args.current ? `Current name: ${args.current}\n\n` : '';
  return `${cur}<conversation>\n${args.excerpt}\n</conversation>`;
}

/// A compact transcript for the naming turn: the opening ask (it frames the
/// whole chat) plus the most recent exchanges, each cut short.
export function buildExcerpt(
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
  opts: { perMessage?: number; total?: number } = {},
): string {
  const per = opts.perMessage ?? 600;
  const total = opts.total ?? 4000;
  const clean = messages
    .map((m) => ({ role: m.role, text: m.text.trim().replace(/\s+/g, ' ') }))
    .filter((m) => m.text);
  if (!clean.length) return '';
  const fmt = (m: { role: string; text: string }) =>
    `${m.role === 'user' ? 'Developer' : 'Assistant'}: ${m.text.length > per ? m.text.slice(0, per) + '…' : m.text}`;
  const first = fmt(clean[0]);
  const tail: string[] = [];
  let used = first.length;
  for (let i = clean.length - 1; i > 0; i--) {
    const line = fmt(clean[i]);
    if (used + line.length + 1 > total) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const skipped = clean.length - 1 - tail.length;
  return [first, ...(skipped > 0 ? ['…'] : []), ...tail].join('\n');
}
