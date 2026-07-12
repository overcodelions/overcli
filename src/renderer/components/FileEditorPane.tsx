import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { useStore } from '../store';
import { useFlowsStore } from '../flowsStore';
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
import { FilePreview } from './FilePreview';
import { UnifiedDiffBody } from './sheets/WorktreeDiffSheet';
import { CodeMirrorEditor } from './CodeMirrorEditor';

// Feature flag: route the editable file view through CodeMirror 6.
// The old layered textarea+pre `Editor` lower in this file has a known
// click-alignment bug (caret drifts off rendered text the further down
// you scroll) that two prior fixes haven't put to bed. Flip back to
// `false` to fall through to the legacy editor if the CM6 version
// regresses something.
const USE_CODEMIRROR_EDITOR = true;

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
  // The flow run currently being viewed, if any. Flow worktree runs live
  // outside the workspace tree, so their member→repo mapping can't be
  // derived from workspaces/projects alone — we read it off the run.
  const detailMode = useStore((s) => s.detailMode);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const flowRuns = useFlowsStore((s) => s.runs);
  const flowRun = detailMode === 'flows' && activeRunId ? flowRuns[activeRunId] : undefined;

  // Workspace-member resolution: when the convId belongs to a workspace
  // conversation, the lookup runs by convId. For flow runs whose
  // projectPath is a workspace symlink root, convId doesn't match any
  // workspace, so we fall back to matching by rootPath — without this
  // the diff view runs `git diff` in the symlink dir (not a git repo)
  // and errors with `Could not access 'HEAD'`.
  //
  // Worktree workspace runs are a further special case: their root is a
  // coordinator symlink dir (not the workspace rootPath, so the fallback
  // misses) AND each member's changes live in a MINTED worktree, not the
  // project's main checkout. Build the member list straight from the run
  // so the ChangesBar's `<member>/…` paths peel to the right worktree,
  // and diff against the per-member fork commit (matches the Review sheet).
  const flowMembers = useMemo(() => {
    if (!flowRun?.workspaceWorktrees?.length) return null;
    return flowRun.workspaceWorktrees.map((w) => ({
      name: w.name,
      path: w.worktreePath,
      projectPath: w.projectPath,
      baseBranch:
        flowRun.baselineCommitsByMember?.[w.name]?.commit ?? flowRun.baseBranch ?? null,
    }));
  }, [flowRun]);
  const workspaceMembers = useMemo(
    () => flowMembers ?? resolveWorkspaceMembers(convId, workspaces, projects, rootPath),
    [flowMembers, convId, workspaces, projects, rootPath],
  );
  // For single-project worktree runs there's no member prefix; diff
  // against the captured fork commit (else the base branch) so a flow
  // that hasn't committed still shows its work instead of an empty/HEAD
  // diff.
  const flowSingleBase =
    flowRun && !flowRun.workspaceWorktrees?.length
      ? flowRun.baselineCommit ?? flowRun.baseBranch ?? null
      : null;
  const path = useStore((s) => s.openFilePath);
  const highlight = useStore((s) => s.openFileHighlight);
  const mode = useStore((s) => s.openFileMode);
  const setMode = useStore((s) => s.setOpenFileMode);
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
  const [reverting, setReverting] = useState(false);
  // True when the diff is a brand-new untracked file — it has no HEAD
  // version to revert to, so we hide the Revert action for it.
  const [diffUntracked, setDiffUntracked] = useState(false);
  // Bumped to force a re-read of the file + diff after a revert, so the
  // view reflects the restored-to-HEAD content.
  const [refreshToken, setRefreshToken] = useState(0);
  const previewKind = detectFilePreviewKind(path);
  const binaryPreview = isBinaryPreviewKind(previewKind);
  const unsupportedBinary = isUnsupportedBinaryFile(path);
  // The file isn't on disk — almost always because the agent deleted it.
  // There's nothing to read, edit or preview, so the only view that means
  // anything is the diff (which renders the deletion hunk).
  const missingFile =
    fileInfo?.requestedPath === path && !fileInfo.ok && !!fileInfo.missing;
  const previewable = canPreviewFile(path) && !missingFile;
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
        // A deleted file isn't an error to surface — the diff effect picks
        // it up and renders the deletion. Anything else (unreadable, outside
        // a project) still gets the raw message.
        if (!info.missing) setError(info.error);
        setContent('');
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
  }, [binaryPreview, highlight, mode, openFile, path, rootPath, unsupportedBinary, workspaceMembers, refreshToken]);

  // For workspace conversations the display root is a symlink dir and
  // not a git repo, so paths in the ChangesBar come in as
  // "<member>/…path". Peel that prefix to run git in the real project.
  const diffTarget = useMemo(
    () => resolveDiffTarget(path, rootPath, workspaceMembers, conv?.baseBranch ?? flowSingleBase ?? null),
    [path, rootPath, workspaceMembers, conv?.baseBranch, flowSingleBase],
  );
  useEffect(() => {
    // A missing file has no readable content, so we fetch its diff whatever
    // the mode says — the deletion is the only thing left to show.
    if (!path || !diffTarget || (mode !== 'diff' && !missingFile)) return;
    if (!fileInfo || fileInfo.requestedPath !== path) return;
    // A file that's gone from disk still has a diff — the deletion itself.
    // Only bail on failures that aren't "it isn't there".
    const deleted = !fileInfo.ok && !!fileInfo.missing;
    if (!fileInfo.ok && !deleted) {
      setDiffText('');
      setError(fileInfo.error);
      return;
    }
    if (fileInfo.ok) {
      if (fileInfo.tooLarge || fileInfo.unsupportedBinary || fileInfo.largeText) {
        setDiffText('');
        setError(fileInfo.error ?? 'Large files are not diffed inside Overcli.');
        return;
      }
      if (unsupportedBinary) {
        setDiffText('');
        return;
      }
    }
    setLoading(true);
    setError(null);
    setDiffUntracked(false);
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
      if (deleted) {
        // No `--no-index` fallback for a file that isn't on disk — it would
        // just fail. An empty diff here means the deletion is already part
        // of `baseRef`, or the path never existed; the missing-file panel
        // covers both.
        setDiffText(text);
        return;
      }
      if (tracked.exitCode === 0 && !text.trim()) {
        const ls = await window.overcli.invoke('git:run', {
          args: ['ls-files', '--', diffTarget.path],
          cwd: diffTarget.cwd,
        });
        const isTracked = ls.exitCode === 0 && !!ls.stdout?.trim();
        setDiffUntracked(!isTracked);
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
  }, [path, mode, diffTarget, unsupportedBinary, fileInfo, missingFile, refreshToken]);

  const save = useCallback(async () => {
    if (!path || !dirty) return;
    const res = await window.overcli.invoke('fs:writeFile', { path, content });
    if (res.ok) setDirty(false);
    else setError(res.error);
  }, [path, dirty, content]);

  // Discard all uncommitted changes to the current file, back to HEAD.
  // Only offered on HEAD-based diffs (see `canRevert`) where "revert" is
  // unambiguous — destructive, so we confirm first. For a deleted file the
  // same checkout brings it back, so it's offered as "Restore" instead.
  const revertFile = useCallback(async () => {
    if (!diffTarget || reverting) return;
    const name = diffTarget.path.split('/').pop() || diffTarget.path;
    const prompt = missingFile
      ? `Restore ${name}?\n\nThis brings the deleted file back from HEAD.`
      : `Revert ${name}?\n\nThis discards all uncommitted changes to it and cannot be undone.`;
    if (!window.confirm(prompt)) {
      return;
    }
    setReverting(true);
    setError(null);
    try {
      const res = await window.overcli.invoke('git:restoreFile', {
        cwd: diffTarget.cwd,
        path: diffTarget.path,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDirty(false);
      setRefreshToken((t) => t + 1);
    } finally {
      setReverting(false);
    }
  }, [diffTarget, reverting, missingFile]);

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
        if (missingFile) return; // nothing to toggle to — the file is gone
        setMode(mode === 'diff' ? 'edit' : 'diff');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path, mode, save, setMode, missingFile]);

  // The folder icon (conversation header) and the project/workspace
  // Explore buttons now route through ExplorerPane, which owns its
  // own side-by-side tree+editor layout. FileEditorPane is the bare
  // editor view: it never embeds the tree itself.
  if (!path) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        No file open. Click a path in a message to open it here.
      </div>
    );
  }
  // Offer Revert only on a HEAD-based diff with real changes to a tracked
  // file — that's where "discard uncommitted changes" is unambiguous.
  // Agent/flow views diff against a base branch (baseBranch set) and can
  // include committed work, so reverting there would mean something riskier
  // than a checkout; we leave those out.
  const canRevert =
    (mode === 'diff' || missingFile) &&
    !loading &&
    !error &&
    !!diffText.trim() &&
    !diffUntracked &&
    !!diffTarget &&
    diffTarget.baseBranch == null;
  return (
    <div className="flex flex-col h-full">
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
            {!missingFile && (
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
            )}
            {missingFile && (
              <span
                title="This file is no longer on disk"
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-500/15 text-red-700 dark:text-red-200"
              >
                deleted
              </span>
            )}
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
                disabled={missingFile}
                title={
                  missingFile
                    ? 'This file is no longer on disk — only the diff is available'
                    : 'Toggle Diff/File (⌘⇧D)'
                }
                className={
                  'px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed ' +
                  (mode === 'edit' && !missingFile
                    ? 'bg-accent text-surface'
                    : 'text-ink hover:bg-card-strong')
                }
              >
                File
              </button>
            </div>
            {canRevert && (
              <button
                onClick={() => void revertFile()}
                disabled={reverting}
                title={
                  missingFile
                    ? 'Bring this deleted file back (git checkout HEAD)'
                    : 'Discard all uncommitted changes to this file (git checkout HEAD)'
                }
                className={
                  'text-xs font-medium px-2.5 py-1 rounded border border-card disabled:opacity-40 ' +
                  (missingFile
                    ? 'text-emerald-300 hover:text-emerald-200 hover:bg-emerald-500/10'
                    : 'text-red-300 hover:text-red-200 hover:bg-red-500/10')
                }
              >
                {missingFile
                  ? reverting
                    ? 'Restoring…'
                    : 'Restore'
                  : reverting
                    ? 'Reverting…'
                    : 'Revert'}
              </button>
            )}
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
          ) : missingFile ? (
            diffText.trim() ? (
              <>
                <div className="px-4 py-2 text-xs text-ink-muted border-b border-card">
                  This file was deleted. Showing the diff of what it contained.
                </div>
                <UnifiedDiffBody text={diffText} />
              </>
            ) : (
              <MissingFilePanel path={path} />
            )
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
          ) : USE_CODEMIRROR_EDITOR ? (
            <CodeMirrorEditor
              content={content}
              onChange={(v) => {
                setContent(v);
                setDirty(true);
              }}
              highlightRange={highlight ? [highlight.startLine, highlight.endLine] : null}
              language={detectLanguage(path)}
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

/// Shown when the open path isn't on disk *and* git has no deletion diff for
/// it — the file was deleted in an earlier commit, or the path is stale.
/// Either way there's nothing to read: say so instead of leaking an ENOENT.
function MissingFilePanel({ path }: { path: string }) {
  return (
    <div className="h-full min-h-0 bg-surface-muted p-4">
      <div className="max-w-xl border border-card-strong bg-surface rounded-lg p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">File not on disk</div>
        <div className="mt-1 text-sm font-semibold text-ink truncate">
          {path.split(/[/\\]/).pop() ?? path}
        </div>
        <div className="mt-3 text-xs text-ink-muted leading-relaxed">
          This file has been deleted, so there's nothing to open. Its contents are still in git
          history if you need them back.
        </div>
        <div className="mt-3 text-[11px] text-ink-faint font-mono break-all">{path}</div>
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
  // Pull range endpoints out so the memo key below stays primitive —
  // the parent recreates the `highlightRange` tuple on every render,
  // which would otherwise bust the highlight cache on every keystroke.
  const rangeStart = highlightRange?.[0] ?? null;
  const rangeEnd = highlightRange?.[1] ?? null;

  // hljs.highlightAuto on a multi-KB file is ~50–150ms of synchronous
  // work — running it on every keystroke is what makes typing feel
  // laggy. Instead, debounce a "settled" content snapshot that the
  // expensive highlighter consumes, and render plain (escaped) text
  // in the overlay between keystrokes. The textarea text is
  // transparent, so the overlay is what the user actually sees; the
  // escaped fallback is cheap and renders instantly with each
  // keystroke, then the colored version swaps in once typing pauses.
  const [settledContent, setSettledContent] = useState(content);
  useEffect(() => {
    const t = setTimeout(() => setSettledContent(content), 60);
    return () => clearTimeout(t);
  }, [content]);

  const highlightedHtml = useMemo(
    () =>
      highlightContent(
        settledContent,
        language,
        rangeStart != null && rangeEnd != null ? [rangeStart, rangeEnd] : null,
      ),
    [settledContent, language, rangeStart, rangeEnd],
  );

  // While the user is mid-keystroke (content has changed but the
  // debounced settledContent hasn't caught up yet), show a
  // plain-escaped version of the live content so the visible text
  // matches the textarea exactly. Once typing pauses, swap to the
  // syntax-highlighted version.
  const displayHtml =
    content === settledContent
      ? highlightedHtml
      : plainEscapedContent(
          content,
          rangeStart != null && rangeEnd != null ? [rangeStart, rangeEnd] : null,
        );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // The textarea and the highlight `<pre>` are independent layers, so
  // horizontal scrolling inside the textarea (long lines, no wrap)
  // would otherwise leave the overlay frozen and the caret would drift
  // off the rendered tokens. Mirror scrollLeft into the pre — which is
  // overflow-hidden — so the two scroll as one. Vertical scrolling
  // lives on the outer container (textarea grows to content height),
  // so we don't need to sync scrollTop.
  const handleScroll = (e: ReactUIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollLeft = e.currentTarget.scrollLeft;
  };

  // Tab in a plain textarea moves focus to the next focusable element,
  // which is unusable for code editing. Insert a literal tab at the
  // selection and keep the caret one position to the right of it.
  // We deliberately don't handle Shift+Tab (would need to find and
  // remove indentation) — that's a worthwhile follow-up but more code
  // than fits the scope here.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = content.slice(0, start) + '\t' + content.slice(end);
    onChange(next);
    // React hasn't re-rendered yet, so the textarea's value is still
    // the old string. Restore the caret after the value prop flushes —
    // setting selectionStart/End on the stale value would land in the
    // wrong place.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.selectionStart = node.selectionEnd = start + 1;
    });
  };

  // leading-[18px] is load-bearing and must match the pixel line-height
  // pinned on `.editor-overlay` and `.editor-pane-textarea` in
  // styles.css. We use a px value (not unitless 1.5) because Chromium
  // rounds subpixel line-heights differently for <pre> vs <textarea>,
  // which makes selections drift further off the rendered text the
  // lower in the file you scroll. The wrapper value here drives the
  // line-numbers column; the overlay/textarea pull theirs from CSS.
  return (
    <div className="flex text-[12px] font-mono leading-[18px]">
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
          ref={preRef}
          aria-hidden
          className="editor-overlay absolute inset-0 pt-2 px-2 m-0 pointer-events-none whitespace-pre overflow-hidden"
          dangerouslySetInnerHTML={{ __html: displayHtml }}
        />
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          spellCheck={false}
          className="editor-pane-textarea relative w-full min-h-full bg-transparent text-transparent caret-ink select-text outline-none whitespace-pre resize-none"
          style={{ minHeight: `${lines.length * 18}px` }}
        />
      </div>
    </div>
  );
}

