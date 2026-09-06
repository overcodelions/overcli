import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { intakeProjectFiles } from '../attachmentIntake';
import type { DocumentEntry, FiledByMap } from '@shared/types';
import { FileEditorPane } from './FileEditorPane';
import { DocumentVersionsRail } from './DocumentVersionsRail';
import { revealLabel } from '../platform';
import { versionTimestamp } from './sheets/VersionsSheet';

/// The documents view: what a non-engineer sees when they open their files.
///
/// A card grid, one folder at a time, with a breadcrumb — the shape everyone
/// already knows from Drive, Dropbox and Finder. `ExplorerPane` stays exactly
/// as it is for code projects; a nested tree of monospace paths is the right
/// tool for a repo and the wrong one for a folder of Word documents.

const KIND_STYLES: Record<string, { tint: string; label: string }> = {
  doc: { tint: '#6aa9ff', label: 'Document' },
  sheet: { tint: '#4bbf7b', label: 'Spreadsheet' },
  slide: { tint: '#f0a35e', label: 'Presentation' },
  pdf: { tint: '#ef6f6f', label: 'PDF' },
  image: { tint: '#c58af0', label: 'Image' },
  text: { tint: '#9aa4b2', label: 'Text' },
};

function kindOf(name: string): keyof typeof KIND_STYLES {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['doc', 'docx', 'odt', 'rtf', 'md'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slide';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return 'image';
  return 'text';
}

/// "just now" / "2 hours ago" / "3 days ago" / a date. What a person wants to
/// know is how stale it is, and only past a week does the actual date matter.
export function relativeTime(mtimeMs: number, now: number): string {
  const secs = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(mtimeMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/// How long a filed document stays on the "recently filed" shelf.
///
/// A week, because the shelf answers "what landed while I wasn't looking"
/// and a worker on a weekly cadence is the common case. Anything older is
/// still in the grid below with the same attribution — it has just stopped
/// being news.
const RECENTLY_FILED_MS = 7 * 24 * 60 * 60 * 1000;

/// At most this many on the shelf. It is a heads-up, not a second grid: past
/// three it stops being scannable and starts competing with the documents.
const RECENTLY_FILED_LIMIT = 3;

type SortKey = 'recent' | 'name' | 'kind';

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'recent', label: 'Recent' },
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind' },
];

/// Folders first in every order — they are containers, not documents, and a
/// folder sorted into the middle of a page of files by date reads as a file
/// you cannot open. Beyond that: newest first, name, or grouped by kind and
/// then named (a "Kind" sort that leaves each group in arbitrary order is
/// only half a sort).
export function sortEntries(entries: readonly DocumentEntry[], key: SortKey): DocumentEntry[] {
  const byName = (a: DocumentEntry, b: DocumentEntry) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (key === 'name') return byName(a, b);
    if (key === 'kind') {
      const kindCmp = KIND_STYLES[kindOf(a.name)].label.localeCompare(KIND_STYLES[kindOf(b.name)].label);
      return kindCmp !== 0 ? kindCmp : byName(a, b);
    }
    return b.mtimeMs - a.mtimeMs || byName(a, b);
  });
}

