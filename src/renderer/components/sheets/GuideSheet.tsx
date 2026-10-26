// The user guide, in the app. Help → Overcli Guide, the command palette, and
// the footers of the two shorter help sheets.
//
// The pages are docs/guide/*.md, bundled at build time (see guide.ts), so
// they work offline and always describe the build you are running. GitHub
// renders the same files; nothing here is a second copy to keep in sync.
//
// Mermaid diagrams go into the app's own DOM here, not into the sandboxed
// frame the file preview uses. That frame exists because a previewed file is
// whatever is on disk; these pages ship inside the app, so the only thing
// reaching the DOM is our own markdown through the chat sanitizer and
// mermaid's SVG through its own SVG-only pass (sanitizeMermaidSvg).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import {
  GUIDE_PAGES,
  GUIDE_URL,
  absolutizeGuideLinks,
  headingSlugs,
  resolveGuideLink,
} from '../../guide';
import {
  applyMermaidDiagrams,
  extractMermaidBlocks,
  renderMermaidDiagrams,
  type MermaidDiagrams,
} from '../../mermaid';
import { renderMarkdownHtml } from '../Markdown';
import { HeroArt } from '../onboarding/basics';

export function GuideSheet({ initialPage }: { initialPage?: string }) {
  const openSheet = useStore((s) => s.openSheet);
  const [slug, setSlug] = useState(() =>
    GUIDE_PAGES.some((p) => p.slug === initialPage) ? initialPage! : GUIDE_PAGES[0]?.slug ?? '',
  );
  // Heading to land on once the page has rendered; null scrolls to the top.
  const [anchor, setAnchor] = useState<{ id: string | null }>({ id: null });
  const [query, setQuery] = useState('');
  const dark = useDarkClass();
  const bodyRef = useRef<HTMLDivElement>(null);

  const page = GUIDE_PAGES.find((p) => p.slug === slug) ?? GUIDE_PAGES[0];
  const source = useMemo(() => (page ? absolutizeGuideLinks(page.source, page.slug) : ''), [page]);
  const blocks = useMemo(() => extractMermaidBlocks(source), [source]);
  const [diagrams, setDiagrams] = useState<MermaidDiagrams>({});

  useEffect(() => {
    let cancelled = false;
    setDiagrams({});
    renderMermaidDiagrams(blocks, { dark })
      .then((d) => !cancelled && setDiagrams(d))
      .catch(() => !cancelled && setDiagrams({}));
    return () => {
      cancelled = true;
    };
  }, [blocks, dark]);

  const html = useMemo(
    () =>
      applyMermaidDiagrams(
        renderMarkdownHtml(source, { enableFilePathLinks: false, mermaidPlaceholders: blocks.length > 0 }),
        blocks,
        diagrams,
      ),
    [blocks, diagrams, source],
  );

  // The sanitizer strips `id`, so headings get their GitHub-style anchors
  // after the fact. Runs on every html change: diagrams arriving re-render
  // the whole body.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4'));
    const ids = headingSlugs(headings.map((h) => h.textContent ?? ''));
    headings.forEach((h, i) => (h.id = ids[i]));
  }, [html]);

  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const target = anchor.id ? root.querySelector<HTMLElement>(`#${CSS.escape(anchor.id)}`) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else root.scrollTop = 0;
  }, [anchor, slug]);

  const go = (next: string, id: string | null = null) => {
    setSlug(next);
    setAnchor({ id });
  };

  const q = query.trim().toLowerCase();
  const visible = q
    ? GUIDE_PAGES.filter((p) => p.label.toLowerCase().includes(q) || p.source.toLowerCase().includes(q))
    : GUIDE_PAGES;

  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('code-copy')) {
      const text = target.parentElement?.querySelector('code')?.textContent ?? '';
      if (text) void navigator.clipboard.writeText(text);
      target.textContent = 'copied';
      window.setTimeout(() => (target.textContent = 'copy'), 1200);
      return;
    }
    const link = target.closest('a');
    const href = link?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    const resolved = resolveGuideLink(href, GUIDE_PAGES);
    if (resolved.kind === 'page') go(resolved.slug, resolved.anchor);
    else void window.overcli.invoke('app:openExternal', resolved.href);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-card px-5 py-3">
        <HeroArt size={26} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">Overcli guide</div>
          <div className="text-[11px] text-ink-faint">
            Getting started, how it works, and every feature in one place.
          </div>
        </div>
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink"
          onClick={() => void window.overcli.invoke('app:openExternal', `${GUIDE_URL}${page?.slug ?? 'README'}.md`)}
        >
          Open on GitHub ↗
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink"
          onClick={() => openSheet(null)}
        >
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[210px] shrink-0 flex-col border-r border-card bg-card/30">
          <div className="p-2.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the guide…"
              className="w-full rounded border border-card-strong bg-surface px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            {visible.map((p) => (
              <button
                key={p.slug}
                type="button"
                onClick={() => go(p.slug)}
                className={
                  'block w-full truncate rounded px-2.5 py-1.5 text-left text-[12px] ' +
                  (p.slug === page?.slug
                    ? 'bg-accent/15 font-medium text-ink'
                    : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                }
              >
                {p.label}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-2.5 py-1.5 text-[11px] text-ink-faint">Nothing matches “{query}”.</div>
            )}
          </div>
        </nav>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          <div
            className={
              'md select-text mx-auto max-w-[760px] text-[13px] leading-[1.7] ' +
              '[&_h1]:mb-3 [&_h1]:text-[22px] [&_h1]:tracking-tight ' +
              '[&_h2]:mt-8 [&_h2]:border-b [&_h2]:border-card [&_h2]:pb-1.5 [&_h2]:text-[16px] ' +
              '[&_h3]:mt-5 [&_h3]:text-[14px] ' +
              '[&_.mermaid-diagram]:my-5 [&_.mermaid-diagram]:flex [&_.mermaid-diagram]:justify-center ' +
              '[&_.mermaid-diagram]:rounded-lg [&_.mermaid-diagram]:border [&_.mermaid-diagram]:border-card ' +
              '[&_.mermaid-diagram]:p-4 [&_.mermaid-diagram_svg]:h-auto [&_.mermaid-diagram_svg]:max-w-full'
            }
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );
}

function useDarkClass(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
