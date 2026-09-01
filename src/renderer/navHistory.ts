import { create } from 'zustand';

import { useStore, type DetailMode } from './store';
import { findConversation } from './conversationLookup';
import { useFlowsStore } from './flowsStore';
import { useOrchestratorStore } from './orchestratorStore';
import { useWorkersStore } from './workersStore';

/// A "page" in the app, for back/forward purposes.
///
/// Overcli has no router — where you are is the product of four stores
/// (main view state, flows, orchestrator, workers). This is the subset of
/// those that a user would call "a place I was": the tab, what's selected
/// inside it, and which project/workspace the sidebar is focused on.
/// Anything else (open file tabs, sheets, scroll position) is state *within*
/// a place and deliberately isn't tracked — restoring it would make Back feel
/// like undo rather than navigation.
export interface NavLocation {
  detailMode: DetailMode;
  selectedConversationId: string | null;
  focusedProjectId: string | null;
  focusedWorkspaceId: string | null;
  explorerRootPath: string | null;
  activeRunId: string | null;
  librarySegment: 'flows' | 'runs' | 'schedules';
  activeOrchestrationId: string | null;
  selectedWorkerId: string | null;
  /// Which of the Workers tab's three surfaces is up. A peer of the worker
  /// selection rather than part of it — the calendar and the funds waterfall
  /// have no worker to be the selection of — so Back out of Funds has to
  /// know to return to the calendar rather than to a desk.
  workersView: 'today' | 'queue' | 'worker' | 'calendar' | 'funds' | 'report';
}

/// Identity of a location — two locations with the same key are the same
/// place and must never produce a history entry (otherwise Back appears to
/// do nothing, which reads as broken).
export function locationKey(loc: NavLocation): string {
  return [
    loc.detailMode,
    loc.selectedConversationId ?? '',
    loc.focusedProjectId ?? '',
    loc.focusedWorkspaceId ?? '',
    loc.explorerRootPath ?? '',
    loc.activeRunId ?? '',
    // The library segment only distinguishes places while you're in Flows;
    // elsewhere it's leftover state and would spuriously split entries.
    loc.detailMode === 'flows' ? loc.librarySegment : '',
    loc.activeOrchestrationId ?? '',
    loc.selectedWorkerId ?? '',
    // Same reasoning as the library segment: only a place while you're in
    // the tab that owns it.
    loc.detailMode === 'workers' ? loc.workersView : '',
  ].join(' ');
}

export function readLocation(): NavLocation {
  const s = useStore.getState();
  const f = useFlowsStore.getState();
  const o = useOrchestratorStore.getState();
  const w = useWorkersStore.getState();
  return {
    detailMode: s.detailMode,
    selectedConversationId: s.selectedConversationId,
    focusedProjectId: s.focusedProjectId,
    focusedWorkspaceId: s.focusedWorkspaceId,
    explorerRootPath: s.explorerRootPath,
    activeRunId: f.activeRunId,
    librarySegment: f.librarySegment,
    activeOrchestrationId: o.activeOrchestrationId,
    selectedWorkerId: w.selectedWorkerId,
    workersView: w.view,
  };
}

/// Deep enough that Back always reaches wherever you actually came from,
/// bounded so a long session can't grow the stack without limit.
const MAX_DEPTH = 100;

/// Record where the app comes to *rest*, not every state it passes through
/// on the way. One click is routinely several store writes — the title bar's
/// Flows button alone does setActiveRun + closeEditor + setLibrarySegment +
/// setDetailMode — and panes then fill in derived defaults from mount effects
/// (WorkersPane picks the first worker when none is selected) a commit later.
/// Recording each step pushed entries that render identically to the page you
/// were already on, so Back visibly did nothing; and on the way back in, the
/// pane's own correction counted as a fresh navigation and wiped Forward.
///
/// So: wait for a quiet window before recording. Nothing depends on an entry
/// landing promptly — the earliest it can be *used* is however long it takes
/// to reach for the arrow or press the chord, far longer than this. The one
/// case that would race it, pressing Back mid-window, is handled by
/// `flushPending`. The cost is that two navigations inside the same window
/// collapse into one entry, which is the right answer anyway: a stop you
/// passed through in under 150ms isn't a place you were.
const SETTLE_MS = 150;

interface NavHistoryState {
  back: NavLocation[];
  forward: NavLocation[];
  /// Where we believe the user is right now. Kept here rather than re-read
  /// from the stores so a push knows what to file away as the *previous*
  /// page without racing the store update that triggered it.
  current: NavLocation | null;
  /// Set while `applyLocation` is writing to the other stores, so the
  /// subscriber doesn't mistake our own navigation for the user navigating.
  applying: boolean;
  record(next: NavLocation): void;
  goBack(): void;
  goForward(): void;
  reset(current: NavLocation): void;
}

