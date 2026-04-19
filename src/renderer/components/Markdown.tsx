import { useMemo } from 'react';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

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

  return marked.parse(source ?? '', { async: false, renderer }) as string;
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
