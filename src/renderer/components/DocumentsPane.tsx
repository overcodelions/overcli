import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { intakeAttachments } from '../attachmentIntake';
import type { DocumentEntry } from '@shared/types';
import { FileEditorPane } from './FileEditorPane';

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

export function DocumentsPane({ rootPath, projectName }: { rootPath: string; projectName: string }) {
  const openFile = useStore((s) => s.openFile);
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

  // Re-list when the sheet that creates documents closes, so a freshly
  // written file is on screen without the user hunting for a refresh.
  const activeSheet = useStore((s) => s.activeSheet);
  useEffect(() => {
    if (!activeSheet) void refresh();
  }, [activeSheet, refresh]);

  const crumbs = dir.slice(rootPath.length).split('/').filter(Boolean);
  const now = Date.now();

  const addFiles = async (fileList: FileList) => {
    setBusy(true);
    const { attachments, rejections } = await intakeAttachments(fileList);
    if (attachments.length === 0) {
      setBusy(false);
      setError(rejections.at(-1) ?? 'Nothing to add.');
      return;
    }
    const res = await window.overcli.invoke('fs:copyIntoProject', {
      projectPath: dir,
      files: attachments.map((a) => ({ name: a.label ?? 'file', dataBase64: a.dataBase64 })),
    });
    setBusy(false);
    // Keep a partial rejection visible: some files landing is not a reason to
    // stop telling the user about the ones that did not.
    setError(res.ok ? (rejections.at(-1) ?? null) : res.error);
    if (res.ok) {
      void checkpointProject(
        rootPath,
        `Added ${res.written} document${res.written === 1 ? '' : 's'}`,
      );
    }
    void refresh();
  };

  if (viewingFile) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="shrink-0 flex items-center gap-2 px-6 py-3 border-b border-card">
          <button
            onClick={() => {
              setViewingFile(false);
              closeFile();
            }}
            className="rounded-md border border-card px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
          >
            ← All documents
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          <FileEditorPane rootPathOverride={rootPath} />
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
      <div className="shrink-0 flex items-center gap-2 px-6 py-4 border-b border-card">
        <div className="flex items-center gap-1.5 text-sm flex-1 min-w-0">
          <button
            onClick={() => setDir(rootPath)}
            className={crumbs.length ? 'text-ink-muted hover:text-ink' : 'text-ink font-medium'}
          >
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
        <button
          onClick={() => openSheet({ type: 'newDocument', dirPath: dir })}
          className="shrink-0 accent-soft rounded-md border px-3 py-1.5 text-xs text-accent transition-colors"
        >
          + New document
        </button>
        <button
          onClick={() => openSheet({ type: 'versions', projectPath: rootPath })}
          title="Go back to how this folder was earlier"
          className="shrink-0 rounded-md border border-card px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
        >
          Undo or restore
        </button>
        <button
          onClick={() => window.overcli.invoke('fs:openInFinder', dir)}
          className="shrink-0 rounded-md border border-card px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
        >
          Show in Finder
        </button>
        <button
          onClick={closeExplorer}
          className="shrink-0 rounded-md px-2 py-1.5 text-xs text-ink-faint hover:text-ink"
          title="Close"
        >
          ✕
        </button>
      </div>

      {error && <div className="shrink-0 px-6 py-2 text-xs text-red-400">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        {entries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2">
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
              Drag documents in from Finder, or use <span className="text-ink">New document</span> to
              describe what you want and have one written for you.
            </div>
          </div>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {entries.map((e) => {
              const kind = kindOf(e.name);
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
