/// <reference types="vite/client" />

// The user guide, bundled into the app from docs/guide/*.md.
//
// The same markdown is what GitHub renders, so the pages are written with
// relative links between them (`concepts.md#run-modes…`) and links out into
// the repo (`../../deploy/README.md`). The chat renderer's sanitizer only
// lets absolute http(s) hrefs through, so before rendering every relative
// link is rewritten to its GitHub URL. That is a real page if it ever leaks
// out, and the Guide sheet recognises the guide's own prefix on click and
// navigates in place instead.

export const GUIDE_URL = 'https://github.com/overcodelions/overcli/blob/master/docs/guide/';

export interface GuidePage {
  slug: string;
  /// Short name for the sheet's nav rail. The page's own `# heading` is
  /// longer and is what the page shows.
  label: string;
  source: string;
}

/// Nav order. A page missing from disk is dropped rather than shown empty,
/// and a page on disk missing from here is appended so it can't go unseen.
const ORDER: Array<[slug: string, label: string]> = [
  ['README', 'Start here'],
  ['getting-started', 'Getting started'],
  ['concepts', 'How Overcli works'],
  ['chats-and-agents', 'Chats and agents'],
  ['workspaces-and-documents', 'Workspaces & documents'],
  ['flows', 'Flows'],
  ['workers-and-teams', 'Workers and teams'],
  ['services', 'Services'],
  ['slack-and-org', 'Slack & org server'],
  ['headless-cli', 'Headless CLI'],
  ['troubleshooting', 'Troubleshooting'],
];

const RAW = import.meta.glob('../../docs/guide/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function buildGuidePages(raw: Record<string, string>): GuidePage[] {
  const bySlug = new Map<string, string>();
  for (const [file, source] of Object.entries(raw)) {
    const slug = file.split('/').pop()!.replace(/\.md$/, '');
    bySlug.set(slug, source);
  }
  const pages: GuidePage[] = [];
  for (const [slug, label] of ORDER) {
    const source = bySlug.get(slug);
    if (source === undefined) continue;
    pages.push({ slug, label, source });
    bySlug.delete(slug);
  }
  for (const [slug, source] of bySlug) {
    pages.push({ slug, label: headingOf(source) ?? slug, source });
  }
  return pages;
}

export const GUIDE_PAGES: GuidePage[] = buildGuidePages(RAW);

function headingOf(source: string): string | null {
  const m = source.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/\*/g, '').trim() : null;
}

/// Rewrite every relative markdown link to an absolute GitHub URL, resolved
/// against the page's own location. Absolute links, mailto: and the like
/// are left alone; a bare `#anchor` resolves against the current page.
export function absolutizeGuideLinks(source: string, slug: string): string {
  const base = `${GUIDE_URL}${slug}.md`;
  return source.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
    try {
      return `](${new URL(target, base).href})`;
    } catch {
      return whole;
    }
  });
}

export type GuideLink =
  | { kind: 'page'; slug: string; anchor: string | null }
  | { kind: 'external'; href: string };

/// What a click on `href` inside the guide should do: move to another guide
/// page (and maybe a heading on it), or leave for the browser.
export function resolveGuideLink(href: string, pages: readonly GuidePage[]): GuideLink {
  if (href.startsWith(GUIDE_URL)) {
    const rest = href.slice(GUIDE_URL.length);
    const hash = rest.indexOf('#');
    const file = hash === -1 ? rest : rest.slice(0, hash);
    const anchor = hash === -1 ? null : decodeURIComponent(rest.slice(hash + 1)) || null;
    const slug = file.replace(/\.md$/, '') || 'README';
    if (!file.includes('/') && pages.some((p) => p.slug === slug)) {
      return { kind: 'page', slug, anchor };
    }
  }
  return { kind: 'external', href };
}

/// GitHub's heading anchor: lowercase, punctuation dropped, spaces to
/// hyphens. Matching it is what makes `concepts.md#run-modes-where-the-work-happens`
/// land on the same heading here as on github.com.
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/// Anchor ids for a page's headings, in document order, with GitHub's `-1`,
/// `-2` suffixes for repeats.
export function headingSlugs(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = headingSlug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  });
}
