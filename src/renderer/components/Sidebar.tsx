import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noBackendReady, useStore } from '../store';
import { useTickingNow } from '../hooks';
import { useRunningMap, useRunnerCompletedAt, useRunnerIsRunning } from '../runnersStore';
import { Colosseum, Conversation, Project, SidebarLayout, UUID } from '@shared/types';
import { flowRunIsOwnedBy, type FlowRun } from '@shared/flows/schema';
import { backendColor } from '../theme';
import { selectActiveEntries } from '../activeSection';
import { conversationActivityAt } from '../conversationLookup';
import { useFlowsStore } from '../flowsStore';
import { DEFAULT_CLEANUP_RULES } from '@shared/cleanupRules';
import { estimateTidyCandidates } from './sheets/cleanupNudge';
import { useWorkersStore } from '../workersStore';
import { ActiveFlowRow, FlowRunRow, flowRunMatchesQuery, runIsLive } from './flows/FlowRunSidebarRow';
import { SidebarMarker } from './SidebarMarker';
import { MomentumMeter, SleepRollup } from './SidebarAtoms';
import { SidebarStream } from './SidebarStream';
import { SLEEP_AFTER_MS } from '../sidebarSleep';
import {
  collectActiveCandidates,
  collectStreamItems,
  isAgentConversation,
  projectActivityAt,
  projectLabel,
  workspaceActivityAt,
  type RecentConversationItem,
} from './sidebarItems';
import { newConversationLabel, resolveNewConversationTarget } from '../newConversationTarget';
import { formatShortcutDef, SHORTCUTS, startNewConversationHere } from '../shortcuts';
import {
  arrangePlaces,
  filterPlaces,
  placeId,
  placeKind,
  movePinned,
  togglePinned,
  type PlaceFilter,
  type PlaceRef,
  type PlaceSort,
  type PlaceStatus,
} from '../places';
import { PlusIcon, PopMenu, ProjectPlace, WorkspacePlace, statusOfPlace } from './SidebarPlaces';
import { useHandoffCountsByPlace } from '../handoffsStore';
import { useWorkDoneToday, useWorkStore } from '../workStore';
import { WorkSidebarList } from './work/WorkSidebarList';

// Collecting what the sidebar shows moved to ./sidebarItems so both layouts
// feed from one place. Re-exported here because the sheets and the
// activeCandidates suite have imported them from this module for a long time,
// and a rename would be churn with no reader-facing benefit.
export { collectActiveCandidates, isAgentConversation };

/// Which places you have opened. Persisted for the same reason the roster's
/// openings are: places fold by default now, and losing what you opened on
/// every reload would make opening one feel pointless.
const PLACES_OPEN_KEY = 'sidebar.placesOpen';
const NO_PINS: string[] = [];

function loadIdSet(key: string): Set<UUID> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw) as UUID[]);
  } catch {
    // A corrupt entry just means starting folded.
  }
  return new Set();
}

