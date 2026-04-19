import { useEffect, useState } from 'react';
import { useStore } from './store';
import { useThemeEffect } from './useThemeEffect';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { StatsPage } from './components/StatsPage';
import { LocalPane } from './components/LocalPane';
import { WelcomePane } from './components/WelcomePane';
import { SheetHost } from './components/SheetHost';
import { TitleBar } from './components/TitleBar';
import { ResizableDivider } from './components/ResizableDivider';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;

export function App() {
  const init = useStore((s) => s.init);
  const ingest = useStore((s) => s.ingestMainEvent);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const detailMode = useStore((s) => s.detailMode);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const activeSheet = useStore((s) => s.activeSheet);
  const openSheet = useStore((s) => s.openSheet);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const projects = useStore((s) => s.projects);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  // Mirror the persisted width into transient state so drag updates are
  // snappy (store writes hit disk via saveSettings which goes through
  // IPC); we commit back to settings on pointer-up.
  const [sidebarWidth, setSidebarWidth] = useState(
    () => clampWidth(settings.sidebarWidth ?? 260, SIDEBAR_MIN, SIDEBAR_MAX),
  );
  useEffect(() => {
    setSidebarWidth(clampWidth(settings.sidebarWidth ?? 260, SIDEBAR_MIN, SIDEBAR_MAX));
  }, [settings.sidebarWidth]);

  useEffect(() => {
    void init();
  }, [init]);

  // Apply light/dark preference to <html>. Must run before first paint so
  // the page doesn't flash the wrong theme on load.
  useThemeEffect();

  useEffect(() => {
    const unsub = window.overcli.onMainEvent((e) => {
      if (e.type === 'running' && e.conversationId === '__menu_new_conversation__') {
        // Menu shortcut: open the composer-first welcome screen for the
        // first project if we have one, otherwise prompt to pick.
        const first = projects[0];
        if (first) startNewConversation(first.id);
        return;
      }
      ingest(e);
    });
    return () => unsub();
  }, [ingest, projects, startNewConversation]);

  // Keyboard shortcuts: Cmd+P for file finder, Cmd+\ for sidebar toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        const convId = selectedConversationId;
        // Resolve the project path from the store for Cmd+P.
        const state = useStore.getState();
        let rootPath = '';
        for (const p of state.projects) {
          const c = p.conversations.find((x) => x.id === convId);
          if (c) {
            rootPath = c.worktreePath ?? p.path;
            break;
          }
        }
        if (rootPath) openSheet({ type: 'fileFinder', rootPath });
      } else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        openSheet({ type: 'settings' });
      } else if (e.key === 'Escape' && activeSheet) {
        openSheet(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSheet, toggleSidebar, selectedConversationId, activeSheet]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {sidebarVisible && (
          <>
            <div
              style={{ width: sidebarWidth }}
              className="flex-shrink-0 h-full overflow-hidden"
            >
              <Sidebar />
            </div>
            <ResizableDivider
              width={sidebarWidth}
              onChange={setSidebarWidth}
              onCommit={(w) => void saveSettings({ ...settings, sidebarWidth: w })}
              minWidth={SIDEBAR_MIN}
              maxWidth={SIDEBAR_MAX}
              side="left"
            />
          </>
        )}
        <main className="flex-1 min-w-0 flex flex-col bg-surface">
          {detailMode === 'stats' ? (
            <StatsPage />
          ) : detailMode === 'local' ? (
            <LocalPane />
          ) : selectedConversationId ? (
            <ConversationPane />
          ) : (
            <WelcomePane />
          )}
        </main>
      </div>
      <SheetHost />
    </div>
  );
}

function clampWidth(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}
