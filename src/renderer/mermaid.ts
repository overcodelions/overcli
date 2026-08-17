import { marked } from 'marked';
import DOMPurify from 'dompurify';

/// Mermaid rendering for the markdown *file preview* only.
///
/// The preview lives in an `sandbox=""` srcDoc iframe, which is an opaque
/// origin with scripts fully disabled — so the SVG we splice in is inert by
/// construction. That is what makes this cheap: we never widen the chat
/// renderer's `SANITIZE_CONFIG`, which governs untrusted prose everywhere
/// else in the app. Diagrams are rendered here, in the parent, sanitized
/// through a second SVG-only DOMPurify pass, and handed to the frame as
/// finished markup. Nothing executes in the frame; the frame can't reach
/// back into the app.
///
/// Mermaid can't run *inside* the frame anyway: a srcDoc iframe inherits the
/// app's `script-src 'self'` CSP, which is why the React preview serves over
/// `overcli-preview://` instead of srcDoc.

const MERMAID_LANG = 'mermaid';

export interface MermaidBlock {
  key: string;
  code: string;
}

export interface MermaidRenderResult {
  svg: string | null;
  error?: string;
}

export type MermaidDiagrams = Record<string, MermaidRenderResult>;

/// SVG-only allowlist, entirely separate from the markdown one. DOMPurify's
/// `svg` profile already omits `foreignObject` (the tag that would smuggle
/// arbitrary HTML back in) and `use` (external-reference fetches), while
/// keeping `marker`, `tspan`, `style`, and `image` — everything mermaid
/// actually emits. `htmlLabels: false` below keeps labels as `<text>` so
/// nothing is silently stripped.
///
/// Do NOT narrow `ALLOWED_URI_REGEXP` here. DOMPurify runs *every* attribute
/// value through it, not just URI attributes, and the default pattern carries
/// a deliberate escape hatch for values that aren't URIs at all. Replacing it
/// with a URL-shaped pattern drops `viewBox="-8 -8 116 36"`,
/// `transform="translate(4,4)"`, `width="100%"`, `d`, `text-anchor` — the
/// entire geometry of the diagram — leaving a blank box that still takes up
/// space. The default already blocks `javascript:` and `data:`, and the
/// preview frame executes nothing regardless.
const SVG_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['script', 'foreignObject'],
  ADD_ATTR: ['role'],
};

/// Diagrams are keyed by content, not document order, so the placeholder the
/// markdown renderer emits and the block the async render resolves can be
/// matched without the two passes having to walk the tree the same way.
/// Identical diagrams in one file collapse to a single render.
export function mermaidKey(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${code.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

export function mermaidPlaceholderHtml(code: string): string {
  return `<div class="mermaid-diagram" data-mermaid-key="${mermaidKey(code)}"></div>`;
}

interface TokenLike {
  type?: string;
  lang?: string;
  text?: string;
  tokens?: unknown;
  items?: unknown;
}

/// Walk the token tree rather than regexing for ``` fences: a fence inside a
/// list item or blockquote is still a diagram, and a fence inside a *larger*
/// fence is not one at all. `marked` already knows the difference.
export function extractMermaidBlocks(source: string): MermaidBlock[] {
  if (!source || !source.includes(MERMAID_LANG)) return [];
  const found: MermaidBlock[] = [];
  collectMermaidTokens(marked.lexer(source, { gfm: true, breaks: true }), found);

  const seen = new Set<string>();
  return found.filter((block) => {
    if (seen.has(block.key)) return false;
    seen.add(block.key);
    return true;
  });
}

function collectMermaidTokens(tokens: readonly unknown[], out: MermaidBlock[]): void {
  for (const raw of tokens) {
    const token = raw as TokenLike;
    if (token.type === 'code') {
      const lang = typeof token.lang === 'string' ? token.lang.match(/\S+/)?.[0] : undefined;
      const code = typeof token.text === 'string' ? token.text : '';
      if (lang === MERMAID_LANG && code.trim()) out.push({ key: mermaidKey(code), code });
      continue;
    }
    if (Array.isArray(token.items)) collectMermaidTokens(token.items, out);
    if (Array.isArray(token.tokens)) collectMermaidTokens(token.tokens, out);
  }
}

/// Every mermaid render gets a fresh DOM id, deliberately *not* derived from
/// the content key. mermaid.render() parks a scratch `<div id="d{id}">` on
/// document.body and calls removeExistingElements() for that id first — so two
/// passes sharing an id delete each other's scratch node mid-render and both
/// die on `element.firstChild`. StrictMode makes that the common case (effects
/// double-invoke), but two open previews or a theme toggle would do it in
/// production too.
let renderSeq = 0;

/// mermaid.initialize() and mermaid.render() both drive module-global state
/// (config, the diagram db, a shared measuring element), so passes are queued
/// rather than allowed to interleave — otherwise a light pass and a dark pass
/// racing would also fight over the theme.
let renderQueue: Promise<unknown> = Promise.resolve();

function enqueueMermaidWork<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/// `mermaid` is ~1MB and most markdown files have no diagrams, so it is
/// imported lazily — Vite code-splits it and the chunk is never fetched until
/// a fence shows up.
export async function renderMermaidDiagrams(
  blocks: readonly MermaidBlock[],
  options: { dark: boolean },
): Promise<MermaidDiagrams> {
  if (!blocks.length) return {};

  return enqueueMermaidWork(async () => {
    const diagrams: MermaidDiagrams = {};
    let mermaid: typeof import('mermaid').default;
    try {
      mermaid = (await import('mermaid')).default;
    } catch (err) {
      const message = errorMessage(err);
      for (const block of blocks) diagrams[block.key] = { svg: null, error: message };
      return diagrams;
    }

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: options.dark ? 'dark' : 'default',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
    });

    for (const block of blocks) {
      diagrams[block.key] = await renderOne(mermaid, block);
    }
    return diagrams;
  });
}

