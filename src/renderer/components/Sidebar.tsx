import { useMemo, useState } from 'react';
import { noBackendReady, useStore } from '../store';
import { useRunningMap, useRunnerCompletedAt, useRunnerIsRunning } from '../runnersStore';
import { Colosseum, Conversation, Project, SidebarLayout, Workspace, UUID } from '@shared/types';
import { flowRunOwnerPath, type FlowRun } from '@shared/flows/schema';
import { pathBasename } from '@shared/workspaceNames';
import { isEverydayProject } from '@shared/everydayProjects';
import { backendColor } from '../theme';
import { selectActiveEntries } from '../activeSection';
import { conversationActivityAt } from '../conversationLookup';
import { partitionSleeping } from '../sidebarSleep';
import { useFlowsStore } from '../flowsStore';
import { useOrchestratorStore } from '../orchestratorStore';
import { useWorkersStore } from '../workersStore';
import {
  ActiveFlowRow,
  FlowRunsSection,
  flowRunMatchesQuery,
} from './flows/FlowRunSidebarRow';
import { ConversationRow } from './ConversationRow';
import { RUNNING_MARKER_COLOR, SidebarMarker } from './SidebarMarker';
import { MomentumMeter, SleepRollup } from './SidebarAtoms';
import { SidebarStream } from './SidebarStream';
import {
  byNewestFirst,
  collectActiveCandidates,
  collectStreamItems,
  isAgentConversation,
  projectActivityAt,
  projectLabel,
  workspaceActivityAt,
  type RecentConversationItem,
} from './sidebarItems';
import { WorkersSidebar } from './workers/WorkersSidebar';
import { newConversationLabel, resolveNewConversationTarget } from '../newConversationTarget';
import { formatShortcutDef, SHORTCUTS, startNewConversationHere } from '../shortcuts';
import { anyDeskLive, workersForPath } from './workers/workerDeskSelectors';

// Collecting what the sidebar shows moved to ./sidebarItems so both layouts
// feed from one place. Re-exported here because the sheets and the
// activeCandidates suite have imported them from this module for a long time,
// and a rename would be churn with no reader-facing benefit.
export { collectActiveCandidates, isAgentConversation };

const WORKERS_EXPANDED_KEY = 'sidebar.workersExpanded';

/// How many worker runs the Active section will show at once. Three of seven
/// slots: enough to see a roster waking up, few enough that your own work
/// keeps the rest.
const ACTIVE_WORKER_RUN_LIMIT = 3;

/// Which workers the user has opened in the roster. Persisted, unlike the
/// project tree's in-memory collapse set, because the roster folds by
/// DEFAULT — losing this on reload would re-fold everything the user
/// deliberately opened, which makes opening things feel pointless.
function loadWorkersExpanded(): Set<UUID> {
  try {
    const raw = localStorage.getItem(WORKERS_EXPANDED_KEY);
    if (raw) return new Set(JSON.parse(raw) as UUID[]);
  } catch {
    // A corrupt entry just means starting folded.
  }
  return new Set();
}

