// What a finished piece of work came to, in one line, for a row that would
// otherwise be titled with the raw ask ("paste it here"). Read from what is
// already kept, never a model call: an `Outcome:` line the worker wrote, the
// run's own digest headline, or the reply's heading or first sentence when
// that says something.

const MAX = 110;
/// An `Outcome:` line near the top, bold or not.
const OUTCOME_LINE = /^\s*(?:[*_]{1,2})?outcome(?:[*_]{1,2})?\s*[:：]\s*(?:[*_]{1,2})?\s*(.+?)\s*$/i;
/// Openers that are talk, not a result.
const FILLER = /^(?:sure|ok(?:ay)?|hi|hello|hey|thanks|thank you|great|got it|done|of course|absolutely|certainly|here(?:'s|’s| is| are)|below|i(?:'ll|’ll| will| can| have| am|'m|’m| looked| checked)|let me|good (?:morning|afternoon|evening)|quick (?:answer|update))\b/i;

/// Markdown stripped to the words.
function plain(s: string): string {
  let out = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '');
  // Tags off until none are left, so one nested in another can't survive a
  // single pass; then any stray angle bracket.
  let before: string;
  do {
    before = out;
    out = out.replace(/<[^<>]*>/g, '');
  } while (out !== before);
  return out.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

/// A one-line outcome worth showing, or undefined.
function usable(raw: string | undefined, title: string): string | undefined {
  let s = plain(raw ?? '').replace(/^[-–—:•\s]+/, '');
  if (!s) return undefined;
  s = s.replace(/[.:;,]+$/, '').trim();
  if (s.length < 8 || s.split(/\s+/).length < 3) return undefined;
  if (s.length > MAX) return undefined;
  if (/\?$/.test(s) || FILLER.test(s) || /^https?:\/\//.test(s)) return undefined;
  const same = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (same(s) === same(title)) return undefined;
  return s;
}

/// The body's own one-line outcome: an `Outcome:` line in its first few
/// lines, else its opening heading, a bold opening line, or its first sentence.
export function outcomeFromBody(body: string | undefined, title: string): string | undefined {
  const lines = (body ?? '').replace(/\r/g, '').split('\n');
  const head = lines.filter((l) => l.trim()).slice(0, 6);
  for (const l of head) {
    const m = OUTCOME_LINE.exec(l);
    if (m) return usable(m[1], title);
  }
  const first = head[0]?.trim();
  if (!first) return undefined;
  // A fence, a table or a list up front: the reply leads with material, not a summary.
  if (/^(?:```|~~~|\||[-*+]\s|\d+[.)]\s|>)/.test(first)) return undefined;
  const heading = /^#{1,6}\s+(.*)$/.exec(first);
  if (heading) return usable(heading[1].replace(/\s+#+\s*$/, ''), title);
  const bold = /^\*\*([^*]+)\*\*:?$/.exec(first);
  if (bold) return usable(bold[1], title);
  // The first sentence of the first paragraph, when it ends inside the line.
  const sentence = /^(.+?[.!])(?:\s|$)/.exec(first);
  return sentence ? usable(sentence[1], title) : undefined;
}

/// What a library item leads with: the worker's `Outcome:` line, its run's
/// digest headline, else the body's heading or first sentence. Undefined when
/// none says more than the title does.
export function outcomeOf(input: { title: string; body?: string; headline?: string }): string | undefined {
  const lines = (input.body ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim()).slice(0, 6);
  const marked = lines.map((l) => OUTCOME_LINE.exec(l)).find(Boolean);
  if (marked) return usable(marked[1], input.title);
  return usable(input.headline, input.title) ?? outcomeFromBody(input.body, input.title);
}
