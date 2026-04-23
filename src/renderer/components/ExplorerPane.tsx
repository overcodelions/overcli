import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { FileTree } from './FileTree';
import { FileEditorPane } from './FileEditorPane';
import { ResizableDivider } from './ResizableDivider';

const TREE_MIN = 200;
const TREE_MAX = 520;

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

  if (!rootPath) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        Pick a project or workspace from the sidebar to explore.
      </div>
    );
  }

  return (
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
  );
}

function clamp(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}
