import { useEffect, useState } from 'react';
import { noBackendReady, useStore } from './store';
import { useConversation } from './hooks';
import { findConversation } from './conversationLookup';
import { useThemeEffect } from './useThemeEffect';
import { useShortcuts } from './useShortcuts';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { StatsPage } from './components/StatsPage';
import { LocalPane } from './components/LocalPane';
import { WelcomePane } from './components/WelcomePane';
import { ExplorerPane } from './components/ExplorerPane';
import { FlowsLibraryPane } from './components/flows/FlowsLibraryPane';
import { OrchestratorPane } from './components/orchestrator/OrchestratorPane';
import { useFlowsStore } from './flowsStore';
import { SheetHost } from './components/SheetHost';
import { TitleBar } from './components/TitleBar';
import { ResizableDivider } from './components/ResizableDivider';
import { SubagentDrawer } from './components/SubagentDrawer';
import { FileEditorPane } from './components/FileEditorPane';
import { UpdateToast } from './components/UpdateToast';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;
const SUBAGENT_DRAWER_MIN = 320;
const SUBAGENT_DRAWER_MAX = 820;
const SUBAGENT_DRAWER_DEFAULT = 480;
const SIDE_FILE_MIN = 420;
const SIDE_FILE_MAX = 1000;
const SIDE_FILE_DEFAULT = 640;