export const useNavHistory = create<NavHistoryState>((set, get) => ({
  back: [],
  forward: [],
  current: null,
  applying: false,

  record(next) {
    const { current, applying, back } = get();
    if (applying) {
      set({ current: next });
      return;
    }
    if (!current || locationKey(current) === locationKey(next)) {
      set({ current: next });
      return;
    }
    // A fresh navigation truncates the forward stack — same as a browser.
    set({
      back: [...back, current].slice(-MAX_DEPTH),
      forward: [],
      current: next,
    });
  },

  goBack() {
    // Bank any navigation still sitting in the coalesce window, so hitting
    // Back immediately after clicking a tab returns to the tab you left
    // rather than skipping past it.
    flushPending();
    const { back, forward, current } = get();
    const target = back[back.length - 1];
    if (!target) return;
    set({
      back: back.slice(0, -1),
      forward: current ? [...forward, current].slice(-MAX_DEPTH) : forward,
      current: target,
    });
    applyLocation(target);
  },

  goForward() {
    flushPending();
    const { back, forward, current } = get();
    const target = forward[forward.length - 1];
    if (!target) return;
    set({
      forward: forward.slice(0, -1),
      back: current ? [...back, current].slice(-MAX_DEPTH) : back,
      current: target,
    });
    applyLocation(target);
  },

  reset(current) {
    clearTimers();
    set({
      back: [],
      forward: [],
      current,
      applying: false,
    });
  },
}));

let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/// Location the pending timer is currently waiting to commit.
let pendingKey: string | null = null;

function clearTimers(): void {
  if (coalesceTimer != null) clearTimeout(coalesceTimer);
  if (settleTimer != null) clearTimeout(settleTimer);
  coalesceTimer = null;
  settleTimer = null;
  pendingKey = null;
}

/// Trailing debounce, restarted only while the *location* is still moving.
///
/// This subscriber sits on the same firehose as everything else in the store
/// — a streaming turn writes every frame for minutes at a time. Restarting
/// the clock on every write would mean the timer never fires during a stream
/// and no history gets recorded at all; keying on the location instead makes
/// unrelated churn free, and only a genuinely unsettled view extends the wait.
function scheduleRecord(): void {
  const key = locationKey(readLocation());
  const current = useNavHistory.getState().current;
  if (current && locationKey(current) === key) {
    // Landed back where we already were — whatever was queued was a state
    // we merely passed through, so drop it.
    if (coalesceTimer != null) clearTimeout(coalesceTimer);
    coalesceTimer = null;
    pendingKey = null;
    return;
  }
  if (key === pendingKey) return; // same destination already queued; let it ride
  pendingKey = key;
  if (coalesceTimer != null) clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(flushPending, SETTLE_MS);
}

function flushPending(): void {
  if (coalesceTimer != null) clearTimeout(coalesceTimer);
  coalesceTimer = null;
  pendingKey = null;
  useNavHistory.getState().record(readLocation());
}

/// Write a location back into the stores it came from.
///
/// Deliberately writes `selectedConversationId` and the focus IDs straight
/// through rather than going via `selectConversation`: that action clears the
/// focused project/workspace and forces `detailMode: 'conversation'`, which
/// would flatten exactly the distinctions this history exists to preserve.
/// The two things `selectConversation` does that we still want — persisting
/// the selection and warming the transcript — are done explicitly below.
function applyLocation(loc: NavLocation): void {
  if (settleTimer != null) clearTimeout(settleTimer);
  useNavHistory.setState({ applying: true });
  try {
    useStore.setState({
      detailMode: loc.detailMode,
      selectedConversationId: loc.selectedConversationId,
      focusedProjectId: loc.focusedProjectId,
      focusedWorkspaceId: loc.focusedWorkspaceId,
      explorerRootPath: loc.explorerRootPath,
    });
    useFlowsStore.getState().setLibrarySegment(loc.librarySegment);
    // A half-edited flow draft isn't a place you can navigate back to (the
    // editor renders over the library), so leaving it open would mean Back
    // lands you on a screen that isn't the one being restored.
    useFlowsStore.getState().closeEditor();
    useOrchestratorStore.getState().setActiveOrchestration(loc.activeOrchestrationId);
    useWorkersStore.getState().selectWorker(loc.selectedWorkerId);
    // AFTER selectWorker, which clears the active run — picking a worker in
    // the UI means "show me the desk", and the Workers tab renders a worker's
    // run in place of its desk. A restored location is the authority on both,
    // so it sets the worker first and then says which run was open.
    useFlowsStore.getState().setActiveRun(loc.activeRunId);
    // AFTER selectWorker too, which forces the desk: picking a worker means
    // "show me the desk", but a restored location already knows whether the
    // desk was what was on screen.
    if (loc.workersView === 'today') useWorkersStore.getState().showToday();
    else if (loc.workersView === 'queue') useWorkersStore.getState().showQueue();
    else if (loc.workersView === 'calendar') useWorkersStore.getState().showCalendar();
    else if (loc.workersView === 'funds') useWorkersStore.getState().showFunds();
    else if (loc.workersView === 'report') useWorkersStore.getState().showReport();
    void window.overcli.invoke('store:saveSelection', loc.selectedConversationId);
    if (loc.selectedConversationId) {
      void useStore.getState().loadHistoryIfNeeded(loc.selectedConversationId);
    }
  } finally {
    useNavHistory.setState({ current: loc });
    // Stay in "arriving" mode until the panes have finished settling, then
    // adopt whatever they actually settled on as the current page — if
    // WorkersPane filled in a worker we asked it not to have, that filled-in
    // state is the page, and the next real navigation should file *it* away
    // as the previous one.
    settleTimer = setTimeout(() => {
      settleTimer = null;
      useNavHistory.setState({ applying: false, current: readLocation() });
    }, SETTLE_MS);
  }
}

