// The org docs (deploy/docs, plus the deploy guides beside them), served by
// the control plane at /docs: the same Markdown GitHub shows, rendered for
// the version actually running, readable inside a VPC with no way out to
// GitHub. Public — there is nothing secret in them, and "how do I sign in"
// is a question asked before signing in.

import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

/// slug → file, relative to deploy/docs. The order is the sidebar's, and
/// pages sharing a group sit under one heading in it.
const PAGES: Array<{ slug: string; file: string; group: string }> = [
  { slug: '', file: 'README.md', group: 'Get started' },
  { slug: 'overview', file: 'overview.md', group: 'Get started' },
  { slug: 'getting-started', file: 'getting-started.md', group: 'Get started' },
  { slug: 'using', file: 'using.md', group: 'Use it' },
  { slug: 'managers', file: 'managers.md', group: 'Use it' },
  { slug: 'admins', file: 'admins.md', group: 'Use it' },
  { slug: 'security', file: 'security.md', group: 'Run it' },
  { slug: 'operator', file: '../README.md', group: 'Run it' },
  { slug: 'aws', file: '../aws.md', group: 'Run it' },
  { slug: 'gcp', file: '../gcp.md', group: 'Run it' },
  { slug: 'reference', file: 'reference.md', group: 'Look it up' },
];

let dirCache: string | null | undefined;
export function docsDir(): string | null {
  if (dirCache !== undefined) return dirCache;
  const candidates = [path.join(__dirname, '../../deploy/docs'), path.join(process.cwd(), 'deploy/docs'), '/app/deploy/docs'];
  dirCache = candidates.find((d) => fs.existsSync(path.join(d, 'README.md'))) ?? null;
  return dirCache;
}

