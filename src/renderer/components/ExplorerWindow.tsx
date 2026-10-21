// A popped-out explorer: one folder's tree and editor in a window of its own.
//
// Loaded by the same renderer bundle with `?explorer=<root>` (see main.tsx),
// so it is the explorer pane itself rather than a second implementation. It
// takes only what the editor needs from the stored state, and never writes
// any back — the main window owns that. Its tabs are reported to main as they
// change, so closing the window hands back what was open at the end.

import { useEffect, useState } from 'react';
import { hydrateFileTabs, useStore } from '../store';
import { useThemeEffect } from '../useThemeEffect';
import { ExplorerPane } from './ExplorerPane';

export function ExplorerWindow({ root }: { root: string }) {
  const [ready, setReady] = useState(false);
  useThemeEffect();

  useEffect(() => {
    let live = true;
    const key = `explorer:${root}`;
    void Promise.all([
      window.overcli.invoke('store:load'),
      window.overcli.invoke('explorer:initialTabs', { root }),
    ]).then(([state, tabs]) => {
      if (!live) return;
      useStore.setState({
        storeLoaded: true,
        settings: state.settings,
        projects: state.projects,
        workspaces: state.workspaces,
        explorerRootPath: root,
        fileTabsByScope: tabs ? hydrateFileTabs({ [key]: tabs }) : {},
      });
      useStore.getState().switchFileScope(key);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [root]);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.tabs === prev.tabs && s.openFilePath === prev.openFilePath) return;
        void window.overcli.invoke('explorer:reportTabs', {
          root,
          tabs: { paths: s.tabs.map((t) => t.path), activePath: s.openFilePath },
        });
      }),
    [root],
  );

  // Unsaved edits hold the window open; main asks whether to discard them.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(useStore.getState().dirtyFiles).length === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    document.title = basename(root);
  }, [root]);

  return (
    <div className="flex h-screen w-screen flex-col bg-surface">
      {/* The inset traffic lights sit over this strip, so it is the window's
          drag handle and keeps its text clear of them. */}
      <div className="draggable flex h-9 flex-shrink-0 items-center justify-between border-b border-card bg-surface-muted pl-20 pr-2">
        <div className="min-w-0 truncate font-mono text-[11.5px] text-ink-muted" title={root}>
          {basename(root)} <span className="text-ink-faint">{root}</span>
        </div>
        <button
          className="no-drag rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-card hover:text-ink"
          title="Close this window and put its files back in the main window"
          onClick={() => void window.overcli.invoke('explorer:popIn', { root })}
        >
          Back to main window
        </button>
      </div>
      <div className="flex min-h-0 flex-1">{ready ? <ExplorerPane popout /> : null}</div>
    </div>
  );
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}
