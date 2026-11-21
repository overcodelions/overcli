// A file opened in overcli from outside it — Finder's "Open With", a drop on
// the Dock icon — in a window of its own: the editor and nothing else, the
// way any other app opens a document.
//
// Loaded by the same renderer bundle with `?file=<path>` (see main.tsx). Main
// has already made exactly this file readable and savable (openedFiles.ts);
// nothing beside it is, so there is no tree to show. Like the explorer
// window, it takes what the editor needs from the stored state and never
// writes any back.

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useThemeEffect } from '../useThemeEffect';
import { FileEditorPane } from './FileEditorPane';

export function FileWindow({ path }: { path: string }) {
  const [ready, setReady] = useState(false);
  useThemeEffect();

  useEffect(() => {
    let live = true;
    void window.overcli.invoke('store:load').then((state) => {
      if (!live) return;
      useStore.setState({
        storeLoaded: true,
        settings: state.settings,
        projects: state.projects,
        workspaces: state.workspaces,
        fileTabsByScope: {},
      });
      const store = useStore.getState();
      store.switchFileScope(`file:${path}`);
      store.openFile(path);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [path]);

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
    document.title = basename(path);
  }, [path]);

  return (
    <div className="flex h-screen w-screen flex-col bg-surface">
      {/* The inset traffic lights sit over this strip, so it is the window's
          drag handle and keeps its text clear of them. */}
      <div className="draggable flex h-9 flex-shrink-0 items-center border-b border-card bg-surface-muted pl-20 pr-2">
        <div className="min-w-0 truncate font-mono text-[11.5px] text-ink-muted" title={path}>
          {basename(path)} <span className="text-ink-faint">{dirname(path)}</span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">{ready ? <FileEditorPane rootPathOverride={dirname(path)} /> : null}</div>
    </div>
  );
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}
