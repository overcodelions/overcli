import { useEffect, useMemo, useRef, useState } from 'react';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

// hljs-produced <span class="hljs-...">, <code class="file-path" data-path="…">,
// and standard markdown tags are the only HTML we generate. Everything else
// (script, iframe, object, on* handlers, javascript: URLs) is stripped so a
// malicious CLAUDE.md, tool result, or model output can't XSS the renderer.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'button', 'code', 'del', 'div', 'em', 'h1',
    'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's',
    'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr',
    'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'data-path', 'type', 'aria-label'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
};

// Configure `marked` once per module load. Code fences go through
// highlight.js; the theme stylesheet (github-dark) imported from the
// renderer entry provides the palette.
marked.setOptions({
  breaks: true,
  gfm: true,
});

const FILE_PATH_RE = /^[a-zA-Z0-9_.\-/]+\.(?:ts|tsx|js|jsx|py|rs|go|swift|kt|java|rb|md|json|yaml|yml|toml|html|css|scss|sh)(?::\d+(?:[-:]\d+)?)?$/i;

interface RenderMarkdownOptions {
  enableFilePathLinks?: boolean;
  escapeRawHtml?: boolean;
}

/// Bounded cache of rendered HTML keyed by (options + source). marked +
/// hljs + DOMPurify is ms-scale per bubble, and that work was repeated every
/// time a bubble mounted — opening a flow run, and especially switching steps
/// (ChatView re-keys Virtuoso on conversationId, remounting and re-rendering
/// every visible bubble from scratch). Message text in history is immutable,
/// so the same source always yields the same HTML: cache it. Insertion-order
/// eviction caps memory — streaming bubbles produce a new source every ~80ms
/// (each a distinct key), so without a bound the map would grow unbounded.
const MARKDOWN_HTML_CACHE = new Map<string, string>();
const MARKDOWN_HTML_CACHE_MAX = 400;

export function renderMarkdownHtml(
  source: string,
  options: RenderMarkdownOptions = {},
): string {
  const { enableFilePathLinks = true, escapeRawHtml = false } = options;
  const cacheKey = `${enableFilePathLinks ? 1 : 0}${escapeRawHtml ? 1 : 0}\n${source ?? ''}`;
  const cached = MARKDOWN_HTML_CACHE.get(cacheKey);
  if (cached !== undefined) {
    // Refresh recency: delete + re-set moves it to the end of insertion order
    // so the hottest entries survive eviction.
    MARKDOWN_HTML_CACHE.delete(cacheKey);
    MARKDOWN_HTML_CACHE.set(cacheKey, cached);
    return cached;
  }
  const html = renderMarkdownHtmlUncached(source, enableFilePathLinks, escapeRawHtml);
  MARKDOWN_HTML_CACHE.set(cacheKey, html);
  if (MARKDOWN_HTML_CACHE.size > MARKDOWN_HTML_CACHE_MAX) {
    // Evict the oldest (first-inserted) entry.
    const oldest = MARKDOWN_HTML_CACHE.keys().next().value;
    if (oldest !== undefined) MARKDOWN_HTML_CACHE.delete(oldest);
  }
  return html;
}

function renderMarkdownHtmlUncached(
  source: string,
  enableFilePathLinks: boolean,
  escapeRawHtml: boolean,
): string {
  const renderer = new Renderer();

  renderer.codespan = ({ text }) => {
    if (enableFilePathLinks && FILE_PATH_RE.test(text)) {
      const escaped = escapeHtml(text);
      return `<code class="file-path" data-path="${escapeAttr(text)}">${escaped}</code>`;
    }
    return `<code>${escapeHtml(text)}</code>`;
  };

  // Markdown links whose href is itself a file path — codex collab loves
  // to emit `[src/foo.ts](src/foo.ts)` — render as the same chip-style
  // <code class="file-path"> as a bare codespan would. Avoids redundant
  // underline+color styling on something that's already obviously a link,
  // and routes clicks through the existing openFile handler. Real http(s)
  // links fall through to the default <a> renderer.
  if (enableFilePathLinks) {
    renderer.link = ({ href, text }) => {
      const target = typeof href === 'string' ? href : '';
      const label = escapeHtml(typeof text === 'string' ? text : target);
      if (target && FILE_PATH_RE.test(target)) {
        return `<code class="file-path" data-path="${escapeAttr(target)}">${label}</code>`;
      }
      const safeHref = target ? escapeAttr(target) : '';
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    };
  }

  renderer.code = ({ text, lang }) => {
    const language = lang?.match(/\S+/)?.[0];
    const escapedLanguage = language ? ` language-${escapeAttr(language)}` : '';

    const copyButton = `<button type="button" class="code-copy" aria-label="Copy code">copy</button>`;

    if (language && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(text, {
          language,
          ignoreIllegals: true,
        }).value;
        return `<div class="code-block">${copyButton}<pre><code class="hljs${escapedLanguage}">${highlighted}</code></pre></div>\n`;
      } catch {
        // Fall through to plain escaped code below.
      }
    }

    return `<div class="code-block">${copyButton}<pre><code class="hljs${escapedLanguage}">${escapeHtml(text)}</code></pre></div>\n`;
  };

  if (escapeRawHtml) {
    renderer.html = ({ text, block }) =>
      block ? `<pre><code>${escapeHtml(text)}</code></pre>` : escapeHtml(text);
  }

  const raw = marked.parse(source ?? '', { async: false, renderer }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG) as string;
}

/// Render a single assistant / review bubble's markdown as HTML. We purposely
/// do this with marked + dangerouslySetInnerHTML instead of react-markdown
/// because the latter's component tree for deeply nested lists is part of
/// what we were fighting in the Swift port — one big memoized HTML string
/// lets the browser's layout engine do its best work.
export function Markdown({ source, onOpenPath }: { source: string; onOpenPath?: (path: string) => void }) {
  // marked + hljs + DOMPurify is ~ms-scale on long bubbles, and the
  // streaming assistant text updates with every token. Re-parsing on
  // each chunk saturates the main thread and stalls the composer.
  // Throttling the input to ~80ms (~12 fps) keeps streaming legible
  // while leaving cycles for typing/scroll. Trailing edge always
  // fires so the final value is fully rendered.
  const throttled = useThrottledValue(source, 80);
  const html = useMemo(() => renderMarkdownHtml(throttled), [throttled]);

  return (
    <div
      className="md select-text"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('file-path') && onOpenPath) {
          const p = target.getAttribute('data-path');
          if (p) onOpenPath(p);
          return;
        }
        if (target.classList.contains('code-copy')) {
          const code = target.parentElement?.querySelector('code');
          const text = code?.textContent ?? '';
          if (!text) return;
          navigator.clipboard.writeText(text);
          const prev = target.textContent;
          target.textContent = 'copied';
          target.classList.add('is-copied');
          window.setTimeout(() => {
            target.textContent = prev ?? 'copy';
            target.classList.remove('is-copied');
          }, 1200);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const lastEmitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(value);
  latestRef.current = value;

  useEffect(() => {
    const now = performance.now();
    const elapsed = now - lastEmitRef.current;
    if (elapsed >= intervalMs) {
      lastEmitRef.current = now;
      setShown(value);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else if (timerRef.current == null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastEmitRef.current = performance.now();
        setShown(latestRef.current);
      }, intervalMs - elapsed);
    }
  }, [value, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return shown;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
