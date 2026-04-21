import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useConversationRoot } from '../hooks';
import hljs from 'highlight.js';
import { canPreviewFile } from '../filePreview';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { UnifiedDiffBody } from './sheets/WorktreeDiffSheet';

export function FileEditorPane() {
  const convId = useStore((s) => s.selectedConversationId);
  const rootPath = useConversationRoot(convId);
  const path = useStore((s) => s.openFilePath);
  const highlight = useStore((s) => s.openFileHighlight);
  const mode = useStore((s) => s.openFileMode);
  const setMode = useStore((s) => s.setOpenFileMode);
  const showFileTree = useStore((s) => s.showFileTree);
  const closeFile = useStore((s) => s.closeFile);
  const [content, setContent] = useState<string>('');
  const [diffText, setDiffText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewable = canPreviewFile(path);

  const openFile = useStore((s) => s.openFile);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDirty(false);
    window.overcli
      .invoke('fs:readFile', { path, rootPath: rootPath ?? undefined })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setContent(res.content);
          // Tool results often pass a hint (`store.ts`, `src/main/index.ts`)
          // that the resolver expanded to an absolute path. Upgrade the
          // store so subsequent save/diff ops target the real file.
          if (res.resolvedPath && res.resolvedPath !== path) {
            openFile(res.resolvedPath, highlight ?? undefined, mode);
          }
        } else setError(res.error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, rootPath]);

  useEffect(() => {
    if (!path || mode !== 'diff' || !rootPath) return;
    setLoading(true);
    setError(null);
    (async () => {
      // Tracked file modifications: `git diff HEAD --` shows them against
      // the last commit. Untracked/new files need `--no-index` since they
      // have no HEAD entry to diff against.
      const tracked = await window.overcli.invoke('git:run', {
        args: ['diff', 'HEAD', '--', path],
        cwd: rootPath,
      });
      let text = tracked.stdout ?? '';
      if (!text.trim()) {
        const untracked = await window.overcli.invoke('git:run', {
          args: ['diff', '--no-index', '--', '/dev/null', path],
          cwd: rootPath,
        });
        // `--no-index` exits 1 when there's a diff; stdout still holds it.
        text = untracked.stdout ?? '';
      }
      setDiffText(text);
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [path, mode, rootPath]);

  // When the file tree is requested but no file is open, show the tree
  // alone. When a file is open, show the tree on top and the file below
  // — a two-pane layout. When tree is off and a file is open, show only
  // the file.
  if (!path && showFileTree && rootPath) {
    return <FileTree rootPath={rootPath} />;
  }
  if (!path) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        No file open. Click a path in a message to open it here.
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full">
      {showFileTree && rootPath && (
        <div className="h-[40%] min-h-[120px] border-b border-card overflow-hidden">
          <FileTree rootPath={rootPath} />
        </div>
      )}
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-card">
          <div className="text-xs truncate text-ink-muted">{path}</div>
          <div className="flex items-center gap-2">
            <div className="flex items-center text-[10px] uppercase tracking-wider rounded border border-card overflow-hidden">
              <button
                onClick={() => setMode('diff')}
                className={
                  'px-2 py-0.5 ' +
                  (mode === 'diff'
                    ? 'bg-accent/20 text-accent'
                    : 'text-ink-muted hover:text-ink hover:bg-card-strong')
                }
              >
                Diff
              </button>
              {previewable && (
                <button
                  onClick={() => setMode('preview')}
                  className={
                    'px-2 py-0.5 ' +
                    (mode === 'preview'
                      ? 'bg-accent/20 text-accent'
                      : 'text-ink-muted hover:text-ink hover:bg-card-strong')
                  }
                >
                  Preview
                </button>
              )}
              <button
                onClick={() => setMode('edit')}
                className={
                  'px-2 py-0.5 ' +
                  (mode === 'edit'
                    ? 'bg-accent/20 text-accent'
                    : 'text-ink-muted hover:text-ink hover:bg-card-strong')
                }
              >
                File
              </button>
            </div>
            {dirty && (
              <button
                onClick={async () => {
                  const res = await window.overcli.invoke('fs:writeFile', { path, content });
                  if (res.ok) setDirty(false);
                  else setError(res.error);
                }}
                className="text-xs px-2 py-0.5 rounded bg-accent/25 text-accent hover:bg-accent/40"
              >
                Save
              </button>
            )}
            <button
              onClick={closeFile}
              className="text-xs px-2 py-0.5 rounded text-ink-muted hover:text-ink hover:bg-card-strong"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="p-4 text-xs text-ink-faint">Loading…</div>
          ) : error ? (
            <div className="p-4 text-xs text-red-300">{error}</div>
          ) : mode === 'diff' ? (
            diffText.trim() ? (
              <UnifiedDiffBody text={diffText} />
            ) : (
              <div className="p-4 text-xs text-ink-faint">No changes against HEAD.</div>
            )
          ) : mode === 'preview' && previewable ? (
            <FilePreview path={path} content={content} />
          ) : (
            <Editor
              content={content}
              onChange={(v) => {
                setContent(v);
                setDirty(true);
              }}
              highlightRange={highlight ? [highlight.startLine, highlight.endLine] : null}
              language={detectLanguage(path)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Editor({
  content,
  onChange,
  highlightRange,
  language,
}: {
  content: string;
  onChange: (v: string) => void;
  highlightRange: [number, number] | null;
  language: string | null;
}) {
  const lines = content.split('\n');
  return (
    <div className="flex text-[12px] font-mono">
      <div className="select-none text-right pr-2 pt-2 text-ink-faint sticky left-0 bg-surface-muted min-w-[3.5em]">
        {lines.map((_, i) => {
          const ln = i + 1;
          const inRange = highlightRange && ln >= highlightRange[0] && ln <= highlightRange[1];
          return (
            <div key={ln} className={inRange ? 'text-accent' : ''}>
              {ln}
            </div>
          );
        })}
      </div>
      <div className="flex-1 relative">
        <pre
          aria-hidden
          className="absolute inset-0 pt-2 px-2 m-0 pointer-events-none whitespace-pre overflow-visible"
          dangerouslySetInnerHTML={{
            __html: highlightContent(content, language, highlightRange),
          }}
        />
        <textarea
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="relative w-full min-h-full bg-transparent text-transparent caret-ink pt-2 px-2 select-text outline-none whitespace-pre resize-none"
          style={{ minHeight: `${lines.length * 1.5}em` }}
        />
      </div>
    </div>
  );
}

function highlightContent(content: string, language: string | null, highlightRange: [number, number] | null): string {
  let html: string;
  try {
    if (language && hljs.getLanguage(language)) {
      html = hljs.highlight(content, { language, ignoreIllegals: true }).value;
    } else {
      html = hljs.highlightAuto(content).value;
    }
  } catch {
    html = content.replace(/</g, '&lt;');
  }
  if (!highlightRange) return html;
  const lines = html.split('\n');
  const [start, end] = highlightRange;
  return lines
    .map((line, i) => {
      const ln = i + 1;
      if (ln >= start && ln <= end) {
        return `<span style="display:inline-block;width:100%;background:rgba(124,139,255,0.1)">${line}</span>`;
      }
      return line;
    })
    .join('\n');
}

/// Extension → hljs language id map. Lives here so bookkeeping stays next
/// to where we consume it; any extension not in the map falls back to
/// `hljs.highlightAuto()` which guesses from content.
const LANGUAGE_BY_EXT: Record<string, string> = {
  // JS / TS family
  ts: 'typescript', tsx: 'typescript', cts: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  // Systems
  rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', hh: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  java: 'java', groovy: 'groovy',
  // Scripting
  py: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  // Config / data
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', svg: 'xml', plist: 'xml',
  env: 'ini', 'env.local': 'ini',
  // Web
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  vue: 'xml', svelte: 'xml',
  // Docs
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  // DB / data query
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  // Build / infra
  dockerfile: 'dockerfile', tf: 'terraform', hcl: 'hcl',
  makefile: 'makefile', mk: 'makefile', cmake: 'cmake',
  // Misc
  r: 'r', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', clj: 'clojure', cljs: 'clojure',
  proto: 'protobuf',
};

function detectLanguage(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  // Special-case extensionless filenames the lookup wouldn't catch.
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  if (name === 'cmakelists.txt') return 'cmake';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return LANGUAGE_BY_EXT[ext] ?? null;
}
