// The coordinator's room wrap-up, read back into its parts: a bottom line,
// what the team agreed, what is still open, and what is worth changing in the
// pack. The wrap-up is plain Markdown written by a model, so this reads the
// shapes it actually comes back in — bold labels, headings, bullets, or all
// three run together in one paragraph — and gives up (null) on text that has
// none of the labels, which the desk then shows as it is.

export interface WrapUp {
  /// One or two sentences: where the discussion landed. Empty when the
  /// wrap-up went straight to its lists.
  bottomLine: string;
  agreed: string[];
  /// Each item may end in who answers it and by when, after a dash: see
  /// `splitOwner`.
  open: string[];
  changes: string[];
}

type Section = 'bottom' | 'agreed' | 'open' | 'changes';

/// The words each part is introduced by, longest first so "Still open" wins
/// over "Open".
const LABELS: Array<{ section: Section; pattern: string }> = [
  { section: 'changes', pattern: 'worth changing in the pack|changes? (?:to|in|for) the pack|worth changing|pack changes?' },
  { section: 'open', pattern: 'still open|open questions?|unresolved|open' },
  { section: 'agreed', pattern: 'agreed|agreement|consensus' },
  { section: 'bottom', pattern: 'bottom line|in short|tl;?dr|summary' },
];

const ALT = LABELS.map((l) => l.pattern).join('|');
// A label that is bold or a heading may sit anywhere ("… **Still open:** …");
// a plain one only counts at the start of a line, so "the question still
// open: X" inside a sentence is not read as a section.
const BOLD_LABEL = new RegExp(`(?:\\*\\*|__)\\s*(${ALT})\\s*(?::\\s*(?:\\*\\*|__)|(?:\\*\\*|__)\\s*:)`, 'gi');
const LINE_LABEL = new RegExp(
  `^[ \\t]*(?:#{1,6}[ \\t]*)?(?:[-*•][ \\t]+)?(?:\\*\\*|__)?(${ALT})(?:\\*\\*|__)?[ \\t]*(?::|$)`,
  'gim',
);

const NOTHING = /^(?:none|nothing|n\/?a|no(?:ne)? (?:yet|so far)|—|-|–|…|\.\.\.)\.?$/i;

function sectionOf(label: string): Section {
  const l = label.toLowerCase();
  for (const { section, pattern } of LABELS) if (new RegExp(`^(?:${pattern})$`, 'i').test(l)) return section;
  return 'bottom';
}

/// Markdown emphasis and list markers off one item.
function clean(text: string): string {
  return text
    .replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/// A section's body as items: one per bullet (lines that continue a bullet
/// join it), else one per paragraph; "None" and the like are no item at all.
function items(body: string): string[] {
  const out: string[] = [];
  const lines = body.split('\n');
  const bullet = /^\s*(?:[-*•+]|\d+[.)])\s+/;
  const anyBullet = lines.some((l) => bullet.test(l));
  let current: string | null = null;
  const flush = () => {
    if (current === null) return;
    const c = clean(current);
    if (c && !NOTHING.test(c)) out.push(c);
    current = null;
  };
  for (const line of lines) {
    if (!line.trim()) {
      if (!anyBullet) flush();
      continue;
    }
    if (bullet.test(line)) {
      flush();
      current = line;
    } else if (current === null) {
      current = line;
    } else {
      current += ` ${line.trim()}`;
    }
  }
  flush();
  return out;
}

export function parseWrapUp(text: string): WrapUp | null {
  const src = (text ?? '').replace(/\r\n?/g, '\n');
  const marks: Array<{ at: number; end: number; section: Section }> = [];
  for (const re of [BOLD_LABEL, LINE_LABEL]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const at = m.index;
      const end = at + m[0].length;
      if (marks.some((k) => at < k.end && end > k.at)) continue;
      marks.push({ at, end, section: sectionOf(m[1]) });
    }
  }
  if (!marks.some((m) => m.section !== 'bottom')) return null;
  marks.sort((a, b) => a.at - b.at);

  const out: WrapUp = { bottomLine: '', agreed: [], open: [], changes: [] };
  const bottom: string[] = [];
  const lead = src.slice(0, marks[0].at).trim();
  if (lead) bottom.push(lead);
  marks.forEach((mark, i) => {
    const body = src.slice(mark.end, marks[i + 1]?.at ?? src.length).replace(/^[ \t]*(?:\*\*|__)?[ \t]*/, '');
    if (mark.section === 'bottom') {
      if (body.trim()) bottom.push(body.trim());
      return;
    }
    out[mark.section].push(...items(body));
  });
  out.bottomLine = clean(bottom.join(' ').replace(/^#{1,6}\s+.*$/gm, ''));
  if (NOTHING.test(out.bottomLine)) out.bottomLine = '';
  return out;
}

/// An open item's question and, when the wrap-up said, who answers it and by
/// when: "Which roles are filled? — payroll, by Dec 15" reads as the question
/// and "payroll, by Dec 15". A trailing "(…)" counts the same way.
export function splitOwner(item: string): { text: string; who?: string } {
  const dash = item.match(/^(.*\S)\s+(?:—|–|--|-)\s+(\S.*)$/);
  if (dash && dash[1].length >= 8) return { text: dash[1], who: dash[2] };
  const paren = item.match(/^(.*\S)\s*\(([^()]+)\)\.?$/);
  if (paren && paren[1].length >= 8) return { text: paren[1], who: paren[2] };
  return { text: item };
}
