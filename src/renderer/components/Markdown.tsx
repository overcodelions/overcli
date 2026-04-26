import { useMemo } from 'react';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

// hljs-produced <span class="hljs-...">, <code class="file-path" data-path="…">,
// and standard markdown tags are the only HTML we generate. Everything else
// (script, iframe, object, on* handlers, javascript: URLs) is stripped so a
// malicious CLAUDE.md, tool result, or model output can't XSS the renderer.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'data-path'],
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

export function renderMarkdownHtml(
  source: string,
  { enableFilePathLinks = true, escapeRawHtml = false }: RenderMarkdownOptions = {},
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

    if (language && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(text, {
          language,
          ignoreIllegals: true,
        }).value;
        return `<pre><code class="hljs${escapedLanguage}">${highlighted}</code></pre>\n`;
      } catch {
        // Fall through to plain escaped code below.
      }
    }

    return `<pre><code class="hljs${escapedLanguage}">${escapeHtml(text)}</code></pre>\n`;
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
  const html = useMemo(() => renderMarkdownHtml(source), [source]);

  return (
    <div
      className="md select-text"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('file-path') && onOpenPath) {
          const p = target.getAttribute('data-path');
          if (p) onOpenPath(p);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
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
