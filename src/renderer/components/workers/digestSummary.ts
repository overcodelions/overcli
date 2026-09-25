// What a finished job ACHIEVED, as a headline, a sentence and a few facts —
// the words on a Today digest card.
//
// Two sources, best first:
//
//   1. What the worker said about its own work, in the protocol tags its
//      final step is asked to emit (`<headline>`, `<points>`). A worker
//      knows what mattered; a heuristic only knows where the headings are.
//   2. The deliverable itself (or, with none, the run's last message), read
//      the way a person skims: the title, the first real sentence, the first
//      few bullets.
//
// Every worker hired before the tags existed simply takes the second path, so
// nothing about an existing worker or flow has to change for its card to read.

export interface DigestSummary {
  headline: string;
  summary: string;
  points: string[];
}

const MAX_HEADLINE = 140;
const MAX_SUMMARY = 240;
const MAX_POINTS = 3;
const MAX_POINT = 160;

/// Titles that name the document rather than say what it found. A card
/// headed "Report" says nothing a filename didn't.
const GENERIC_TITLE =
  /^(summary|report|results?|output|findings|notes|overview|status|update|plan|briefing|digest|daily brief(ing)?)\b[\s:—-]*$/i;

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/// Markdown decoration off a line of prose: emphasis, inline code, links.
function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/// An HTML deliverable as text a skim can read: headings kept as markdown
/// headings and list items as bullets, everything else as paragraphs.
export function htmlToSkimText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    // A script or style the read cut off before its closing tag runs to the
    // end of what we have — its code is not the page's words.
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${'#'.repeat(Number(n))} ${t}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1\n')
    .replace(/<(p|div|br|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/// The worker's own account, when its final step gave one.
export function taggedDigest(text: string): DigestSummary | null {
  const headline = text.match(/<headline>([\s\S]*?)<\/headline>/i)?.[1];
  if (!headline?.trim()) return null;
  const pointsBlock = text.match(/<points>([\s\S]*?)<\/points>/i)?.[1] ?? '';
  const points = pointsBlock
    .split('\n')
    .map((l) => plain(l.replace(/^\s*[-*•]\s*/, '')))
    .filter(Boolean)
    .slice(0, MAX_POINTS)
    .map((p) => clip(p, MAX_POINT));
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? '';
  return { headline: clip(plain(headline), MAX_HEADLINE), summary: clip(plain(summary), MAX_SUMMARY), points };
}

/// A skim of a document: its title (when the title says something), its
/// first real sentence, and its first few bullets.
export function skimDigest(text: string, fallbackTitle: string): DigestSummary {
  const lines = text.split('\n').map((l) => l.trim());
  let title = '';
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) paragraphs.push(plain(para.join(' ')));
    para = [];
  };
  for (const line of lines) {
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || line.startsWith('```') || line.startsWith('|')) {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      if (!title) title = plain(heading[1]);
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      const b = plain(bullet[1]);
      if (b && bullets.length < MAX_POINTS) bullets.push(clip(b, MAX_POINT));
      continue;
    }
    para.push(line);
  }
  flush();

  const firstPara = paragraphs.find((p) => p.length > 20) ?? paragraphs[0] ?? '';
  const firstSentence = firstPara.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? firstPara;
  const useTitle = title && !GENERIC_TITLE.test(title) && title.length > 12;
  const headline = useTitle ? title : firstSentence || title || fallbackTitle;
  // The summary must add something the headline did not already say.
  const summarySource = useTitle ? firstPara : firstPara.slice(firstSentence.length).trim() || '';
  return {
    headline: clip(headline || fallbackTitle, MAX_HEADLINE),
    summary: clip(summarySource, MAX_SUMMARY),
    points: bullets,
  };
}

/// Code is not a headline. A page that draws itself with JavaScript has
/// almost no text in its markup, and what a skim finds there is its script.
function looksLikeCode(s: string): boolean {
  return /(^|\s)(const|let|var|function|import|return)\s|[;{}]\s*$|=>|===|\(\)\s*\{/.test(s);
}

/// The card's words for one finished job. `text` is the deliverable (or the
/// run's last message); `kind` says how to read it.
export function digestFor(text: string, kind: 'markdown' | 'html' | 'text', fallbackTitle: string): DigestSummary {
  const tagged = taggedDigest(text);
  if (tagged) return tagged;
  const skimmable = kind === 'html' ? htmlToSkimText(text) : text;
  const skim = skimDigest(skimmable, fallbackTitle);
  // A page's own <title> beats a skim of a page that renders itself.
  const pageTitle = kind === 'html' ? plain(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') : '';
  // …and so does a skim that found no words at all and fell back to the job.
  const headline =
    looksLikeCode(skim.headline) || skim.headline === fallbackTitle ? pageTitle || fallbackTitle : skim.headline;
  return {
    headline: clip(headline, MAX_HEADLINE),
    summary: looksLikeCode(skim.summary) ? '' : skim.summary,
    points: skim.points.filter((p) => !looksLikeCode(p)),
  };
}

/// How to read a file, by its name.
export function kindOf(fileName: string): 'markdown' | 'html' | 'text' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return 'text';
}
