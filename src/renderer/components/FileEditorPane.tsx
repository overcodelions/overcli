import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useConversation, useConversationRoot } from '../hooks';
import { workspaceSymlinkNames } from '@shared/workspaceNames';
import type { ArtifactPreviewResult, FileInfoResult } from '@shared/types';
import hljs from 'highlight.js';
import {
  canPreviewFile,
  detectFilePreviewKind,
  isBinaryPreviewKind,
  isUnsupportedBinaryFile,
} from '../filePreview';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { UnifiedDiffBody } from './sheets/WorktreeDiffSheet';

type FileInfoState = FileInfoResult & { requestedPath: string };
type LargeTextPreview = {
  content: string;
  truncated: boolean;
  totalBytes: number;
  previewBytes: number;
};

export function FileEditorPane({ rootPathOverride }: { rootPathOverride?: string | null } = {}) {
  const convId = useStore((s) => s.selectedConversationId);
  const convRoot = useConversationRoot(convId);
  const rootPath = rootPathOverride ?? convRoot;
  const conv = useConversation(rootPathOverride ? null : convId);
  // Pull the raw store slices (stable references when unchanged) rather
  // than a derived array, so the useMemo below doesn't rebuild every
  // render — if `workspaceMembers` churned, the diff useEffect would
  // re-fire each render and pin the CPU.
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  // Workspace-member path resolution is only meaningful for a
  // conversation-scoped file view. The explorer passes an explicit root
  // and has no conversation, so skip the lookup.
  const workspaceMembers = useMemo(
    () => (rootPathOverride ? null : resolveWorkspaceMembers(convId, workspaces, projects)),
    [convId, workspaces, projects, rootPathOverride],
  );
  const path = useStore((s) => s.openFilePath);
  const highlight = useStore((s) => s.openFileHighlight);
  const mode = useStore((s) => s.openFileMode);
  const setMode = useStore((s) => s.setOpenFileMode);
  const showFileTree = useStore((s) => s.showFileTree);
  const closeFile = useStore((s) => s.closeFile);
  const [content, setContent] = useState<string>('');
  const [diffText, setDiffText] = useState<string>('');
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewResult | null>(null);
  const [fileInfo, setFileInfo] = useState<FileInfoState | null>(null);
  const [largeTextPreview, setLargeTextPreview] = useState<LargeTextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const previewKind = detectFilePreviewKind(path);
  const previewable = canPreviewFile(path);
  const binaryPreview = isBinaryPreviewKind(previewKind);
  const unsupportedBinary = isUnsupportedBinaryFile(path);
  const blockedFile =
    (fileInfo?.requestedPath === path &&
      fileInfo.ok &&
      (fileInfo.tooLarge || fileInfo.unsupportedBinary)) ||
    (unsupportedBinary && !!error);

  const openFile = useStore((s) => s.openFile);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    if (unsupportedBinary) {
      setLoading(false);
      setError('This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.');
      setDirty(false);
      setArtifactPreview(null);
      setLargeTextPreview(null);
      setContent('');
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    setDirty(false);
    setArtifactPreview(null);
    setLargeTextPreview(null);
    setFileInfo(null);
    const isWorkspaceMemberPath =
      !!workspaceMembers &&
      workspaceMembers.some((m) => path.startsWith(`${m.name}/`));
    (async () => {
      const info = await window.overcli.invoke('fs:fileInfo', { path, rootPath: rootPath ?? undefined });
      if (cancelled) return;
      setFileInfo({ ...info, requestedPath: path });
      if (!info.ok) {
        setError(info.error);
        return;
      }
      if (!isWorkspaceMemberPath && info.resolvedPath && info.resolvedPath !== path) {
        openFile(info.resolvedPath, highlight ?? undefined, mode);
        return;
      }
      if (info.tooLarge || info.unsupportedBinary) {
        setError(info.error ?? 'File is not safe to open.');
        return;
      }
      if (binaryPreview) {
        const res = await window.overcli.invoke('fs:readArtifactPreview', { path, rootPath: rootPath ?? undefined });
        if (cancelled) return;
        if (res.ok) setArtifactPreview(res);
        else setError(res.error);
      } else {
        if (info.largeText) {
          const res = await window.overcli.invoke('fs:readLargeTextPreview', { path, rootPath: rootPath ?? undefined });
          if (cancelled) return;
          if (res.ok) {
            setLargeTextPreview({
              content: res.content,
              truncated: res.truncated,
              totalBytes: res.totalBytes,
              previewBytes: res.previewBytes,
            });
            setContent(res.content);
          } else {
            setError(res.error);
          }
          return;
        }
        const res = await window.overcli.invoke('fs:readFile', { path, rootPath: rootPath ?? undefined });
        if (cancelled) return;
        if (res.ok) setContent(res.content);
        else setError(res.error);
      }
    })()
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [binaryPreview, highlight, mode, openFile, path, rootPath, unsupportedBinary, workspaceMembers]);

  // For workspace conversations the display root is a symlink dir and
  // not a git repo, so paths in the ChangesBar come in as
  // "<member>/…path". Peel that prefix to run git in the real project.
  const diffTarget = useMemo(
    () => resolveDiffTarget(path, rootPath, workspaceMembers, conv?.baseBranch ?? null),
    [path, rootPath, workspaceMembers, conv?.baseBranch],
  );
  useEffect(() => {
    if (!path || mode !== 'diff' || !diffTarget) return;
    if (!fileInfo || fileInfo.requestedPath !== path) return;
    if (!fileInfo.ok) {
      setDiffText('');
      setError(fileInfo.error);
      return;
    }
    if (fileInfo.tooLarge || fileInfo.unsupportedBinary || fileInfo.largeText) {
      setDiffText('');
      setError(fileInfo.error ?? 'Large files are not diffed inside Overcli.');
      return;
    }
    if (unsupportedBinary) {
      setDiffText('');
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      // Agents commit as they go, so `HEAD` already includes their
      // edits — diffing HEAD returns empty and the no-index fallback
      // then shows the whole file as added (all green). When we know
      // the agent's base branch, diff against it to roll committed and
      // uncommitted changes into one view. Falls back to HEAD for
      // non-agent file views (explorer, project root).
      const baseRef = diffTarget.baseBranch ?? 'HEAD';
      const tracked = await window.overcli.invoke('git:run', {
        args: ['diff', baseRef, '--', diffTarget.path],
        cwd: diffTarget.cwd,
      });
      let text = tracked.stdout ?? '';
      // Only fall through to `--no-index` when the tracked diff is empty
      // *and* the file isn't tracked — otherwise a clean tracked file
      // (matches base, already committed) would render as a brand-new
      // add. `git ls-files` exits 0 with the path on stdout iff git
      // knows about the file. Untracked files print nothing, so the
      // fallback fires only for genuine adds.
      if (tracked.exitCode === 0 && !text.trim()) {
        const ls = await window.overcli.invoke('git:run', {
          args: ['ls-files', '--', diffTarget.path],
          cwd: diffTarget.cwd,
        });
        const isTracked = ls.exitCode === 0 && !!ls.stdout?.trim();
        if (!isTracked) {
          const untracked = await window.overcli.invoke('git:run', {
            args: ['diff', '--no-index', '--', '/dev/null', diffTarget.path],
            cwd: diffTarget.cwd,
          });
          // `--no-index` exits 1 when there's a diff; stdout still holds it.
          text = untracked.stdout ?? '';
        }
      } else if (tracked.exitCode !== 0) {
        const stderr = tracked.stderr?.trim() || `exited ${tracked.exitCode}`;
        throw new Error(
          `git diff ${baseRef} -- ${diffTarget.path}\ncwd: ${diffTarget.cwd}\n${stderr}`,
        );
      }
      setDiffText(text);
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [path, mode, diffTarget, unsupportedBinary, fileInfo]);

  const save = useCallback(async () => {
    if (!path || !dirty) return;
    const res = await window.overcli.invoke('fs:writeFile', { path, content });
    if (res.ok) setDirty(false);
    else setError(res.error);
  }, [path, dirty, content]);

  // Keyboard: Cmd/Ctrl+S or Cmd/Ctrl+Enter saves; Cmd/Ctrl+Shift+D
  // toggles between Diff and File modes (Preview is button-only).
  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if ((e.key === 's' || e.key === 'S') && !e.shiftKey) {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void save();
        return;
      }
      if ((e.key === 'd' || e.key === 'D') && e.shiftKey) {
        e.preventDefault();
        setMode(mode === 'diff' ? 'edit' : 'diff');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path, mode, save, setMode]);

  // When the file tree is requested but no file is open, show the tree
  // alone. When a file is open, show the tree on top and the file below
  // — a two-pane layout. When tree is off and a file is open, show only
  // the file. Suppress the embedded tree when ExplorerPane mounts us
  // (rootPathOverride) — that view already supplies its own tree pane.
  const embedTree = showFileTree && !rootPathOverride;
  if (!path && embedTree && rootPath) {
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
      {embedTree && rootPath && (
        <div className="h-[40%] min-h-[120px] border-b border-card overflow-hidden">
          <FileTree rootPath={rootPath} />
        </div>
      )}
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-card">
          <div className="min-w-0 flex items-center gap-2">
            <div
              className="text-xs truncate text-ink-muted select-text cursor-text"
              title={path}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {path}
            </div>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(path);
                  setCopiedPath(true);
                  window.setTimeout(() => setCopiedPath(false), 1200);
                } catch {
                  setCopiedPath(false);
                }
              }}
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-faint hover:text-ink hover:bg-card-strong"
              title="Copy file path"
            >
              {copiedPath ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={async () => {
                const res = await window.overcli.invoke('fs:openPath', path);
                if (!res.ok) setError(res.error);
              }}
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-card text-ink-faint hover:text-ink hover:bg-card-strong"
              title="Open in default app (e.g. VS Code)"
            >
              Open
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center text-xs font-medium uppercase tracking-wider rounded border border-card-strong overflow-hidden">
              <button
                onClick={() => setMode('diff')}
                title="Toggle Diff/File (⌘⇧D)"
                className={
                  'px-2.5 py-1 ' +
                  (mode === 'diff'
                    ? 'bg-accent text-surface'
                    : 'text-ink hover:bg-card-strong')
                }
              >
                Diff
              </button>
              {previewable && (
                <button
                  onClick={() => setMode('preview')}
                  className={
                    'px-2.5 py-1 ' +
                    (mode === 'preview'
                      ? 'bg-accent text-surface'
                      : 'text-ink hover:bg-card-strong')
                  }
                >
                  Preview
                </button>
              )}
              <button
                onClick={() => setMode('edit')}
                title="Toggle Diff/File (⌘⇧D)"
                className={
                  'px-2.5 py-1 ' +
                  (mode === 'edit'
                    ? 'bg-accent text-surface'
                    : 'text-ink hover:bg-card-strong')
                }
              >
                File
              </button>
            </div>
            {dirty && (
              <button
                onClick={() => void save()}
                title="Save (⌘S or ⌘↵)"
                className="text-xs font-medium px-2.5 py-1 rounded bg-accent text-surface hover:bg-accent/90"
              >
                Save
              </button>
            )}
            <button
              onClick={closeFile}
              className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="p-4 text-xs text-ink-faint">Loading…</div>
          ) : blockedFile ? (
            <BlockedFilePanel path={path} message={error ?? 'This file cannot be previewed in Overcli.'} />
          ) : error ? (
            <div className="p-4 text-xs text-red-300">{error}</div>
          ) : mode === 'diff' ? (
            diffText.trim() ? (
              <UnifiedDiffBody text={diffText} />
            ) : (
              <div className="p-4 text-xs text-ink-faint">No changes against HEAD.</div>
            )
          ) : mode === 'preview' && previewable ? (
            <FilePreview
              path={path}
              content={content}
              artifact={artifactPreview}
              rootPath={rootPath ?? undefined}
            />
          ) : binaryPreview ? (
            <div className="p-4 text-xs text-ink-faint">
              This artifact is not editable as text. Use Preview to inspect it, or Diff to review
              repository changes.
            </div>
          ) : largeTextPreview ? (
            <LargeTextViewer
              preview={largeTextPreview}
              path={path}
              onOpenExternal={() => window.overcli.invoke('fs:openPath', path)}
            />
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

function BlockedFilePanel({ path, message }: { path: string; message: string }) {
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <div className="h-full min-h-0 bg-surface-muted p-4">
      <div className="max-w-xl border border-card-strong bg-surface rounded-lg p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">Preview unavailable</div>
        <div className="mt-1 text-sm font-semibold text-ink truncate">{path.split(/[/\\]/).pop() ?? path}</div>
        <div className="mt-3 text-xs text-ink-muted leading-relaxed">{message}</div>
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={async () => {
              setOpenError(null);
              const res = await window.overcli.invoke('fs:openPath', path);
              if (!res.ok) setOpenError(res.error);
            }}
            className="text-xs font-medium px-3 py-1.5 rounded bg-accent text-surface hover:bg-accent/90"
          >
            Open
          </button>
          <button
            onClick={() => window.overcli.invoke('fs:openInFinder', path)}
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

function LargeTextViewer({
  preview,
  path,
  onOpenExternal,
}: {
  preview: LargeTextPreview;
  path: string;
  onOpenExternal: () => void;
}) {
  const safeContent = useMemo(() => clampLongLines(preview.content, 2000), [preview.content]);
  return (
    <div className="h-full min-h-0 flex flex-col bg-surface-muted">
      <div className="px-3 py-2 border-b border-card text-xs text-ink-muted flex items-center justify-between gap-3">
        <span className="truncate">
          Previewing first {formatBytes(preview.previewBytes)} of {formatBytes(preview.totalBytes)}
          {preview.truncated ? ' · truncated' : ''}
        </span>
        <button
          onClick={onOpenExternal}
          className="shrink-0 px-2 py-1 rounded border border-card-strong hover:bg-card-strong text-ink-muted hover:text-ink"
        >
          Open
        </button>
      </div>
      <pre
        className="m-0 flex-1 overflow-auto p-3 text-[12px] leading-relaxed font-mono text-ink-muted whitespace-pre"
        title={path}
      >
        {safeContent}
      </pre>
    </div>
  );
}

function clampLongLines(content: string, maxChars: number): string {
  return content
    .split('\n')
    .map((line) => (line.length > maxChars ? `${line.slice(0, maxChars)} … [line truncated]` : line))
    .join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
          className="editor-overlay absolute inset-0 pt-2 px-2 m-0 pointer-events-none whitespace-pre overflow-visible"
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

/// Workspace conversations show paths like "<member>/src/foo.ts" — the
/// ChangesBar prefix matches the symlink name under the workspace root.
/// Strip it to get a cwd that's a real git repo; the remaining path is
/// what `git diff` wants. `baseBranch` is the ref the caller should
/// diff against — each workspace member carries its own base, so we
/// attach it when we match a member prefix.
function resolveDiffTarget(
  path: string | null,
  rootPath: string | null,
  members: Array<{
    name: string;
    path: string;
    projectPath?: string | null;
    baseBranch?: string | null;
  }> | null,
  convBaseBranch: string | null,
): { cwd: string; path: string; baseBranch: string | null } | null {
  if (!path || !rootPath) return null;
  if (members && members.length > 0) {
    for (const m of members) {
      const namePrefix = `${m.name}/`;
      if (path.startsWith(namePrefix)) {
        return {
          cwd: m.path,
          path: path.slice(namePrefix.length),
          baseBranch: m.baseBranch ?? null,
        };
      }
      // Tool output often emits absolute paths; reverse-map them onto
      // the owning member so the diff runs in the real repo (and against
      // the member's base branch) instead of the workspace symlink root.
      // Match against both the worktree path and the original project
      // path — agents sometimes emit the upstream-repo path even when
      // they edit through a worktree.
      const candidates = [m.path, m.projectPath ?? null].filter(
        (p): p is string => !!p,
      );
      for (const root of candidates) {
        if (path === root || path.startsWith(`${root}/`)) {
          return {
            cwd: m.path,
            path: path === root ? '.' : path.slice(root.length + 1),
            baseBranch: m.baseBranch ?? null,
          };
        }
      }
    }
  }
  // Git wants a repo-relative path; absolute paths get treated as
  // unknown and fall through to the --no-index branch above, which
  // makes every file render as a fresh add.
  const rel =
    path === rootPath
      ? '.'
      : path.startsWith(`${rootPath}/`)
        ? path.slice(rootPath.length + 1)
        : path;
  return { cwd: rootPath, path: rel, baseBranch: convBaseBranch };
}

function resolveWorkspaceMembers(
  convId: string | null,
  workspaces: Array<{
    projectIds: string[];
    conversations?: Array<{
      id: string;
      worktreePath?: string;
      workspaceAgentMemberIds?: string[];
    }>;
  }>,
  projects: Array<{
    id: string;
    name: string;
    path: string;
    conversations: Array<{
      id: string;
      worktreePath?: string;
      baseBranch?: string | null;
      checkedOutLocally?: boolean;
    }>;
  }>,
): Array<{
  name: string;
  path: string;
  projectPath?: string | null;
  baseBranch?: string | null;
}> | null {
  if (!convId) return null;
  for (const w of workspaces) {
    const c = (w.conversations ?? []).find((x) => x.id === convId);
    if (!c) continue;
    if (c.worktreePath) return null;
    // Coordinator: map symlinks to member WORKTREES so the diff view
    // runs git from the right repo. Use the same project-name + numeric
    // suffix dedup that `ensureCoordinatorSymlinkRoot` uses on disk.
    if (c.workspaceAgentMemberIds?.length) {
      const out: Array<{
        name: string;
        path: string;
        projectPath?: string | null;
        baseBranch?: string | null;
      }> = [];
      const used = new Set<string>();
      for (const memberId of c.workspaceAgentMemberIds) {
        for (const proj of projects) {
          const member = proj.conversations.find((x) => x.id === memberId);
          if (!member) continue;
          // Live members route through the worktree; once checked out
          // locally, the worktree is gone but the project repo is on the
          // agent's branch — diff against the project path instead so we
          // run git from a real repo, not the removed worktree dir.
          const memberPath =
            member.worktreePath ?? (member.checkedOutLocally ? proj.path : null);
          if (!memberPath) continue;
          let name = proj.name;
          let i = 2;
          while (used.has(name)) {
            name = `${proj.name}-${i}`;
            i += 1;
          }
          used.add(name);
          out.push({
            name,
            path: memberPath,
            projectPath: proj.path ?? null,
            baseBranch: member.baseBranch ?? null,
          });
          break;
        }
      }
      return out;
    }
    const projs = w.projectIds
      .map((pid) => projects.find((p) => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
      .map((p) => ({ name: p.name, path: p.path }));
    return workspaceSymlinkNames(projs);
  }
  return null;
}