export function App() {
  const init = useStore((s) => s.init);
  const ingest = useStore((s) => s.ingestMainEvent);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const backendHealth = useStore((s) => s.backendHealth);
  const detailMode = useStore((s) => s.detailMode);
  const subagentDrawerParentId = useStore((s) => s.subagentDrawerParentId);
  const subagentDrawerConversationId = useStore((s) => s.subagentDrawerConversationId);
  const [subagentDrawerWidth, setSubagentDrawerWidth] = useState(SUBAGENT_DRAWER_DEFAULT);
  // Side-file pane: when the SubagentDrawer is open, ANY open file
  // renders here (right of the drawer) instead of inline next to the
  // conversation. The conversation should never be displaced once
  // you've committed to the drawer view, so we ignore the trigger
  // (drawer click, main-transcript click, sheet open — same slot).
  const openFilePath = useStore((s) => s.openFilePath);
  // Show the side-file editor pane when:
  //   - the subagent drawer is open (original behavior), OR
  //   - we're in the Flows view (FlowsLibraryPane has no built-in file
  //     editor mount, so file-link clicks would otherwise fall on the
  //     floor — wire them to this side pane instead).
  const sideFileVisible =
    !!openFilePath && (!!subagentDrawerParentId || detailMode === 'flows');
  const [sideFileWidth, setSideFileWidth] = useState(SIDE_FILE_DEFAULT);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const selectConversation = useStore((s) => s.selectConversation);
  const selectedConv = useConversation(selectedConversationId);
  // When the user is inside a flow run, derive a "drawer conv id" from
  // the active run's currently-focused participant so subagent cards
  // inside a flow step (e.g. the Task tool spawning an Explore agent)
  // can open the SubagentDrawer — without this fallback the drawer
  // gating on `selectedConversationId` no-ops in the flows detail mode.
  const activeFlowRunId = useFlowsStore((s) => s.activeRunId);
  const activeFlowRun = useFlowsStore((s) =>
    s.activeRunId ? s.runs[s.activeRunId] : undefined,
  );
  const flowDrawerConvId = (() => {
    if (detailMode !== 'flows' || !activeFlowRun) return null;
    const st = activeFlowRun.state;
    const currentStepId =
      st.kind === 'running'
        ? st.currentStepId
        : st.kind === 'paused'
          ? st.nextStepId
          : activeFlowRun.attempts[activeFlowRun.attempts.length - 1]?.stepId;
    if (!currentStepId) return null;
    const step = activeFlowRun.flowSnapshot.steps.find((s) => s.id === currentStepId);
    return step ? activeFlowRun.conversationIds[step.participantId] ?? null : null;
  })();
  // The drawer renders when EITHER a regular conversation is selected
  // OR we're inside a flow run with a known conv. Prefer the conv id
  // recorded by the inline SubagentCard at click time — the card knows
  // its own conversation, even when that conversation isn't the one
  // selected in the sidebar (flow step transcripts, history search).
  const drawerConvId =
    subagentDrawerConversationId ?? selectedConversationId ?? flowDrawerConvId;
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

  // Hydrate flow runs on app startup so the sidebar's per-project
  // "Flows" sections populate immediately. Without this, runs only
  // appeared after the user visited the Flows tab (which is where
  // the original IPC call lived).
  useEffect(() => {
    void window.overcli.invoke('flows:listRuns').then((runs) => {
      useFlowsStore.getState().applyRunsBulk(runs);
      // Warm each run's transcript + markdown in the background (idle-paced)
      // so the first click into a run paints instantly.
      void useStore.getState().prefetchFlowRunHistories();
    });
    // Hydrate orchestrations too, so an in-progress batch's ledger survives a
    // window refresh even if the user lands on a different tab — the batch
    // and its runs live in main and keep going regardless.
    void import('./orchestratorStore').then(({ useOrchestratorStore }) => {
      void useOrchestratorStore.getState().reload();
    });
  }, []);

  // Self-heal: if the selected conversation has been deleted (e.g. the
  // user hits Delete from ArchiveConversationSheet), fall back to the
  // welcome pane instead of leaving a dead conversation selected.
  // Debounced so transient store/index timing doesn't cause a visible
  // one-frame drop back to Welcome while the conversation still exists.
  useEffect(() => {
    if (!selectedConversationId || selectedConv) return;
    const timer = setTimeout(() => {
      const state = useStore.getState();
      if (state.selectedConversationId !== selectedConversationId) return;
      if (!findConversation(state, selectedConversationId)) {
        state.selectConversation(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [selectedConversationId, selectedConv, selectConversation]);

  // Apply light/dark preference to <html>. Must run before first paint so
  // the page doesn't flash the wrong theme on load.
  useThemeEffect();

  // Coalesce incoming main events over a one-frame window. Each streamed
  // delta arrives as its own IPC message in a separate task, so React can't
  // batch them: a single background watch tick that streams many deltas would
  // otherwise fire one FULL global re-render per delta (every broad
  // useAllRunners() subscriber — sidebar activity sort, headers, flow rows)
  // AND one O(n) event-merge per delta. That storm is what beachballs the UI
  // when a watch wakes up. Buffering collapses a burst into a single render
  // pass, and concatenating consecutive same-conversation stream batches
  // collapses the per-delta merges into one merge per conversation per flush.
  useEffect(() => {
    type MainEvent = Parameters<typeof ingest>[0];
    let buffer: MainEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const batch = buffer;
      buffer = [];
      const coalesced: MainEvent[] = [];
      for (const e of batch) {
        const last = coalesced[coalesced.length - 1];
        if (
          e.type === 'stream' &&
          last &&
          last.type === 'stream' &&
          last.conversationId === e.conversationId
        ) {
          // Still streaming the same conversation — concatenate so the store
          // merges once instead of once per IPC message. `last` is a private
          // copy (made below), so mutating it here is safe.
          last.events = last.events.concat(e.events);
        } else {
          coalesced.push(e.type === 'stream' ? { ...e, events: [...e.events] } : e);
        }
      }
      for (const e of coalesced) ingest(e);
    };
    const unsub = window.overcli.onMainEvent((e) => {
      if (e.type === 'running' && e.conversationId === '__menu_new_conversation__') {
        // Menu shortcut: open the composer-first welcome screen for the
        // first project if we have one, otherwise prompt to pick. Routed
        // immediately — it's a one-off, never part of a stream burst.
        const first = projects[0];
        if (first) startNewConversation(first.id);
        return;
      }
      buffer.push(e);
      if (timer == null) timer = setTimeout(flush, 16);
    });
    return () => {
      if (timer != null) clearTimeout(timer);
      if (buffer.length) flush();
      unsub();
    };
  }, [ingest, projects, startNewConversation]);

  useShortcuts();

  // First-run onboarding: with no projects and no usable CLI the sidebar is
  // empty (its add buttons are disabled anyway), so hide it and give the
  // welcome/setup screen the full width. Settings stays reachable via the
  // title-bar gear.
  const onboarding = projects.length === 0 && noBackendReady(backendHealth);
  const showSidebar = sidebarVisible && !onboarding;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {showSidebar && (
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
          ) : detailMode === 'explorer' ? (
            <ExplorerPane />
          ) : detailMode === 'flows' ? (
            <FlowsLibraryPane />
          ) : detailMode === 'orchestrator' ? (
            <OrchestratorPane />
          ) : selectedConversationId ? (
            <ConversationPane />
          ) : (
            <WelcomePane />
          )}
        </main>
        {subagentDrawerParentId && drawerConvId && (
          <>
            <ResizableDivider
              width={subagentDrawerWidth}
              onChange={setSubagentDrawerWidth}
              minWidth={SUBAGENT_DRAWER_MIN}
              maxWidth={SUBAGENT_DRAWER_MAX}
              side="right"
            />
            <div
              style={{ width: subagentDrawerWidth }}
              className="flex-shrink-0 h-full overflow-hidden"
            >
              <SubagentDrawer conversationId={drawerConvId} />
            </div>
          </>
        )}
        {sideFileVisible && (
          <>
            <ResizableDivider
              width={sideFileWidth}
              onChange={setSideFileWidth}
              minWidth={SIDE_FILE_MIN}
              maxWidth={SIDE_FILE_MAX}
              side="right"
            />
            <div
              style={{ width: sideFileWidth }}
              className="flex-shrink-0 h-full overflow-hidden border-l border-card"
            >
              {/* Flow runs aren't in the main Conversation index, so the
                  editor's default `useConversationRoot(convId)` lookup
                  returns null and relative paths fail to resolve. Pass
                  the active run's projectPath as an explicit root when
                  we're viewing a flow. */}
              <FileEditorPane
                rootPathOverride={
                  detailMode === 'flows' && activeFlowRun ? activeFlowRun.projectPath : null
                }
              />
            </div>
          </>
        )}
      </div>
      <SheetHost />
      <UpdateToast />
    </div>
  );
}

function clampWidth(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}