/// A Markdown link between the docs, as a /docs address: `admins.md#roles`
/// → `/docs/admins#roles`, `../aws.md` → `/docs/aws`. Anything else as is.
export function docsHref(href: string): string {
  const m = /^(\.\.\/)?([\w-]+)\.md(#[\w-]*)?$/.exec(href);
  if (!m) return href;
  const file = `${m[1] ?? ''}${m[2]}.md`;
  const page = PAGES.find((p) => p.file === file);
  return page ? `/docs${page.slug ? `/${page.slug}` : ''}${m[3] ?? ''}` : href;
}

function titleOf(markdown: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? 'Docs';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/// What the sidebar calls a page: its own title, shortened where the deploy
/// guides spell out the whole sentence, and whether it is still alpha.
function navTitle(p: (typeof PAGES)[number], markdown: string | null): { title: string; alpha: boolean } {
  if (p.slug === '') return { title: 'Start here', alpha: false };
  const full = markdown ? titleOf(markdown) : p.slug;
  const alpha = /\(alpha\)/i.test(full);
  const title = full
    .replace(/\s*\(alpha\)\s*/i, '')
    .replace(/^Running overgo for your org.*$/, 'Docker and compose')
    .replace(/^overgo for your org on /, '')
    .replace(/^overgo on /, '');
  return { title, alpha };
}

function readPage(dir: string, p: (typeof PAGES)[number]): string | null {
  try {
    return fs.readFileSync(path.join(dir, p.file), 'utf8');
  } catch {
    return null;
  }
}

/// Rendered HTML's text: everything between `<` and `>` dropped, counting
/// nesting, so a tag inside a tag (`<<b>i>`) leaves nothing that reads as
/// markup. A scan rather than a regex, which a single pass can't make safe.
export function plainText(html: string): string {
  let out = '';
  let depth = 0;
  for (const ch of html) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}
const slugify = (text: string) => plainText(text).toLowerCase().replace(/&[a-z]+;/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');
const href = (p: (typeof PAGES)[number]) => `/docs${p.slug ? `/${p.slug}` : ''}`;

// GitHub's alert syntax (> [!NOTE], > [!WARNING]…), so the same Markdown
// reads right on GitHub and here.
const CALLOUTS: Record<string, string> = { NOTE: 'Note', TIP: 'What to do', IMPORTANT: 'Important', WARNING: 'The risk', CAUTION: 'Careful' };

/// The page for a /docs path, or null when there is no such page.
export function renderDocsPage(urlPath: string): string | null {
  const dir = docsDir();
  if (!dir) return null;
  const slug = urlPath.replace(/^\/docs\/?/, '').replace(/\/$/, '').replace(/\.md$/, '');
  const page = PAGES.find((p) => p.slug === slug || (p.slug === '' && slug === 'README'));
  if (!page) return null;
  const markdown = readPage(dir, page);
  if (markdown === null) return null;
  const sections: Array<{ id: string; text: string }> = [];
  const body = (marked.parse(markdown, { async: false }) as string)
    .replace(/<a href="([^"]+)"/g, (_m, link: string) => {
      const to = docsHref(link);
      return /^https?:/.test(to) ? `<a href="${to}" target="_blank" rel="noopener"` : `<a href="${to}"`;
    })
    // Headings get anchors, so "Learn more" links can land on a section, and
    // the h2s become the page's own contents.
    .replace(/<h([23])>(.+?)<\/h\1>/g, (_m, level: string, text: string) => {
      const id = slugify(text);
      if (level === '2') sections.push({ id, text: plainText(text) });
      return `<h${level} id="${id}">${text}</h${level}>`;
    })
    .replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, (_m, kind: string) =>
      `<blockquote class="callout ${kind.toLowerCase()}"><p class="callout-title">${CALLOUTS[kind]}</p><p>`)
    .replace(/<pre><code class="language-flow">([\s\S]*?)<\/code><\/pre>/g, (_m, src: string) => flowDiagram(src))
    .replace(/<table>/g, '<div class="doc-table"><table>')
    .replace(/<\/table>/g, '</table></div>');

  const titles = PAGES.map((p) => ({ p, ...navTitle(p, p === page ? markdown : readPage(dir, p)) }));
  const groups: string[] = [];
  const nav = titles.map(({ p, title, alpha }) => {
    const head = groups.includes(p.group) ? '' : (groups.push(p.group), `<div class="docs-group">${esc(p.group)}</div>`);
    return `${head}<a href="${href(p)}"${p === page ? ' aria-current="page"' : ''}>${esc(title)}${alpha ? ' <span class="docs-alpha">alpha</span>' : ''}</a>`;
  }).join('');

  const at = PAGES.indexOf(page);
  const prev = at > 0 ? titles[at - 1] : null;
  const next = at < PAGES.length - 1 ? titles[at + 1] : null;
  const pager = `<nav class="docs-pager" aria-label="Next and previous">${prev ? `<a href="${href(prev.p)}"><span>← Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${href(next.p)}"><span>Next →</span>${esc(next.title)}</a>` : ''}</nav>`;
  const words = markdown.split(/\s+/).length;
  const crumb = `<div class="docs-crumb">${esc(page.group)}${page.slug ? ` / ${esc(titles[at].title)}` : ''} · ${Math.max(1, Math.round(words / 220))} min read</div>`;
  const toc = sections.length > 1
    ? `<aside class="docs-toc" aria-label="On this page"><div class="docs-group">On this page</div>${sections.map((x) => `<a href="#${x.id}">${x.text}</a>`).join('')}</aside>`
    : '';
  // What the search box looks through: every page's title and sections.
  const index = JSON.stringify(titles.map(({ p, title }) => {
    const md = p === page ? markdown : readPage(dir, p) ?? '';
    return { t: title, u: href(p), h: [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => [m[1].replace(/[`*_]/g, '').trim(), slugify(m[1])]) };
  })).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleOf(markdown))} · overgo docs</title>
<link rel="stylesheet" href="/console.css"><link rel="stylesheet" href="/docs.css"></head>
<body class="docs">
<header class="docs-top">
<a href="/docs" class="docs-brand">${MARK}<span>overgo <span class="docs-dim">docs</span></span><span class="alpha">alpha</span></a>
<div class="docs-search"><label class="search">${SEARCH_ICON}<input type="search" id="docs-q" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off"><kbd>/</kbd></label><div class="docs-results" id="docs-results" role="listbox" hidden></div></div>
<a href="/" class="btn small">Open the console</a>
</header>
<div class="docs-body">
<nav class="docs-nav" aria-label="Docs">${nav}</nav>
<main class="docs-main"><article class="doc">${crumb}${body}${pager}</article>${toc}</main>
</div>
<script type="application/json" id="docs-index">${index}</script>
<script src="/docs.js"></script>
</body></html>`;
}

/// A request's path, drawn: the ask on the left, the steps down the middle,
/// what comes back beside each. The block's text arrives HTML-escaped from
/// marked, so its pieces go into the page as they are.
///
///   ask: Who asks | What they ask
///   step: Title | Detail | What comes back (either may be empty)
function flowDiagram(src: string): string {
  let ask = '';
  let lane = '';
  const steps: string[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*(ask|step):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [a = '', b = '', c = ''] = m[2].split(/\s+\|\s+/).map((x) => x.trim());
    if (m[1] === 'ask') { lane = a; ask = b; continue; }
    steps.push(`<li><div class="flow-step"><span class="flow-n">${steps.length + 1}</span><div><b>${a}</b>${b ? `<p>${b}</p>` : ''}</div></div>`
      + (c ? `<div class="flow-out"><span class="flow-arrow" aria-hidden="true"></span><p>${c}</p></div>` : '<div></div>') + '</li>');
  }
  return `<figure class="flow"><div class="flow-cols" aria-hidden="true"><span>${lane}</span><span>The org server</span><span>Back in the thread</span></div>`
    + `<div class="flow-body"><div class="flow-ask"><p>${ask}</p></div><ol class="flow-steps">${steps.join('')}</ol></div></figure>`;
}

const MARK = '<svg class="docs-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#fafaf8" stroke="#000" stroke-opacity="0.14"/><path d="M10 9.5h12" stroke="#111113" stroke-width="3" stroke-linecap="round"/><path d="M10 19h11.5M17 14.5l4.5 4.5-4.5 4.5" fill="none" stroke="#111113" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

/// Search over the page and section titles, and which section of the page
/// you are reading. A file, not inline: the CSP runs no inline script.
export const DOCS_JS = `(function () {
  var q = document.getElementById('docs-q'), box = document.getElementById('docs-results');
  var index = JSON.parse(document.getElementById('docs-index').textContent || '[]');
  var hits = [], at = 0;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function draw() {
    var term = q.value.trim().toLowerCase();
    box.textContent = ''; hits = []; at = 0;
    if (!term) { box.hidden = true; return; }
    index.forEach(function (p) {
      if (p.t.toLowerCase().indexOf(term) >= 0) hits.push({ t: p.t, s: '', u: p.u });
      p.h.forEach(function (h) { if (h[0].toLowerCase().indexOf(term) >= 0) hits.push({ t: h[0], s: p.t, u: p.u + '#' + h[1] }); });
    });
    hits = hits.slice(0, 8);
    if (!hits.length) box.appendChild(el('div', 'docs-none', 'Nothing matches.'));
    hits.forEach(function (x, i) {
      var a = el('a', i === 0 ? 'on' : ''); a.href = x.u; a.setAttribute('role', 'option');
      a.appendChild(el('span', '', x.t)); if (x.s) a.appendChild(el('small', '', x.s));
      box.appendChild(a);
    });
    box.hidden = false;
  }
  function move(d) {
    var links = box.querySelectorAll('a'); if (!links.length) return;
    links[at].className = ''; at = (at + d + links.length) % links.length; links[at].className = 'on';
  }
  q.addEventListener('input', draw);
  q.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && hits[at]) location.href = hits[at].u;
    else if (e.key === 'Escape') { q.value = ''; draw(); q.blur(); }
  });
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); q.focus(); q.select(); }
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.docs-search')) box.hidden = true; });
  var toc = document.querySelectorAll('.docs-toc a');
  if (toc.length && 'IntersectionObserver' in window) {
    var mark = function (id) { toc.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + id); }); };
    var seen = new IntersectionObserver(function (es) {
      es.forEach(function (x) { if (x.isIntersecting) mark(x.target.id); });
    }, { rootMargin: '0px 0px -70% 0px' });
    document.querySelectorAll('.doc h2[id]').forEach(function (h) { seen.observe(h); });
    mark(toc[0].getAttribute('href').slice(1));
  }
})();
`;

export const DOCS_CSS = `
/* The console's frame, so the docs read as the same product. */
body.docs { margin: 0; background: var(--bg); color: var(--ink); }
.docs-top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 16px; background: var(--side); border-bottom: 1px solid var(--line); }
.docs-brand { display: inline-flex; align-items: center; gap: 10px; width: 216px; flex: none; color: var(--ink); text-decoration: none; font-family: var(--serif); font-size: 16px; font-weight: 500; }
.docs-dim { color: var(--faint); }
.docs-mark { flex: none; }
.docs-search { position: relative; flex: 1 1 260px; max-width: 520px; }
.docs-search .search { max-width: none; }
.docs-results { position: absolute; left: 0; right: 0; top: calc(100% + 6px); background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--r-lg); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); padding: 6px; z-index: 10; }
.docs-results a { display: flex; flex-direction: column; padding: 8px 10px; border-radius: var(--r-sm); color: var(--ink); text-decoration: none; font-size: 13.5px; }
.docs-results a small { color: var(--faint); font-size: 12px; }
.docs-results a.on, .docs-results a:hover { background: var(--go-soft); }
.docs-none { padding: 10px; color: var(--faint); font-size: 13px; }
.docs-top .btn { margin-left: auto; }
.docs-body { display: flex; flex-wrap: wrap; min-height: calc(100vh - 56px); }
/* Pinned under the top bar, scrolling on its own when it is the taller one. */
.docs-nav { flex: 0 0 232px; box-sizing: border-box; background: var(--side); border-right: 1px solid var(--line); padding: 8px 10px 24px; display: flex; flex-direction: column; gap: 2px;
  position: sticky; top: 56px; align-self: flex-start; height: calc(100vh - 56px); overflow-y: auto; }
.docs-group { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); padding: 16px 10px 6px; }
.docs-nav a { display: block; padding: 6px 10px; border-radius: var(--r-sm); color: var(--muted); text-decoration: none; font-size: 13.5px; }
.docs-nav a:hover { color: var(--ink); background: var(--panel-2); }
.docs-nav a[aria-current="page"] { color: var(--go); background: var(--go-soft); font-weight: 600; }
.docs-alpha { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--need); margin-left: 4px; }
.docs-main { flex: 999 1 560px; min-width: 0; display: flex; gap: 48px; align-items: flex-start; padding: 32px 40px 80px; box-sizing: border-box; }
.doc { flex: 1 1 auto; min-width: 0; max-width: 780px; line-height: 1.65; font-size: 15px; }
.docs-crumb { font-size: 12.5px; color: var(--faint); margin-bottom: 4px; }
.doc h1 { font-family: var(--serif); font-size: 34px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; margin: 0 0 10px; }
.doc h1 + p { font-size: 17px; color: var(--muted); margin-bottom: 8px; }
.doc h2 { font-family: var(--serif); font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 44px 0 12px; scroll-margin-top: 76px; }
.doc h3 { font-size: 16.5px; font-weight: 650; margin: 28px 0 8px; scroll-margin-top: 76px; }
.doc p, .doc ul, .doc ol { margin: 0 0 14px; }
.doc li { margin: 4px 0; }
.doc a { color: var(--go); }
.doc code { font-family: var(--mono, ui-monospace, monospace); font-size: 0.86em; background: var(--panel-2); border: 1px solid var(--line); padding: 0 5px; border-radius: 5px; }
.doc pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; overflow-x: auto; line-height: 1.45; }
.doc pre code { background: none; border: 0; padding: 0; font-size: 13px; }
.doc-table { border: 1px solid var(--line); border-radius: var(--r-lg); overflow-x: auto; background: var(--panel); margin: 0 0 18px; }
.doc table { width: 100%; border-collapse: collapse; font-size: 14px; }
.doc th { text-align: left; font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); padding: 10px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.doc td { padding: 11px 16px; border-top: 1px solid var(--line); vertical-align: top; }
.doc tr:first-child td { border-top: 0; }
.doc blockquote { margin: 0 0 14px; padding: 10px 14px; border: 1px solid var(--line-2); background: var(--panel); border-radius: var(--r); color: var(--muted); }
.doc blockquote p { margin: 0; }
.doc .callout { color: var(--ink); }
.doc .callout .callout-title { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
.doc .callout.note, .doc .callout.important { background: var(--go-soft); border-color: color-mix(in srgb, var(--go) 35%, transparent); } .doc .callout.note .callout-title, .doc .callout.important .callout-title { color: var(--go); }
.doc .callout.tip { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 35%, transparent); } .doc .callout.tip .callout-title { color: var(--ok); }
.doc .callout.warning { background: var(--need-soft); border-color: color-mix(in srgb, var(--need) 40%, transparent); } .doc .callout.warning .callout-title { color: var(--need); }
.doc .callout.caution { background: var(--bad-soft); border-color: var(--bad-line); } .doc .callout.caution .callout-title { color: var(--bad); }
/* The flow diagram: three lanes, the steps joined by a rail. */
.flow { margin: 4px 0 22px; padding: 18px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel); }
.flow-cols, .flow-body { display: grid; grid-template-columns: minmax(150px, 0.8fr) minmax(0, 2.2fr); gap: 16px; }
.flow-cols { grid-template-columns: minmax(150px, 0.8fr) minmax(0, 1.25fr) minmax(0, 0.95fr); margin-bottom: 12px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
.flow-ask { align-self: start; padding: 12px 14px; border-radius: var(--r); background: var(--go-soft); border: 1px solid color-mix(in srgb, var(--go) 30%, transparent); font-size: 14px; position: relative; }
.flow-ask p, .flow p { margin: 0; }
.flow-ask::after { content: ""; position: absolute; right: -16px; top: 22px; width: 16px; height: 1px; background: var(--line-2); }
.flow-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; position: relative; }
.flow-steps li { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.95fr); gap: 16px; align-items: start; position: relative; margin: 0; }
.flow-steps li:not(:last-child)::before { content: ""; position: absolute; left: 25px; top: 38px; bottom: -12px; width: 1px; background: var(--line-2); }
.flow-step { display: flex; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg); position: relative; }
.flow-step b { font-weight: 600; font-size: 14px; }
.flow-step p { font-size: 13px; color: var(--muted); line-height: 1.5; margin-top: 2px; }
.flow-n { flex: none; width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12.5px; font-weight: 700; background: var(--go-soft); color: var(--go); }
.flow-out { display: flex; gap: 10px; align-items: flex-start; padding-top: 12px; font-size: 13.5px; }
.flow-arrow { flex: none; width: 22px; height: 1px; margin-top: 10px; background: var(--line-2); position: relative; }
.flow-arrow::after { content: ""; position: absolute; right: 0; top: -3px; border: 3.5px solid transparent; border-left: 6px solid var(--line-2); border-right: 0; }
@media (max-width: 900px) {
  .flow-cols { display: none; }
  .flow-body, .flow-steps li { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .flow-ask::after, .flow-steps li::before { display: none; }
  .flow-out { padding: 0 0 0 38px; }
}
.docs-pager { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 56px; padding-top: 24px; border-top: 1px solid var(--line); }
.docs-pager a { display: flex; flex-direction: column; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--r-lg); color: var(--ink); text-decoration: none; font-weight: 600; background: var(--panel); }
.docs-pager a:hover { border-color: var(--go); }
.docs-pager a span { font-size: 12px; font-weight: 400; color: var(--faint); }
.docs-pager a.next { text-align: right; grid-column: 2; }
.docs-toc { flex: 0 0 200px; position: sticky; top: 88px; display: flex; flex-direction: column; gap: 2px; max-height: calc(100vh - 120px); overflow-y: auto; }
.docs-toc .docs-group { padding: 0 0 8px; }
.docs-toc a { display: block; padding: 4px 0 4px 12px; border-left: 1px solid var(--line); color: var(--faint); text-decoration: none; font-size: 13px; }
.docs-toc a:hover { color: var(--ink); }
.docs-toc a.on { color: var(--go); border-left-color: var(--go); }
@media (max-width: 1180px) { .docs-toc { display: none; } }
@media (max-width: 800px) {
  .docs-top { height: auto; flex-wrap: wrap; padding: 10px 16px; gap: 10px; position: static; }
  .docs-brand { width: auto; }
  .docs-search { order: 3; flex-basis: 100%; max-width: none; }
  .docs-search kbd { display: none; }
  .docs-nav { flex: 1 1 100%; flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; position: static; height: auto; }
  .docs-group { display: none; }
  .docs-main { padding: 24px 16px 48px; }
}
`;