/// Subscribe to every store that contributes to a location. Returns an
/// unsubscribe. Call once, from the app shell.
export function installNavHistory(): () => void {
  useNavHistory.getState().reset(readLocation());
  const unsubs = [
    useStore.subscribe(scheduleRecord),
    useFlowsStore.subscribe(scheduleRecord),
    useOrchestratorStore.subscribe(scheduleRecord),
    useWorkersStore.subscribe(scheduleRecord),
  ];
  return () => {
    clearTimers();
    unsubs.forEach((u) => u());
  };
}

/// Take the user to `toRoot` — the tab's own front page.
///
/// A tab click means one thing: "put me on this tab's front page", every
/// time, whichever tab you were on and whatever you were doing there. It used
/// to mean "put me back where I last was inside this tab", which sounds
/// friendlier and isn't: pressing Flows to reach the flows list landed you
/// back on the run you had been reading, and the tab you press to escape
/// something was the one control that wouldn't. Two rules that fire on the
/// same click ("front page" when you're already in the tab, "last place"
/// otherwise) also meant the button did different things depending on state
/// you can't see.
///
/// Retracing your steps is the Back arrow's job, and it still restores the
/// run, the desk, or the chat exactly — that's the control whose whole
/// promise is "where I was", and it doesn't have to share it with the tabs.
///
/// `toRoot` stays owned by the title bar, which is where each tab's idea of
/// its front page belongs.
export function navigateToTab(toRoot: () => void): void {
  // Bank the page we're leaving before it moves, so Back returns to it
  // rather than to whatever preceded it.
  flushPending();
  toRoot();
}

/// Plain-language name for a place, for the history arrows' tooltips.
///
/// The arrows used to say only "Back", which is the one thing the user
/// already knows. Naming the destination is what separates them from a tab
/// click — the two controls answer different questions ("retrace my steps"
/// versus "take me to this tab's last place"), and until the arrow says where
/// it goes there is nothing on screen to tell you which one you want.
export function describeLocation(loc: NavLocation): string {
  switch (loc.detailMode) {
    case 'workers':
      if (loc.workersView === 'today') return "the crew's day";
      if (loc.workersView === 'queue') return 'the work queue';
      if (loc.workersView === 'calendar') return 'the shift calendar';
      if (loc.workersView === 'funds') return 'funds';
      if (loc.workersView === 'report') return 'a shift report';
      return "a worker's desk";
    case 'flows':
      if (loc.activeRunId) return 'a flow run';
      if (loc.librarySegment === 'runs') return 'the runs list';
      if (loc.librarySegment === 'schedules') return 'schedules';
      return 'the flows library';
    case 'orchestrator':
      return 'the orchestrator';
    case 'explorer':
      return 'the file explorer';
    case 'stats':
      return 'usage';
    case 'local':
      return 'local models';
    case 'conversation': {
      if (!loc.selectedConversationId) return 'chat';
      const found = findConversation(useStore.getState(), loc.selectedConversationId);
      const name = found?.name?.trim();
      return name ? `“${name}”` : 'your conversation';
    }
  }
}

/// Where Back would take you, or null when there is nowhere to go.
export function backTarget(): NavLocation | null {
  const { back } = useNavHistory.getState();
  return back[back.length - 1] ?? null;
}

/// Where Forward would take you, or null.
export function forwardTarget(): NavLocation | null {
  const { forward } = useNavHistory.getState();
  return forward[forward.length - 1] ?? null;
}

export function navigateBack(): void {
  useNavHistory.getState().goBack();
}

export function navigateForward(): void {
  useNavHistory.getState().goForward();
}