function saveIdSet(key: string, ids: Set<UUID>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Best effort: the fold state is a nicety, not data.
  }
}

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const colosseums = useStore((s) => s.colosseums);
  const backendHealth = useStore((s) => s.backendHealth);
  const cliBlocked = noBackendReady(backendHealth);
  const rawSelectedId = useStore((s) => s.selectedConversationId);
  const detailMode = useStore((s) => s.detailMode);
  // The conversation sidebar rows should only HIGHLIGHT as selected
  // when the user is actually viewing a conversation. Otherwise the
  // last-opened conversation keeps rendering as selected even while
  // the user is on Flows / Local / Usage / Explorer — confusing when
  // a different selection (a flow run row) is also highlighted there.
  const selectedId = detailMode === 'conversation' ? rawSelectedId : null;
  const focusedProjectId = useStore((s) => s.focusedProjectId);
  const focusedWorkspaceId = useStore((s) => s.focusedWorkspaceId);
  const selectConversation = useStore((s) => s.selectConversation);
  const pickProject = useStore((s) => s.pickProject);
  const openSheet = useStore((s) => s.openSheet);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const showDebug = useStore((s) => s.settings.showDebug ?? false);
  const showActiveSection = useStore((s) => s.settings.showActiveSidebarSection ?? true);
  const sidebarLayout = useStore((s) => s.settings.sidebarLayout ?? 'projects');
  const pinnedPlaces = useStore((s) => s.settings.pinnedPlaces) ?? NO_PINS;
  // Read through getState rather than subscribing to the whole settings
  // object: the switch writes once a click, and a sidebar that re-rendered on
  // every unrelated settings change would be paying for it constantly.
  // Work is the switch's third tab. It is not a layout — leaving it goes back
  // to whichever of Places/Recent you had — so it lives in the work store.
  const workView = useWorkStore((s) => s.sidebarWork);
  const setSidebarWork = useWorkStore((s) => s.setSidebarWork);
  const workQuery = useWorkStore((s) => s.query);
  const setWorkQuery = useWorkStore((s) => s.setQuery);
  const workToday = useWorkDoneToday();
  // The Work page and the Work tab are one place: opening the page any way
  // (⌘K, Back, a restored session) puts the switch on Work too, so the
  // sidebar never claims Places while Work is on screen.
  const onWorkPage = useStore((s) => s.detailMode === 'work');
  useEffect(() => {
    if (onWorkPage && !useWorkStore.getState().sidebarWork) setSidebarWork(true);
  }, [onWorkPage, setSidebarWork]);
  // Recent was folded into Work. Anyone who had it as their layout lands on
  // Work — the view that does its job now — and the old setting is retired.
  useEffect(() => {
    if (sidebarLayout !== 'stream') return;
    setSidebarWork(true);
    const st = useStore.getState();
    void st.saveSettings({ ...st.settings, sidebarLayout: 'projects' });
  }, [sidebarLayout, setSidebarWork]);
  const workLogLoaded = useWorkStore((s) => s.logLoaded);
  useEffect(() => {
    // The tab's count needs the work log (runs that outlived eviction).
    if (!workLogLoaded) void useWorkStore.getState().loadLog();
  }, [workLogLoaded]);
  const showTree = sidebarLayout === 'projects' && !workView;
  const setSidebarLayout = (layout: SidebarLayout) => {
    const st = useStore.getState();
    setSidebarWork(false);
    if ((st.settings.sidebarLayout ?? 'projects') === layout) return;
    void st.saveSettings({ ...st.settings, sidebarLayout: layout });
  };
  const togglePin = (id: string) => {
    const st = useStore.getState();
    void st.saveSettings({ ...st.settings, pinnedPlaces: togglePinned(st.settings.pinnedPlaces ?? [], id) });
  };
  // One clock for every time-sensitive memo in this render, rather than each
  // calling Date.now() itself. Two memos disagreeing about "now" by a few
  // milliseconds is harmless; two memos each taking their own reading is how
  // a row ends up warm in one list and asleep in the next. Held in state and
  // ticked coarsely rather than read per render: a fresh reading every render
  // is a new dependency every render, which made every memo below rebuild on
  // each keystroke. A minute is well under any warm/asleep window.
  const now = useTickingNow(60_000);
  // What the compose button says it will do. Resolved from the same helper ⌘N
  // runs, so the tooltip cannot promise one project while the click makes a
  // chat in another.
  const newTarget = useMemo(
    () =>
      resolveNewConversationTarget({
        projects,
        workspaces,
        selectedConversationId: rawSelectedId,
        focusedProjectId,
        focusedWorkspaceId,
      }),
    [projects, workspaces, rawSelectedId, focusedProjectId, focusedWorkspaceId],
  );
  // The shortcut rides along in the tooltip: the users who will end up
  // preferring ⌘N are the ones who click the button first.
  const newConversationHint = useMemo(() => {
    const def = SHORTCUTS.find((d) => d.id === 'conversation.new');
    return def ? formatShortcutDef(def) : '';
  }, []);
  const runners = useRunningMap();
  const flowRuns = useFlowsStore((s) => s.runs);
  const cleanupRules = useStore((s) => s.settings.cleanup) ?? DEFAULT_CLEANUP_RULES;
  // State-only estimate — no git, no disk. See `estimateTidyCandidates`.
  const tidyCandidates = useMemo(
    () =>
      estimateTidyCandidates({
        owners: [...projects, ...workspaces],
        runs: Object.values(flowRuns),
        runningById: Object.fromEntries(
          Object.entries(runners).map(([id, r]) => [id, !!r?.isRunning]),
        ),
        rules: cleanupRules,
        now,
      }),
    [projects, workspaces, flowRuns, runners, cleanupRules, now],
  );
  const workers = useWorkersStore((s) => s.workers);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const lastSelectedAt = useStore((s) => s.lastSelectedAt);
  const lastOpenedAtByRun = useFlowsStore((s) => s.lastOpenedAtByRun);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const isGitRepoById = useStore((s) => s.projectIsGitRepo);
  const openedRunId = detailMode === 'flows' ? activeRunId : null;
  const [search, setSearch] = useState('');
  const [placeSort, setPlaceSort] = useState<PlaceSort>('recent');
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>('all');
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addAnchor = useRef<HTMLButtonElement>(null);
  // Places run the roster's model: folded by default, tracking what you
  // OPENED. With one line per place, thirty repos arriving pre-expanded is
  // exactly the wall of rows this layout exists to get rid of.
  const [placesOpen, setPlacesOpen] = useState<Set<UUID>>(() => loadIdSet(PLACES_OPEN_KEY));
  const updatePlacesOpen = (updater: (cur: Set<UUID>) => Set<UUID>) =>
    setPlacesOpen((cur) => {
      const next = updater(cur);
      if (next !== cur) saveIdSet(PLACES_OPEN_KEY, next);
      return next;
    });
  const togglePlace = (id: UUID) =>
    updatePlacesOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const query = search.trim().toLowerCase();

  // Opening a conversation opens the place it lives in — and its workspace,
  // when it is a member — so the sidebar always shows where you are.
  useEffect(() => {
    if (!rawSelectedId) return;
    const owners: UUID[] = [];
    const project = projects.find((p) => p.conversations.some((c) => c.id === rawSelectedId));
    if (project) {
      owners.push(project.id);
      for (const w of workspaces) if (w.projectIds.includes(project.id)) owners.push(w.id);
    }
    const ws = workspaces.find((w) => (w.conversations ?? []).some((c) => c.id === rawSelectedId));
    if (ws) owners.push(ws.id);
    if (owners.length === 0) return;
    updatePlacesOpen((cur) => {
      if (owners.every((id) => cur.has(id))) return cur;
      const next = new Set(cur);
      for (const id of owners) next.add(id);
      return next;
    });
    // Only on a new selection: closing the place afterwards is yours to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSelectedId]);

  // ---- places -------------------------------------------------------------

  const runList = useMemo(() => Object.values(flowRuns), [flowRuns]);
  // Handoffs from other tools count as needing you in the place they will
  // open in — see handoffsStore.
  const handoffCounts = useHandoffCountsByPlace();
  const placeStatus = useMemo(() => {
    const cache = new Map<string, PlaceStatus>();
    return (ref: PlaceRef) => {
      const id = placeId(ref);
      let s = cache.get(id);
      if (!s) {
        s = statusOfPlace(ref, runList, runners, now);
        const handed = handoffCounts.get(id) ?? 0;
        if (handed) s = { ...s, needsYou: s.needsYou + handed };
        cache.set(id, s);
      }
      return s;
    };
  }, [runList, runners, now, handoffCounts]);
  const placeActivity = useMemo(() => {
    const cache = new Map<string, number>();
    const of = (ref: PlaceRef): number => {
      const id = placeId(ref);
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      const at =
        ref.kind === 'project'
          ? projectActivityAt(ref.project, colosseums, runners, flowRuns, now)
          : Math.max(
              workspaceActivityAt(ref.workspace, runners, flowRuns, now),
              ...ref.members.map((m) => projectActivityAt(m, colosseums, runners, flowRuns, now)),
            );
      cache.set(id, at);
      return at;
    };
    return of;
  }, [colosseums, runners, flowRuns, now]);
  const arranged = useMemo(
    () =>
      arrangePlaces({
        projects,
        workspaces,
        pinned: pinnedPlaces,
        activityAt: placeActivity,
        status: placeStatus,
        keepOut: (ref) =>
          ref.kind === 'project'
            ? ref.project.id === focusedProjectId ||
              ref.project.conversations.some((c) => c.id === selectedId) ||
              !hasProjectActivity(ref.project, colosseums, flowRuns)
            : ref.workspace.id === focusedWorkspaceId ||
              (ref.workspace.conversations ?? []).some((c) => c.id === selectedId) ||
              ref.members.some((m) => m.conversations.some((c) => c.id === selectedId)),
        now,
      }),
    [
      projects,
      workspaces,
      pinnedPlaces,
      placeActivity,
      placeStatus,
      focusedProjectId,
      focusedWorkspaceId,
      selectedId,
      colosseums,
      flowRuns,
      now,
    ],
  );
  const filtered = useMemo(
    () =>
      showTree && query
        ? filterPlaces(projects, workspaces, {
            query,
            sort: placeSort,
            filter: placeFilter,
            kind: (ref) => placeKind(ref, ref.kind === 'project' ? isGitRepoById[ref.project.id] : undefined),
            activityAt: placeActivity,
            status: placeStatus,
            weight: (ref) => {
              const convs =
                ref.kind === 'project'
                  ? ref.project.conversations
                  : [...(ref.workspace.conversations ?? []), ...ref.members.flatMap((m) => m.conversations)];
              const path = ref.kind === 'project' ? ref.project.path : ref.workspace.rootPath;
              return convs.filter((c) => !c.hidden).length + runList.filter((r) => flowRunIsOwnedBy(r, path)).length;
            },
          })
        : [],
    [showTree, query, projects, workspaces, placeSort, placeFilter, isGitRepoById, placeActivity, placeStatus, runList],
  );
  // Conversations and runs whose titles match, under the places — a search
  // for a thing you said should find the chat you said it in.
  const conversationMatches = useMemo(() => {
    if (!showTree || !query) return [];
    const out: RecentConversationItem[] = [];
    for (const p of projects) {
      for (const c of p.conversations) {
        if (!c.hidden && matchesConversation(c, query)) {
          out.push({ kind: 'conversation', conv: c, ownerName: projectLabel(p), ownerKind: 'project' });
        }
      }
    }
    for (const w of workspaces) {
      for (const c of w.conversations ?? []) {
        if (!c.hidden && matchesConversation(c, query)) {
          out.push({ kind: 'conversation', conv: c, ownerName: w.name, ownerKind: 'workspace' });
        }
      }
    }
    return out.sort((a, b) => conversationActivityAt(b.conv) - conversationActivityAt(a.conv)).slice(0, 30);
  }, [showTree, query, projects, workspaces]);
  const runMatches = useMemo(
    () =>
      showTree && query
        ? runList
            // Worker runs too: a ticket a worker picked up is still a thing
            // you search for, and the row opens it on the worker's desk.
            .filter((run) => run.state.kind !== 'archived' && flowRunMatchesQuery(run, query))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 20)
        : [],
    [showTree, query, runList],
  );

  // Collapse-all acts on the places the sidebar is currently showing.
  const allGroupIds = useMemo(
    () => [...arranged.pinned, ...arranged.active].map(placeId),
    [arranged],
  );
  const allCollapsed = allGroupIds.length > 0 && !allGroupIds.some((id) => placesOpen.has(id));
  const toggleAll = () => {
    updatePlacesOpen((cur) => {
      const next = new Set(cur);
      for (const id of allGroupIds) {
        if (allCollapsed) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const activeEntries = useMemo(
    () =>
      selectActiveEntries(
        collectActiveCandidates(
          projects,
          workspaces,
          flowRuns,
          runners,
          {
            openedConversationId: selectedId,
            lastSelectedAt,
            openedRunId,
            lastOpenedAtByRun,
          },
          now,
          workers,
        ),
      ),
    [
      now,
      flowRuns,
      projects,
      runners,
      workspaces,
      selectedId,
      lastSelectedAt,
      openedRunId,
      lastOpenedAtByRun,
      workers,
    ],
  );
  // The Stream layout's flat list. Built regardless of the current layout so
  // that flipping the switch is instant rather than a visible rebuild — it is
  // the same walk over the same arrays the tree already does.
  const streamEntries = useMemo(
    () => sidebarLayout !== 'stream' ? [] : collectStreamItems(
        projects,
        workspaces,
        flowRuns,
        runners,
        { openedConversationId: selectedId, lastSelectedAt, openedRunId, lastOpenedAtByRun },
        now,
        workers,
      ),
    [
      now,
      projects,
      workspaces,
      flowRuns,
      runners,
      selectedId,
      lastSelectedAt,
      openedRunId,
      lastOpenedAtByRun,
      workers,
      sidebarLayout,
    ],
  );
  // Which lane gets the accent rail. Reads off whatever is actually on
  // screen — a conversation, or a flow run — so "where am I" survives
  // switching between the two.
  const currentOwnerId = useMemo(() => {
    // `activeRunId`, not `openedRunId`: the latter is null whenever you are
    // not on the Flows tab, which would drop the rail exactly when you opened
    // a worker's run and most wanted to know whose repo it was in.
    const open = streamEntries.find(
      (e) =>
        (selectedId && e.key === `c:${selectedId}`) ||
        (activeRunId && e.key === `f:${activeRunId}`),
    );
    return open?.owner.id ?? null;
  }, [streamEntries, selectedId, activeRunId]);
  const streamMatches = useMemo(() => {
    if (!query) return streamEntries;
    return streamEntries.filter((e) =>
      e.item.kind === 'conversation'
        ? e.item.conv.name.toLowerCase().includes(query) ||
          (e.item.conv.sessionId ?? '').toLowerCase().includes(query) ||
          e.owner.name.toLowerCase().includes(query)
        : flowRunMatchesQuery(e.item.run, query) || e.owner.name.toLowerCase().includes(query),
    );
  }, [streamEntries, query]);

  /// Opening a run from the sidebar, wherever the row lives.
  ///
  /// A worker's run keeps its one home: the row is a route to the desk it
  /// belongs to, not a second copy of it. `selectWorker` clears the active
  /// run, so it has to go first.
  const openFlowRun = (run: FlowRun) => {
    if (run.workerId) {
      selectWorker(run.workerId);
      setActiveRun(run.id);
      setDetailMode('workers');
      return;
    }
    setActiveRun(run.id);
    setDetailMode('flows');
  };

  const openConversation = useCallback(
    (id: UUID) => {
      setDetailMode('conversation');
      selectConversation(id);
    },
    [setDetailMode, selectConversation],
  );

  const renderPlace = (ref: PlaceRef, nested = false): React.ReactNode => {
    const id = placeId(ref);
    const common = {
      expanded: placesOpen.has(id),
      onToggle: () => togglePlace(id),
      status: placeStatus(ref),
      activityAt: placeActivity(ref),
      now,
      pinned: pinnedPlaces.includes(id),
      onTogglePin: () => togglePin(id),
      onMovePin: (direction: -1 | 1) => {
        const st = useStore.getState();
        void st.saveSettings({
          ...st.settings,
          pinnedPlaces: movePinned(st.settings.pinnedPlaces ?? [], id, direction),
        });
      },
      selectedId,
      onSelect: openConversation,
      nested,
    };
    return ref.kind === 'project' ? (
      <ProjectPlace
        key={id}
        project={ref.project}
        colosseums={colosseums.filter((c) => c.projectId === ref.project.id)}
        {...common}
      />
    ) : (
      <WorkspacePlace
        key={id}
        workspace={ref.workspace}
        members={ref.members}
        renderMember={(p: Project) => renderPlace({ kind: 'project', project: p }, true)}
        memberIsActive={(p: Project) => {
          const member: PlaceRef = { kind: 'project', project: p };
          const s = placeStatus(member);
          return (
            placesOpen.has(p.id) ||
            s.running + s.needsYou > 0 ||
            placeActivity(member) >= now - SLEEP_AFTER_MS ||
            (!!selectedId && p.conversations.some((c) => c.id === selectedId))
          );
        }}
        {...common}
      />
    );
  };

  const FILTERS: Array<[PlaceFilter, string]> = [
    ['all', 'All'],
    ['repos', 'Repos'],
    ['documents', 'Documents'],
    ['workspaces', 'Workspaces'],
    ['running', 'Busy'],
  ];
  const SORTS: Array<[PlaceSort, string]> = [
    ['recent', 'Recent'],
    ['az', 'A–Z'],
    ['busiest', 'Busiest'],
  ];

  return (
    <aside className="h-full flex-shrink-0 flex flex-col bg-surface-muted border-r border-card min-w-0" style={{ width: '100%' }}>
      <div className="px-2 pt-2 pb-1 flex items-center gap-1">
        <span className="relative flex flex-1 min-w-0 items-center">
        <input
          value={workView ? workQuery : search}
          onChange={(e) => (workView ? setWorkQuery(e.target.value) : setSearch(e.target.value))}
          onKeyDown={(e) => {
            const current = workView ? workQuery : search;
            if (e.key === 'Escape' && current) {
              e.stopPropagation();
              if (workView) setWorkQuery('');
              else setSearch('');
            }
          }}
          placeholder={
            workView ? 'Search work' : showTree ? 'Filter places' : 'Search'
          }
          aria-label={workView ? 'Search work' : showTree ? 'Filter places' : 'Search'}
          className="field flex-1 min-w-0 px-2 py-1 pr-6 text-xs"
        />
        {(workView ? workQuery : search) && (
          <button
            onClick={() => (workView ? setWorkQuery('') : setSearch(''))}
            title="Clear search (Esc)"
            aria-label="Clear search"
            className="absolute right-1 flex h-4 w-4 items-center justify-center rounded-full text-ink-faint hover:bg-card-strong hover:text-ink"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden>
              <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        </span>
        {/* Starting a chat was reachable only from a project row in Places, or
            from ⌘N / ⌘K if you happened to know them — so Recent, the default
            tab, offered no visible way to begin one. This button is that way,
            and it names its destination rather than making the user find out
            by creating one. It sits directly after the search field so it does
            not move when the fold control comes and goes. */}
        <button
          onClick={() => startNewConversationHere()}
          disabled={cliBlocked}
          title={
            cliBlocked
              ? 'Install a CLI first to start a conversation'
              : `${newConversationLabel(newTarget)} (${newConversationHint})`
          }
          aria-label={newConversationLabel(newTarget)}
          className="p-1 rounded text-ink-faint hover:text-ink-muted hover:bg-card-strong disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
        >
          <PlusIcon />
        </button>
        {/* Nothing to fold in Stream — it has no groups to collapse — so the
            control goes rather than sitting there permanently disabled. */}
        {showTree && (
          <button
            onClick={toggleAll}
            disabled={allGroupIds.length === 0}
            title={allCollapsed ? 'Expand all' : 'Collapse all'}
            aria-label={allCollapsed ? 'Expand all' : 'Collapse all'}
            className="p-1 rounded text-ink-faint hover:text-ink-muted hover:bg-card-strong disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
          >
            {allCollapsed ? <ExpandAllIcon /> : <CollapseAllIcon />}
          </button>
        )}
      </div>
      {/* The switch is the setting: it writes the same stored value the
          Settings sheet mirrors, so the two can never disagree. The Workers
          tab never gets here — it draws its own rail (WorkersRail). */}
      {/* Nothing to lay out until there is a project: a choice between two
          views of nothing is the first thing a newcomer would have read. */}
      {(projects.length > 0 || workspaces.length > 0) && (
        <div
          role="tablist"
          aria-label="Sidebar view"
          className="mx-2 mt-1 flex gap-0.5 rounded-lg border border-card-strong bg-surface p-[3px]"
        >
          {/* Places first: with what's running and what needs you on every
              row, it answers "what was I doing" as well as "where does this
              live". Work is the other axis — what is in flight and what got
              done — and took over from the old Recent list. */}
          <LayoutTab
            label="Places"
            title="Your projects and workspaces, one line each"
            on={!workView}
            onClick={() => setSidebarLayout('projects')}
          />
          {/* What needs you, what is running, and what got done: every chat,
              run, batch and PR on one branch as one record, searchable by what
              it was. The count is what finished today. */}
          <LayoutTab
            label="Work"
            title="Everything shipped or started — find it by what it was"
            on={workView}
            onClick={() => setSidebarWork(true)}
            badge={workToday}
            badgeTitle={`${workToday} finished today`}
          />
        </div>
      )}
      {showTree && query && (
        <div className="mx-2 mt-1.5 flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                onClick={() => setPlaceFilter(value)}
                aria-pressed={placeFilter === value}
                className={
                  'rounded-full px-2 py-px text-[10.5px] ' +
                  (placeFilter === value
                    ? 'bg-card-strong text-ink'
                    : 'border border-card-strong text-ink-faint hover:text-ink-muted')
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[10.5px] text-ink-faint">
            <span className="flex-1">
              {filtered.length} place{filtered.length === 1 ? '' : 's'}
            </span>
            <span>Sort</span>
            <div className="flex gap-px rounded bg-card p-px">
              {SORTS.map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setPlaceSort(value)}
                  aria-pressed={placeSort === value}
                  className={
                    'rounded px-1.5 py-px ' +
                    (placeSort === value ? 'bg-card-strong text-ink' : 'hover:text-ink-muted')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav className="sidebar-scroll flex-1 min-h-0 overflow-y-auto pl-1 pr-0.5 pb-2 mt-1">
        {workView && <WorkSidebarList />}
        {!workView && !query && showActiveSection && activeEntries.length > 0 && (
          <>
            <SidebarSectionTitle label="Working on" />
            {activeEntries.map(({ entry, momentum }) =>
              entry.kind === 'flow' ? (
                <ActiveFlowRow
                  key={entry.run.id}
                  run={entry.run}
                  isLive={entry.isLive}
                  ownerName={entry.ownerName}
                  ownerKind={entry.ownerKind}
                  onClick={() => openFlowRun(entry.run)}
                />
              ) : (
                <RecentConversationRow
                  key={entry.conv.id}
                  item={entry}
                  momentum={momentum ?? 0}
                  onClick={() => openConversation(entry.conv.id)}
                />
              ),
            )}
          </>
        )}
        {!showTree && !workView && (
          <SidebarStream
            entries={query ? streamMatches : streamEntries}
            currentOwnerId={currentOwnerId}
            // The open run wins over `selectedId`. Opening a flow run doesn't
            // clear the conversation selection — nothing does — so with a
            // chat id left over from before, the stream lit up that chat's
            // row while you were looking at a run, and the run you actually
            // had open sat unhighlighted next to it. `openedRunId` is
            // already null unless the Flows pane is what's on screen, so
            // this only takes precedence when the run really is the page.
            selectedKey={
              openedRunId ? `f:${openedRunId}` : selectedId ? `c:${selectedId}` : null
            }
            onOpenConversation={openConversation}
            onNewConversation={cliBlocked ? undefined : () => startNewConversationHere()}
            now={now}
          />
        )}
        {showTree && query && (
          <>
            {filtered.length === 0 && conversationMatches.length === 0 && runMatches.length === 0 && (
              <div className="px-2 py-2 text-xs text-ink-faint">Nothing matches “{search.trim()}”</div>
            )}
            <div className="mt-1">{filtered.map((ref) => renderPlace(ref))}</div>
            {conversationMatches.length > 0 && (
              <>
                <SidebarSectionTitle label="Conversations" />
                {conversationMatches.map((item) => (
                  <RecentConversationRow
                    key={item.conv.id}
                    item={item}
                    momentum={0}
                    onClick={() => openConversation(item.conv.id)}
                  />
                ))}
              </>
            )}
            {runMatches.length > 0 && (
              <>
                <SidebarSectionTitle label="Flow runs" />
                {runMatches.map((run) => (
                  <FlowRunRow key={run.id} run={run} selected={run.id === activeRunId} isLive={runIsLive(run, runners)} />
                ))}
              </>
            )}
          </>
        )}
        {showTree && !query && (
          <>
            {arranged.pinned.length > 0 && (
              <>
                <SidebarSectionTitle label="Pinned" />
                {arranged.pinned.map((ref) => renderPlace(ref))}
              </>
            )}
            {arranged.active.length > 0 && (
              <>
                <SidebarSectionTitle label={arranged.pinned.length > 0 ? 'Active' : 'Places'} />
                {arranged.active.map((ref) => renderPlace(ref))}
              </>
            )}
            {arranged.more.length > 0 && (
              <>
                <SleepRollup
                  count={arranged.more.length}
                  open={moreOpen}
                  onToggle={() => setMoreOpen((v) => !v)}
                  label="More places · quiet 2 days+"
                  openLabel="More places"
                />
                {moreOpen && arranged.more.map((ref) => renderPlace(ref))}
              </>
            )}
          </>
        )}

        {!workView && <ArchivedGroup />}
      </nav>

      <div className="border-t border-card px-2 py-2 flex flex-col gap-1">
            {/* Three ways to add a place, behind one button: they are one
                decision ("I want another place here"), and three permanent
                rows of it were the heaviest thing in the footer. */}
            <button
              ref={addAnchor}
              onClick={() => setAddOpen((v) => !v)}
              disabled={cliBlocked}
              title={cliBlocked ? 'Install a CLI first to add a project' : 'Open a folder, start something new, or join repos into a workspace'}
              aria-haspopup="menu"
              aria-expanded={addOpen}
              className="flex items-center gap-1.5 rounded border border-dashed border-card-strong px-2 py-1 text-left text-xs text-ink-muted hover:border-ink-faint hover:bg-card-strong hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <PlusIcon />
              <span className="flex-1">Add a place</span>
            </button>
            {addOpen && (
              <PopMenu
                anchor={addAnchor}
                onClose={() => setAddOpen(false)}
                items={[
                  { label: 'Open a folder…', hint: 'repo or documents', onSelect: () => void pickProject() },
                  { label: 'Start something new…', hint: 'empty folder', onSelect: () => openSheet({ type: 'newEverydayProject' }) },
                  // A workspace joins repos, so it means nothing before there
                  // are two. Until then the way in is opening a folder of repos.
                  ...(projects.length >= 2
                    ? [{ label: 'New workspace…', hint: 'join repos', onSelect: () => openSheet({ type: 'newWorkspace' }) }]
                    : []),
                ]}
              />
            )}
        <div className="flex items-center gap-1 mt-1">
          <SidebarIconButton label="Extensions" onClick={() => openSheet({ type: 'capabilities' })} />
          <SidebarIconButton
            label="Clean up"
            onClick={() => openSheet({ type: 'cleanup' })}
            badge={tidyCandidates}
            title={
              tidyCandidates
                ? `${tidyCandidates} finished worktrees are worth a look`
                : 'Clean up worktrees, workers, flows and chats'
            }
          />
          {showDebug && (
            <SidebarIconButton label="Debug" onClick={() => openSheet({ type: 'debug' })} />
          )}
        </div>
      </div>
    </aside>
  );
}

/// One half of the layout switch. Deliberately a pair of buttons rather than
/// a checkbox: these are two answers to two questions — "what was I doing"
/// and "where does this live" — not a feature and its absence, and a
/// checkbox would make people guess what the off state does.
function LayoutTab({
  label,
  title,
  on,
  onClick,
  badge = 0,
  badgeTitle,
}: {
  label: string;
  title: string;
  on: boolean;
  onClick: () => void;
  badge?: number;
  badgeTitle?: string;
}) {
  return (
    <button
      role="tab"
      onClick={onClick}
      title={title}
      aria-selected={on}
      className={
        // Same lifted pill as the title bar's tabs, so "which one am I on"
        // reads the same everywhere. The old elevated-on-card fill was two
        // near-identical greys in the dark theme.
        'flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors ' +
        (on
          ? 'text-ink shadow-[inset_0_0_0_1px_var(--c-card-border-strong)]'
          : 'text-ink-muted hover:text-ink hover:bg-card-strong')
      }
      style={on ? { background: 'color-mix(in srgb, var(--c-ink) 9%, var(--c-surface-elevated))' } : undefined}
    >
      {label}
      {badge > 0 && (
        <span
          title={badgeTitle}
          className={
            'rounded-full px-1.5 text-[9.5px] font-semibold leading-[15px] tabular-nums ' +
            (on ? 'bg-accent text-white' : 'bg-accent/20 text-accent')
          }
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function CollapseAllIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 3l4 3 4-3" />
      <path d="M4 13l4-3 4 3" />
    </svg>
  );
}

function ExpandAllIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4-3 4 3" />
      <path d="M4 10l4 3 4-3" />
    </svg>
  );
}

function SidebarIconButton({
  label,
  onClick,
  badge,
  title,
}: {
  label: string;
  onClick: () => void;
  /// Count of worktrees worth looking at. Shown only when there is a pile —
  /// a badge that is always lit is one the eye learns to skip.
  badge?: number;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        'flex-1 text-[10px] py-1 rounded hover:bg-card-strong flex items-center justify-center gap-1 ' +
        (badge ? 'text-ink-muted hover:text-ink' : 'text-ink-faint hover:text-ink-muted')
      }
    >
      {label}
      {!!badge && (
        <span className="text-[9px] text-amber-700 dark:text-amber-300 bg-amber-500/15 rounded px-1 leading-[13px]">
          {badge}
        </span>
      )}
    </button>
  );
}

/// Whether a project has anything worth showing at the top level, as opposed
/// to rolling up with the ones you have not touched.
function hasProjectActivity(
  project: Project,
  colosseums: Colosseum[],
  flowRuns: Record<UUID, FlowRun>,
): boolean {
  if (project.conversations.some((c) => !c.hidden)) return true;
  if (colosseums.some((c) => c.projectId === project.id)) return true;
  // A flow run is real activity even when the project has no visible
  // conversation of its own — keep such projects in the main list.
  if (Object.values(flowRuns).some((r) => flowRunIsOwnedBy(r, project.path)))
    return true;
  // A freshly picked project has no conversation yet — the welcome composer
  // creates one only on first send. Keep it out of the roll-up for a short
  // grace window so it does not vanish the moment it is added.
  return (project.lastOpenedAt ?? 0) > Date.now() - 24 * 60 * 60 * 1000;
}

function matchesConversation(c: Conversation, query: string): boolean {
  return c.name.toLowerCase().includes(query) || (c.sessionId ?? '').toLowerCase().includes(query);
}

function SidebarSectionTitle({ label }: { label: string }) {
  return (
    <div className="mt-3 px-2 text-[10px] uppercase tracking-wide text-ink-faint">
      {label}
    </div>
  );
}

function RecentConversationRow({
  item,
  momentum,
  onClick,
}: {
  item: RecentConversationItem;
  /// Shown so the ranking is legible rather than mysterious: the row at the
  /// top of the section can say why it is there.
  momentum: number;
  onClick: () => void;
}) {
  const bgColor = backendColor(item.conv.primaryBackend);
  const isRunning = useRunnerIsRunning(item.conv.id);
  const completedAt = useRunnerCompletedAt(item.conv.id);
  const completed = !isRunning && !!completedAt;
  const isAgent = isAgentConversation(item.conv);

  return (
    <button
      onClick={onClick}
      className={
        'sidebar-row group mt-0.5 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs ' +
        'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card'
      }
      title={`${item.conv.name} · ${item.ownerName}`}
    >
      <SidebarMarker color={bgColor} active={isRunning} completed={completed} />
      {isAgent && <span className="text-[10px] text-ink-faint">⎇</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.conv.name}</span>
        <span className="block truncate text-[9px] leading-3.5 text-ink-faint">
          {item.ownerKind === 'workspace' ? 'workspace · ' : ''}
          {item.ownerName}
        </span>
      </span>
      {!isRunning && <MomentumMeter score={momentum} />}
    </button>
  );
}

/// Collapsible "Archived" bucket shown at the bottom of the sidebar.
/// Lists every hidden conversation/agent across projects + workspaces.
/// Clicking a row opens the archive sheet, where the user can rename,
/// unarchive, or permanently delete. Uses the persistent
/// `showHiddenConversations` flag as the expanded/collapsed state so
/// it's remembered across launches.
function ArchivedGroup() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const expanded = useStore((s) => s.showHiddenConversations);
  const openSheet = useStore((s) => s.openSheet);

  const items = useMemo(() => {
    const out: Array<{
      conv: Conversation;
      owner: string;
      ownerIcon: 'project' | 'workspace';
    }> = [];
    for (const p of projects) {
      for (const c of p.conversations) {
        if (c.hidden) out.push({ conv: c, owner: projectLabel(p), ownerIcon: 'project' });
      }
    }
    for (const w of workspaces) {
      for (const c of w.conversations ?? []) {
        if (c.hidden) out.push({ conv: c, owner: w.name, ownerIcon: 'workspace' });
      }
    }
    return out;
  }, [projects, workspaces]);

  if (items.length === 0) return null;

  const toggle = () => {
    useStore.setState((s) => ({ showHiddenConversations: !s.showHiddenConversations }));
  };

  return (
    <div className="mt-3">
      <div className="group flex items-center gap-1.5 w-full px-2 py-1 rounded hover:bg-card-strong">
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          <span
            className={
              'text-[9px] text-ink-faint transition-transform flex-shrink-0 ' +
              (expanded ? 'rotate-90' : '')
            }
          >
            ▸
          </span>
          <span className="text-[10px] uppercase tracking-wide text-ink-faint flex-1 truncate">
            Archived
          </span>
          <span className="text-[10px] text-ink-faint">{items.length}</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            openSheet({ type: 'cleanup' });
          }}
          className="text-[10px] text-ink-faint hover:text-ink px-1 py-0.5 rounded hover:bg-card-strong opacity-0 group-hover:opacity-100 focus:opacity-100"
          title="Clean up worktrees and conversations"
        >
          Cleanup
        </button>
      </div>
      {expanded && (
        <div className="ml-4 border-l border-card pl-1">
          {items.map(({ conv, owner }) => {
            const isAgent = isAgentConversation(conv);
            return (
              <button
                key={conv.id}
                onClick={() =>
                  openSheet({ type: 'archiveConversation', convId: conv.id })
                }
                className="sidebar-row group w-full rounded text-xs truncate flex items-center gap-1.5 pr-1 px-2 py-1 text-left text-ink-faint hover:bg-card-strong hover:text-ink"
                title={`${conv.name} · ${owner}`}
              >
                {isAgent && <span className="text-[10px]">⎇</span>}
                <span className="truncate flex-1">{conv.name}</span>
                <span className="text-[10px] text-ink-faint truncate max-w-[80px]">
                  {owner}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
