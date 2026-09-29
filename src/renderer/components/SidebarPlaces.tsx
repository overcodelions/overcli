// The Places half of the sidebar: one line per project or workspace.
//
// A place used to cost two rows before you opened it — its name with three
// always-on buttons (new, explore, a red trash can), and a second row of
// "+ agent + colosseum" underneath — so thirty repos were sixty rows, mostly
// buttons. Now a place is its name, a kind icon, and a line of what is going
// on inside it. The actions are still one hover away: "+" for anything new,
// "⋯" for pinning, files and removing.
//
// Opened, a place leads with what needs you and what is running, then the
// last few conversations, and folds everything else into count lines — so a
// workspace with seventeen finished flow runs no longer pushes the three that
// are paused on you off the screen.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useStore } from '../store';
import { useRunningMap } from '../runnersStore';
import { useFlowsStore } from '../flowsStore';
import { useWorkersStore } from '../workersStore';
import { useOrchestratorStore } from '../orchestratorStore';
import type { Colosseum, Conversation, Project, UUID, Workspace } from '@shared/types';
import { flowRunActivityAt, flowRunIsOwnedBy, type FlowRun } from '@shared/flows/schema';
import { isEverydayProject } from '@shared/everydayProjects';
import { labOn } from '@shared/labs';
import { backendColor } from '../theme';
import { conversationActivityAt } from '../conversationLookup';
import { partitionSleeping } from '../sidebarSleep';
import { starredFlowsForPlace } from '../placeFlows';
import { ConversationRow } from './ConversationRow';
import { RUNNING_MARKER_COLOR, SidebarMarker } from './SidebarMarker';
import { byNewestFirst, isAgentConversation } from './sidebarItems';
import { FlowRunRow, WAITING_RUN_WINDOW_MS, flowRunsForPath, runIsLive } from './flows/FlowRunSidebarRow';
import { anyDeskLive, workersForPath } from './workers/workerDeskSelectors';
import {
  agoLabel,
  placeKind,
  placeName,
  type PlaceKind,
  type PlaceRef,
  type PlaceStatus,
} from '../places';

// ---- status ---------------------------------------------------------------

type Runners = Record<UUID, { isRunning: boolean } | undefined>;

/// What is happening in one folder: its conversations and the flow runs it
/// owns. Worker runs are left out on purpose — they live on the worker's desk,
/// and a count here that opening the place could not show would be a lie.
export function statusOfPath(
  conversations: readonly Conversation[],
  path: string,
  runs: readonly FlowRun[],
  runners: Runners,
  now: number,
): PlaceStatus {
  let running = conversations.filter((c) => !c.hidden && runners[c.id]?.isRunning).length;
  let needsYou = 0;
  for (const run of runs) {
    if (run.workerId || !flowRunIsOwnedBy(run, path)) continue;
    if (runIsLive(run, runners)) running++;
    else if (run.state.kind === 'paused' && flowRunActivityAt(run) > now - WAITING_RUN_WINDOW_MS) needsYou++;
  }
  return { running, needsYou };
}

/// A workspace's line counts its members too: collapsed, the members are
/// hidden inside it, so their work has to show on the workspace's row.
export function statusOfPlace(ref: PlaceRef, runs: readonly FlowRun[], runners: Runners, now: number): PlaceStatus {
  if (ref.kind === 'project') return statusOfPath(ref.project.conversations, ref.project.path, runs, runners, now);
  const own = statusOfPath(ref.workspace.conversations ?? [], ref.workspace.rootPath, runs, runners, now);
  return ref.members.reduce((sum, member) => {
    const s = statusOfPath(member.conversations, member.path, runs, runners, now);
    return { running: sum.running + s.running, needsYou: sum.needsYou + s.needsYou };
  }, own);
}

// ---- a place's row --------------------------------------------------------

export interface PlaceActions {
  onNewConversation: () => void;
  onNewAgent?: () => void;
  onNewColosseum?: () => void;
  onExplore?: () => void;
  onEdit?: () => void;
  onDocuments?: { label: string; run: () => void };
  onArchiveAll?: () => void;
  onRemove: () => void;
}

interface PlaceRowProps {
  ref_: PlaceRef;
  kind: PlaceKind;
  expanded: boolean;
  onToggle: () => void;
  status: PlaceStatus;
  activityAt: number;
  now: number;
  pinned: boolean;
  onTogglePin: () => void;
  /// Set while pinned: nudge this place up or down the pinned list.
  onMovePin?: (direction: -1 | 1) => void;
  actions: PlaceActions;
  /// Holds the conversation you have open, so the row says "you are here".
  current: boolean;
  workerLive: boolean;
  removeTitle: string;
  removeBody: string;
  removeDetails: string[];
  nested?: boolean;
}