export function DocumentsPane({ rootPath, projectName }: { rootPath: string; projectName: string }) {
  const openFile = useStore((s) => s.openFile);
  const openFilePath = useStore((s) => s.openFilePath);
  const closeFile = useStore((s) => s.closeFile);
  // Local, not `openFilePath`: a file left open from a previous visit should
  // not decide what this one opens on. Coming into your documents lands on
  // the documents, every time.
  const [viewingFile, setViewingFile] = useState(false);
  const openSheet = useStore((s) => s.openSheet);
  const closeExplorer = useStore((s) => s.closeExplorer);
  const checkpointProject = useStore((s) => s.checkpointProject);
  const [dir, setDir] = useState(rootPath);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('recent');
  /// Who filed what, for the attribution line. Loaded separately from the
  /// entries and allowed to arrive late: it reads every worker's publish
  /// ledger, and a caption is not worth making the grid wait.
  const [filedBy, setFiledBy] = useState<FiledByMap>({});

  const refresh = useCallback(async () => {
    const res = await window.overcli.invoke('fs:listDocuments', { dirPath: dir });
    if (res.ok) {
      setEntries(res.entries);
      setError(null);
    } else {
      setEntries([]);
      setError(res.error);
    }
  }, [dir]);

  useEffect(() => {
    setDir(rootPath);
  }, [rootPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keyed on the PROJECT, not the folder being browsed: workers file into the
  // project root, and the ledger records basenames. Re-read whenever the
  // listing does, so a document filed while this pane is open gets its
  // caption without a revisit.
  useEffect(() => {
    let live = true;
    void window.overcli
      .invoke('everyday:filedBy', { projectPath: rootPath })
      .then((map) => {
        if (live) setFiledBy(map);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rootPath, entries]);

  // Re-list when the sheet that creates documents closes, so a freshly
  // written file is on screen without the user hunting for a refresh.
  const activeSheet = useStore((s) => s.activeSheet);
  useEffect(() => {
    if (!activeSheet) void refresh();
  }, [activeSheet, refresh]);

  const crumbs = dir.slice(rootPath.length).split('/').filter(Boolean);
  const now = Date.now();
  const atRoot = crumbs.length === 0;
  const shown = sortEntries(entries, sort);
  const documents = entries.filter((e) => !e.isDir);
  const lastChangeMs = documents.reduce((newest, e) => Math.max(newest, e.mtimeMs), 0);
  // Only at the root, and only for documents a worker actually filed. In a
  // subfolder the shelf would be answering a question nobody asked — you
  // navigated there deliberately.
  const recentlyFiled = atRoot
    ? documents
        .filter((e) => filedBy[e.name] && now - e.mtimeMs < RECENTLY_FILED_MS)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, RECENTLY_FILED_LIMIT)
    : [];

  const addFiles = async (fileList: FileList) => {
    setBusy(true);
    const { files, rejections } = await intakeProjectFiles(fileList);
    if (files.length === 0) {
      setBusy(false);
      setError(rejections.at(-1) ?? 'Nothing to add.');
      return;
    }
    const res = await window.overcli.invoke('fs:copyIntoProject', {
      projectPath: dir,
      files: files.map((f) => ({
        name: f.name,
        sourcePath: f.sourcePath,
        dataBase64: f.dataBase64,
      })),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      void refresh();
      return;
    }
    // Keep a partial rejection visible: some files landing is not a reason to
    // stop telling the user about the ones that did not. Main can reject on
    // its own account too — it re-checks the size of a path it copies.
    const skipped = [...rejections, ...res.rejections];
    setError(skipped.at(-1) ?? null);
    const saved = await checkpointProject(
      rootPath,
      `Added ${res.written} document${res.written === 1 ? '' : 's'}`,
    );
    // A file too big to version still landed on disk, and saying nothing
    // leaves the user believing "Undo or restore" covers it. It does not:
    // git can never reclaim a big blob it has taken in, so the checkpoint is
    // declined on purpose.
    if (saved.skipped === 'too-large' && skipped.length === 0) {
      setError('Added — too large to include in version history.');
    }
    void refresh();
  };

  if (viewingFile) {
    const openName = openFilePath?.slice(openFilePath.lastIndexOf('/') + 1) ?? '';
    const openFiled = openFilePath ? filedBy[openName] : undefined;
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-card">
          <button
            onClick={() => {
              setViewingFile(false);
              closeFile();
            }}
            className="shrink-0 rounded-md border border-card px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
          >
            ← All documents
          </button>
          {openName && (
            <div className="min-w-0 flex flex-col gap-0.5">
              <div className="text-sm font-medium text-ink truncate">{openName}</div>
              {openFiled && (
                <div className="text-[11px] text-ink-faint truncate">
                  Filed by {openFiled.workerName}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col">
            <FileEditorPane rootPathOverride={rootPath} />
          </div>
          {/* The document's own history, beside it. `openFilePath` is the
              file the editor actually has open, which is not necessarily the
              one this pane last clicked — the editor has tabs. */}
          {openFilePath && <DocumentVersionsRail rootPath={rootPath} filePath={openFilePath} />}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {/* The project, not a path. The old header led with a breadcrumb, which
          is chrome for getting somewhere else — but you are already where you
          meant to be, and the folder's own name and state were nowhere on the
          screen. Crumbs still appear, below, once there is somewhere to go
          back from. */}
      <div className="shrink-0 flex items-start gap-4 px-6 py-5 border-b border-card">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in srgb, var(--c-accent) 16%, transparent)',
            color: 'var(--c-accent)',
          }}
        >
          <FolderGlyph />
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="text-xl font-semibold text-ink truncate tracking-[-0.01em]">{projectName}</div>
          <div className="text-xs text-ink-faint truncate">
            Everyday project
            {documents.length > 0 && ` · ${documents.length} document${documents.length === 1 ? '' : 's'}`}
            {lastChangeMs > 0 && ` · last change ${versionTimestamp(new Date(lastChangeMs).toISOString(), new Date(now))}`}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={() => openSheet({ type: 'versions', projectPath: rootPath })}
            title="Go back to how this folder was earlier"
            className="rounded-md border border-card bg-surface-elevated px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong hover:border-card-strong transition-colors"
          >
            Earlier versions
          </button>
          <button
            onClick={() => openSheet({ type: 'newDocument', dirPath: dir })}
            className="accent-soft rounded-md border px-3 py-1.5 text-xs text-accent transition-colors"
          >
            + New document
          </button>
          <button
            onClick={() => window.overcli.invoke('fs:openInFinder', dir)}
            className="rounded-md border border-card px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
          >
            {revealLabel()}
          </button>
          <button
            onClick={closeExplorer}
            className="rounded-md px-2 py-1.5 text-xs text-ink-faint hover:text-ink"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {!atRoot && (
        <div className="shrink-0 flex items-center gap-1.5 px-6 py-2.5 text-xs border-b border-card">
          <button onClick={() => setDir(rootPath)} className="text-ink-muted hover:text-ink">
            {projectName}
          </button>
          {crumbs.map((c, i) => (
            <span key={c + i} className="flex items-center gap-1.5 min-w-0">
              <span className="text-ink-faint">/</span>
              <button
                onClick={() => setDir(`${rootPath}/${crumbs.slice(0, i + 1).join('/')}`)}
                className={
                  'truncate ' +
                  (i === crumbs.length - 1 ? 'text-ink font-medium' : 'text-ink-muted hover:text-ink')
                }
              >
                {c}
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div className="shrink-0 px-6 py-2 text-xs text-red-400">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-6">
        {recentlyFiled.length > 0 && (
          <div className="flex flex-col gap-2.5 shrink-0">
            <div className="flex items-baseline gap-2.5">
              <div className="text-[13px] font-semibold text-ink">Recently filed</div>
              <div className="text-[11px] text-ink-faint">Everything below can be undone.</div>
            </div>
            <div className="flex flex-col gap-2">
              {recentlyFiled.map((e) => (
                <div
                  key={e.path}
                  className="flex items-center gap-3 rounded-lg border accent-invite px-3 py-2.5"
                >
                  <div
                    className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 text-[11px] font-semibold"
                    style={{
                      background: 'color-mix(in srgb, var(--c-accent) 18%, transparent)',
                      color: 'var(--c-accent)',
                    }}
                  >
                    {initialsOf(filedBy[e.name]?.workerName ?? '')}
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <div className="text-[13px] text-ink truncate">{e.name}</div>
                    <div className="text-[11px] text-ink-faint truncate">
                      {filedBy[e.name]?.workerName} filed it · {relativeTime(e.mtimeMs, now)}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      onClick={() => openSheet({ type: 'versions', projectPath: rootPath })}
                      title="Go back to how this folder was earlier"
                      className="rounded border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink hover:bg-card-strong"
                    >
                      Undo this
                    </button>
                    <button
                      onClick={() => {
                        openFile(e.path);
                        setViewingFile(true);
                      }}
                      className="accent-soft rounded border px-2.5 py-1 text-[11px] text-accent"
                    >
                      Open
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {entries.length > 0 && (
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-[13px] font-semibold text-ink">
              {atRoot ? 'Your documents' : crumbs[crumbs.length - 1]}
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-1 p-0.5 rounded-md border border-card bg-card">
              {SORTS.map((option) => (
                <button
                  key={option.key}
                  onClick={() => setSort(option.key)}
                  className={
                    'rounded px-2.5 py-1 text-[11px] transition-colors ' +
                    (sort === option.key
                      ? 'bg-card-strong text-ink'
                      : 'text-ink-faint hover:text-ink-muted')
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center"
              style={{
                background: 'color-mix(in srgb, var(--c-accent) 16%, transparent)',
                color: 'var(--c-accent)',
              }}
            >
              <FileGlyph size={22} />
            </div>
            <div className="text-sm font-medium text-ink mt-1">Nothing here yet</div>
            <div className="text-xs text-ink-muted max-w-[380px] leading-relaxed">
              Drag documents in from your file manager, or use{' '}
              <span className="text-ink">New document</span> to
              describe what you want and have one written for you.
            </div>
          </div>
        ) : (
          <div className="grid gap-3 content-start [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {shown.map((e) => {
              const kind = kindOf(e.name);
              const filed = filedBy[e.name];
              const style = KIND_STYLES[kind];
              return (
                <button
                  key={e.path}
                  onClick={() => {
                    if (e.isDir) {
                      setDir(e.path);
                      return;
                    }
                    openFile(e.path);
                    setViewingFile(true);
                  }}
                  className="group rounded-lg border border-card bg-surface-elevated p-3 text-left hover:border-card-strong hover:bg-card-strong transition-colors flex flex-col gap-2"
                  style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
                >
                  <div
                    className="w-9 h-9 rounded-md flex items-center justify-center"
                    style={
                      e.isDir
                        ? { background: 'color-mix(in srgb, var(--c-accent) 16%, transparent)', color: 'var(--c-accent)' }
                        : { background: `color-mix(in srgb, ${style.tint} 16%, transparent)`, color: style.tint }
                    }
                  >
                    {e.isDir ? <FolderGlyph /> : <FileGlyph />}
                  </div>
                  <div className="text-xs text-ink font-medium truncate" title={e.name}>
                    {e.name}
                  </div>
                  <div className="text-[11px] text-ink-faint truncate">
                    {e.isDir ? 'Folder' : `${style.label} · ${formatSize(e.sizeBytes)}`}
                  </div>
                  <div className="text-[11px] text-ink-faint truncate">
                    {relativeTime(e.mtimeMs, now)}
                  </div>
                  {filed && !e.isDir && (
                    <div
                      className="text-[11px] truncate"
                      style={{ color: 'var(--c-accent)' }}
                      title={`Filed by ${filed.workerName}`}
                    >
                      by {filed.workerName}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {(dragging || busy) && (
        <div className="absolute inset-0 flex items-center justify-center accent-dropzone border-2 border-dashed rounded-lg m-2 pointer-events-none">
          <div className="text-sm font-medium text-accent">
            {busy ? 'Adding…' : 'Drop to add to this folder'}
          </div>
        </div>
      )}
    </div>
  );
}

function FolderGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .78.37l.74.92h5.88a1 1 0 0 1 1 1v6.21a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}

function FileGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M9.25 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" strokeLinejoin="round" />
      <path d="M9.25 1.75v3.5h3.5" strokeLinejoin="round" />
    </svg>
  );
}

/// Up to two initials for a worker's tile — "Release Warden" is RW, one-word
/// names keep a single letter. Purely a stand-in for a face; the name itself
/// is always spelled out on the line beside it.
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}
