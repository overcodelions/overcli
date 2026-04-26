import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useAllRunners, useRunnerIsRunning } from '../runnersStore';
import { Colosseum, Conversation, Project, Workspace, UUID } from '@shared/types';
import { backendColor } from '../theme';

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const colosseums = useStore((s) => s.colosseums);
  const selectedId = useStore((s) => s.selectedConversationId);
  const selectConversation = useStore((s) => s.selectConversation);
  const pickProject = useStore((s) => s.pickProject);
  const openSheet = useStore((s) => s.openSheet);
  const removeProject = useStore((s) => s.removeProject);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const openExplorer = useStore((s) => s.openExplorer);
  const showDebug = useStore((s) => s.settings.showDebug ?? false);
  const [search, setSearch] = useState('');
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

  const query = search.trim().toLowerCase();

  const allGroupIds = useMemo(
    () => [...projects.map((p) => p.id), ...workspaces.map((w) => w.id)],
    [projects, workspaces],
  );
  const allCollapsed = allGroupIds.length > 0 && allGroupIds.every((id) => collapsed.has(id));
  const toggleAll = () => {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(allGroupIds));
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
      .filter((p) => p.name.toLowerCase().includes(query) || p.conversations.length > 0);
  }, [projects, query]);

  return (
    <aside className="h-full flex-shrink-0 flex flex-col bg-surface-muted border-r border-card min-w-0" style={{ width: '100%' }}>
      <div className="px-2 pt-2 pb-1 flex items-center gap-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          className="field flex-1 min-w-0 px-2 py-1 text-xs"
        />
        <button
          onClick={toggleAll}
          disabled={allGroupIds.length === 0}
          title={allCollapsed ? 'Expand all' : 'Collapse all'}
          aria-label={allCollapsed ? 'Expand all' : 'Collapse all'}
          className="p-1 rounded text-ink-faint hover:text-ink-muted hover:bg-card-strong disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
        >
          {allCollapsed ? <ExpandAllIcon /> : <CollapseAllIcon />}
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
        {visibleProjects.map((project) => (
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
          />
        ))}
        {workspaces.length > 0 && (
          <div className="mt-3 px-2 text-[10px] uppercase tracking-wide text-ink-faint">
            Workspaces
          </div>
        )}
        {workspaces.map((ws) => (
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
            onNewConversation={() => {
              // Open the composer-first welcome page for this workspace;
              // the conversation is materialized on first send so users
              // can pick model/mode/effort up front, same as projects.
              useStore.getState().startNewConversationInWorkspace(ws.id);
            }}
            onNewAgent={() =>
              openSheet({ type: 'newWorkspaceAgent', workspaceId: ws.id })
            }
            onEdit={() => openSheet({ type: 'editWorkspace', workspaceId: ws.id })}
            onRemove={() => void removeWorkspace(ws.id)}
            onExplore={ws.rootPath ? () => openExplorer(ws.rootPath!) : undefined}
          />
        ))}

        <ArchivedGroup />
      </nav>

      <div className="border-t border-card px-2 py-2 flex flex-col gap-1">
        <button
          onClick={pickProject}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card-strong text-left"
        >
          + Add project
        </button>
        <button
          onClick={() => openSheet({ type: 'newWorkspace' })}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card-strong text-left"
          disabled={projects.length === 0}
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
}) {
  const openSheet = useStore((s) => s.openSheet);
  const workspaces = useStore((s) => s.workspaces);
  const runners = useAllRunners();
  // `true`/`false` once probed, `undefined` while still unknown. Agents
  // depend on git worktrees, so we hide the "+ agent" affordance only
  // when we've confirmed the project isn't a git repo.
  const isGitRepo = useStore((s) => s.projectIsGitRepo[project.id]);
  const visible = project.conversations.filter(
    (c) => !isAgentConversation(c) && !c.hidden,
  );
  const agents = project.conversations.filter(
    (c) =>
      isAgentConversation(c) &&
      !c.hidden &&
      !c.colosseumId &&
      !c.workspaceAgentCoordinatorId,
  );
  const archivableCount = project.conversations.filter(
    (c) => !c.hidden && c.id !== selectedId && !(runners[c.id]?.isRunning ?? false),
  ).length;
  const workspaceRefs = workspaces.filter((w) => w.projectIds.includes(project.id));

  const handleRemove = () => {
    const colosseumCount = colosseums.length;
    const workspaceCount = workspaceRefs.length;
    const deletedWorkspaceCount = workspaceRefs.filter(
      (w) => w.projectIds.filter((pid) => pid !== project.id).length === 0,
    ).length;
    const message = [
      `Remove project "${project.name}" from overcli?`,
      'This keeps the repo on disk, but removes it from the app.',
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
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!window.confirm(message)) return;
    onRemove();
  };

  return (
    <div className="mt-1">
      <div className="group flex items-center px-2 py-1 rounded hover:bg-card-strong">
        <button onClick={toggle} className="flex items-center gap-1.5 flex-1 text-left min-w-0">
          <span className={'text-[9px] text-ink-faint ' + (expanded ? 'rotate-90' : '') + ' transition-transform flex-shrink-0'}>▸</span>
          <ProjectIcon />
          <span className="text-xs font-medium truncate">{project.name}</span>
        </button>
        <button
          onClick={onExplore}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
          title="Explore files"
          aria-label={`Explore files in ${project.name}`}
        >
          <SearchIcon />
        </button>
        <button
          onClick={onNewConversation}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
          title="New conversation"
          aria-label={`New conversation in ${project.name}`}
        >
          <PlusIcon />
        </button>
        <button
          onClick={handleRemove}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-red-300 hover:bg-card-strong"
          title="Remove project from overcli"
          aria-label={`Remove project ${project.name}`}
        >
          <TrashIcon />
        </button>
      </div>
      {expanded && (
        <div className="ml-4 border-l border-card pl-1">
          {visible.map((conv) => (
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
            {archivableCount > 0 && (
              <button
                onClick={() => openSheet({ type: 'archiveAllInProject', projectId: project.id })}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong ml-auto"
                title="Archive all inactive conversations in this project"
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
  const runners = useAllRunners();
  const [expanded, setExpanded] = useState(true);

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
                <SidebarMarker color={backendColor(conv.primaryBackend)} active={isRunning} />
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
              onClick={() => {
                if (!window.confirm(`Remove colosseum "${colosseum.name}" and all contender worktrees?`)) return;
                void removeColosseum(colosseum.id);
              }}
              className="text-[10px] text-ink-faint hover:text-red-400 py-0.5 px-1.5 rounded hover:bg-card-strong"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationRow({ conv, selected, onClick }: {
  conv: Conversation;
  selected: boolean;
  onClick: () => void;
}) {
  const bgColor = backendColor(conv.primaryBackend);
  const isRunning = useRunnerIsRunning(conv.id);
  const openSheet = useStore((s) => s.openSheet);
  const isAgent = isAgentConversation(conv);

  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSheet({ type: 'archiveConversation', convId: conv.id });
  };

  return (
    <div
      className={
        'sidebar-row group w-full rounded text-xs truncate flex items-center gap-1.5 pr-1 ' +
        (selected
          ? 'sidebar-row-selected text-ink'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card')
      }
      title={conv.name}
    >
      <button onClick={onClick} className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1">
        <SidebarMarker color={bgColor} active={isRunning} />
        {isAgent && <span className="text-[10px] text-ink-faint">⎇</span>}
        <span className={'truncate flex-1 ' + (selected ? 'font-medium' : '')}>{conv.name}</span>
      </button>
      <button
        onClick={onClose}
        className={
          'w-4 h-4 flex items-center justify-center text-[11px] text-ink-faint hover:text-red-400 rounded transition-opacity ' +
          (selected ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100')
        }
        title={isAgent ? 'Archive or delete agent…' : 'Archive or delete conversation…'}
      >
        ×
      </button>
    </div>
  );
}

/// Conversations in the store are plain objects, so we use a helper
/// rather than extending the type with methods. `continuedLocally`
/// coordinators still carry `workspaceAgentMemberIds` (we keep the
/// historical link), but the coordinator is no longer operating as an
/// agent so the sidebar should list it with the workspace's plain
/// chats, not under Agents.
export function isAgentConversation(c: Conversation): boolean {
  if (c.continuedLocally) return false;
  return !!c.worktreePath || (c.workspaceAgentMemberIds?.length ?? 0) > 0;
}

function effectiveColosseumStatus(
  colosseum: Colosseum,
  runners: Record<UUID, { isRunning: boolean } | undefined>,
): Colosseum['status'] {
  if (colosseum.status === 'cancelled' || colosseum.status === 'merged') return colosseum.status;
  return colosseum.contenderIds.some((cid) => runners[cid]?.isRunning) ? 'running' : 'comparing';
}

/// Theme-aware running pulse. Reads the CSS var so light mode uses a
/// darker green-600 while dark mode stays on green-400; the old hardcoded
/// #4ade80 washed to near-white against the light surface and the pulse
/// was barely visible.
const RUNNING_MARKER_COLOR = 'var(--c-running-pulse)';

function SidebarMarker({ color, active }: { color: string; active: boolean }) {
  const pingStyle = useMemo(() => synchronizedAnimationStyle(1200), []);
  const markerColor = active ? RUNNING_MARKER_COLOR : color;

  if (!active) {
    return <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: markerColor }} />;
  }

  return (
    <span className="relative flex h-2.5 w-2.5 flex-shrink-0 items-center justify-center pointer-events-none">
      <span
        className="absolute inline-flex h-full w-full rounded-full animate-ping"
        style={{ ...pingStyle, background: markerColor, opacity: 0.45 }}
      />
      <span
        className="absolute inline-flex h-full w-full rounded-full"
        style={{ background: markerColor, opacity: 0.22 }}
      />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: markerColor }} />
    </span>
  );
}

function synchronizedAnimationStyle(durationMs: number) {
  const phase = Date.now() % durationMs;
  return {
    animationDelay: `${-phase}ms`,
    animationDuration: `${durationMs}ms`,
  };
}

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
}) {
  const convs = (workspace.conversations ?? []).filter((c) => !c.hidden);
  const plain = convs.filter((c) => !isAgentConversation(c));
  const agents = convs.filter(isAgentConversation);
  const openSheet = useStore((s) => s.openSheet);
  const runners = useAllRunners();
  const archivableCount = (workspace.conversations ?? []).filter(
    (c) => !c.hidden && c.id !== selectedId && !(runners[c.id]?.isRunning ?? false),
  ).length;

  const handleRemove = () => {
    const message = [
      `Remove workspace "${workspace.name}" from overcli?`,
      'This removes the synthetic workspace and its conversations, but keeps member repos on disk and in the app.',
      convs.length
        ? `${convs.length} workspace conversation${convs.length === 1 ? '' : 's'} will be removed.`
        : 'This workspace has no conversations yet.',
      workspace.projectIds.length
        ? `${workspace.projectIds.length} member project${workspace.projectIds.length === 1 ? '' : 's'} will stay available individually.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!window.confirm(message)) return;
    onRemove();
  };

  return (
    <div className="mt-1">
      <div className="group flex items-center px-2 py-1 rounded hover:bg-card-strong">
        <button onClick={toggle} className="flex items-center gap-1.5 flex-1 text-left min-w-0">
          <span className={'text-[9px] text-ink-faint ' + (expanded ? 'rotate-90' : '') + ' transition-transform flex-shrink-0'}>▸</span>
          <WorkspaceIcon />
          <span className="text-xs font-medium truncate">{workspace.name}</span>
        </button>
        <button
          onClick={onEdit}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-muted opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
          title="Edit workspace member projects"
          aria-label={`Edit workspace ${workspace.name}`}
        >
          <PencilIcon />
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
          onClick={onNewConversation}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-ink hover:bg-card-strong"
          title="New conversation"
          aria-label={`New conversation in ${workspace.name}`}
        >
          <PlusIcon />
        </button>
        <button
          onClick={handleRemove}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-faint opacity-85 hover:opacity-100 hover:text-red-300 hover:bg-card-strong"
          title="Remove workspace from overcli"
          aria-label={`Remove workspace ${workspace.name}`}
        >
          <TrashIcon />
        </button>
      </div>
      {expanded && (
        <div className="ml-4 border-l border-card pl-1">
          {plain.length === 0 && agents.length === 0 && (
            <div className="px-2 py-1 text-[10px] text-ink-faint">No conversations yet</div>
          )}
          {plain.map((conv) => (
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
          <div className="flex gap-1 my-1 pl-1">
            <button
              onClick={onNewAgent}
              className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong"
              title="New workspace agent (spans all member projects)"
            >
              + agent
            </button>
            {archivableCount > 0 && (
              <button
                onClick={() => openSheet({ type: 'archiveAllInWorkspace', workspaceId: workspace.id })}
                className="text-[10px] text-ink-faint hover:text-ink py-0.5 px-1.5 rounded hover:bg-card-strong ml-auto"
                title="Archive all inactive conversations in this workspace"
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
        if (c.hidden) out.push({ conv: c, owner: p.name, ownerIcon: 'project' });
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
