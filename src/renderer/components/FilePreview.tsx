import { useEffect, useMemo, useState } from 'react';
import type { ArtifactPreviewResult, ProjectPreviewHintsResult } from '@shared/types';
import { detectFilePreviewKind } from '../filePreview';
import { renderMarkdownHtml } from './Markdown';

export function FilePreview({
  path,
  content,
  artifact,
  rootPath,
}: {
  path: string;
  content: string;
  artifact?: ArtifactPreviewResult | null;
  rootPath?: string;
}) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const kind = detectFilePreviewKind(path);
  const srcDoc = useMemo(() => {
    if (kind === 'html') return buildHtmlDocument(path, content);
    if (kind === 'markdown') return buildMarkdownDocument(path, content, dark);
    return '';
  }, [content, dark, kind, path]);

  if (!kind) {
    return <div className="p-4 text-xs text-ink-faint">Preview is not available for this file.</div>;
  }

  if (kind === 'image') {
    return artifact?.ok && artifact.kind === 'image' && artifact.dataUrl ? (
      <div className="h-full min-h-0 bg-surface-muted flex items-center justify-center p-4">
        <img
          src={artifact.dataUrl}
          alt={path}
          className="max-w-full max-h-full object-contain border border-card bg-surface"
        />
      </div>
    ) : (
      <ArtifactUnavailable artifact={artifact} />
    );
  }

  if (kind === 'pdf') {
    return artifact?.ok && artifact.kind === 'pdf' ? (
      <PdfPreview artifact={artifact} path={path} />
    ) : (
      <ArtifactUnavailable artifact={artifact} />
    );
  }

  if (kind === 'office') {
    if (!artifact?.ok || artifact.kind !== 'office') return <ArtifactUnavailable artifact={artifact} />;
    if (artifact.convertedPdfDataUrl) {
      return (
        <iframe
          title={`${path} preview`}
          src={artifact.convertedPdfDataUrl}
          className="block w-full h-full border-0 bg-surface"
        />
      );
    }
    return (
      <div className="h-full min-h-0 bg-surface-muted p-4">
        <div className="max-w-xl border border-card-strong bg-surface rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">{artifact.family}</div>
          <div className="mt-1 text-sm font-semibold text-ink truncate">{basename(path)}</div>
          <div className="mt-2 text-xs text-ink-muted">
            {artifact.extension.toUpperCase()} · {formatBytes(artifact.sizeBytes)}
          </div>
          <div className="mt-4 text-xs text-ink-muted leading-relaxed">
            LibreOffice conversion is used for inline previews when available. Open this artifact in
            the system app to inspect sheets, slides, comments, and formatting.
          </div>
          {artifact.conversionError && (
            <div className="mt-3 text-xs text-ink-faint">{artifact.conversionError}</div>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={async () => {
                setOpenError(null);
                const res = await window.overcli.invoke('fs:openPath', artifact.resolvedPath);
                if (!res.ok) setOpenError(res.error);
              }}
              className="text-xs font-medium px-3 py-1.5 rounded bg-accent text-surface hover:bg-accent/90"
            >
              Open
            </button>
            <button
              onClick={() => window.overcli.invoke('fs:openInFinder', artifact.resolvedPath)}
              className="text-xs px-3 py-1.5 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
            >
              Reveal
            </button>
          </div>
          {openError && <div className="mt-3 text-xs text-red-300">{openError}</div>}
        </div>
      </div>
    );
  }

  if (kind === 'csv') return <CsvPreview content={content} tsv={path.toLowerCase().endsWith('.tsv')} />;
  if (kind === 'json') return <JsonPreview content={content} />;
  if (kind === 'react') return <ReactPreview path={path} content={content} rootPath={rootPath} />;

  return (
    <iframe
      title={`${path} preview`}
      sandbox=""
      srcDoc={srcDoc}
      className="block w-full h-full border-0 bg-transparent"
    />
  );
}

function PdfPreview({
  artifact,
  path,
}: {
  artifact: Extract<ArtifactPreviewResult, { ok: true; kind: 'pdf' }>;
  path: string;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const [source, setSource] = useState<'data' | 'file'>(artifact.dataUrl ? 'data' : 'file');
  const src = source === 'data' ? artifact.dataUrl ?? artifact.fileUrl : artifact.fileUrl ?? artifact.dataUrl;
  if (!src) return <ArtifactUnavailable artifact={{ ok: false, error: 'PDF preview URL is unavailable.' }} />;
  return (
    <div className="h-full min-h-0 flex flex-col bg-surface">
      <div className="px-3 py-2 border-b border-card flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-ink-muted">{basename(path)} · {formatBytes(artifact.sizeBytes)}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setOpenError(null);
              const res = await window.overcli.invoke('fs:openPath', artifact.resolvedPath);
              if (!res.ok) setOpenError(res.error);
            }}
            className="px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
          >
            Open
          </button>
          <button
            onClick={() => window.overcli.invoke('fs:openInFinder', artifact.resolvedPath)}
            className="px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
          >
            Reveal
          </button>
          {artifact.dataUrl && artifact.fileUrl && (
            <button
              onClick={() => setSource((s) => (s === 'data' ? 'file' : 'data'))}
              className="px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
            >
              Try {source === 'data' ? 'File' : 'Data'}
            </button>
          )}
        </div>
      </div>
      {openError && <div className="px-3 py-2 text-xs text-red-300 border-b border-card">{openError}</div>}
      <embed title={`${path} preview`} src={src} type="application/pdf" className="block w-full flex-1 border-0 bg-surface" />
      <div className="px-3 py-2 text-[11px] text-ink-faint border-t border-card">
        If the preview area is blank, use Open or Reveal. Some PDFs do not render in Electron's inline viewer.
      </div>
    </div>
  );
}

