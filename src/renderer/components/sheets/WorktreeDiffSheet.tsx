// Worktree diff sheet — unified diff viewer + merge/push/PR actions for a
// single agent. Mirrors the Swift WorktreeDiffSheet: a two-pane layout
// (file list + diff body) with the same action buttons in the header
// (Refresh, Rebase onto base, Merge to base, Merge to current, Push, Open PR).

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { Conversation, RemoteKind, UUID, WorktreeStatus } from '@shared/types';
import {
  FileDiff,
  agentDescription,
  fileBaseName,
  findOwningProjectPath,
  lastAssistantText,
  parseUnifiedDiffByFile,
} from '../../diff-utils';

export function WorktreeDiffSheet({ convId }: { convId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const runner = useStore((s) => s.runners[convId]);
  const openSheet = useStore((s) => s.openSheet);

  // Locate the conversation + its owning project. Workspace-agent members
  // live inside a project's conversation list (not under the workspace),
  // so we scan both the project list and the workspace members.
  const { conv, projectPath } = useMemo(() => {
    let c: Conversation | null = null;
    let p: string | null = null;
    for (const proj of projects) {
      const match = proj.conversations.find((x) => x.id === convId);
      if (match) {
        c = match;
        p = proj.path;
        break;
      }
    }
    if (!c) {
      for (const ws of workspaces) {
        const match = (ws.conversations ?? []).find((x) => x.id === convId);
        if (match) {
          c = match;
          p = findOwningProjectPath(projects, convId);
          break;
        }
      }
    }
    return { conv: c, projectPath: p };
  }, [projects, workspaces, convId]);

  const [files, setFiles] = useState<FileDiff[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const baseBranch = conv?.baseBranch ?? 'main';
  const branchShort = conv?.branchName ?? '?';

  const reload = async () => {
    if (!conv?.worktreePath || !projectPath || !conv.branchName) return;
    setLoading(true);
    // `git diff <base>` (two-dot, working-tree-vs-base) rolls committed
    // and uncommitted changes into one view — the most useful
    // "everything the agent has done" diff for the reviewer.
    const [diff, stat] = await Promise.all([
      window.overcli.invoke('git:run', {
        args: ['diff', baseBranch],
        cwd: conv.worktreePath,
      }),
      window.overcli.invoke('git:worktreeStatus', {
        projectPath,
        worktreePath: conv.worktreePath,
        branchName: conv.branchName,
        baseBranch,
      }),
    ]);
    let text = diff.stdout;
    if (diff.exitCode !== 0 && !text) text = diff.stderr;
    const parsed = parseUnifiedDiffByFile(text);
    setFiles(parsed);
    setStatus(stat);
    setLoading(false);
    setSelected((current) => {
      if (current && parsed.some((f) => f.path === current)) return current;
      return parsed[0]?.path ?? null;
    });
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  if (!conv) return null;

  const description = () =>
    agentDescription(conv.name, lastAssistantText(runner), conv.branchName ?? branchShort);

  const canMergeToBase =
    status != null && status.currentProjectBranch === baseBranch && files.length > 0;

  const currentBranchTarget =
    status &&
    status.currentProjectBranch &&
    status.currentProjectBranch !== baseBranch &&
    status.currentProjectBranch !== conv.branchName
      ? status.currentProjectBranch
      : null;

  const baseMergeHelp = (() => {
    if (loading) return 'Loading project branch state…';
    if (!status || status.currentProjectBranch == null)
      return `Couldn't determine the current project branch. Check out ${baseBranch} in the project repo.`;
    if (status.currentProjectBranch !== baseBranch)
      return `Project repo is on ${status.currentProjectBranch}. Switch to ${baseBranch}, or use Merge to ${status.currentProjectBranch}.`;
    return 'Commit any uncommitted changes, then merge into the base branch.';
  })();

  const rebaseHelp = `Auto-commits uncommitted changes, fetches the latest ${baseBranch} when available, then reapplies this branch on top.`;

  const pushHelp = (() => {
    switch (status?.remoteKind) {
      case 'none':
        return 'No `origin` remote is configured on this worktree.';
      case 'github':
        return 'Push the branch to origin. Use Open PR to also run `gh pr create`.';
      case 'other':
        return 'Push the branch to origin. The remote will print a URL to open a merge/pull request.';
      default:
        return '';
    }
  })();

  const runMerge = async (target: string) => {
    if (!conv.worktreePath || !projectPath || !conv.branchName) return;
    if (
      !window.confirm(
        `Merge ${branchShort} into ${target}? Uncommitted worktree changes will be auto-committed first.`,
      )
    )
      return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const desc = description();
    const res = await window.overcli.invoke('git:mergeAgent', {
      projectPath,
      worktreePath: conv.worktreePath,
      branchName: conv.branchName,
      target,
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) {
      setActionMessage(res.message);
      await reload();
    } else {
      setActionError(res.error);
    }
    setWorking(false);
  };

  const runRebase = async () => {
    if (!conv.worktreePath || !projectPath || !conv.branchName) return;
    if (
      !window.confirm(
        `Rebase ${branchShort} onto ${baseBranch}? We'll fetch the latest ${baseBranch} and replay this branch's commits on top.`,
      )
    )
      return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const desc = description();
    const res = await window.overcli.invoke('git:rebaseAgent', {
      projectPath,
      worktreePath: conv.worktreePath,
      branchName: conv.branchName,
      baseBranch,
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) {
      setActionMessage(res.message);
      await reload();
    } else {
      setActionError(res.error);
    }
    setWorking(false);
  };

  const runPush = async () => {
    if (!conv.worktreePath || !conv.branchName) return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const desc = description();
    const res = await window.overcli.invoke('git:pushBranch', {
      worktreePath: conv.worktreePath,
      branchName: conv.branchName,
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) setActionMessage(res.message);
    else setActionError(res.error);
    setWorking(false);
  };

  const runOpenPR = async () => {
    if (!conv.worktreePath || !conv.branchName) return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const desc = description();
    const body =
      (desc.body ?? '') + `\n\n—\nOpened from Overcli · \`${conv.branchName}\` → \`${baseBranch}\``;
    const res = await window.overcli.invoke('git:openPR', {
      worktreePath: conv.worktreePath,
      branchName: conv.branchName,
      baseBranch,
      title: desc.subject,
      body: body.trim(),
      commitSubject: desc.subject,
      commitBody: desc.body,
    });
    if (res.ok) setActionMessage(res.message);
    else setActionError(res.error);
    setWorking(false);
  };

  const selectedFile = files.find((f) => f.path === selected) ?? null;

  return (
    <div className="flex flex-col max-h-[85vh] h-[85vh]">
      <div className="px-5 pt-4 pb-3 border-b border-white/5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold truncate">{conv.name}</div>
          <div className="text-xs text-ink-faint truncate">
            {branchShort} vs {baseBranch}
            {status && status.commitsAhead > 0 && (
              <span> · {status.commitsAhead} commit{status.commitsAhead === 1 ? '' : 's'} ahead</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs flex-wrap justify-end">
          <ActionButton
            onClick={() => void reload()}
            disabled={loading || working}
            label="Refresh"
          />
          <ActionButton
            onClick={() => void runRebase()}
            disabled={loading || working || !projectPath || !conv.worktreePath || !conv.branchName}
            label={working ? 'Working…' : `Rebase onto ${baseBranch}`}
            title={rebaseHelp}
          />
          <ActionButton
            onClick={() => void runMerge(baseBranch)}
            disabled={loading || working || !canMergeToBase}
            label={`Merge to ${baseBranch}`}
            title={baseMergeHelp}
          />
          {currentBranchTarget && (
            <ActionButton
              onClick={() => void runMerge(currentBranchTarget)}
              disabled={loading || working || files.length === 0}
              label={`Merge to ${currentBranchTarget}`}
              title={`Commit any uncommitted changes, then merge into the currently checked-out project branch.`}
            />
          )}
          <ActionButton
            onClick={() => void runPush()}
            disabled={loading || working || !status || status.remoteKind === 'none'}
            label={working ? 'Working…' : 'Push branch'}
            title={pushHelp}
          />
          {status?.remoteKind === 'github' && (
            <ActionButton
              onClick={() => void runOpenPR()}
              disabled={loading || working || files.length === 0}
              label={working ? 'Working…' : 'Open PR'}
              title="Push branch and run `gh pr create`"
              prominent
            />
          )}
          <button
            onClick={() => openSheet(null)}
            className="ml-1 text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5"
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
              ? 'diff-remove-ink diff-remove-row border-red-500/30'
              : 'diff-add-ink diff-add-row border-green-500/30')
          }
        >
          {actionError ?? actionMessage}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="w-[260px] min-w-[220px] max-w-[360px] border-r border-white/5 flex flex-col">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-faint border-b border-white/5">
            Files ({files.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && files.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">Running git diff…</div>
            ) : files.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">No changes on this branch yet.</div>
            ) : (
              files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setSelected(f.path)}
                  className={
                    'w-full text-left px-3 py-1.5 border-b border-white/5 last:border-b-0 ' +
                    (selected === f.path
                      ? 'bg-white/10 text-ink'
                      : 'text-ink-muted hover:bg-white/5 hover:text-ink')
                  }
                  title={f.path}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] truncate flex-1">{fileBaseName(f.path)}</span>
                    {f.added > 0 && <span className="text-[10px] diff-add-ink">+{f.added}</span>}
                    {f.removed > 0 && (
                      <span className="text-[10px] diff-remove-ink">−{f.removed}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-faint truncate">{f.path}</div>
                </button>
              ))
            )}
          </div>
          {status && (
            <StatusFooter status={status} remote={status.remoteKind} />
          )}
        </div>
        <div className="flex-1 min-w-0 overflow-auto">
          {selectedFile ? (
            <UnifiedDiffBody text={selectedFile.body} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-ink-faint">
              Select a file.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  label,
  title,
  prominent,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  title?: string;
  prominent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        'px-2 py-1 rounded text-xs ' +
        (prominent
          ? 'bg-accent/20 text-accent hover:bg-accent/30 border border-accent/40'
          : 'bg-accent/5 text-ink-muted hover:text-ink hover:bg-accent/10 border border-accent/30') +
        (disabled ? ' opacity-40 cursor-not-allowed' : '')
      }
    >
      {label}
    </button>
  );
}

function StatusFooter({ status, remote }: { status: WorktreeStatus; remote: RemoteKind }) {
  return (
    <div className="border-t border-white/5 px-3 py-2 text-[10px] text-ink-faint space-y-0.5">
      <div>
        Project on:{' '}
        <span className="text-ink-muted">{status.currentProjectBranch ?? '(detached)'}</span>
      </div>
      <div>
        Remote: <span className="text-ink-muted">{remote}</span>
        {status.hasUncommittedChanges && (
          <span className="ml-1 text-amber-400">· uncommitted</span>
        )}
        {status.isMergedIntoBase && <span className="ml-1 diff-add-ink">· merged</span>}
      </div>
      {status.mainTreeDirtyFiles > 0 && (
        <div className="text-amber-400">
          ⚠ {status.mainTreeDirtyFiles} dirty file{status.mainTreeDirtyFiles === 1 ? '' : 's'} in
          main tree
        </div>
      )}
    </div>
  );
}

/// Self-contained unified-diff renderer. Doesn't use the Diff component
/// because this view renders the full diff text (with file headers), not
/// just a single hunk — and because we already have FileDiff.body split by
/// file, we just need hunk + line styling.
export function UnifiedDiffBody({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="font-mono text-[11px] leading-[1.5]">
      {lines.map((raw, i) => {
        let kind: 'add' | 'remove' | 'context' | 'hunk' | 'fileHeader' | 'meta' = 'context';
        if (raw.startsWith('+++') || raw.startsWith('---')) kind = 'fileHeader';
        else if (raw.startsWith('@@')) kind = 'hunk';
        else if (raw.startsWith('diff ') || raw.startsWith('index ')) kind = 'meta';
        else if (raw.startsWith('+')) kind = 'add';
        else if (raw.startsWith('-')) kind = 'remove';

        const bg =
          kind === 'add'
            ? 'diff-add-row'
            : kind === 'remove'
            ? 'diff-remove-row'
            : kind === 'hunk'
            ? 'bg-card'
            : '';
        const fg =
          kind === 'add'
            ? 'diff-add-ink'
            : kind === 'remove'
            ? 'diff-remove-ink'
            : kind === 'hunk'
            ? 'diff-hunk-ink'
            : kind === 'fileHeader'
            ? 'diff-file-ink'
            : kind === 'meta'
            ? 'text-ink-faint'
            : 'text-ink';
        return (
          <div
            key={i}
            className={'px-3 whitespace-pre select-text ' + bg + ' ' + fg}
          >
            {raw || ' '}
          </div>
        );
      })}
    </div>
  );
}