/// Cheap mid-typing fallback for the overlay. The textarea text is
/// transparent so the user only sees what the overlay renders —
/// while the (expensive) hljs pass is being debounced, this provides
/// a per-keystroke render of the live content with no tokenization.
/// `<` is the only thing we need to escape for `<pre>` to display
/// raw source faithfully; `&` etc. would only matter if our own
/// row wrapper introduced entities, and it doesn't.
function plainEscapedContent(content: string, highlightRange: [number, number] | null): string {
  const escaped = content.replace(/</g, '&lt;');
  if (!highlightRange) return escaped;
  const [start, end] = highlightRange;
  return escaped
    .split('\n')
    .map((line, i) => {
      const ln = i + 1;
      if (ln >= start && ln <= end) {
        return `<span style="display:inline-block;width:100%;background:rgba(124,139,255,0.1)">${line}</span>`;
      }
      return line;
    })
    .join('\n');
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
  // Config / data — properties/ini/toml all key=value and the legacy
  // `properties` stream mode tokenizes any of them well enough.
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  properties: 'ini', conf: 'ini', cfg: 'ini',
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
    rootPath?: string;
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
  rootPathFallback: string | null,
): Array<{
  name: string;
  path: string;
  projectPath?: string | null;
  baseBranch?: string | null;
}> | null {
  for (const w of workspaces) {
    const c = convId ? (w.conversations ?? []).find((x) => x.id === convId) : null;
    // Match by convId first (regular workspace convs), then fall back to
    // rootPath (flow runs whose projectPath is the workspace symlink dir
    // but whose convId isn't part of the workspace's conversation list).
    if (!c && (!rootPathFallback || w.rootPath !== rootPathFallback)) continue;
    if (c?.worktreePath) return null;
    // Coordinator: map symlinks to member WORKTREES so the diff view
    // runs git from the right repo. Use the same project-name + numeric
    // suffix dedup that `ensureCoordinatorSymlinkRoot` uses on disk.
    if (c?.workspaceAgentMemberIds?.length) {
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