function ArtifactUnavailable({ artifact }: { artifact?: ArtifactPreviewResult | null }) {
  return (
    <div className="p-4 text-xs text-ink-faint">
      {artifact && !artifact.ok ? artifact.error : 'Artifact preview is not available for this file.'}
    </div>
  );
}

function CsvPreview({ content, tsv }: { content: string; tsv: boolean }) {
  const rows = useMemo(() => parseDelimited(content, tsv ? '\t' : ','), [content, tsv]);
  const visible = rows.slice(0, 200);
  const width = Math.max(0, ...visible.map((r) => r.length));
  if (rows.length === 0) return <div className="p-4 text-xs text-ink-faint">No rows.</div>;
  return (
    <div className="h-full overflow-auto bg-surface-muted p-3">
      <table className="border-collapse min-w-full text-xs bg-surface">
        <tbody>
          {visible.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? 'bg-card' : ''}>
              {Array.from({ length: width }).map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border border-card px-2 py-1 max-w-[280px] truncate text-ink-muted"
                  title={row[cellIndex] ?? ''}
                >
                  {row[cellIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > visible.length && (
        <div className="mt-2 text-xs text-ink-faint">Showing first {visible.length} rows of {rows.length}.</div>
      )}
    </div>
  );
}

function JsonPreview({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(content) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [content]);
  if (!parsed.ok) return <div className="p-4 text-xs text-red-300">{parsed.error}</div>;
  return (
    <pre className="m-0 p-4 text-xs leading-relaxed whitespace-pre-wrap bg-surface-muted text-ink-muted">
      {JSON.stringify(parsed.value, null, 2)}
    </pre>
  );
}

function ReactPreview({ path, content, rootPath }: { path: string; content: string; rootPath?: string }) {
  const info = useMemo(() => analyzeReactSource(content), [content]);
  const [hints, setHints] = useState<ProjectPreviewHintsResult | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHints(null);
    window.overcli
      .invoke('preview:projectHints', { path, rootPath })
      .then((res) => {
        if (!cancelled) setHints(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setHints({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, rootPath]);

  return (
    <div className="h-full overflow-auto bg-surface-muted p-4">
      <div className="max-w-3xl space-y-4">
        <section className="border border-card-strong bg-surface rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">Visual validation</div>
          <div className="mt-1 text-sm font-semibold text-ink truncate">{basename(path)}</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Metric label="Exports" value={String(info.exports.length)} />
            <Metric label="JSX tags" value={String(info.tags.length)} />
            <Metric label="Style refs" value={String(info.styleRefs)} />
          </div>
        </section>
        <section className="border border-card bg-surface rounded-lg p-4">
          <div className="text-xs font-medium text-ink">Component surface</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(info.exports.length ? info.exports : ['No named component exports detected']).map((name) => (
              <span key={name} className="px-2 py-1 rounded border border-card text-xs text-ink-muted">
                {name}
              </span>
            ))}
          </div>
        </section>
        <section className="border border-card bg-surface rounded-lg p-4">
          <div className="text-xs font-medium text-ink">Project preview</div>
          {hints == null ? (
            <div className="mt-2 text-xs text-ink-faint">Looking for preview scripts…</div>
          ) : hints.ok ? (
            <>
              <div className="mt-2 text-xs text-ink-muted truncate">{hints.rootPath}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {hints.commands.map((cmd) => (
                  <button
                    key={cmd.id}
                    onClick={async () => {
                      setLaunchError(null);
                      const res = await window.overcli.invoke('preview:runProjectCommand', {
                        cwd: hints.rootPath,
                        command: cmd.command,
                      });
                      if (!res.ok) setLaunchError(res.error);
                    }}
                    className="text-xs px-3 py-1.5 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
                    title={cmd.command}
                  >
                    {cmd.label}
                  </button>
                ))}
              </div>
              {launchError && <div className="mt-3 text-xs text-red-300">{launchError}</div>}
            </>
          ) : (
            <div className="mt-2 text-xs text-ink-faint">{hints.error}</div>
          )}
        </section>
        <section className="border border-card bg-surface rounded-lg p-4">
          <div className="text-xs font-medium text-ink">Validation checklist</div>
          <ul className="mt-2 space-y-1.5 text-xs text-ink-muted">
            <li>Run the app or Storybook route that renders this component.</li>
            <li>Capture desktop and mobile screenshots after the agent change.</li>
            <li>Compare spacing, typography, states, overflow, and disabled/loading behavior.</li>
            <li>For design work, attach the relevant Figma frame or screenshot to the next reviewer turn.</li>
          </ul>
        </section>
        {info.tags.length > 0 && (
          <section className="border border-card bg-surface rounded-lg p-4">
            <div className="text-xs font-medium text-ink">Most used JSX tags</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {info.tags.slice(0, 24).map((tag) => (
                <span key={tag} className="px-2 py-1 rounded bg-card text-xs text-ink-muted">
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-card rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}

function parseDelimited(content: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function analyzeReactSource(content: string): { exports: string[]; tags: string[]; styleRefs: number } {
  const exports = new Set<string>();
  for (const match of content.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g)) {
    exports.add(match[1]);
  }
  for (const match of content.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=/g)) {
    exports.add(match[1]);
  }
  for (const match of content.matchAll(/export\s+default\s+([A-Z][A-Za-z0-9_]*)/g)) {
    exports.add(match[1]);
  }

  const tagCounts = new Map<string, number>();
  for (const match of content.matchAll(/<([A-Za-z][A-Za-z0-9.]*)[\s>/]/g)) {
    const tag = match[1];
    if (tag === 'React.Fragment') continue;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);

  const styleRefs =
    (content.match(/className=/g)?.length ?? 0) +
    (content.match(/style=/g)?.length ?? 0) +
    (content.match(/css=/g)?.length ?? 0);

  return { exports: [...exports], tags, styleRefs };
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildHtmlDocument(filePath: string, content: string): string {
  const baseTag = `<base href="${escapeAttr(toFileDirectoryHref(filePath))}">`;
  if (/<base[\s>]/i.test(content)) return content;
  if (/<head[\s>]/i.test(content)) return content.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${baseTag}`);
  if (/<html[\s>]/i.test(content)) {
    return content.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${baseTag}</head>`);
  }
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    baseTag,
    '<style>html,body{margin:0;padding:0;}</style>',
    '</head>',
    '<body>',
    content,
    '</body>',
    '</html>',
  ].join('');
}

function buildMarkdownDocument(filePath: string, content: string, dark: boolean): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<base href="${escapeAttr(toFileDirectoryHref(filePath))}">`,
    `<style>${markdownPreviewStyles(dark)}</style>`,
    '</head>',
    '<body>',
    `<article class="md">${renderMarkdownHtml(content, { escapeRawHtml: true, enableFilePathLinks: false })}</article>`,
    '</body>',
    '</html>',
  ].join('');
}

function markdownPreviewStyles(dark: boolean): string {
  const background = dark ? '#11151b' : '#f8fafc';
  const surface = dark ? '#171c23' : '#ffffff';
  const surfaceStrong = dark ? '#1e2630' : '#f1f5f9';
  const border = dark ? '#2a3340' : '#d8e0ea';
  const text = dark ? '#e6edf3' : '#17212b';
  const muted = dark ? '#9aa6b2' : '#52606d';
  const accent = dark ? '#8ab4ff' : '#2563eb';
  const code = dark ? '#0f141a' : '#f3f6fa';
  const inlineCode = dark ? '#202734' : '#eef2f7';
  const blockquote = dark ? '#b7c4d3' : '#5b6875';
  const hlKeyword = dark ? '#c586c0' : '#af00db';
  const hlString = dark ? '#ce9178' : '#a31515';
  const hlNumber = dark ? '#b5cea8' : '#098658';
  const hlComment = dark ? '#6a9955' : '#008000';
  const hlTitle = dark ? '#dcdcaa' : '#795e26';
  const hlType = dark ? '#4ec9b0' : '#267f99';
  const hlVariable = dark ? '#9cdcfe' : '#001080';
  const hlTag = dark ? '#569cd6' : '#800000';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${text}; }
    body {
      padding: 18px;
      font: 13px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .md { max-width: 980px; margin: 0 auto; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md h1 { font-size: 1.9em; margin: 0 0 0.6rem; }
    .md h2 { font-size: 1.45em; margin: 1.5rem 0 0.5rem; }
    .md h3 { font-size: 1.2em; margin: 1.15rem 0 0.45rem; }
    .md h4, .md h5, .md h6 { margin: 1rem 0 0.4rem; }
    .md p, .md ul, .md ol, .md pre, .md blockquote, .md table { margin: 0.6rem 0; }
    .md ul, .md ol { padding-left: 1.4rem; }
    .md li + li { margin-top: 0.2rem; }
    .md a { color: ${accent}; text-decoration: underline; text-underline-offset: 2px; }
    .md img, .md video { max-width: 100%; height: auto; }
    .md hr { border: 0; border-top: 1px solid ${border}; margin: 1rem 0; }
    .md blockquote {
      padding: 0.2rem 0 0.2rem 0.9rem;
      border-left: 3px solid ${border};
      color: ${blockquote};
    }
    .md table { border-collapse: collapse; max-width: 100%; display: block; overflow-x: auto; }
    .md th, .md td { border: 1px solid ${border}; padding: 0.45rem 0.65rem; }
    .md th { background: ${surfaceStrong}; text-align: left; }
    .md code, .md pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .md code {
      background: ${inlineCode};
      padding: 0.12rem 0.35rem;
      border-radius: 6px;
      font-size: 0.92em;
    }
    .md pre {
      background: ${code};
      border: 1px solid ${border};
      border-radius: 10px;
      padding: 0.85rem 1rem;
      overflow: auto;
    }
    .md pre code {
      background: transparent;
      padding: 0;
      border-radius: 0;
      font-size: inherit;
    }
    .hljs { background: transparent !important; color: ${text}; }
    .hljs-keyword, .hljs-built_in { color: ${hlKeyword}; }
    .hljs-string { color: ${hlString}; }
    .hljs-number { color: ${hlNumber}; }
    .hljs-comment { color: ${hlComment}; font-style: italic; }
    .hljs-title, .hljs-function { color: ${hlTitle}; }
    .hljs-type, .hljs-class { color: ${hlType}; }
    .hljs-variable, .hljs-attr { color: ${hlVariable}; }
    .hljs-tag { color: ${hlTag}; }
    .md pre, .md code, .md table, .md blockquote { background-clip: padding-box; }
    .md article, .md section, .md aside {
      background: ${surface};
    }
    .md { background: transparent; }
    .md iframe { max-width: 100%; }
    .md :is(input, button, textarea, select) { font: inherit; }
    .md { overflow-wrap: anywhere; }
    .md p code, .md li code, .md td code, .md th code { color: ${text}; }
    .md .task-list-item { list-style: none; }
    .md .task-list-item input { margin-right: 0.45rem; }
    .md { accent-color: ${accent}; }
    .md { -webkit-font-smoothing: antialiased; }
    .md { text-rendering: optimizeLegibility; }
    .md { caret-color: ${accent}; }
    .md { tab-size: 2; }
    .md { word-break: break-word; }
    .md { background: transparent; }
    .md { color: ${text}; }
    .md { border-radius: 12px; }
    .md { padding: 0; }
    .md { box-shadow: none; }
    .md { border: 0; }
    .md { min-width: 0; }
    .md { width: 100%; }
    .md { margin-bottom: 0; }
    .md { margin-top: 0; }
    .md del { color: ${muted}; }
  `;
}

function toFileDirectoryHref(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const directory = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : '';
  const prefixed = /^[a-zA-Z]:\//.test(directory) ? `/${directory}` : directory;
  return encodeURI(`file://${prefixed}`);
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