async function renderOne(
  mermaid: typeof import('mermaid').default,
  block: MermaidBlock,
): Promise<MermaidRenderResult> {
  const id = `mmd-${(renderSeq++).toString(36)}`;
  try {
    // Parse first with errors suppressed: render() on invalid source injects
    // its own error graphic into the document as a side effect.
    const parsed = await mermaid.parse(block.code, { suppressErrors: true });
    if (!parsed) return { svg: null, error: 'Could not parse the diagram source.' };

    const { svg } = await mermaid.render(id, block.code);
    const clean = sanitizeMermaidSvg(svg);
    if (!clean.trim()) return { svg: null, error: 'Diagram was empty after sanitizing.' };
    return { svg: clean };
  } catch (err) {
    return { svg: null, error: errorMessage(err) };
  } finally {
    // render() leaves its measuring node behind when it throws part-way.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/// Exported so the sanitize step can be tested on its own: a config that
/// quietly strips geometry produces a blank-but-correctly-sized diagram, which
/// no other test in the suite can see.
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, SVG_SANITIZE_CONFIG) as unknown as string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === 'string' && err ? err : 'Unknown error.';
}

const PLACEHOLDER_RE = /<div\b[^>]*\bdata-mermaid-key="([^"]*)"[^>]*><\/div>/g;

/// Swap rendered SVG into the sanitized markdown HTML. Runs on every preview
/// render, including the first one before the async job resolves — an
/// unresolved diagram falls back to its source as a code block, which is what
/// the preview showed before this feature existed.
export function applyMermaidDiagrams(
  html: string,
  blocks: readonly MermaidBlock[],
  diagrams: MermaidDiagrams,
): string {
  if (!html.includes('data-mermaid-key')) return html;
  const codeByKey = new Map(blocks.map((block) => [block.key, block.code]));

  return html.replace(PLACEHOLDER_RE, (match, key: string) => {
    const diagram = diagrams[key];
    if (diagram?.svg) return `<figure class="mermaid-diagram">${diagram.svg}</figure>`;

    const code = codeByKey.get(key);
    if (code === undefined) return match;
    const source = `<pre><code class="hljs language-mermaid">${escapeHtml(code)}</code></pre>`;
    if (diagram?.error) {
      return `<figure class="mermaid-diagram is-error"><figcaption>Diagram failed to render — ${escapeHtml(diagram.error)}</figcaption>${source}</figure>`;
    }
    return `<figure class="mermaid-diagram is-pending">${source}</figure>`;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
