import { useEffect, useRef, useState } from 'react';
import { anyBackendReady, useStore } from './store';
import { useConversation } from './hooks';
import { findConversation } from './conversationLookup';
import { useThemeEffect } from './useThemeEffect';
import { useShortcuts } from './useShortcuts';
import { useRunningReconcile } from './useRunningReconcile';
import { useFileScope } from './fileScope';
import { installNavHistory, readLocation, useNavHistory } from './navHistory';
import { Sidebar } from './components/Sidebar';
import { ConversationPane } from './components/ConversationPane';
import { StatsPage } from './components/StatsPage';
import { LocalPane } from './components/LocalPane';
import { WelcomePane } from './components/WelcomePane';
import { ExplorerPane } from './components/ExplorerPane';
import { FlowsLibraryPane } from './components/flows/FlowsLibraryPane';
import { OrchestratorPane } from './components/orchestrator/OrchestratorPane';
import { WorkersPane } from './components/workers/WorkersPane';
import { focusedFlowConversationId } from './flowFocus';
import { useFlowsStore } from './flowsStore';
import { useOrchestratorStore } from './orchestratorStore';
import { SheetHost } from './components/SheetHost';
import { TitleBar } from './components/TitleBar';
import { ResizableDivider } from './components/ResizableDivider';
import { SubagentDrawer } from './components/SubagentDrawer';
import { FileEditorPane } from './components/FileEditorPane';
import { useWorkersStore } from './workersStore';
import { UpdateToast } from './components/UpdateToast';
import { fileEditorRootFor } from './fileEditorRoot';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;
const SUBAGENT_DRAWER_MIN = 320;
const SUBAGENT_DRAWER_MAX = 820;
const SUBAGENT_DRAWER_DEFAULT = 480;
const SIDE_FILE_MIN = 420;
const SIDE_FILE_DEFAULT = 640;
/// The narrowest the main column may be squeezed to when a side pane is
/// dragged wide. The side file pane's ceiling is derived from the window
/// rather than fixed (see `sideFileMax`): a fixed 1000px cap stopped the
/// preview mid-screen on a 27" display, where the whole point of the extra
/// pixels is that a rendered document can have them.
const MAIN_MIN = 480;

