// Archive / rename / delete sheet — replaces the ad-hoc
// window.confirm()/alert() flow. For agents, fetches WorktreeStatus so
// the user can see what will be destroyed before confirming Delete.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useRunnerIsRunning } from '../../runnersStore';
import { Conversation, UUID, WorktreeStatus } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { findOwningProjectPath } from '../../diff-utils';

type Mode = 'overview' | 'confirmDelete';

export function ArchiveConversationSheet({ convId }: { convId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const openSheet = useStore((s) => s.openSheet);
  const renameConversation = useStore((s) => s.renameConversation);
  const setConversationHidden = useStore((s) => s.setConversationHidden);
  const removeConversation = useStore((s) => s.removeConversation);
  const removeAgent = useStore((s) => s.removeAgent);
  const isRunning = useRunnerIsRunning(convId);

  const { conv, projectPath } = useMemo(() => {
    let c: Conversation | null = null;
    let p: string | null = null;
    for (const proj of projects) {
      const m = proj.conversations.find((x) => x.id === convId);
      if (m) {
        c = m;
        p = proj.path;
        break;
      }
    }
    if (!c) {
      for (const ws of workspaces) {
        const m = (ws.conversations ?? []).find((x) => x.id === convId);
        if (m) {
          c = m;
          p = findOwningProjectPath(projects, convId);
          break;
        }
      }
    }
    return { conv: c, projectPath: p };
  }, [projects, workspaces, convId]);

  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>('overview');
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [memberStatuses, setMemberStatuses] = useState<
    Array<{ convId: UUID; projectName: string; branchName: string; status: WorktreeStatus | null }>
  >([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (conv) setName(conv.name);
  }, [conv?.id]);

  const isAgent = !!conv?.worktreePath;
  const isCoordinator = (conv?.workspaceAgentMemberIds?.length ?? 0) > 0;

  useEffect(() => {
    if (!conv) return;
    // Single-project agent: fetch its own status.
    if (isAgent && projectPath && conv.worktreePath && conv.branchName) {
      setStatusLoading(true);
      void window.overcli
        .invoke('git:worktreeStatus', {
          projectPath,
          worktreePath: conv.worktreePath,
          branchName: conv.branchName,
          baseBranch: conv.baseBranch ?? 'main',
        })
        .then((s) => setStatus(s))
        .finally(() => setStatusLoading(false));
    }
    // Coordinator: fetch per-member status.
    if (isCoordinator && conv.workspaceAgentMemberIds) {
      setStatusLoading(true);
      const memberIds = conv.workspaceAgentMemberIds;
      const pairs = memberIds
        .map((mid) => {
          for (const p of projects) {
            const m = p.conversations.find((x) => x.id === mid);
            if (m?.worktreePath && m.branchName) {
              return { member: m, projectPath: p.path, projectName: p.name };
            }
          }
          return null;
        })
        .filter((x): x is { member: Conversation; projectPath: string; projectName: string } => !!x);
      void Promise.all(
        pairs.map(async (pair) => ({
          convId: pair.member.id,
          projectName: pair.projectName,
          branchName: pair.member.branchName ?? '',
          status: await window.overcli.invoke('git:worktreeStatus', {
            projectPath: pair.projectPath,
            worktreePath: pair.member.worktreePath ?? '',
            branchName: pair.member.branchName ?? '',
            baseBranch: pair.member.baseBranch ?? 'main',
          }),
        })),
      )
        .then(setMemberStatuses)
        .finally(() => setStatusLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv?.id]);

  if (!conv) return null;

  const hasUncommitted = (() => {
    if (isAgent) return status?.hasUncommittedChanges ?? false;
    if (isCoordinator) return memberStatuses.some((m) => m.status?.hasUncommittedChanges);
    return false;
  })();
  const unmergedCommits = (() => {
    if (isAgent) {
      if (!status) return 0;
      return status.isMergedIntoBase ? 0 : status.commitsAhead;
    }
    if (isCoordinator) {
      return memberStatuses.reduce(
        (sum, m) => sum + (m.status && !m.status.isMergedIntoBase ? m.status.commitsAhead : 0),
        0,
      );
    }
    return 0;
  })();
  const hasDanger = hasUncommitted || unmergedCommits > 0;

  const doRename = async (nextName: string) => {
    if (nextName === conv.name || !nextName.trim()) return;
    await renameConversation(conv.id, nextName.trim());
  };

  const doArchive = async () => {
    setWorking(true);
    setError(null);
    try {
      if (name.trim() && name.trim() !== conv.name) {
        await renameConversation(conv.id, name.trim());
      }
      await setConversationHidden(conv.id, !conv.hidden);
      openSheet(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const doDelete = async () => {
    setWorking(true);
    setError(null);
    try {
      if (isAgent || isCoordinator) {
        const res = await removeAgent(conv.id);
        if (!res.ok && res.error) {
          setError(`Removed with warnings: ${res.error}`);
          setWorking(false);
          return;
        }
      } else {
        await removeConversation(conv.id);
      }
      openSheet(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col p-5 gap-4 max-h-[80vh] overflow-y-auto">
      <div>
        <div className="text-lg font-semibold">
          {isCoordinator
            ? 'Workspace agent'
            : isAgent
            ? 'Agent conversation'
            : 'Conversation'}
        </div>
        <div className="text-xs text-ink-faint">
          {isAgent || isCoordinator
            ? 'Archive hides it from the sidebar (keeps the worktree and branch). Delete removes the git worktree and branch.'
            : 'Archive hides it from the sidebar. Delete drops the conversation from disk. Neither touches your project files.'}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void doRename(name)}
          placeholder={conv.name}
          className="field px-3 py-1.5 text-sm"
          disabled={working}
        />
        <div className="text-[10px] text-ink-faint">
          Renames take effect immediately.
        </div>
      </div>

      {(isAgent || isCoordinator) && (
        <AgentDetails
          conv={conv}
          status={status}
          memberStatuses={memberStatuses}
          isCoordinator={isCoordinator}
          loading={statusLoading}
        />
      )}

      {isRunning && (
        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
          Session is running. Stop it first if you want to delete — archiving is safe.
        </div>
      )}

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {mode === 'overview' && (
        <div className="flex justify-between gap-2 mt-1">
          <SheetActionButton
            label="Delete…"
            onClick={() => setMode('confirmDelete')}
            disabled={working}
          />
          <div className="flex gap-2">
            <SheetActionButton label="Cancel" onClick={() => openSheet(null)} disabled={working} />
            <SheetActionButton
              primary
              label={
                working
                  ? conv.hidden
                    ? 'Unarchiving…'
                    : 'Archiving…'
                  : conv.hidden
                  ? 'Unarchive'
                  : 'Archive'
              }
              onClick={() => void doArchive()}
              disabled={working}
            />
          </div>
        </div>
      )}

      {mode === 'confirmDelete' && (
        <DeleteConfirm
          conv={conv}
          isAgent={isAgent}
          isCoordinator={isCoordinator}
          hasDanger={hasDanger}
          hasUncommitted={hasUncommitted}
          unmergedCommits={unmergedCommits}
          working={working}
          onCancel={() => setMode('overview')}
          onConfirm={() => void doDelete()}
        />
      )}
    </div>
  );
}

function AgentDetails({
  conv,
  status,
  memberStatuses,
  isCoordinator,
  loading,
}: {
  conv: Conversation;
  status: WorktreeStatus | null;
  memberStatuses: Array<{
    convId: UUID;
    projectName: string;
    branchName: string;
    status: WorktreeStatus | null;
  }>;
  isCoordinator: boolean;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 border border-card rounded-lg p-3 bg-surface-muted">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">
        Pending changes
      </div>
      {loading && !status && memberStatuses.length === 0 && (
        <div className="text-xs text-ink-faint">Checking worktree…</div>
      )}
      {!isCoordinator && status && (
        <StatusRow
          branch={conv.branchName ?? ''}
          base={conv.baseBranch ?? 'main'}
          status={status}
        />
      )}
      {isCoordinator && memberStatuses.length > 0 && (
        <div className="flex flex-col gap-2">
          {memberStatuses.map((m) => (
            <div key={m.convId} className="flex flex-col gap-1">
              <div className="text-[11px] text-ink-muted">{m.projectName}</div>
              {m.status ? (
                <StatusRow
                  branch={m.branchName}
                  base={conv.baseBranch ?? 'main'}
                  status={m.status}
                />
              ) : (
                <div className="text-[11px] text-ink-faint">(no status)</div>
              )}
            </div>
          ))}
        </div>
      )}
      {!loading && !status && !isCoordinator && (
        <div className="text-xs text-ink-faint">
          Worktree not found — safe to delete the conversation row.
        </div>
      )}
      {conv.worktreePath && (
        <div className="text-[10px] text-ink-faint truncate" title={conv.worktreePath}>
          {conv.worktreePath}
        </div>
      )}
    </div>
  );
}

function StatusRow({
  branch,
  base,
  status,
}: {
  branch: string;
  base: string;
  status: WorktreeStatus;
}) {
  const unmerged = !status.isMergedIntoBase && status.commitsAhead > 0;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-ink">{branch}</span>
        <span className="text-ink-faint">→</span>
        <span className="font-mono text-[11px] text-ink-muted">{base}</span>
        {status.isMergedIntoBase && (
          <Pill tone="green">merged</Pill>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {status.filesChanged > 0 ? (
          <Pill tone="neutral">
            {status.filesChanged} file{status.filesChanged === 1 ? '' : 's'} · +{status.insertions} −
            {status.deletions}
          </Pill>
        ) : (
          <Pill tone="neutral">no diff vs {base}</Pill>
        )}
        {unmerged && (
          <Pill tone="amber">
            {status.commitsAhead} unmerged commit{status.commitsAhead === 1 ? '' : 's'}
          </Pill>
        )}
        {status.hasUncommittedChanges && <Pill tone="amber">uncommitted</Pill>}
        {status.mainTreeDirtyFiles > 0 && (
          <Pill tone="amber">
            {status.mainTreeDirtyFiles} dirty in main tree
          </Pill>
        )}
      </div>
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'green' | 'amber' | 'red' | 'neutral';
}) {
  const cls =
    tone === 'green'
      ? 'bg-green-500/15 text-green-300 border-green-500/30'
      : tone === 'amber'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : tone === 'red'
      ? 'bg-red-500/15 text-red-300 border-red-500/30'
      : 'bg-accent/5 text-ink-muted border-accent/30';
  return (
    <span
      className={'rounded-full border px-2 py-0.5 text-[10px] font-medium ' + cls}
    >
      {children}
    </span>
  );
}

function DeleteConfirm({
  conv,
  isAgent,
  isCoordinator,
  hasDanger,
  hasUncommitted,
  unmergedCommits,
  working,
  onCancel,
  onConfirm,
}: {
  conv: Conversation;
  isAgent: boolean;
  isCoordinator: boolean;
  hasDanger: boolean;
  hasUncommitted: boolean;
  unmergedCommits: number;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const warnings: string[] = [];
  if (hasUncommitted) warnings.push('uncommitted changes will be lost');
  if (unmergedCommits > 0)
    warnings.push(
      `${unmergedCommits} unmerged commit${unmergedCommits === 1 ? '' : 's'} on the agent branch will be destroyed`,
    );

  const headline = isCoordinator
    ? `Delete "${conv.name}" and all member worktrees?`
    : isAgent
    ? `Delete agent "${conv.name}"?`
    : `Delete "${conv.name}"?`;

  return (
    <div
      className={
        'flex flex-col gap-3 rounded-lg border p-3 ' +
        (hasDanger
          ? 'border-red-500/40 bg-red-500/5'
          : 'border-amber-500/30 bg-amber-500/5')
      }
    >
      <div className="text-sm font-medium">{headline}</div>
      {(isAgent || isCoordinator) && (
        <div className="text-xs text-ink-muted">
          Removes the git worktree{isCoordinator ? 's' : ''} and deletes the
          branch{isCoordinator ? 'es' : ''}.
        </div>
      )}
      {!isAgent && !isCoordinator && (
        <div className="text-xs text-ink-muted">
          Drops the conversation from disk. Your project files are not touched.
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="text-xs text-red-300 list-disc pl-4 space-y-0.5">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <SheetActionButton label="Back" onClick={onCancel} disabled={working} />
        <button
          onClick={onConfirm}
          disabled={working}
          className={
            'px-3 py-1 rounded text-xs border disabled:opacity-40 disabled:cursor-not-allowed ' +
            (hasDanger
              ? 'bg-red-500/30 border-red-500/60 text-red-200 hover:bg-red-500/40'
              : 'bg-red-500/20 border-red-500/40 text-red-300 hover:bg-red-500/30')
          }
        >
          {working ? 'Deleting…' : hasDanger ? 'Delete anyway' : 'Delete'}
        </button>
      </div>
    </div>
  );
}
