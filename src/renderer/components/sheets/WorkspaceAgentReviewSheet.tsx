// Per-project review sheet for a workspace-agent coordinator. Each card
// is one member conversation (one project's worktree); users can
// independently View Diff, Merge, Push or Open PR for each project.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { Conversation, UUID, WorktreeStatus } from '@shared/types';
import { agentDescription, lastAssistantText } from '../../diff-utils';

interface MemberView {
  member: Conversation;
  projectId: UUID;
  projectName: string;
  projectPath: string;
  status: WorktreeStatus | null;
  loading: boolean;
}

export function WorkspaceAgentReviewSheet({ coordinatorId }: { coordinatorId: UUID }) {
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const runners = useStore((s) => s.runners);
  const openSheet = useStore((s) => s.openSheet);

  const coordinator = useMemo<Conversation | null>(() => {
    for (const ws of workspaces) {
      const c = (ws.conversations ?? []).find((x) => x.id === coordinatorId);
      if (c) return c;
    }
    return null;
  }, [workspaces, coordinatorId]);

  const memberIds = coordinator?.workspaceAgentMemberIds ?? [];

  const [memberStatuses, setMemberStatuses] = useState<Record<UUID, WorktreeStatus | null>>({});
  const [loadingIds, setLoadingIds] = useState<Set<UUID>>(new Set(memberIds));
  const [workingId, setWorkingId] = useState<UUID | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Resolve member → owning project so we can run git from the right cwd.
  const members = useMemo<MemberView[]>(() => {
    const out: MemberView[] = [];
    for (const id of memberIds) {
      for (const p of projects) {
        const match = p.conversations.find((c) => c.id === id);
        if (match) {
          out.push({
            member: match,
            projectId: p.id,
            projectName: p.name,
            projectPath: p.path,
            status: memberStatuses[id] ?? null,
            loading: loadingIds.has(id),
          });
          break;
        }
      }
    }
    return out;
  }, [memberIds, projects, memberStatuses, loadingIds]);

  const refreshAll = async () => {
    if (!members.length) return;
    setLoadingIds(new Set(members.map((m) => m.member.id)));
    const entries = await Promise.all(
      members.map(async (m) => {
        if (!m.member.worktreePath || !m.member.branchName || !m.member.baseBranch) {
          return [m.member.id, null] as const;
        }
        const stat = await window.overcli.invoke('git:worktreeStatus', {
          projectPath: m.projectPath,
          worktreePath: m.member.worktreePath,
          branchName: m.member.branchName,
          baseBranch: m.member.baseBranch,
        });
        return [m.member.id, stat] as const;
      }),
    );
    const next: Record<UUID, WorktreeStatus | null> = {};
    for (const [id, status] of entries) next[id] = status;
    setMemberStatuses(next);
    setLoadingIds(new Set());
  };

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinatorId, memberIds.join(',')]);

  if (!coordinator) return null;

  const descriptionFor = (member: Conversation) => {
    // Use the coordinator's conversation name + its last assistant text
    // so every project's commit / PR gets the same narrative.
    return agentDescription(
      coordinator.name,
      lastAssistantText(runners[coordinator.id]),
      member.branchName ?? coordinator.branchName ?? '?',
    );
  };

  const runMerge = async (view: MemberView) => {
    const { member, projectPath } = view;
    if (!member.worktreePath || !member.branchName || !member.baseBranch) return;
    const target = member.baseBranch;
    if (!window.confirm(`Merge ${member.branchName} into ${target} in ${view.projectName}?`))
      return;
    setWorkingId(member.id);
    setActionMessage(null);
    setActionError(null);
    const desc = descriptionFor(member);
    const res = await window.overcli.invoke('git:mergeAgent', {
      projectPath,
      worktreePath: member.worktreePath,
      branchName: member.branchName,
      target,
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) setActionMessage(`${view.projectName}: ${res.message}`);
    else setActionError(`${view.projectName}: ${res.error}`);
    setWorkingId(null);
    await refreshAll();
  };

  const runPush = async (view: MemberView) => {
    const { member } = view;
    if (!member.worktreePath || !member.branchName) return;
    setWorkingId(member.id);
    setActionMessage(null);
    setActionError(null);
    const desc = descriptionFor(member);
    const res = await window.overcli.invoke('git:pushBranch', {
      worktreePath: member.worktreePath,
      branchName: member.branchName,
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) setActionMessage(`${view.projectName}: ${res.message}`);
    else setActionError(`${view.projectName}: ${res.error}`);
    setWorkingId(null);
    await refreshAll();
  };

  const runOpenPR = async (view: MemberView) => {
    const { member } = view;
    if (!member.worktreePath || !member.branchName || !member.baseBranch) return;
    setWorkingId(member.id);
    setActionMessage(null);
    setActionError(null);
    const desc = descriptionFor(member);
    const body =
      (desc.body ?? '') +
      `\n\n—\nOpened from Overcli workspace agent · \`${member.branchName}\` → \`${member.baseBranch}\` in ${view.projectName}`;
    const res = await window.overcli.invoke('git:openPR', {
      worktreePath: member.worktreePath,
      branchName: member.branchName,
      baseBranch: member.baseBranch,
      title: `${desc.subject} · ${view.projectName}`,
      body: body.trim(),
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) setActionMessage(`${view.projectName}: ${res.message}`);
    else setActionError(`${view.projectName}: ${res.error}`);
    setWorkingId(null);
  };

  const runRescue = async (view: MemberView) => {
    const { member, projectPath } = view;
    if (!member.worktreePath || !member.branchName) return;
    setWorkingId(member.id);
    setActionMessage(null);
    setActionError(null);
    const res = await window.overcli.invoke('git:rescueMainTree', {
      projectPath,
      worktreePath: member.worktreePath,
      branchName: member.branchName,
    });
    if (res.ok) setActionMessage(`${view.projectName}: ${res.message}`);
    else setActionError(`${view.projectName}: ${res.error}`);
    setWorkingId(null);
    await refreshAll();
  };

  const branchName = coordinator.branchName ?? 'agent/?';

  return (
    <div className="flex flex-col max-h-[85vh] h-[85vh]">
      <div className="px-5 pt-4 pb-3 border-b border-white/5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold truncate">{coordinator.name}</div>
          <div className="text-xs text-ink-faint truncate">
            Review each project and merge independently · {branchName}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button
            onClick={() => void refreshAll()}
            disabled={loadingIds.size > 0 || workingId != null}
            className="text-xs px-2 py-1 rounded bg-accent/5 text-ink-muted hover:text-ink hover:bg-accent/10 border border-accent/30 disabled:opacity-40"
          >
            Refresh
          </button>
          <button
            onClick={() => openSheet(null)}
            className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5"
          >
            Close
          </button>
        </div>
      </div>

      {(actionMessage || actionError) && (
        <div
          className={
            'px-4 py-2 text-xs border-b ' +
            (actionError
              ? 'text-red-300 bg-red-500/10 border-red-500/30'
              : 'text-green-300 bg-green-500/10 border-green-500/30')
          }
        >
          {actionError ?? actionMessage}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {members.length === 0 && (
          <div className="text-center text-xs text-ink-faint py-8">
            No participating projects found for this workspace agent.
          </div>
        )}
        {members.map((view) => (
          <MemberCard
            key={view.member.id}
            view={view}
            busy={workingId === view.member.id}
            busyGlobal={workingId != null}
            onViewDiff={() => openSheet({ type: 'worktreeDiff', convId: view.member.id })}
            onMerge={() => void runMerge(view)}
            onPush={() => void runPush(view)}
            onOpenPR={() => void runOpenPR(view)}
            onRescue={() => void runRescue(view)}
            onReveal={() => {
              if (view.member.worktreePath)
                void window.overcli.invoke('fs:openInFinder', view.member.worktreePath);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MemberCard({
  view,
  busy,
  busyGlobal,
  onViewDiff,
  onMerge,
  onPush,
  onOpenPR,
  onRescue,
  onReveal,
}: {
  view: MemberView;
  busy: boolean;
  busyGlobal: boolean;
  onViewDiff: () => void;
  onMerge: () => void;
  onPush: () => void;
  onOpenPR: () => void;
  onRescue: () => void;
  onReveal: () => void;
}) {
  const { member, status } = view;
  const label = statusLabel(status);
  const tone = statusTone(status);
  const filesChanged = status?.filesChanged ?? 0;
  const hasWork =
    status != null &&
    (status.filesChanged > 0 || status.commitsAhead > 0 || status.hasUncommittedChanges);
  const kind = status?.remoteKind ?? 'none';
  const canMerge =
    status != null && !status.isMergedIntoBase && (hasWork || status.commitsAhead > 0);
  const canPush = status != null && kind !== 'none' && (hasWork || status.commitsAhead > 0);

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start gap-2">
        <span
          className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
          style={{ background: tone }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{view.projectName}</div>
          <div className="text-[11px] text-ink-faint truncate">{label}</div>
          <div className="text-[10px] text-ink-faint truncate mt-0.5">
            {member.branchName} · {member.worktreePath}
          </div>
        </div>
        <div className="text-xs text-right space-y-0.5">
          {filesChanged > 0 && (
            <div className="text-ink-muted">
              {filesChanged} file{filesChanged === 1 ? '' : 's'}
            </div>
          )}
          {status && (status.insertions > 0 || status.deletions > 0) && (
            <div>
              <span className="text-green-400">+{status.insertions}</span>{' '}
              <span className="text-red-400">−{status.deletions}</span>
            </div>
          )}
          {status && status.commitsAhead > 0 && (
            <div className="text-[10px] text-ink-faint">
              {status.commitsAhead} commit{status.commitsAhead === 1 ? '' : 's'} ahead
            </div>
          )}
        </div>
      </div>

      {status && status.mainTreeDirtyFiles > 0 && (
        <div className="mt-2 rounded p-2 bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
          <div className="font-medium">Agent may have written to the main tree.</div>
          <div className="text-[10px] mt-0.5">
            {status.mainTreeDirtyFiles} dirty file
            {status.mainTreeDirtyFiles === 1 ? '' : 's'} in {view.projectPath}. Move them into the
            worktree so they land on {member.branchName}.
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <button
              onClick={onRescue}
              disabled={busyGlobal}
              className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Move to worktree'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
        <button
          onClick={onViewDiff}
          disabled={!hasWork}
          className="px-2 py-1 rounded bg-accent/5 text-ink-muted hover:text-ink hover:bg-accent/10 border border-accent/30 disabled:opacity-40"
        >
          View Diff
        </button>
        <button
          onClick={onMerge}
          disabled={!canMerge || busyGlobal}
          className="px-2 py-1 rounded bg-accent/5 text-ink-muted hover:text-ink hover:bg-accent/10 border border-accent/30 disabled:opacity-40"
        >
          {busy ? 'Working…' : `Merge to ${member.baseBranch ?? 'main'}`}
        </button>
        <button
          onClick={onPush}
          disabled={!canPush || busyGlobal}
          className="px-2 py-1 rounded bg-accent/5 text-ink-muted hover:text-ink hover:bg-accent/10 border border-accent/30 disabled:opacity-40"
        >
          Push branch
        </button>
        {kind === 'github' && (
          <button
            onClick={onOpenPR}
            disabled={!hasWork || busyGlobal}
            className="px-2 py-1 rounded bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 disabled:opacity-40"
          >
            Open PR
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onReveal}
          className="px-2 py-1 text-[10px] text-ink-faint hover:text-ink"
        >
          Reveal
        </button>
      </div>
    </div>
  );
}

function statusLabel(status: WorktreeStatus | null): string {
  if (!status) return 'Loading…';
  if (status.isMergedIntoBase) return 'Merged';
  if (status.hasUncommittedChanges) return 'Uncommitted changes';
  if (status.commitsAhead > 0) return 'Committed, not merged';
  if (status.filesChanged === 0) return 'No changes';
  return 'Pending review';
}

function statusTone(status: WorktreeStatus | null): string {
  if (!status) return '#666';
  if (status.isMergedIntoBase) return '#4ade80';
  if (status.hasUncommittedChanges) return '#f7b267';
  if (status.commitsAhead > 0) return '#60a5fa';
  if (status.filesChanged === 0) return '#666';
  return '#fbbf24';
}