export function App() {
  // Keeps the file editor's open tabs pointed at the right scope
  // (conversation / flow run / explorer root). See ./fileScope.ts.
  useFileScope();
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
    !!openFilePath &&
    (!!subagentDrawerParentId || detailMode === 'flows' || detailMode === 'workers');
  const workerFilesRoot = useWorkersStore(
    (s) => (s.selectedWorkerId ? (s.filesRoot[s.selectedWorkerId] ?? null) : null),
  );
  const [sideFileWidth, setSideFileWidth] = useState(SIDE_FILE_DEFAULT);
  // Whether the user has sized this pane themselves this session. An explicit
  // drag outranks any default, so the next report opening must not undo it.
  const sideFileDragged = useRef(false);
  const windowWidth = useWindowWidth();
  // The three resizable panels, handed to their dividers so a drag can move
  // them directly. A width is pure layout: making it React state mid-gesture
  // re-renders the whole tab (roster, transcript, rendered markdown) once per
  // pointer event, which is what made dragging the preview edge stutter on the
  // Workers tab and not on Chat. State is set once, on release.
  const sidebarPanel = useRef<HTMLDivElement>(null);
  const drawerPanel = useRef<HTMLDivElement>(null);
  const sideFilePanel = useRef<HTMLDivElement>(null);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const selectConversation = useStore((s) => s.selectConversation);
  const selectedConv = useConversation(selectedConversationId);
  // When the user is inside a flow run, derive a "drawer conv id" from
  // the active run's currently-focused participant so subagent cards
  // inside a flow step (e.g. the Task tool spawning an Explore agent)
  // can open the SubagentDrawer — without this fallback the drawer
  // gating on `selectedConversationId` no-ops in the flows detail mode.
  const activeFlowRun = useFlowsStore((s) =>
    s.activeRunId ? s.runs[s.activeRunId] : undefined,
  );
  const flowDrawerConvId =
    detailMode === 'flows' && activeFlowRun ? focusedFlowConversationId(activeFlowRun) : null;
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
    // Reset the back/forward history once the startup view restore has
    // settled — the store writes init() makes are the app arriving at the
    // last-used screen, not the user navigating to it, and leaving them in
    // the stack would make the first Back press jump somewhere they never
    // visited this session.
    void init().then(() => useNavHistory.getState().reset(readLocation()));
  }, [init]);

  // Back/forward across views (⌘←/⌘→, and the title-bar arrows).
  useEffect(() => installNavHistory(), []);

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
    // Schedules hydrate at startup rather than with the Flows pane, because
    // the title bar's indicator has to be right from the first paint — the
    // whole point of it is telling you something is running before you've
    // thought to go looking.
    void import('./schedulesStore').then(({ useSchedulesStore }) => {
      void useSchedulesStore.getState().reload();
    });
    // Workers hydrate at startup for the same reason: a shift can fire (and a
    // scorecard change) before the user ever opens the Workers tab.
    void import('./workersStore').then(({ useWorkersStore }) => {
      void useWorkersStore.getState().reload();
    });
  }, []);

  // Surface release notes on the first launch after an update. The install is
  // deferred to quit (see updater.ts), so UpdateToast fires while the user is
  // still on the old build — this is the first moment they actually have the
  // features being described. Anything already on screen wins: an auto-opened
  // panel that stomps a restored sheet is worse than one the user opens from
  // About a minute later.
  useEffect(() => {
    void window.overcli.invoke('app:whatsNew').then((report) => {
      if (!report.unseen) return;
      const { activeSheet, openSheet, setWhatsNewUnseen } = useStore.getState();
      setWhatsNewUnseen(true);
      if (!activeSheet) openSheet({ type: 'whatsNew' });
    });
  }, []);

  // Persist the current "where am I" view (detail mode, focused project/
  // workspace, active flow run, active orchestration) whenever it changes, so
  // a full renderer reload — e.g. macOS discarding the render process during a
  // long sleep — restores the same screen on relaunch instead of dropping back
  // to the default conversation view. selectedConversationId is persisted
  // separately by selectConversation; this covers everything else. init()
  // reads these back on launch.
  useEffect(() => {
    let last = '';
    const persist = () => {
      const s = useStore.getState();
      const orch = useOrchestratorStore.getState();
      const view = {
        detailMode: s.detailMode,
        focusedProjectId: s.focusedProjectId,
        focusedWorkspaceId: s.focusedWorkspaceId,
        activeRunId: useFlowsStore.getState().activeRunId,
        activeOrchestrationId: orch.activeOrchestrationId,
        // Sticky batch-launch defaults — so "main tree" (runIn: 'cwd') and its
        // coupled concurrency / PR-on-finish choices survive a reload instead
        // of snapping back to the worktree default.
        orchestrator: {
          runIn: orch.runIn,
          maxConcurrent: orch.maxConcurrent,
          openPrOnFinish: orch.openPrOnFinish,
        },
      };
      // The main store fires on every stream delta; skip the IPC write unless
      // the view identity actually changed.
      const key = JSON.stringify(view);
      if (key === last) return;
      last = key;
      void window.overcli.invoke('store:saveView', view);
    };
    const unsubs = [
      useStore.subscribe(persist),
      useFlowsStore.subscribe(persist),
      useOrchestratorStore.subscribe(persist),
    ];
    return () => unsubs.forEach((u) => u());
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

  // Retract per-conversation running flags main no longer stands behind —
  // otherwise one lost `running: false` spins a conversation (and any flow
  // run that owns it) until the window reloads.
  useRunningReconcile();

  // First-run onboarding: with no projects and no usable CLI the sidebar is
  // empty (its add buttons are disabled anyway), so hide it and give the
  // welcome/setup screen the full width. Settings stays reachable via the
  // title-bar gear.
  //
  // Deliberately `!anyBackendReady` and not `noBackendReady`: the latter is
  // false until the first health probe returns, so a fresh install painted
  // an empty sidebar and then tore it away mid-glance. Treating "not probed
  // yet" as onboarding costs nothing (with zero projects there's nothing in
  // the sidebar to miss) and keeps the first frame stable.
  const onboarding = projects.length === 0 && !anyBackendReady(backendHealth);
  const showSidebar = sidebarVisible && !onboarding;

  // What's left for the preview once everything it shares the row with has
  // taken its share. Recomputed on window resize so a maximised window can
  // give the pane the space it just gained.
  const sideFileMax = Math.max(
    SIDE_FILE_MIN,
    windowWidth -
      (showSidebar ? sidebarWidth : 0) -
      (subagentDrawerParentId && drawerConvId ? subagentDrawerWidth : 0) -
      MAIN_MIN,
  );
  // Shrinking the window can strand the pane above its new ceiling; the
  // divider only clamps mid-drag, so pull it back in here.
  useEffect(() => {
    setSideFileWidth((w) => Math.min(w, sideFileMax));
  }, [sideFileMax]);

  // A worker's report opens at half the content width, not at the 640px
  // default that suits a file peeked at beside a chat. Selecting a worker
  // renders its report automatically — the page IS what you came to look at,
  // and at 640px on a wide screen that's a quarter of the window, so every
  // arrival started with the same drag. Split the space with the desk instead.
  // Only until the user drags it: their width then holds for the session.
  useEffect(() => {
    if (!sideFileVisible || detailMode !== 'workers' || sideFileDragged.current) return;
    const content = windowWidth - (showSidebar ? sidebarWidth : 0);
    setSideFileWidth(
      Math.max(SIDE_FILE_MIN, Math.min(Math.round(content / 2), sideFileMax)),
    );
  }, [sideFileVisible, detailMode, windowWidth, showSidebar, sidebarWidth, sideFileMax]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {showSidebar && (
          <>
            <div
              ref={sidebarPanel}
              style={{ width: sidebarWidth }}
              className="flex-shrink-0 h-full overflow-hidden"
            >
              <Sidebar />
            </div>
            <ResizableDivider
              panel={sidebarPanel}
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
          ) : detailMode === 'workers' ? (
            <WorkersPane />
          ) : selectedConversationId ? (
            <ConversationPane />
          ) : (
            <WelcomePane />
          )}
        </main>
        {subagentDrawerParentId && drawerConvId && (
          <>
            <ResizableDivider
              panel={drawerPanel}
              width={subagentDrawerWidth}
              onChange={setSubagentDrawerWidth}
              minWidth={SUBAGENT_DRAWER_MIN}
              maxWidth={SUBAGENT_DRAWER_MAX}
              side="right"
            />
            <div
              ref={drawerPanel}
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
              panel={sideFilePanel}
              width={sideFileWidth}
              onChange={(w) => {
                sideFileDragged.current = true;
                setSideFileWidth(w);
              }}
              minWidth={SIDE_FILE_MIN}
              maxWidth={sideFileMax}
              side="right"
            />
            <div
              ref={sideFilePanel}
              style={{ width: sideFileWidth }}
              className="flex-shrink-0 h-full overflow-hidden border-l border-card"
            >
              {/* Flow runs aren't in the main Conversation index, so the
                  editor's default `useConversationRoot(convId)` lookup
                  returns null and relative paths fail to resolve. Pass
                  the active run's projectPath as an explicit root when
                  we're viewing a flow. */}
              {/* Scope the editor to the thing being browsed. A worker's
                  files live under userData beside every other worker's, so
                  without an explicit root the pane resolves nothing and the
                  user can see their way out of the directory they opened. */}
              {/* A run opened from a worker is the same run pane, so it
                  takes the same root — without this its files resolved
                  against the selected conversation and git ran in that
                  project instead of the run's. */}
              <FileEditorPane
                rootPathOverride={fileEditorRootFor({
                  detailMode,
                  runProjectPath: activeFlowRun?.projectPath ?? null,
                  workerFilesRoot,
                })}
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

/// Window width as state, so panel ceilings derived from it re-derive when
/// the user resizes or maximises rather than being frozen at mount width.
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

function clampWidth(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}