export function PlaceRow(props: PlaceRowProps) {
  const { ref_, kind, expanded, status, activityAt, now, pinned, actions, current, nested } = props;
  const name = placeName(ref_);
  const [menu, setMenu] = useState<'add' | 'more' | 'context' | null>(null);
  const [contextAt, setContextAt] = useState<{ x: number; y: number } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const addAnchor = useRef<HTMLButtonElement>(null);
  const moreAnchor = useRef<HTMLButtonElement>(null);
  const path = ref_.kind === 'project' ? ref_.project.path : ref_.workspace.rootPath;
  const flowItems = usePlaceFlowItems(ref_, menu === 'add' || menu === 'context');

  // Hints say what you get, not what kind of thing it is. The one instant
  // action leads; a divider sets it off from the two that open a sheet.
  const addItems: MenuItemDef[] = [
    { label: 'Conversation', hint: 'Chat with Claude in this folder', icon: <ChatIcon />, onSelect: actions.onNewConversation },
    ...(actions.onNewAgent || actions.onNewColosseum ? [{ divider: true, label: '', onSelect: () => {} }] : []),
    ...(actions.onNewAgent
      ? [{
          label: 'Agent on a branch…',
          hint: ref_.kind === 'workspace'
            ? 'A worktree in every repo; you review the diff'
            : 'Works in its own worktree; you review the diff',
          icon: <BranchIcon />,
          onSelect: actions.onNewAgent,
        }]
      : []),
    ...(actions.onNewColosseum
      ? [{ label: 'Colosseum…', hint: 'One prompt, several models, compare answers', icon: <ColumnsIcon />, onSelect: actions.onNewColosseum }]
      : []),
    ...flowItems,
  ];
  const moreItems: MenuItemDef[] = [
    { label: pinned ? 'Unpin' : 'Pin to top', onSelect: props.onTogglePin },
    ...(pinned && props.onMovePin
      ? [
          { label: 'Move up', onSelect: () => props.onMovePin!(-1) },
          { label: 'Move down', onSelect: () => props.onMovePin!(1) },
        ]
      : []),
    ...(actions.onEdit ? [{ label: 'Edit member projects…', onSelect: actions.onEdit }] : []),
    ...(actions.onExplore ? [{ label: 'Explore files', onSelect: actions.onExplore }] : []),
    ...(path ? [{ label: 'Show in Finder', onSelect: () => void window.overcli.invoke('fs:openInFinder', path) }] : []),
    ...(actions.onDocuments ? [{ label: actions.onDocuments.label, onSelect: actions.onDocuments.run }] : []),
    ...(actions.onArchiveAll ? [{ label: 'Archive old conversations…', onSelect: actions.onArchiveAll }] : []),
    { divider: true, label: '', onSelect: () => {} },
    { label: 'Remove from Overcli…', hint: 'files stay on disk', danger: true, onSelect: () => setConfirmRemove(true) },
  ];

  return (
    <div className={nested ? '' : 'mt-px'}>
      <div
        className={
          'group relative flex h-7 items-center gap-1.5 rounded pl-1 pr-1 ' +
          (current ? 'bg-card-strong/70 ' : 'hover:bg-card-strong ') +
          (menu ? 'bg-card-strong ' : '')
        }
        title={path}
        // Right-click is where a macOS sidebar keeps its actions; this is
        // both hover menus in one, opened at the pointer.
        onContextMenu={(e) => {
          e.preventDefault();
          setContextAt({ x: e.clientX, y: e.clientY });
          setMenu('context');
        }}
      >
        {/* Two targets, the way a file browser has them: the arrow folds the
            place open or shut, the name takes you to it. A documents project
            IS its landing page — the grid, Recently filed, the composer — so
            a name that only folded the row left no way there from here. */}
        <button
          onClick={props.onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Fold' : 'Unfold'} ${name}`}
          className="flex h-5 w-4 flex-shrink-0 items-center justify-center rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          <Chevron open={expanded} />
        </button>
        <button
          onClick={() => {
            actions.onNewConversation();
            if (!expanded) props.onToggle();
          }}
          title={`Open ${name}`}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded pl-0.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          <KindIcon kind={kind} />
          <span className={'truncate text-xs ' + (current || expanded ? 'font-medium text-ink' : 'text-ink-muted group-hover:text-ink')}>
            {name}
          </span>
          {props.workerLive && <RunningIndicator activityLabel="A worker is working here" />}
        </button>
        <span className={'flex flex-shrink-0 items-center gap-1.5 ' + (menu ? 'hidden' : 'group-hover:hidden group-focus-within:hidden')}>
          <StatusSummary status={status} ago={agoLabel(activityAt, now)} />
        </span>
        <span className={'flex-shrink-0 items-center gap-0.5 ' + (menu ? 'flex' : 'hidden group-hover:flex group-focus-within:flex')}>
          <button
            ref={addAnchor}
            onClick={() => setMenu((m) => (m === 'add' ? null : 'add'))}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-surface-elevated hover:text-ink"
            title={`New in ${name}`}
            aria-label={`New in ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu === 'add'}
          >
            <PlusIcon />
          </button>
          <button
            ref={moreAnchor}
            onClick={() => setMenu((m) => (m === 'more' ? null : 'more'))}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-surface-elevated hover:text-ink"
            title={`More for ${name}`}
            aria-label={`More for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
          >
            <DotsIcon />
          </button>
        </span>
      </div>
      {menu === 'add' && (
        <PopMenu
          anchor={addAnchor}
          heading={`New in ${name}`}
          headingDetail={pathTail(path)}
          items={addItems}
          beside
          width={300}
          onClose={() => setMenu(null)}
        />
      )}
      {menu === 'more' && <PopMenu anchor={moreAnchor} items={moreItems} onClose={() => setMenu(null)} />}
      {menu === 'context' && contextAt && (
        <PopMenu
          anchor={moreAnchor}
          at={contextAt}
          heading={name}
          headingDetail={pathTail(path)}
          items={[...addItems, { divider: true, label: '', onSelect: () => {} }, ...moreItems]}
          width={300}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmRemove && (
        <InlineRemoveConfirm
          title={props.removeTitle}
          body={props.removeBody}
          details={props.removeDetails}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            actions.onRemove();
          }}
        />
      )}
    </div>
  );
}

/// The right edge of a collapsed row: what is going on, or how long ago you
/// were last here when nothing is.
function StatusSummary({ status, ago }: { status: PlaceStatus; ago: string }) {
  if (status.running === 0 && status.needsYou === 0) {
    return <span className="text-[10px] tabular-nums text-ink-faint">{ago}</span>;
  }
  return (
    <>
      {status.needsYou > 0 && (
        <span
          className="flex items-center gap-1 text-[10px] tabular-nums text-amber-600 dark:text-amber-300"
          title={`${status.needsYou} waiting on you`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {status.needsYou}
        </span>
      )}
      {status.running > 0 && (
        <span
          className="flex items-center gap-1 text-[10px] tabular-nums text-emerald-600 dark:text-emerald-300"
          title={`${status.running} running`}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: RUNNING_MARKER_COLOR }} />
          {status.running}
        </span>
      )}
    </>
  );
}