function saveWorkersExpanded(ids: Set<UUID>): void {
  try {
    localStorage.setItem(WORKERS_EXPANDED_KEY, JSON.stringify([...ids]));
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
  const removeProject = useStore((s) => s.removeProject);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const startNewConversationInWorkspace = useStore((s) => s.startNewConversationInWorkspace);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const openExplorer = useStore((s) => s.openExplorer);
  const showDebug = useStore((s) => s.settings.showDebug ?? false);
  const showActiveSection = useStore((s) => s.settings.showActiveSidebarSection ?? true);
  const sidebarLayout = useStore((s) => s.settings.sidebarLayout ?? 'stream');
  // Read through getState rather than subscribing to the whole settings
  // object: the switch writes once a click, and a sidebar that re-rendered on
  // every unrelated settings change would be paying for it constantly.
  const showTree = sidebarLayout === 'projects';
  const setSidebarLayout = (layout: SidebarLayout) => {
    const st = useStore.getState();
    if ((st.settings.sidebarLayout ?? 'stream') === layout) return;
    void st.saveSettings({ ...st.settings, sidebarLayout: layout });
  };
  // One clock for every time-sensitive memo in this render, rather than each
  // calling Date.now() itself. Two memos disagreeing about "now" by a few
  // milliseconds is harmless; two memos each taking their own reading is how
  // a row ends up warm in one list and asleep in the next.
  const now = Date.now();
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
  const workers = useWorkersStore((s) => s.workers);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const lastSelectedAt = useStore((s) => s.lastSelectedAt);
  const lastOpenedAtByRun = useFlowsStore((s) => s.lastOpenedAtByRun);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const openedRunId = detailMode === 'flows' ? activeRunId : null;
  const [search, setSearch] = useState('');
  const [sleepingProjectsOpen, setSleepingProjectsOpen] = useState(false);
  const [sleepingWorkspacesOpen, setSleepingWorkspacesOpen] = useState(false);
  /// Which woken groups the user has since opened. Separate from `collapsed`
  /// because the two lists run opposite defaults — the warm tree is open
  /// until you close it, a woken group is closed until you open it.
  const [expandedSleeping, setExpandedSleeping] = useState<Set<UUID>>(new Set());
  const toggleSleeping = (id: UUID) =>
    setExpandedSleeping((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Flip the expand model: "expanded by default unless collapsed by the
  // user." We track only the IDs the user has explicitly collapsed;
  // everything else is open. New projects that arrive later (after the
  // app boots and `init()` loads the store) inherit the default-open
  // behavior automatically — no useEffect sync needed.
  const [collapsed, setCollapsed] = useState<Set<UUID>>(new Set());
  const isCollapsed = (id: UUID) => collapsed.has(id);
  const toggle = (id: UUID) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // The Workers roster runs the OPPOSITE model: folded by default, tracking
  // what the user OPENED. A project group is a container you file into, so
  // default-open earns its rows; a roster is a list of names you pick from,
  // and ten workers arriving pre-expanded buried the picking. Openings
  // persist across launches — see loadWorkersExpanded.
  const [workersExpanded, setWorkersExpanded] = useState<Set<UUID>>(loadWorkersExpanded);
  const updateWorkersExpanded = (updater: (cur: Set<UUID>) => Set<UUID>) =>
    setWorkersExpanded((cur) => {
      const next = updater(cur);
      if (next !== cur) saveWorkersExpanded(next);
      return next;
    });
  const toggleWorkerExpanded = (id: UUID) =>
    updateWorkersExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Idempotent — returns the same set untouched when nothing changes —
  // because the roster calls it from an effect on every selection render.
  const expandWorker = (id: UUID) =>
    updateWorkersExpanded((cur) => {
      if (cur.has(id)) return cur;
      const next = new Set(cur);
      next.add(id);
      return next;
    });
  const query = search.trim().toLowerCase();
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Owner paths (project repo path / workspace root) that have at least
  // one flow run matching the search. Lets a project/workspace surface in
  // results purely because one of its flow runs matches, even when its
  // name and conversations don't.
  const flowMatchPaths = useMemo(() => {
    const set = new Set<string>();
    if (!query) return set;
    for (const run of Object.values(flowRuns)) {
      if (flowRunMatchesQuery(run, query)) set.add(flowRunOwnerPath(run));
    }
    return set;
  }, [flowRuns, query]);
  // Collapse-all acts on whatever the sidebar is currently SHOWING. On the
  // Workers tab that is the roster, not the project tree — the button used to
  // fold groups nobody could see, so it read as broken.
  const allGroupIds = useMemo(
    () =>
      detailMode === 'workers'
        ? Object.keys(workers)
        : [...projects.map((p) => p.id), ...workspaces.map((w) => w.id)],
    [detailMode, workers, projects, workspaces],
  );
  // "Everything folded" reads off a different set per tab, because the roster
  // tracks openings where the project tree tracks closings.
  const allCollapsed =
    allGroupIds.length > 0 &&
    (detailMode === 'workers'
      ? allGroupIds.every((id) => !workersExpanded.has(id))
      : allGroupIds.every((id) => collapsed.has(id)));
  // Only the ids on screen move, so folding the roster does not silently
  // reopen every project group you had closed on the Chat tab.
  const toggleAll = () => {
    if (detailMode === 'workers') {
      updateWorkersExpanded((cur) => {
        const next = new Set(cur);
        for (const id of allGroupIds) {
          if (allCollapsed) next.add(id);
          else next.delete(id);
        }
        return next;
      });
      return;
    }
    setCollapsed((cur) => {
      const next = new Set(cur);
      for (const id of allGroupIds) {
        if (allCollapsed) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const visibleProjects = useMemo(() => {
    if (!query) return projects;
    return projects
      .map((p) => ({
        ...p,
        conversations: p.conversations.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            (c.sessionId ?? '').toLowerCase().includes(query),
        ),
      }))
      .filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.conversations.length > 0 ||
          flowMatchPaths.has(p.path),
      );
  }, [projects, query, flowMatchPaths]);

  const visibleWorkspaces = useMemo(() => {
    if (!query) return workspaces;
    return workspaces
      .map((w) => ({
        ...w,
        conversations: (w.conversations ?? []).filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            (c.sessionId ?? '').toLowerCase().includes(query),
        ),
      }))
      .filter((w) => {
        const memberMatch = w.projectIds.some((pid) =>
          projectsById.get(pid)?.name.toLowerCase().includes(query),
        );
        return (
          w.name.toLowerCase().includes(query) ||
          memberMatch ||
          w.conversations.length > 0 ||
          flowMatchPaths.has(w.rootPath)
        );
      });
  }, [projectsById, query, workspaces, flowMatchPaths]);
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
          Date.now(),
          workers,
        ),
      ),
    [
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
    () =>
      collectStreamItems(
        projects,
        workspaces,
        flowRuns,
        runners,
        { openedConversationId: selectedId, lastSelectedAt, openedRunId, lastOpenedAtByRun },
        now,
        workers,
      ),
    [
      projects,
      workspaces,
      flowRuns,
      runners,
      selectedId,
      lastSelectedAt,
      openedRunId,
      lastOpenedAtByRun,
      workers,
      now,
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

  // Projects and workspaces now obey ONE rule instead of two.
  //
  // Projects used to sort by activity, show the first five and overflow the
  // rest into "More projects"; workspaces sorted not at all, showed all of
  // them, and never rolled up. Two lists of the same kind of thing behaving
  // differently is most of why this sidebar read as busy — and the flat five
  // was arbitrary, so a sixth repo you were actively in got buried while a
  // dead one above it did not.
  //
  // Both are now: sort by activity, then roll up whatever has gone cold.
  // Warmth decides, not a headcount.
  const sortedProjects = useMemo(
    () =>
      [...projects].sort(
        (a, b) =>
          projectActivityAt(b, colosseums, runners, flowRuns, now) -
          projectActivityAt(a, colosseums, runners, flowRuns, now),
      ),
    [colosseums, projects, runners, flowRuns, now],
  );
  const projectSleep = useMemo(
    () =>
      partitionSleeping(
        sortedProjects,
        (p) => ({
          touchedAt: projectActivityAt(p, colosseums, runners, flowRuns, now),
          // A project you are inside, or one that has never had a chance to
          // look busy, stays put. Without the second half a repo you just
          // added would roll up before you had typed in it.
          pinned:
            p.id === focusedProjectId ||
            p.conversations.some((c) => c.id === selectedId) ||
            !hasProjectActivity(p, colosseums, flowRuns),
        }),
        { now },
      ),
    [sortedProjects, colosseums, runners, flowRuns, focusedProjectId, selectedId, now],
  );
  const sortedWorkspaces = useMemo(
    () =>
      [...workspaces].sort(
        (a, b) =>
          workspaceActivityAt(b, runners, flowRuns, now) -
          workspaceActivityAt(a, runners, flowRuns, now),
      ),
    [workspaces, runners, flowRuns, now],
  );
  const workspaceSleep = useMemo(
    () =>
      partitionSleeping(
        sortedWorkspaces,
        (w) => ({
          touchedAt: workspaceActivityAt(w, runners, flowRuns, now),
          pinned: (w.conversations ?? []).some((c) => c.id === selectedId),
        }),
        { now },
      ),
    [sortedWorkspaces, runners, flowRuns, selectedId, now],
  );
  const selectedProjectId = useMemo(
    () =>
      selectedId
        ? projects.find((p) => p.conversations.some((c) => c.id === selectedId))?.id ?? null
        : focusedProjectId,
    [focusedProjectId, projects, selectedId],
  );

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

  const renderProjectShortcut = (project: Project) => (
    <ProjectShortcutRow
      key={project.id}
      project={project}
      selected={project.id === selectedProjectId}
      onOpen={() => startNewConversation(project.id)}
      onExplore={() => openExplorer(project.path)}
    />
  );
  const renderProjectGroup = (project: Project) => (
    <ProjectGroup
      key={project.id}
      project={project}
      colosseums={colosseums.filter((c) => c.projectId === project.id)}
      expanded={!isCollapsed(project.id)}
      toggle={() => toggle(project.id)}
      selectedId={selectedId}
      onSelect={(id) => {
        setDetailMode('conversation');
        selectConversation(id);
      }}
      onNewConversation={() => startNewConversation(project.id)}
      onRemove={() => void removeProject(project.id)}
      onNewAgent={() => openSheet({ type: 'newAgent', projectId: project.id })}
      onNewColosseum={() => openSheet({ type: 'newColosseum', projectId: project.id })}
      onExplore={() => openExplorer(project.path)}
      searchQuery={query}
    />
  );
  // A woken group starts folded: you opened the roll-up to see WHICH cold
  // projects are there, not to have ten trees unfurl at once.
  const renderSleepingProjectGroup = (project: Project) => (
    <ProjectGroup
      key={project.id}
      project={project}
      colosseums={colosseums.filter((c) => c.projectId === project.id)}
      expanded={collapsed.has(project.id) ? false : expandedSleeping.has(project.id)}
      toggle={() => toggleSleeping(project.id)}
      selectedId={selectedId}
      onSelect={(id) => {
        setDetailMode('conversation');
        selectConversation(id);
      }}
      onNewConversation={() => startNewConversation(project.id)}
      onRemove={() => void removeProject(project.id)}
      onNewAgent={() => openSheet({ type: 'newAgent', projectId: project.id })}
      onNewColosseum={() => openSheet({ type: 'newColosseum', projectId: project.id })}
      onExplore={() => openExplorer(project.path)}
    />
  );

  return (
    <aside className="h-full flex-shrink-0 flex flex-col bg-surface-muted border-r border-card min-w-0" style={{ width: '100%' }}>
      <div className="px-2 pt-2 pb-1 flex items-center gap-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          className="field flex-1 min-w-0 px-2 py-1 text-xs"
        />
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
          Settings sheet mirrors, so the two can never disagree. Hidden on
          Workers, whose sidebar is the roster and has no second layout. */}
      {detailMode !== 'workers' && (
        <div className="mx-2 mt-1 flex gap-0.5 rounded-md border border-card-strong bg-card p-0.5">
          <LayoutTab
            label="Recent"
            title="Everything you have worked on, newest first"
            on={sidebarLayout === 'stream'}
            onClick={() => setSidebarLayout('stream')}
          />
          <LayoutTab
            label="Places"
            title="Your projects and workspaces as folders"
            on={sidebarLayout === 'projects'}
            onClick={() => setSidebarLayout('projects')}
          />
        </div>
      )}

      <nav className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
        {/* The Workers tab gets its own navigator. Workers are a fleet, not a
            branch of one project — a worker hired against a workspace root
            launches runs that land in member repos — so nesting each one under
            a project group made the tree lie about where its work lives. */}
        {detailMode === 'workers' ? (
          <WorkersSidebar
            query={query}
            expanded={workersExpanded}
            onToggleExpanded={toggleWorkerExpanded}
            onExpand={expandWorker}
          />
        ) : (
        <>
        {!query && showActiveSection && activeEntries.length > 0 && (
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
                  onClick={() => {
                    setDetailMode('conversation');
                    selectConversation(entry.conv.id);
                  }}
                />
              ),
            )}
          </>
        )}
        {!showTree && (
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
            onOpenConversation={(id) => {
              setDetailMode('conversation');
              selectConversation(id);
            }}
            onNewConversation={cliBlocked ? undefined : () => startNewConversationHere()}
            now={now}
          />
        )}
        {showTree && query && <SidebarSectionTitle label="Search results" />}
        {showTree && query && visibleProjects.length === 0 && visibleWorkspaces.length === 0 && (
          <div className="px-2 py-2 text-xs text-ink-faint">No matches</div>
        )}
        {showTree && query && visibleProjects.map(renderProjectGroup)}
        {showTree && (query ? visibleWorkspaces : workspaceSleep.awake).length > 0 && (
          <SidebarSectionTitle label="Workspaces" />
        )}
        {showTree && (query ? visibleWorkspaces : workspaceSleep.awake).map((ws) => (
          <WorkspaceGroup
            key={ws.id}
            workspace={ws}
            expanded={!isCollapsed(ws.id)}
            toggle={() => toggle(ws.id)}
            selectedId={selectedId}
            onSelect={(id) => {
              setDetailMode('conversation');
              selectConversation(id);
            }}
            onNewConversation={() => startNewConversationInWorkspace(ws.id)}
            onNewAgent={() =>
              openSheet({ type: 'newWorkspaceAgent', workspaceId: ws.id })
            }
            onEdit={() => openSheet({ type: 'editWorkspace', workspaceId: ws.id })}
            onRemove={() => void removeWorkspace(ws.id)}
            onExplore={ws.rootPath ? () => openExplorer(ws.rootPath!) : undefined}
            searchQuery={query}
          />
        ))}
        {showTree && !query && workspaceSleep.sleeping.length > 0 && (
          <SleepRollup
            count={workspaceSleep.sleeping.length}
            open={sleepingWorkspacesOpen}
            onToggle={() => setSleepingWorkspacesOpen((v) => !v)}
            label="Sleeping workspaces"
            openLabel="Sleeping workspaces"
          />
        )}
        {showTree &&
          !query &&
          sleepingWorkspacesOpen &&
          workspaceSleep.sleeping.map((ws) => (
            <WorkspaceGroup
              key={ws.id}
              workspace={ws}
              expanded={expandedSleeping.has(ws.id)}
              toggle={() => toggleSleeping(ws.id)}
              selectedId={selectedId}
              onSelect={(id) => {
                setDetailMode('conversation');
                selectConversation(id);
              }}
              onNewConversation={() => startNewConversationInWorkspace(ws.id)}
              onNewAgent={() => openSheet({ type: 'newWorkspaceAgent', workspaceId: ws.id })}
              onEdit={() => openSheet({ type: 'editWorkspace', workspaceId: ws.id })}
              onRemove={() => void removeWorkspace(ws.id)}
              onExplore={ws.rootPath ? () => openExplorer(ws.rootPath!) : undefined}
            />
          ))}
        {showTree && !query && projects.length > 0 && (
          <>
            <SidebarSectionTitle label="Projects" />
            {projectSleep.awake.map(renderProjectGroup)}
            {projectSleep.sleeping.length > 0 && (
              <>
                <SleepRollup
                  count={projectSleep.sleeping.length}
                  open={sleepingProjectsOpen}
                  onToggle={() => setSleepingProjectsOpen((v) => !v)}
                  label="Sleeping projects"
                  openLabel="Sleeping projects"
                />
                {sleepingProjectsOpen &&
                  projectSleep.sleeping.map(renderSleepingProjectGroup)}
              </>
            )}
          </>
        )}

        <ArchivedGroup />
        </>
        )}
      </nav>

      <div className="border-t border-card px-2 py-2 flex flex-col gap-1">
        <button
          onClick={() => openSheet({ type: 'newEverydayProject' })}
          disabled={cliBlocked}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card-strong text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-muted"
        >
          + New everyday project
        </button>
        <button
          onClick={pickProject}
          disabled={cliBlocked}
          title={cliBlocked ? 'Install a CLI first to add a project' : undefined}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card-strong text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-muted"
        >
          + Add project
        </button>
        <button
          onClick={() => openSheet({ type: 'newWorkspace' })}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card-strong text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-muted"
          disabled={cliBlocked || projects.length === 0}
          title={cliBlocked ? 'Install a CLI first to add a workspace' : undefined}
        >
          + New workspace
        </button>
        <div className="flex items-center gap-1 mt-1">
          <SidebarIconButton label="Extensions" onClick={() => openSheet({ type: 'capabilities' })} />
          <SidebarIconButton
            label="Cleanup"
            onClick={() => openSheet({ type: 'bulkConversationActions' })}
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
}: {
  label: string;
  title: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={
        'flex-1 rounded px-2 py-0.5 text-[11px] transition-colors ' +
        (on
          ? 'bg-surface-elevated text-ink shadow-sm'
          : 'text-ink-faint hover:text-ink-muted')
      }
    >
      {label}
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

function SidebarIconButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 text-[10px] py-1 text-ink-faint hover:text-ink-muted rounded hover:bg-card-strong"
    >
      {label}
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
  if (Object.values(flowRuns).some((r) => flowRunOwnerPath(r) === project.path)) return true;
  // A freshly picked project has no conversation yet — the welcome composer
  // creates one only on first send. Keep it out of the roll-up for a short
  // grace window so it does not vanish the moment it is added.
  return (project.lastOpenedAt ?? 0) > Date.now() - 24 * 60 * 60 * 1000;
}

function SidebarSectionTitle({ label }: { label: string }) {
  return (
    <div className="mt-3 px-2 text-[10px] uppercase tracking-wide text-ink-faint">
      {label}
    </div>
  );
}

function ProjectShortcutRow({
  project,
  selected,
  onOpen,
  onExplore,
}: {
  project: Project;
  selected: boolean;
  onOpen: () => void;
  onExplore: () => void;
}) {
  return (
    <div
      className={
        'sidebar-row group mt-1 flex items-center gap-1 rounded pr-1 ' +
        (selected
          ? 'sidebar-row-selected text-ink'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card')
      }
      title={project.path}
    >
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left">
        <ProjectIcon />
        <span className="min-w-0 flex-1">
          <span className={'block truncate text-xs ' + (selected ? 'font-medium' : '')}>
            {projectLabel(project)}
          </span>
          <span className="block truncate text-[10px] text-ink-faint">{pathBasename(project.path)}</span>
        </span>
      </button>
      <button
        onClick={onExplore}
        className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
        title="Explore files"
        aria-label={`Explore files in ${project.name}`}
      >
        <SearchIcon />
      </button>
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

function ProjectGroup({
  project,
  colosseums,
  expanded,
  toggle,
  selectedId,
  onSelect,
  onNewConversation,
  onRemove,
  onNewAgent,
  onNewColosseum,
  onExplore,
  searchQuery = '',
}: {
  project: Project;
  colosseums: Colosseum[];
  expanded: boolean;
  toggle: () => void;
  selectedId: UUID | null;
  onSelect: (id: UUID) => void;
  onNewConversation: () => void;
  onRemove: () => void;
  onNewAgent: () => void;
  onNewColosseum: () => void;
  onExplore: () => void;
  searchQuery?: string;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const workspaces = useStore((s) => s.workspaces);
  const runners = useRunningMap();
  const workers = useWorkersStore((s) => s.workers);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  // `true`/`false` once probed, `undefined` while still unknown. Agents
  // depend on git worktrees, so we hide the "+ agent" affordance only
  // when we've confirmed the project isn't a git repo.
  const isGitRepo = useStore((s) => s.projectIsGitRepo[project.id]);
  // Everyday projects ARE git repos, so this is a separate question from
  // `isGitRepo` — see `isEverydayProject`. A plain folder with no history is
  // the one state where offering the conversion is purely additive, which is
  // why the offer is gated on `false` and not on `!== true`.
  const everyday = isEverydayProject(project);
  // Memoized because this group is re-rendered by every unrelated store
  // change, and a mature project list carries hundreds of conversations —
  // walking them four times per render was showing up in profiles.
  const { visible, agents } = useMemo(() => {
    const vis: Conversation[] = [];
    const ags: Conversation[] = [];
    for (const c of project.conversations) {
      if (c.hidden) continue;
      if (!isAgentConversation(c)) vis.push(c);
      else if (!c.colosseumId && !c.workspaceAgentCoordinatorId) ags.push(c);
    }
    // Newest first, like the flow runs directly below them. These used to
    // render in raw store order — which is append order — so the newest chat
    // sat at the BOTTOM of a group whose newest run sat at the top. One list,
    // two directions.
    return { visible: byNewestFirst(vis), agents: byNewestFirst(ags) };
  }, [project.conversations]);
  const convSleep = useMemo(
    () =>
      partitionSleeping(visible, (c) => ({
        touchedAt: conversationActivityAt(c),
        pinned: c.id === selectedId || (runners[c.id]?.isRunning ?? false),
      })),
    [visible, selectedId, runners],
  );
  const [sleepOpen, setSleepOpen] = useState(false);
  const archivableCount = useMemo(
    () =>
      project.conversations.filter(
        (c) => !c.hidden && c.id !== selectedId && !(runners[c.id]?.isRunning ?? false),
      ).length,
    [project.conversations, selectedId, runners],
  );
  const flowRuns = useFlowsStore((s) => s.runs);
  const deskLive = useMemo(
    () =>
      anyDeskLive(
        workersForPath(workers, project.path),
        flowRuns,
        orchestrations,
        runners,
        shiftProgress,
      ),
    [flowRuns, orchestrations, project.path, runners, shiftProgress, workers],
  );
  const deletableFlowCount = useMemo(
    () =>
      Object.values(flowRuns).filter(
        (r) =>
          flowRunOwnerPath(r) === project.path &&
          r.state.kind !== 'running' &&
          r.state.kind !== 'paused' &&
          !Object.values(r.conversationIds).some((cid) => runners[cid]?.isRunning),
      ).length,
    [flowRuns, project.path, runners],
  );
  const workspaceRefs = useMemo(
    () => workspaces.filter((w) => w.projectIds.includes(project.id)),
    [workspaces, project.id],
  );
  const [confirmRemove, setConfirmRemove] = useState(false);

  const removeDetails = useMemo(() => {
    const colosseumCount = colosseums.length;
    const workspaceCount = workspaceRefs.length;
    const deletedWorkspaceCount = workspaceRefs.filter(
      (w) => w.projectIds.filter((pid) => pid !== project.id).length === 0,
    ).length;
    return [
      project.conversations.length
        ? `${project.conversations.length} conversation${project.conversations.length === 1 ? '' : 's'} and agent${project.conversations.length === 1 ? '' : 's'} will be removed.`
        : '',
      colosseumCount
        ? `${colosseumCount} colosseum${colosseumCount === 1 ? '' : 's'} will be removed.`
        : '',
      workspaceCount
        ? `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'} will be updated.`
        : '',
      deletedWorkspaceCount
        ? `${deletedWorkspaceCount} workspace${deletedWorkspaceCount === 1 ? '' : 's'} with no projects left will also be removed.`
        : '',
    ].filter(Boolean);
  }, [colosseums.length, project.conversations.length, project.id, workspaceRefs]);

  return (
    <div className="mt-1">
      <div className="group flex items-center px-2 py-1 rounded hover:bg-card-strong">
        <button
          onClick={toggle}
          className="w-5 h-5 flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card-strong"
          title={expanded ? 'Collapse project' : 'Expand project'}
          aria-label={expanded ? 'Collapse project' : 'Expand project'}
        >
          <span className={'text-[9px] ' + (expanded ? 'rotate-90' : '') + ' transition-transform flex-shrink-0'}>▸</span>
        </button>
        <button
          onClick={onNewConversation}
          className="flex items-center gap-1.5 flex-1 text-left min-w-0"
          title={`Open ${projectLabel(project)}`}
          aria-label={`Open ${projectLabel(project)}`}
        >
          <ProjectIcon />
          <span className="text-xs font-medium truncate">{projectLabel(project)}</span>
          {deskLive && <RunningIndicator activityLabel="A worker is working" />}
        </button>
        <button
          onClick={onNewConversation}
          className="w-6 h-6 flex items-center justify-center rounded text-accent hover:text-accent hover:bg-card-strong [filter:drop-shadow(0_0_3px_rgba(125,200,255,0.7))] hover:[filter:drop-shadow(0_0_5px_rgba(125,200,255,0.9))]"
          title="New conversation"
          aria-label={`New conversation in ${projectLabel(project)}`}
        >
          <PlusIcon />
        </button>
        <button
          onClick={onExplore}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
          title="Explore files"
          aria-label={`Explore files in ${projectLabel(project)}`}
        >
          <SearchIcon />
        </button>
        <button
          onClick={() => setConfirmRemove(true)}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-red-300 hover:bg-card-strong"
          title="Remove project from Overcli"
          aria-label={`Remove project ${projectLabel(project)}`}
        >
          <TrashIcon />
        </button>
      </div>
      {confirmRemove && (
        <InlineRemoveConfirm
          title={`Remove ${projectLabel(project)} from Overcli?`}
          body="This keeps the repo on disk, but removes it from the app."
          details={removeDetails}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            onRemove();
          }}
        />
      )}
      {expanded && (
        <div className="ml-4 border-l border-card pl-1">
          {convSleep.awake.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              selected={conv.id === selectedId}
              onClick={() => onSelect(conv.id)}
            />
          ))}
          {convSleep.sleeping.length > 0 && (
            <SleepRollup
              count={convSleep.sleeping.length}
              open={sleepOpen}
              onToggle={() => setSleepOpen((v) => !v)}
            />
          )}
          {sleepOpen &&
            convSleep.sleeping.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                selected={conv.id === selectedId}
                onClick={() => onSelect(conv.id)}
              />
            ))}
          {agents.length > 0 && (
            <div className="mt-1 text-[10px] uppercase tracking-wider text-ink-faint px-2">
              Agents
            </div>
          )}
          {agents.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              selected={conv.id === selectedId}
              onClick={() => onSelect(conv.id)}
            />
          ))}
          {colosseums.length > 0 && (
            <div className="mt-1 text-[10px] uppercase tracking-wider text-ink-faint px-2">
              Colosseums
            </div>
          )}
          {colosseums.map((colosseum) => (
            <ColosseumSidebarGroup
              key={colosseum.id}
              colosseum={colosseum}
              project={project}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
          <FlowRunsSection path={project.path} query={searchQuery} />
          <div className="flex gap-1 my-1 pl-1">
            {isGitRepo !== false && (
              <button
                onClick={onNewAgent}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
                title="New agent (build, review, docs, …)"
              >
                + agent
              </button>
            )}
            {isGitRepo !== false && (
              <button
                onClick={onNewColosseum}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
                title="New colosseum"
              >
                + colosseum
              </button>
            )}
            {(everyday || isGitRepo === false) && (
              <button
                onClick={() => openSheet({ type: 'everydayConversion', projectId: project.id })}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
                title={
                  everyday
                    ? 'Everyday project — documents, plain words, undo. Click to turn off.'
                    : 'Make this an everyday project: documents, plain words, undo'
                }
              >
                {everyday ? 'everyday' : '+ everyday'}
              </button>
            )}
            {archivableCount + deletableFlowCount > 0 && (
              <button
                onClick={() => openSheet({ type: 'archiveAllInProject', projectId: project.id })}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong ml-auto"
                title="Archive inactive conversations and delete finished flow runs in this project"
              >
                archive all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ColosseumSidebarGroup({
  colosseum,
  project,
  selectedId,
  onSelect,
}: {
  colosseum: Colosseum;
  project: Project;
  selectedId: UUID | null;
  onSelect: (id: UUID) => void;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const cancelColosseum = useStore((s) => s.cancelColosseum);
  const removeColosseum = useStore((s) => s.removeColosseum);
  const runners = useRunningMap();
  const [expanded, setExpanded] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const contenders = colosseum.contenderIds
    .map((cid) => project.conversations.find((c) => c.id === cid) ?? null)
    .filter((c): c is Conversation => c != null);
  const containsSelected = selectedId != null && contenders.some((c) => c.id === selectedId);
  const status = effectiveColosseumStatus(colosseum, runners);
  const runningContender = contenders.find((conv) => runners[conv.id]?.isRunning);

  return (
    <div className="mt-1">
      <div
        className={
          'group flex items-center gap-1 rounded pr-1 ' +
          (containsSelected ? 'bg-accent/10' : 'hover:bg-card-strong')
        }
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-2 py-1 text-[9px] text-ink-faint"
          aria-label={expanded ? 'Collapse colosseum' : 'Expand colosseum'}
        >
          <span className={expanded ? 'rotate-90 inline-block transition-transform' : 'inline-block transition-transform'}>
            ▸
          </span>
        </button>
        <button
          onClick={() => openSheet({ type: 'colosseumCompare', colosseumId: colosseum.id })}
          className="flex flex-1 min-w-0 items-center gap-1.5 py-1 text-left"
          title={`Open ${colosseum.name}`}
        >
          <TrophyIcon />
          <span className="truncate text-xs font-medium">{colosseum.name}</span>
        </button>
        <ColosseumStatusBadge
          status={status}
          activityLabel={runningContender ? runners[runningContender.id]?.activityLabel : undefined}
        />
      </div>
      {expanded && (
        <div className="ml-5 border-l border-card pl-2">
          {contenders.map((conv) => {
            const isWinner = colosseum.winnerId === conv.id;
            const runner = runners[conv.id];
            const isRunning = runner?.isRunning ?? false;
            const completed = !isRunning && !!runner?.completedAt;
            return (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={
                  'sidebar-row flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs ' +
                  (selectedId === conv.id
                    ? 'sidebar-row-selected text-ink'
                    : 'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card')
                }
                title={conv.name}
              >
                <SidebarMarker
                  color={backendColor(conv.primaryBackend)}
                  active={isRunning}
                  completed={completed}
                />
                <span className="truncate flex-1">
                  {conv.primaryBackend}
                  {conv.currentModel ? ` · ${conv.currentModel}` : ''}
                </span>
                {isWinner ? (
                  <span className="text-amber-300/80">
                    <CrownIcon />
                  </span>
                ) : null}
              </button>
            );
          })}
          <div className="flex items-center gap-1 px-2 py-1">
            <button
              onClick={() => openSheet({ type: 'colosseumCompare', colosseumId: colosseum.id })}
              className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
            >
              Compare
            </button>
            {status === 'running' && (
              <button
                onClick={() => void cancelColosseum(colosseum.id)}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
              >
                Cancel
              </button>
            )}
            <button
              onClick={() => setConfirmRemove(true)}
              className="text-[10px] text-ink-faint hover:text-red-400 py-0.5 px-1.5 rounded hover:bg-card-strong"
            >
              Remove
            </button>
          </div>
          {confirmRemove && (
            <InlineRemoveConfirm
              title={`Remove ${colosseum.name}?`}
              body="This removes the colosseum and its contender worktrees."
              details={[
                `${contenders.length} contender${contenders.length === 1 ? '' : 's'} will be removed.`,
              ]}
              confirmLabel="Remove"
              onCancel={() => setConfirmRemove(false)}
              onConfirm={() => {
                setConfirmRemove(false);
                void removeColosseum(colosseum.id);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function effectiveColosseumStatus(
  colosseum: Colosseum,
  runners: Record<UUID, { isRunning: boolean } | undefined>,
): Colosseum['status'] {
  if (colosseum.status === 'cancelled' || colosseum.status === 'merged') return colosseum.status;
  return colosseum.contenderIds.some((cid) => runners[cid]?.isRunning) ? 'running' : 'comparing';
}

// SidebarMarker + synchronizedAnimationStyle moved to ./SidebarMarker.tsx
// so flow rows can reuse them without an import cycle.

function RunningIndicator({
  active = true,
  activityLabel,
}: {
  active?: boolean;
  activityLabel?: string;
}) {
  const title = activityLabel?.trim() || 'Running';

  return (
    <span
      className="flex w-4 h-4 flex-shrink-0 items-center justify-center"
      title={active ? title : undefined}
      aria-label={active ? title : undefined}
    >
      {active ? (
        <span className="relative flex h-3 w-3 items-center justify-center pointer-events-none">
          <span
            className="absolute inline-flex h-full w-full rounded-full animate-ping"
            style={{ background: RUNNING_MARKER_COLOR, opacity: 0.35 }}
          />
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: RUNNING_MARKER_COLOR }} />
        </span>
      ) : null}
    </span>
  );
}

function ColosseumStatusBadge({
  status,
  activityLabel,
}: {
  status: Colosseum['status'];
  activityLabel?: string;
}) {
  if (status === 'running') {
    return <RunningIndicator activityLabel={activityLabel ?? 'Colosseum running'} />;
  }
  if (status === 'merged') {
    return <span className="text-[10px] text-green-400" title="Colosseum merged">✓</span>;
  }
  if (status === 'cancelled') {
    return <span className="text-[10px] text-ink-faint" title="Colosseum cancelled">×</span>;
  }
  return <span className="text-[10px] text-sky-300" title="Colosseum comparing">⇄</span>;
}

function WorkspaceGroup({
  workspace,
  expanded,
  toggle,
  selectedId,
  onSelect,
  onNewConversation,
  onNewAgent,
  onEdit,
  onRemove,
  onExplore,
  searchQuery = '',
}: {
  workspace: Workspace;
  expanded: boolean;
  toggle: () => void;
  selectedId: UUID | null;
  onSelect: (id: UUID) => void;
  onNewConversation: () => void;
  onNewAgent: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onExplore?: () => void;
  searchQuery?: string;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const runners = useRunningMap();
  const workers = useWorkersStore((s) => s.workers);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  // See the matching note in ProjectGroup — memoized so an unrelated store
  // change doesn't re-walk the whole conversation list.
  const { convs, plain, agents } = useMemo(() => {
    const all = (workspace.conversations ?? []).filter((c) => !c.hidden);
    // Same direction as a project group and as the flow runs below — see the
    // note on byNewestFirst.
    return {
      convs: all,
      plain: byNewestFirst(all.filter((c) => !isAgentConversation(c))),
      agents: byNewestFirst(all.filter(isAgentConversation)),
    };
  }, [workspace.conversations]);
  const convSleep = useMemo(
    () =>
      partitionSleeping(plain, (c) => ({
        touchedAt: conversationActivityAt(c),
        pinned: c.id === selectedId || (runners[c.id]?.isRunning ?? false),
      })),
    [plain, selectedId, runners],
  );
  const [sleepOpen, setSleepOpen] = useState(false);
  const archivableCount = useMemo(
    () =>
      (workspace.conversations ?? []).filter(
        (c) => !c.hidden && c.id !== selectedId && !(runners[c.id]?.isRunning ?? false),
      ).length,
    [workspace.conversations, selectedId, runners],
  );
  const flowRuns = useFlowsStore((s) => s.runs);
  const deskLive = useMemo(
    () =>
      anyDeskLive(
        workersForPath(workers, workspace.rootPath),
        flowRuns,
        orchestrations,
        runners,
        shiftProgress,
      ),
    [flowRuns, orchestrations, runners, shiftProgress, workers, workspace.rootPath],
  );
  const deletableFlowCount = useMemo(
    () =>
      Object.values(flowRuns).filter(
        (r) =>
          flowRunOwnerPath(r) === workspace.rootPath &&
          r.state.kind !== 'running' &&
          r.state.kind !== 'paused' &&
          !Object.values(r.conversationIds).some((cid) => runners[cid]?.isRunning),
      ).length,
    [flowRuns, workspace.rootPath, runners],
  );
  const [confirmRemove, setConfirmRemove] = useState(false);

  const removeDetails = useMemo(
    () =>
      [
      convs.length
        ? `${convs.length} workspace conversation${convs.length === 1 ? '' : 's'} will be removed.`
        : 'This workspace has no conversations yet.',
      workspace.projectIds.length
        ? `${workspace.projectIds.length} member project${workspace.projectIds.length === 1 ? '' : 's'} will stay available individually.`
        : '',
      ].filter(Boolean),
    [convs.length, workspace.projectIds.length],
  );

  return (
    <div className="mt-1">
      <div className="group flex items-center px-2 py-1 rounded hover:bg-card-strong">
        <button onClick={toggle} className="flex items-center gap-1.5 flex-1 text-left min-w-0">
          <span className={'text-[9px] text-ink-faint ' + (expanded ? 'rotate-90' : '') + ' transition-transform flex-shrink-0'}>▸</span>
          <WorkspaceIcon />
          <span className="text-xs font-medium truncate">{workspace.name}</span>
          {deskLive && <RunningIndicator activityLabel="A worker is working" />}
        </button>
        <button
          onClick={onNewConversation}
          className="w-6 h-6 flex items-center justify-center rounded text-accent hover:text-accent hover:bg-card-strong [filter:drop-shadow(0_0_3px_rgba(125,200,255,0.7))] hover:[filter:drop-shadow(0_0_5px_rgba(125,200,255,0.9))]"
          title="New conversation"
          aria-label={`New conversation in ${workspace.name}`}
        >
          <PlusIcon />
        </button>
        {onExplore && (
          <button
            onClick={onExplore}
            className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
            title="Explore files"
            aria-label={`Explore files in ${workspace.name}`}
          >
            <SearchIcon />
          </button>
        )}
        <button
          onClick={onEdit}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-muted opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
          title="Edit workspace member projects"
          aria-label={`Edit workspace ${workspace.name}`}
        >
          <PencilIcon />
        </button>
        <button
          onClick={() => setConfirmRemove(true)}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-red-300 hover:bg-card-strong"
          title="Remove workspace from Overcli"
          aria-label={`Remove workspace ${workspace.name}`}
        >
          <TrashIcon />
        </button>
      </div>
      {confirmRemove && (
        <InlineRemoveConfirm
          title={`Remove ${workspace.name} from Overcli?`}
          body="This removes the synthetic workspace and its conversations, but keeps member repos on disk and in the app."
          details={removeDetails}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            onRemove();
          }}
        />
      )}
      {expanded && (
        <div className="ml-4 border-l border-card pl-1">
          {plain.length === 0 && agents.length === 0 && (
            <div className="px-2 py-1 text-[10px] text-ink-faint">No conversations yet</div>
          )}
          {convSleep.awake.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              selected={conv.id === selectedId}
              onClick={() => onSelect(conv.id)}
            />
          ))}
          {convSleep.sleeping.length > 0 && (
            <SleepRollup
              count={convSleep.sleeping.length}
              open={sleepOpen}
              onToggle={() => setSleepOpen((v) => !v)}
            />
          )}
          {sleepOpen &&
            convSleep.sleeping.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                selected={conv.id === selectedId}
                onClick={() => onSelect(conv.id)}
              />
            ))}
          {agents.length > 0 && (
            <div className="mt-1 text-[10px] uppercase tracking-wider text-ink-faint px-2">
              Agents
            </div>
          )}
          {agents.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              selected={conv.id === selectedId}
              onClick={() => onSelect(conv.id)}
            />
          ))}
          <FlowRunsSection path={workspace.rootPath} query={searchQuery} />
          <div className="flex gap-1 my-1 pl-1">
            <button
              onClick={onNewAgent}
              className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
              title="New workspace agent (spans all member projects)"
            >
              + agent
            </button>
            {archivableCount + deletableFlowCount > 0 && (
              <button
                onClick={() => openSheet({ type: 'archiveAllInWorkspace', workspaceId: workspace.id })}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong ml-auto"
                title="Archive inactive conversations and delete finished flow runs in this workspace"
              >
                archive all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InlineRemoveConfirm({
  title,
  body,
  details,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  details: string[];
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mx-2 mt-1 rounded-lg border border-red-400/30 bg-red-950/20 p-2">
      <div className="text-xs font-semibold text-ink">{title}</div>
      <div className="mt-1 text-[11px] leading-relaxed text-ink-muted">{body}</div>
      {details.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[10px] leading-relaxed text-ink-faint">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onCancel}
          className="flex-1 rounded border border-card-strong px-2 py-1 text-xs text-ink-muted hover:bg-card-strong hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 rounded bg-red-400 px-2 py-1 text-xs font-medium text-surface hover:bg-red-300"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
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
            openSheet({ type: 'bulkConversationActions' });
          }}
          className="text-[10px] text-ink-faint hover:text-ink px-1 py-0.5 rounded hover:bg-card-strong opacity-0 group-hover:opacity-100 focus:opacity-100"
          title="Bulk cleanup conversations"
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

/// Small folder glyph used at the head of each project group. Sized to
/// match the text row and tinted with `text-ink-muted` so it blends with
/// the label.
function ProjectIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      className="text-ink-muted flex-shrink-0"
    >
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/// Stacked-folders glyph to distinguish workspaces (which reference
/// multiple projects) from a single project folder.
function WorkspaceIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      className="text-ink-muted flex-shrink-0"
    >
      <path
        d="M3.5 2.5H5.7L6.7 3.6H12.5V5.5H3.5V2.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.2"
      />
      <path
        d="M1.5 5.5H4L5 6.5H14.5V13.3A1 1 0 0113.5 14.3H2.5A1 1 0 011.5 13.3V5.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <path
        d="M12.793 2.793a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-8.2 8.2a2.5 2.5 0 0 1-1.14.63l-2.26.566a.75.75 0 0 1-.91-.91l.566-2.26a2.5 2.5 0 0 1 .63-1.14l8.2-8.2Z"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <path d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z" />
    </svg>
  );
}

/// Folder with a magnifier — used to launch the standalone file
/// explorer from a project or workspace header. Kept small so it sits
/// next to the other 14px glyphs in the row.
function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <path
        d="M6 2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V3h2.25a.75.75 0 0 1 0 1.5h-.386l-.558 7.253A1.75 1.75 0 0 1 9.56 13.5H6.44a1.75 1.75 0 0 1-1.746-1.747L4.136 4.5H3.75a.75.75 0 0 1 0-1.5H6v-.5Zm1.5 0V3h1v-.5a.5.5 0 0 0-.5-.5h-.5a.5.5 0 0 0-.5.5Zm-.25 3.25a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0v-4Zm3 0a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0v-4Z"
      />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      className="text-ink-muted flex-shrink-0"
      aria-hidden="true"
    >
      <path
        d="M4 2.5h8v3.5a4 4 0 0 1-8 0V2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M4 3.5H2.5v1.5a2 2 0 0 0 2 2M12 3.5h1.5v1.5a2 2 0 0 1-2 2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 10v2.5M5.5 13.5h5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <path
        d="M2 5.5l2 5h8l2-5-3 2-3-4-3 4-3-2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.2"
      />
      <path d="M4 12.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
