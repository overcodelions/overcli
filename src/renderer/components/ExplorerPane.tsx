import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { FileTree } from './FileTree';
import { FileEditorPane } from './FileEditorPane';
import { ResizableDivider } from './ResizableDivider';

const TREE_MIN = 200;
const TREE_MAX = 520;

interface BranchInfo {
  isRepo: boolean;
  currentBranch: string;
  insertions: number;
  deletions: number;
  changeCount: number;
}

/// Standalone file explorer — a persistent tree on the left and the file
/// editor on the right, rooted at the project or workspace the user picked
/// from the sidebar. Lets the user read and edit without needing to open
/// a conversation first.
export function ExplorerPane() {
  const rootPath = useStore((s) => s.explorerRootPath);
  const openFilePath = useStore((s) => s.openFilePath);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const [treeWidth, setTreeWidth] = useState(
    () => clamp(settings.explorerTreeWidth ?? 280, TREE_MIN, TREE_MAX),
  );
  useEffect(() => {
    setTreeWidth(clamp(settings.explorerTreeWidth ?? 280, TREE_MIN, TREE_MAX));
  }, [settings.explorerTreeWidth]);

  // Poll the working tree for branch + dirty counts whenever the root
  // changes or the user opens/saves a file. When a file is open we query
  // at its enclosing directory so nested repos (e.g. a workspace that
  // symlinks multiple projects) resolve to their own branch — git walks
  // up to the nearest `.git` on its own. Symlink workspace roots with no
  // file open aren't real repos; `isRepo` comes back false and we hide
  // the banner.
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  useEffect(() => {
    if (!rootPath) {
      setBranch(null);
      return;
    }
    const cwd = openFilePath ? dirname(openFilePath) : rootPath;
    let cancelled = false;
    void window.overcli.invoke('git:commitStatus', { cwd }).then((res) => {
      if (cancelled) return;
      setBranch({
        isRepo: res.isRepo,
        currentBranch: res.currentBranch,
        insertions: res.insertions,
        deletions: res.deletions,
        changeCount: res.changes.length,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, openFilePath]);

  if (!rootPath) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        Pick a project or workspace from the sidebar to explore.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {branch?.isRepo && branch.currentBranch && (
        <BranchBanner info={branch} />
      )}
      <div className="flex flex-1 min-h-0 min-w-0">
      <div
        style={{ width: treeWidth }}
        className="flex-shrink-0 h-full border-r border-card overflow-hidden"
      >
        <FileTree rootPath={rootPath} />
      </div>
      <ResizableDivider
        width={treeWidth}
        onChange={setTreeWidth}
        onCommit={(w) => void saveSettings({ ...settings, explorerTreeWidth: w })}
        minWidth={TREE_MIN}
        maxWidth={TREE_MAX}
        side="left"
      />
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        {openFilePath ? (
          <FileEditorPane rootPathOverride={rootPath} />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-ink-faint">
            Select a file from the tree to open it.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/// Thin read-only strip at the top of the explorer showing the current
/// git branch and dirty-file stats. Matches the `⎇ branch` treatment used
/// in the conversation header so the two views feel consistent.
function BranchBanner({ info }: { info: BranchInfo }) {
  const dirty = info.changeCount > 0;
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] border-b border-card bg-surface-muted">
      <span
        className="font-mono text-ink-muted truncate max-w-[280px]"
        title={info.currentBranch}
      >
        ⎇ {info.currentBranch}
      </span>
      {dirty ? (
        <span className="text-ink-faint">
          <span className="text-green-400">+{info.insertions}</span>{' '}
          <span className="text-red-400">−{info.deletions}</span>
          <span className="ml-2">
            {info.changeCount} file{info.changeCount === 1 ? '' : 's'} changed
          </span>
        </span>
      ) : (
        <span className="text-ink-faint">clean</span>
      )}
    </div>
  );
}

function clamp(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}

function dirname(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const i = p.lastIndexOf(sep);
  return i <= 0 ? p : p.slice(0, i);
}