// ---- a place's contents ---------------------------------------------------

/// What an opened place shows: what needs you, what is running, the last few
/// conversations — and one count line for each pile of everything else.
export function PlaceBody({
  path,
  conversations,
  colosseums,
  project,
  selectedId,
  onSelect,
  onNewConversation,
  children,
}: {
  path: string;
  conversations: readonly Conversation[];
  colosseums: Colosseum[];
  /// Set for a project: colosseum contenders are looked up in its list.
  project?: Project;
  selectedId: UUID | null;
  onSelect: (id: UUID) => void;
  onNewConversation: () => void;
  /// Rendered last — a workspace's member projects.
  children?: ReactNode;
}) {
  const runners = useRunningMap();
  const allRuns = useFlowsStore((s) => s.runs);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const [now] = useState(() => Date.now());

  const parts = useMemo(() => {
    const plain: Conversation[] = [];
    const agents: Conversation[] = [];
    for (const c of conversations) {
      if (c.hidden) continue;
      if (!isAgentConversation(c)) plain.push(c);
      else if (!c.colosseumId && !c.workspaceAgentCoordinatorId) agents.push(c);
    }
    const isRunning = (c: Conversation) => runners[c.id]?.isRunning ?? false;
    const runs = flowRunsForPath(allRuns, path, '');
    const liveRuns = runs.filter((r) => runIsLive(r, runners));
    const waiting = runs.filter(
      (r) => !runIsLive(r, runners) && r.state.kind === 'paused' && flowRunActivityAt(r) > now - WAITING_RUN_WINDOW_MS,
    );
    const settled = runs.filter((r) => !liveRuns.includes(r) && !waiting.includes(r));
    const quietPlain = byNewestFirst(plain.filter((c) => !isRunning(c)));
    const sleepFacts = (c: Conversation) => ({
      touchedAt: conversationActivityAt(c),
      pinned: c.id === selectedId,
    });
    const sleep = partitionSleeping(quietPlain, sleepFacts);
    // Agents sleep the same way, minus the floor: one worked on recently (or
    // the one on screen) sits with Recent instead of vanishing into the
    // count line, but a quiet place isn't backfilled with old agents.
    const agentSleep = partitionSleeping(byNewestFirst(agents.filter((c) => !isRunning(c))), sleepFacts, { floor: 0 });
    return {
      waiting,
      runningConvs: byNewestFirst([...plain, ...agents].filter(isRunning)),
      liveRuns,
      recent: byNewestFirst([...sleep.awake, ...agentSleep.awake]),
      older: sleep.sleeping,
      idleAgents: agentSleep.sleeping,
      settled,
    };
  }, [conversations, runners, allRuns, path, selectedId, now]);

  const hasLive = parts.waiting.length + parts.runningConvs.length + parts.liveRuns.length > 0;
  const empty =
    !hasLive &&
    parts.recent.length + parts.older.length + parts.idleAgents.length + parts.settled.length + colosseums.length === 0;
  const convRow = (c: Conversation) => (
    <ConversationRow key={c.id} conv={c} selected={c.id === selectedId} onClick={() => onSelect(c.id)} />
  );
  const runRow = (r: FlowRun) => (
    <FlowRunRow key={r.id} run={r} selected={r.id === activeRunId} isLive={runIsLive(r, runners)} />
  );

  return (
    <div className="ml-[13px] border-l border-card pl-1.5">
      {empty && (
        <button
          onClick={onNewConversation}
          className="w-full rounded px-2 py-1 text-left text-[11px] text-ink-faint hover:bg-card-strong hover:text-ink"
        >
          Nothing here yet — start a conversation
        </button>
      )}
      {parts.waiting.length > 0 && (
        <>
          <BodyHeading tone="amber">Needs you · {parts.waiting.length}</BodyHeading>
          {parts.waiting.map(runRow)}
        </>
      )}
      {parts.runningConvs.length + parts.liveRuns.length > 0 && (
        <>
          <BodyHeading tone="green">Running · {parts.runningConvs.length + parts.liveRuns.length}</BodyHeading>
          {parts.runningConvs.map(convRow)}
          {parts.liveRuns.map(runRow)}
        </>
      )}
      {parts.recent.length > 0 && (
        <>
          {hasLive && <BodyHeading>Recent</BodyHeading>}
          {parts.recent.map(convRow)}
        </>
      )}
      <Fold label={`${parts.older.length} older conversation${parts.older.length === 1 ? '' : 's'}`} count={parts.older.length}>
        {parts.older.map(convRow)}
      </Fold>
      <Fold label={`${parts.idleAgents.length} agent${parts.idleAgents.length === 1 ? '' : 's'}`} count={parts.idleAgents.length}>
        {parts.idleAgents.map(convRow)}
      </Fold>
      {project && (
        <Fold label={`${colosseums.length} colosseum${colosseums.length === 1 ? '' : 's'}`} count={colosseums.length}>
          {colosseums.map((c) => (
            <ColosseumSidebarGroup key={c.id} colosseum={c} project={project} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </Fold>
      )}
      <Fold label={`${parts.settled.length} flow run${parts.settled.length === 1 ? '' : 's'}`} count={parts.settled.length}>
        {parts.settled.map(runRow)}
      </Fold>
      {children}
    </div>
  );
}

function BodyHeading({ children, tone }: { children: ReactNode; tone?: 'amber' | 'green' }) {
  const color =
    tone === 'amber'
      ? 'text-amber-600 dark:text-amber-300'
      : tone === 'green'
        ? 'text-emerald-600 dark:text-emerald-300'
        : 'text-ink-faint';
  return <div className={'px-2 pb-0.5 pt-1.5 text-[10px] font-medium ' + color}>{children}</div>;
}

/// One count line standing in for a pile of rows, opened on click.
function Fold({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] text-ink-faint hover:bg-card-strong hover:text-ink-muted"
      >
        <Chevron open={open} />
        <span className="truncate">{label}</span>
      </button>
      {open && children}
    </>
  );
}

// ---- project and workspace ------------------------------------------------

interface PlaceCommon {
  expanded: boolean;
  onToggle: () => void;
  status: PlaceStatus;
  activityAt: number;
  now: number;
  pinned: boolean;
  onTogglePin: () => void;
  onMovePin?: (direction: -1 | 1) => void;
  selectedId: UUID | null;
  onSelect: (id: UUID) => void;
  nested?: boolean;
}

export function ProjectPlace({
  project,
  colosseums,
  ...common
}: PlaceCommon & { project: Project; colosseums: Colosseum[] }) {
  const openSheet = useStore((s) => s.openSheet);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const openExplorer = useStore((s) => s.openExplorer);
  const removeProject = useStore((s) => s.removeProject);
  const workspaces = useStore((s) => s.workspaces);
  const isGitRepo = useStore((s) => s.projectIsGitRepo[project.id]);
  const compareOn = useStore((s) => labOn(s.settings.labs, 'compare'));
  const workerLive = useWorkerLive(project.path);
  const everyday = isEverydayProject(project);
  const ref: PlaceRef = { kind: 'project', project };
  const current = !!common.selectedId && project.conversations.some((c) => c.id === common.selectedId);
  const archivable = project.conversations.some((c) => !c.hidden);

  const workspaceRefs = workspaces.filter((w) => w.projectIds.includes(project.id));
  const removeDetails = [
    project.conversations.length
      ? `${project.conversations.length} conversation${project.conversations.length === 1 ? '' : 's'} and agents will be removed.`
      : '',
    colosseums.length ? `${colosseums.length} colosseum${colosseums.length === 1 ? '' : 's'} will be removed.` : '',
    workspaceRefs.length ? `${workspaceRefs.length} workspace${workspaceRefs.length === 1 ? '' : 's'} will be updated.` : '',
  ].filter(Boolean);

  return (
    <div>
      <PlaceRow
        ref_={ref}
        kind={placeKind(ref, isGitRepo)}
        expanded={common.expanded}
        onToggle={common.onToggle}
        status={common.status}
        activityAt={common.activityAt}
        now={common.now}
        pinned={common.pinned}
        onTogglePin={common.onTogglePin}
        onMovePin={common.onMovePin}
        current={current && !common.expanded}
        workerLive={workerLive}
        nested={common.nested}
        removeTitle={`Remove ${placeName(ref)} from Overcli?`}
        removeBody="This keeps the folder on disk, but removes it from the app."
        removeDetails={removeDetails}
        actions={{
          onNewConversation: () => startNewConversation(project.id),
          onNewAgent: isGitRepo !== false ? () => openSheet({ type: 'newAgent', projectId: project.id }) : undefined,
          onNewColosseum:
            isGitRepo !== false && compareOn ? () => openSheet({ type: 'newColosseum', projectId: project.id }) : undefined,
          onExplore: () => openExplorer(project.path),
          onDocuments:
            everyday || isGitRepo === false
              ? {
                  label: everyday ? 'Show as files…' : 'Show as documents…',
                  run: () => openSheet({ type: 'everydayConversion', projectId: project.id }),
                }
              : undefined,
          onArchiveAll: archivable ? () => openSheet({ type: 'archiveAllInProject', projectId: project.id }) : undefined,
          onRemove: () => void removeProject(project.id),
        }}
      />
      {common.expanded && (
        <PlaceBody
          path={project.path}
          conversations={project.conversations}
          colosseums={colosseums}
          project={project}
          selectedId={common.selectedId}
          onSelect={common.onSelect}
          onNewConversation={() => startNewConversation(project.id)}
        />
      )}
    </div>
  );
}

export function WorkspacePlace({
  workspace,
  members,
  renderMember,
  memberIsActive,
  ...common
}: PlaceCommon & {
  workspace: Workspace;
  members: Project[];
  renderMember: (project: Project) => ReactNode;
  /// Whether a member earns a row of its own when the workspace is open —
  /// the top level's rule, applied one level down. The rest fold.
  memberIsActive: (project: Project) => boolean;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const startNewConversationInWorkspace = useStore((s) => s.startNewConversationInWorkspace);
  const openExplorer = useStore((s) => s.openExplorer);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const workerLive = useWorkerLive(workspace.rootPath);
  const ref: PlaceRef = { kind: 'workspace', workspace, members };
  const convs = workspace.conversations ?? [];
  const current =
    !!common.selectedId &&
    (convs.some((c) => c.id === common.selectedId) ||
      members.some((m) => m.conversations.some((c) => c.id === common.selectedId)));

  return (
    <div>
      <PlaceRow
        ref_={ref}
        kind="workspace"
        expanded={common.expanded}
        onToggle={common.onToggle}
        status={common.status}
        activityAt={common.activityAt}
        now={common.now}
        pinned={common.pinned}
        onTogglePin={common.onTogglePin}
        onMovePin={common.onMovePin}
        current={current && !common.expanded}
        workerLive={workerLive}
        nested={common.nested}
        removeTitle={`Remove ${workspace.name} from Overcli?`}
        removeBody="This removes the workspace and its own conversations. Member repos stay on disk and in the app."
        removeDetails={[
          convs.length ? `${convs.length} workspace conversation${convs.length === 1 ? '' : 's'} will be removed.` : '',
          members.length ? `${members.length} member project${members.length === 1 ? '' : 's'} will stay available.` : '',
        ].filter(Boolean)}
        actions={{
          onNewConversation: () => startNewConversationInWorkspace(workspace.id),
          onNewAgent: () => openSheet({ type: 'newWorkspaceAgent', workspaceId: workspace.id }),
          onExplore: workspace.rootPath ? () => openExplorer(workspace.rootPath) : undefined,
          onEdit: () => openSheet({ type: 'editWorkspace', workspaceId: workspace.id }),
          onArchiveAll: convs.some((c) => !c.hidden)
            ? () => openSheet({ type: 'archiveAllInWorkspace', workspaceId: workspace.id })
            : undefined,
          onRemove: () => void removeWorkspace(workspace.id),
        }}
      />
      {common.expanded && (
        <PlaceBody
          path={workspace.rootPath}
          conversations={convs}
          colosseums={[]}
          selectedId={common.selectedId}
          onSelect={common.onSelect}
          onNewConversation={() => startNewConversationInWorkspace(workspace.id)}
        >
          {members.length > 0 && (
            <MemberList members={members} renderMember={renderMember} isActive={memberIsActive} />
          )}
        </PlaceBody>
      )}
    </div>
  );
}

/// A workspace's member repos: the ones in use as rows, the rest behind one
/// count line — twenty-six repos listed flat under a workspace is the same
/// wall of rows the top level folds away.
function MemberList({
  members,
  renderMember,
  isActive,
}: {
  members: Project[];
  renderMember: (project: Project) => ReactNode;
  isActive: (project: Project) => boolean;
}) {
  const active = members.filter(isActive);
  const quiet = members.filter((m) => !isActive(m));
  return (
    <>
      <BodyHeading>Projects · {members.length}</BodyHeading>
      {active.map(renderMember)}
      <Fold
        label={`${quiet.length} ${active.length > 0 ? 'more ' : ''}project${quiet.length === 1 ? '' : 's'}`}
        count={quiet.length}
      >
        {quiet.map(renderMember)}
      </Fold>
    </>
  );
}

function useWorkerLive(path: string): boolean {
  const runners = useRunningMap();
  const workers = useWorkersStore((s) => s.workers);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const flowRuns = useFlowsStore((s) => s.runs);
  return useMemo(
    () => anyDeskLive(workersForPath(workers, path), flowRuns, orchestrations, runners, shiftProgress),
    [flowRuns, orchestrations, path, runners, shiftProgress, workers],
  );
}

// ---- menus ----------------------------------------------------------------

export interface MenuItemDef {
  /// On a divider, a non-empty label turns the rule into a group caption.
  label: string;
  hint?: string;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

/// The "Starred flows" group of a place's New menu: up to three starred flows
/// that can run here, each opening the launcher aimed at this place, then a
/// way into the whole library. With nothing starred it's one line, so the
/// menu still says flows exist and how to put one here.
function usePlaceFlowItems(ref_: PlaceRef, open: boolean): MenuItemDef[] {
  const flows = useFlowsStore((s) => s.flows);
  const loaded = useFlowsStore((s) => s.loaded);
  const reload = useFlowsStore((s) => s.reload);
  const projects = useStore((s) => s.projects);
  const starred = useStore((s) => s.settings.starredFlows);
  const openSheet = useStore((s) => s.openSheet);
  const setDetailMode = useStore((s) => s.setDetailMode);

  // The library loads when something shows it; a sidebar menu may be first.
  useEffect(() => {
    if (open && !loaded) void reload(projects.map((p) => p.path));
  }, [open, loaded]);

  const target = ref_.kind === 'project' ? `project:${ref_.project.path}` : `workspace:${ref_.workspace.rootPath}`;
  const shown = useMemo(
    () =>
      starredFlowsForPlace(flows, starred ?? [], {
        folders:
          ref_.kind === 'project'
            ? [ref_.project.path]
            : [ref_.workspace.rootPath, ...ref_.members.map((m) => m.path)],
        everyday: ref_.kind === 'project' && isEverydayProject(ref_.project),
      }),
    [flows, starred, ref_],
  );

  const openLibrary = () => setDetailMode('flows');
  if (shown.length === 0) {
    return [
      { divider: true, label: '', onSelect: () => {} },
      { label: 'Run a flow…', hint: 'Star one in the library to keep it here', icon: <FlowIcon />, onSelect: openLibrary },
    ];
  }
  return [
    { divider: true, label: 'Starred flows', onSelect: () => {} },
    ...shown.map((f) => ({
      label: `${f.name}…`,
      hint: f.description || undefined,
      icon: <FlowIcon />,
      onSelect: () => openSheet({ type: 'flowLaunch', flowId: f.id, target }),
    })),
    { label: 'All flows…', hint: 'Open the library', onSelect: openLibrary },
  ];
}

/// The last two segments of a path, for telling apart two places with the
/// same name ("codelions/overcli" vs "forks/overcli").
function pathTail(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join('/') : undefined;
}

/// A small menu anchored to a button. Portalled and fixed-positioned, so the
/// sidebar's scroll box can't clip it; flips above the anchor when there is no
/// room below. Escape, a click elsewhere or a scroll closes it.
///
/// `beside` opens it past the sidebar's right edge, level with the anchor's
/// row, instead of dropping it over the rows underneath — for a row menu,
/// where the tree you're acting on is the context you want to keep seeing.
/// Falls back to dropping down when the window is too narrow for it.
///
/// `at` opens it at a point instead (a right-click); `anchor` then only
/// matters as where focus goes back to.
///
/// Keyboard: the first item takes focus on open, ↑/↓/Home/End move, a letter
/// jumps to the next item starting with it, Enter picks, Tab or Escape closes
/// (Escape hands focus back to the anchor). Hovering moves focus too, so the
/// pointer and the keyboard never highlight two different items.
export function PopMenu({
  anchor,
  items,
  heading,
  headingDetail,
  onClose,
  beside,
  at,
  width = 260,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  items: MenuItemDef[];
  heading?: string;
  headingDetail?: string;
  onClose: () => void;
  beside?: boolean;
  at?: { x: number; y: number };
  width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    if (at) {
      setPos({
        left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
        top: at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y,
      });
      return;
    }
    const el = anchor.current;
    const a = el?.getBoundingClientRect();
    if (!el || !a) return;
    const edge = beside ? el.closest('aside')?.getBoundingClientRect().right : undefined;
    if (edge !== undefined && edge + 6 + width <= window.innerWidth - 8) {
      // Line the first item up with the row: the heading sits above it.
      const top = Math.max(8, Math.min(a.top - 32, window.innerHeight - h - 8));
      setPos({ top, left: edge + 6 });
      return;
    }
    const left = Math.max(8, Math.min(a.right - width, window.innerWidth - width - 8));
    const below = a.bottom + 4;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, a.top - h - 4) : below;
    setPos({ top, left });
  }, [anchor, at, beside, width]);

  // Position lands before first paint, so the fade needs a frame of its own
  // to have something to fade from.
  useEffect(() => {
    if (!pos) return;
    const f = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(f);
  }, [pos]);

  // Once any item has an icon, the rest keep its gutter so labels line up.
  const hasIcons = items.some((i) => i.icon);

  const menuItems = () =>
    Array.from(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (pos) menuItems()[0]?.focus({ preventScroll: true });
  }, [pos]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const all = menuItems();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      all[(i + all.length) % all.length].focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? all.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      for (let step = 1; step <= all.length; step++) {
        const i = (at + step + all.length) % all.length;
        if (all[i].dataset.label?.toLowerCase().startsWith(k)) return go(i);
      }
    }
    else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
      anchor.current?.focus();
    }
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={heading}
      onKeyDown={onMenuKey}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      className={
        'z-50 rounded-lg border border-card-strong bg-surface-elevated p-1 text-[13px] shadow-2xl transition-[opacity,transform] duration-100 ease-out ' +
        (shown ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.98]') +
        (beside ? ' origin-top-left' : ' origin-top-right')
      }
    >
      {heading && (
        <div className="flex min-w-0 items-baseline gap-1.5 px-2.5 pb-1.5 pt-1.5 text-[11px]">
          <span className="flex-shrink-0 font-medium text-ink-muted">{heading}</span>
          {headingDetail && <span className="truncate text-ink-faint">{headingDetail}</span>}
        </div>
      )}
      {items.map((item, i) =>
        item.divider ? (
          item.label ? (
            <div key={`d${i}`} className="mx-1.5 mt-1 border-t border-card-strong px-1 pb-0.5 pt-2 text-[11px] font-medium text-ink-faint">
              {item.label}
            </div>
          ) : (
            <div key={`d${i}`} className="mx-1.5 my-1 h-px bg-card-strong" />
          )
        ) : (
          <button
            key={`${i}:${item.label}`}
            role="menuitem"
            data-label={item.label}
            disabled={item.disabled}
            onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={
              'flex w-full items-start gap-2.5 rounded-md px-2.5 text-left hover:bg-card-strong focus:bg-card-strong focus:outline-none disabled:opacity-40 ' +
              (item.hint ? 'py-2 ' : 'py-1.5 ') +
              (item.danger ? 'text-red-600 dark:text-red-300' : 'text-ink')
            }
          >
            {(item.icon || hasIcons) && (
              <span className="mt-px flex h-4 w-4 flex-shrink-0 items-center justify-center text-accent">{item.icon}</span>
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="mt-0.5 truncate text-[11px] text-ink-faint">{item.hint}</span>}
            </span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---- pieces moved from the old tree --------------------------------------

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
      <div className={'group flex items-center gap-1 rounded pr-1 ' + (containsSelected ? 'bg-accent/10' : 'hover:bg-card-strong')}>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-2 py-1 text-[9px] text-ink-faint"
          aria-label={expanded ? 'Collapse colosseum' : 'Expand colosseum'}
        >
          <span className={expanded ? 'rotate-90 inline-block transition-transform' : 'inline-block transition-transform'}>▸</span>
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
                <SidebarMarker color={backendColor(conv.primaryBackend)} active={isRunning} completed={completed} />
                <span className="truncate flex-1">
                  {conv.primaryBackend}
                  {conv.currentModel ? ` · ${conv.currentModel}` : ''}
                </span>
                {isWinner ? (
                  <span className="text-amber-700 dark:text-amber-300/80">
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
              details={[`${contenders.length} contender${contenders.length === 1 ? '' : 's'} will be removed.`]}
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

function effectiveColosseumStatus(colosseum: Colosseum, runners: Runners): Colosseum['status'] {
  if (colosseum.status === 'cancelled' || colosseum.status === 'merged') return colosseum.status;
  return colosseum.contenderIds.some((cid) => runners[cid]?.isRunning) ? 'running' : 'comparing';
}

export function RunningIndicator({ active = true, activityLabel }: { active?: boolean; activityLabel?: string }) {
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

function ColosseumStatusBadge({ status, activityLabel }: { status: Colosseum['status']; activityLabel?: string }) {
  if (status === 'running') return <RunningIndicator activityLabel={activityLabel ?? 'Colosseum running'} />;
  if (status === 'merged') return <span className="text-[10px] text-green-400" title="Colosseum merged">✓</span>;
  if (status === 'cancelled') return <span className="text-[10px] text-ink-faint" title="Colosseum cancelled">×</span>;
  return <span className="text-[10px] text-sky-300" title="Colosseum comparing">⇄</span>;
}

export function InlineRemoveConfirm({
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

// ---- icons ----------------------------------------------------------------

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      className={'flex-shrink-0 text-ink-faint transition-transform ' + (open ? 'rotate-90' : '')}
      aria-hidden
    >
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/// Repo, documents, plain folder or workspace — told apart by shape first and
/// colour second, so the difference survives either theme.
export function KindIcon({ kind, size = 13 }: { kind: PlaceKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'workspace') {
    return (
      <svg {...common} className="flex-shrink-0 text-violet-600 dark:text-violet-300">
        <path d="M12 3l9 5-9 5-9-5z" />
        <path d="M3 13l9 5 9-5" />
      </svg>
    );
  }
  if (kind === 'documents') {
    return (
      <svg {...common} className="flex-shrink-0 text-amber-600 dark:text-amber-300/90">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    );
  }
  if (kind === 'folder') {
    return (
      <svg {...common} className="flex-shrink-0 text-ink-muted">
        <path d="M3 6h7l2 2h9v11H3z" />
      </svg>
    );
  }
  return (
    <svg {...common} className="flex-shrink-0 text-accent">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-6 3-11 6" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0" aria-hidden="true">
      <path d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11v7.5h-6.5l-3 2.5V11h-1.5z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-3 2.8-6.5 4" />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="3.5" cy="4" r="1.5" />
      <circle cx="12.5" cy="12" r="1.5" />
      <path d="M5 4h4.5a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-3a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2H11" />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="3" width="5" height="10" rx="1" />
      <rect x="9" y="3" width="5" height="10" rx="1" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-ink-muted flex-shrink-0" aria-hidden="true">
      <path d="M4 2.5h8v3.5a4 4 0 0 1-8 0V2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M4 3.5H2.5v1.5a2 2 0 0 0 2 2M12 3.5h1.5v1.5a2 2 0 0 1-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 10v2.5M5.5 13.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="flex-shrink-0" aria-hidden="true">
      <path d="M2 5.5l2 5h8l2-5-3 2-3-4-3 4-3-2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="currentColor" fillOpacity="0.2" />
      <path d="M4 12.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
