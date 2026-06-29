// Review + merge sheet for a flow run launched with `runIn: 'worktree'`.
// Flow runs aren't backed by a project Conversation (their step convs are
// hidden and per-participant), so we can't reuse the conversation-keyed
// WorktreeDiffSheet / WorkspaceAgentReviewSheet directly. Instead this
// reads the worktree coordinates straight off the FlowRun and drives the
// same git IPC primitives (git:run / worktreeStatus / mergeAgent /
// rebaseAgent / pushBranch / openPR) so the user can review the diff and
// pull the work back into their local repo — the agent-worktree workflow,
// for flows.
//
// Two shapes:
//   - Single-project worktree run → one two-pane diff + action header.
//   - Workspace worktree run → one card per member project's worktree,
//     each merged/pushed independently; "View Diff" drills into that
//     member's two-pane diff with a back button.

import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import type { RemoteKind, UUID, WorktreeStatus } from '@shared/types';
import type { FlowRun } from '@shared/flows/schema';
import {
  FileDiff,
  fileBaseName,
  parseUnifiedDiffByFile,
  summariseAssistantText,
} from '../../diff-utils';
import { ActionButton, StatusFooter, UnifiedDiffBody } from './WorktreeDiffSheet';

/// Commit / PR description for a flow run. There's no assistant transcript
/// to summarise (a flow has many participants), so we derive it from the
/// launch prompt: first line → subject, full prompt → body.
function flowRunDescription(run: FlowRun): { subject: string; body?: string } {
  const trimmed = (run.userPrompt ?? '').trim();
  const firstLine =
    trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const subject = firstLine
    ? summariseAssistantText(firstLine, 72)
    : `${run.flowSnapshot.name} changes`;
  const body =
    trimmed && trimmed !== firstLine ? summariseAssistantText(trimmed, 500) : undefined;
  return { subject, body };
}

/// Best-effort detection of a repo's default branch, used only for runs
/// that predate the persisted `baseBranch` field (older worktree runs
/// fall back to whatever this resolves to). Tries `origin/HEAD`, then the
/// usual local branch names, then `main`.
async function detectDefaultBranch(repo: string): Promise<string> {
  const sym = await window.overcli.invoke('git:run', {
    args: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    cwd: repo,
  });
  if (sym.exitCode === 0) {
    const ref = sym.stdout.trim();
    const b = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
    if (b) return b;
  }
  for (const b of ['main', 'master', 'develop']) {
    const r = await window.overcli.invoke('git:run', {
      args: ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`],
      cwd: repo,
    });
    if (r.exitCode === 0 && r.stdout.trim()) return b;
  }
  return 'main';
}

/// The revision the diff/status should be computed against. We prefer the
/// commit captured when the worktree was forked (`baselineCommit` /
/// `baselineCommitsByMember`) over the base branch NAME because: (a) it's
/// exact — it shows precisely what the flow changed even if the base
/// branch has moved on since, and (b) it's present on runs created before
/// `baseBranch` was persisted, so legacy worktree runs diff correctly
/// instead of erroring against a non-existent `main`.
function singleDiffBase(run: FlowRun, baseBranch: string): string {
  return run.baselineCommit ?? baseBranch;
}
function memberDiffBase(run: FlowRun, name: string, baseBranch: string): string {
  return run.baselineCommitsByMember?.[name]?.commit ?? baseBranch;
}

export function FlowRunReviewSheet({ runId }: { runId: UUID }) {
  const run = useFlowsStore((s) => s.runs[runId]);
  const openSheet = useStore((s) => s.openSheet);
  // Workspace mode drills into a single member's diff; tracked by member name.
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  // Base branch for merge/rebase/display. Persisted on new runs; detected
  // for legacy runs so `master` repos don't fall back to a wrong `main`.
  const [baseBranch, setBaseBranch] = useState<string>(run?.baseBranch ?? 'main');

  useEffect(() => {
    if (!run) return;
    if (run.baseBranch) {
      setBaseBranch(run.baseBranch);
      return;
    }
    // Detect from a real git repo. For workspace runs `sourceProjectPath`
    // is the workspace symlink root (not a repo), so prefer a member
    // project's checkout; single-project runs fall back to the source repo.
    const repo = run.workspaceWorktrees?.[0]?.projectPath ?? run.sourceProjectPath;
    if (!repo) return;
    let cancelled = false;
    void detectDefaultBranch(repo).then((b) => {
      if (!cancelled) setBaseBranch(b);
    });
    return () => {
      cancelled = true;
    };
  }, [run?.id, run?.baseBranch]);

  if (!run) {
    return (
      <SheetShell title="Flow run" onClose={() => openSheet(null)}>
        <div className="p-6 text-sm text-ink-muted">This run is no longer available.</div>
      </SheetShell>
    );
  }

  const description = flowRunDescription(run);

  // Workspace worktree run → per-member review (with optional drill-in).
  if (run.workspaceWorktrees && run.workspaceWorktrees.length > 0) {
    const member = selectedMember
      ? run.workspaceWorktrees.find((m) => m.name === selectedMember)
      : null;
    if (member) {
      return (
        <WorktreeReviewPane
          title={`${run.flowSnapshot.name} · ${member.name}`}
          projectPath={member.projectPath}
          worktreePath={member.worktreePath}
          branchName={member.branchName}
          baseBranch={baseBranch}
          diffBase={memberDiffBase(run, member.name, baseBranch)}
          description={description}
          onBack={() => setSelectedMember(null)}
          onClose={() => openSheet(null)}
        />
      );
    }
    return (
      <FlowWorkspaceReview
        run={run}
        baseBranch={baseBranch}
        description={description}
        onPickMember={setSelectedMember}
        onClose={() => openSheet(null)}
      />
    );
  }

  // Single-project worktree run.
  if (run.worktreePath && run.branchName && run.sourceProjectPath) {
    return (
      <WorktreeReviewPane
        title={run.flowSnapshot.name}
        projectPath={run.sourceProjectPath}
        worktreePath={run.worktreePath}
        branchName={run.branchName}
        baseBranch={baseBranch}
        diffBase={singleDiffBase(run, baseBranch)}
        description={description}
        onClose={() => openSheet(null)}
      />
    );
  }

  // In-place run — nothing isolated to merge back.
  return (
    <SheetShell title={run.flowSnapshot.name} onClose={() => openSheet(null)}>
      <div className="p-6 text-sm text-ink-muted space-y-2">
        <p>This run executed in place (no worktree), so its changes are already in your working tree — there's nothing to merge back here.</p>
        <p className="text-ink-faint">Launch a flow with “Run in worktree” to get review &amp; merge in this sheet.</p>
      </div>
    </SheetShell>
  );
}

/// Minimal sheet chrome for the empty/error states (the review panes carry
/// their own header).
function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col max-h-[85vh]">
      <div className="px-5 pt-4 pb-3 border-b border-white/5 flex items-center gap-3">
        <div className="text-lg font-semibold truncate flex-1">{title}</div>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5"
        >
          Close
        </button>
      </div>
      {children}
    </div>
  );
}

/// Path-keyed twin of WorktreeDiffSheet's body: two-pane diff + the same
/// Rebase / Merge / Push / Open PR header, but driven by raw worktree
/// coordinates instead of a Conversation. Used for single-project flow
/// runs and for the drill-in view of a workspace member.
function WorktreeReviewPane({
  title,
  projectPath,
  worktreePath,
  branchName,
  baseBranch,
  diffBase,
  description,
  onBack,
  onClose,
}: {
  title: string;
  projectPath: string;
  worktreePath: string;
  branchName: string;
  /// Branch name used for merge-to-base / rebase / display.
  baseBranch: string;
  /// Revision the diff + status are computed against — the captured fork
  /// commit when available, else the base branch. Splitting this from
  /// `baseBranch` lets the diff stay exact while merge still targets a
  /// real branch.
  diffBase: string;
  description: { subject: string; body?: string };
  onBack?: () => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    const [diff, stat] = await Promise.all([
      window.overcli.invoke('git:run', { args: ['diff', diffBase], cwd: worktreePath }),
      window.overcli.invoke('git:worktreeStatus', {
        projectPath,
        worktreePath,
        branchName,
        // Status math (numstat, commits-ahead, merge-base) runs against the
        // fork point too, so counts match the diff shown.
        baseBranch: diffBase,
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
  }, [worktreePath, diffBase]);

  const canMergeToBase =
    status != null && status.currentProjectBranch === baseBranch && files.length > 0;

  const currentBranchTarget =
    status &&
    status.currentProjectBranch &&
    status.currentProjectBranch !== baseBranch &&
    status.currentProjectBranch !== branchName
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
    if (
      !window.confirm(
        `Merge ${branchName} into ${target}? Uncommitted worktree changes will be auto-committed first.`,
      )
    )
      return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const res = await window.overcli.invoke('git:mergeAgent', {
      projectPath,
      worktreePath,
      branchName,
      target,
      baseBranch,
      commitSubject: description.subject,
      commitBody: description.body,
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
    if (
      !window.confirm(
        `Rebase ${branchName} onto ${baseBranch}? We'll fetch the latest ${baseBranch} and replay this branch's commits on top.`,
      )
    )
      return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const res = await window.overcli.invoke('git:rebaseAgent', {
      projectPath,
      worktreePath,
      branchName,
      baseBranch,
      commitSubject: description.subject,
      commitBody: description.body,
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
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const res = await window.overcli.invoke('git:pushBranch', {
      worktreePath,
      branchName,
      commitSubject: description.subject,
      commitBody: description.body,
    });
    if (res.ok) setActionMessage(res.message);
    else setActionError(res.error);
    setWorking(false);
  };

  const runOpenPR = async () => {
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const body =
      (description.body ?? '') + `\n\n—\nOpened from overcli flow · \`${branchName}\` → \`${baseBranch}\``;
    const res = await window.overcli.invoke('git:openPR', {
      worktreePath,
      branchName,
      baseBranch,
      title: description.subject,
      body: body.trim(),
      commitSubject: description.subject,
      commitBody: description.body,
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
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="text-xs px-1.5 py-0.5 rounded text-ink-muted hover:text-ink hover:bg-white/5"
                title="Back to all projects"
              >
                ‹ Back
              </button>
            )}
            <div className="text-lg font-semibold truncate">{title}</div>
          </div>
          <div className="text-xs text-ink-faint truncate">
            {branchName} vs {baseBranch}
            {status && status.commitsAhead > 0 && (
              <span> · {status.commitsAhead} commit{status.commitsAhead === 1 ? '' : 's'} ahead</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs flex-wrap justify-end">
          <ActionButton onClick={() => void reload()} disabled={loading || working} label="Refresh" />
          <ActionButton
            onClick={() => void runRebase()}
            disabled={loading || working}
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
              title="Commit any uncommitted changes, then merge into the currently checked-out project branch."
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
            onClick={onClose}
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
                    {f.removed > 0 && <span className="text-[10px] diff-remove-ink">−{f.removed}</span>}
                  </div>
                  <div className="text-[10px] text-ink-faint truncate">{f.path}</div>
                </button>
              ))
            )}
          </div>
          {status && <StatusFooter status={status} remote={status.remoteKind} />}
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

/// Per-member overview for a workspace worktree run. One card per member
/// project; each can be reviewed (drill-in), merged into base, pushed, or
/// opened as a PR independently — mirrors WorkspaceAgentReviewSheet.
function FlowWorkspaceReview({
  run,
  baseBranch,
  description,
  onPickMember,
  onClose,
}: {
  run: FlowRun;
  baseBranch: string;
  description: { subject: string; body?: string };
  onPickMember: (name: string) => void;
  onClose: () => void;
}) {
  const members = useMemo(() => run.workspaceWorktrees ?? [], [run.workspaceWorktrees]);
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus | null>>({});
  const [loading, setLoading] = useState(true);
  const [workingName, setWorkingName] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshAll = async () => {
    if (members.length === 0) return;
    setLoading(true);
    const entries = await Promise.all(
      members.map(async (m) => {
        const stat = await window.overcli.invoke('git:worktreeStatus', {
          projectPath: m.projectPath,
          worktreePath: m.worktreePath,
          branchName: m.branchName,
          // Diff/status against the captured fork commit (exact + present
          // on legacy runs); falls back to the base branch.
          baseBranch: memberDiffBase(run, m.name, baseBranch),
        });
        return [m.name, stat] as const;
      }),
    );
    const next: Record<string, WorktreeStatus | null> = {};
    for (const [name, stat] of entries) next[name] = stat;
    setStatuses(next);
    setLoading(false);
  };

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, members.length]);

  const runMerge = async (m: (typeof members)[number]) => {
    const status = statuses[m.name];
    const target = status?.currentProjectBranch === baseBranch ? baseBranch : null;
    if (!target) {
      setActionError(
        `${m.name}: project repo is on ${status?.currentProjectBranch ?? '(unknown)'}. Switch it to ${baseBranch} before merging.`,
      );
      return;
    }
    if (!window.confirm(`Merge ${m.branchName} into ${target} in ${m.name}?`)) return;
    setWorkingName(m.name);
    setActionMessage(null);
    setActionError(null);
    const res = await window.overcli.invoke('git:mergeAgent', {
      projectPath: m.projectPath,
      worktreePath: m.worktreePath,
      branchName: m.branchName,
      target,
      baseBranch,
      commitSubject: description.subject,
      commitBody: description.body,
    });
    if (res.ok) setActionMessage(`${m.name}: ${res.message}`);
    else setActionError(`${m.name}: ${res.error}`);
    setWorkingName(null);
    await refreshAll();
  };

  const runPush = async (m: (typeof members)[number]) => {
    setWorkingName(m.name);
    setActionMessage(null);
    setActionError(null);
    const res = await window.overcli.invoke('git:pushBranch', {
      worktreePath: m.worktreePath,
      branchName: m.branchName,
      commitSubject: description.subject,
      commitBody: description.body,
    });
    if (res.ok) setActionMessage(`${m.name}: ${res.message}`);
    else setActionError(`${m.name}: ${res.error}`);
    setWorkingName(null);
    await refreshAll();
  };

  const runCheckoutLocally = async (m: (typeof members)[number]) => {
    const status = statuses[m.name];
    const onBranch = status?.currentProjectBranch;
    const stashNote =
      onBranch && onBranch !== m.branchName
        ? ` ${m.name}'s repo is on ${onBranch}; any work-in-progress there is auto-stashed (recover with \`git stash pop\`).`
        : ' Any work-in-progress in the project repo is auto-stashed first.';
    if (
      !window.confirm(
        `Check out ${m.branchName} locally in ${m.name}? The agent's worktree is removed and ${m.name}'s repo is switched to this branch so you can build/run it. Uncommitted worktree changes are auto-committed first.${stashNote}`,
      )
    )
      return;
    setWorkingName(m.name);
    setActionMessage(null);
    setActionError(null);
    const res = await window.overcli.invoke('git:checkoutAgentLocally', {
      projectPath: m.projectPath,
      worktreePath: m.worktreePath,
      branchName: m.branchName,
      commitSubject: description.subject,
      commitBody: description.body,
    });
    if (res.ok) setActionMessage(`${m.name}: ${res.message}`);
    else setActionError(`${m.name}: ${res.error}`);
    setWorkingName(null);
    await refreshAll();
  };

  const runOpenPR = async (m: (typeof members)[number]) => {
    setWorkingName(m.name);
    setActionMessage(null);
    setActionError(null);
    const body =
      (description.body ?? '') +
      `\n\n—\nOpened from overcli flow · \`${m.branchName}\` → \`${baseBranch}\` in ${m.name}`;
    const res = await window.overcli.invoke('git:openPR', {
      worktreePath: m.worktreePath,
      branchName: m.branchName,
      baseBranch,
      title: `${description.subject} · ${m.name}`,
      body: body.trim(),
      commitSubject: description.subject,
      commitBody: description.body,
    });
    if (res.ok) setActionMessage(`${m.name}: ${res.message}`);
    else setActionError(`${m.name}: ${res.error}`);
    setWorkingName(null);
  };

  return (
    <div className="flex flex-col max-h-[85vh] h-[85vh]">
      <div className="px-5 pt-4 pb-3 border-b border-white/5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold truncate">{run.flowSnapshot.name}</div>
          <div className="text-xs text-ink-faint truncate">
            Review each project and merge independently · base {baseBranch}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button
            onClick={() => void refreshAll()}
            disabled={loading || workingName != null}
            className="review-btn"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
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
            This workspace run has no member worktrees.
          </div>
        )}
        {members.map((m) => (
          <MemberCard
            key={m.name}
            name={m.name}
            branchName={m.branchName}
            worktreePath={m.worktreePath}
            baseBranch={baseBranch}
            status={statuses[m.name] ?? null}
            busy={workingName === m.name}
            busyGlobal={workingName != null}
            onViewDiff={() => onPickMember(m.name)}
            onMerge={() => void runMerge(m)}
            onPush={() => void runPush(m)}
            onCheckoutLocally={() => void runCheckoutLocally(m)}
            onOpenPR={() => void runOpenPR(m)}
            onReveal={() => void window.overcli.invoke('fs:openInFinder', m.worktreePath)}
          />
        ))}
      </div>
    </div>
  );
}

/// Card action buttons: clean filled chips (no heavy outline) so they read
/// like the rest of the product's buttons. `cardButtonPrimary` is the solid
/// accent CTA (Open PR).
const cardButton = 'review-btn';
const cardButtonPrimary = 'review-btn-primary';

function MemberCard({
  name,
  branchName,
  worktreePath,
  baseBranch,
  status,
  busy,
  busyGlobal,
  onViewDiff,
  onMerge,
  onPush,
  onCheckoutLocally,
  onOpenPR,
  onReveal,
}: {
  name: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  status: WorktreeStatus | null;
  busy: boolean;
  busyGlobal: boolean;
  onViewDiff: () => void;
  onMerge: () => void;
  onPush: () => void;
  onCheckoutLocally: () => void;
  onOpenPR: () => void;
  onReveal: () => void;
}) {
  const label = statusLabel(status);
  const tone = statusTone(status);
  const filesChanged = status?.filesChanged ?? 0;
  const hasWork =
    status != null &&
    (status.filesChanged > 0 || status.commitsAhead > 0 || status.hasUncommittedChanges);
  const kind: RemoteKind = status?.remoteKind ?? 'none';
  const canMerge = status != null && !status.isMergedIntoBase && (hasWork || status.commitsAhead > 0);
  const canPush = status != null && kind !== 'none' && (hasWork || status.commitsAhead > 0);

  return (
    <div className="review-card p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ background: tone }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{name}</div>
          <div className="text-[11px] text-ink-muted truncate">{label}</div>
          <div className="mt-1 text-[11px] font-mono text-ink-muted truncate" title={worktreePath}>
            <span className="text-accent">{branchName}</span>
            <span className="text-ink-faint"> · </span>
            {worktreePath}
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
              <span className="diff-add-ink">+{status.insertions}</span>{' '}
              <span className="diff-remove-ink">−{status.deletions}</span>
            </div>
          )}
          {status && status.commitsAhead > 0 && (
            <div className="text-[10px] text-ink-faint">
              {status.commitsAhead} commit{status.commitsAhead === 1 ? '' : 's'} ahead
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        <button onClick={onViewDiff} disabled={!hasWork} className={cardButton}>
          View Diff
        </button>
        <button onClick={onMerge} disabled={!canMerge || busyGlobal} className={cardButton}>
          {busy ? 'Working…' : `Merge to ${baseBranch}`}
        </button>
        <button onClick={onPush} disabled={!canPush || busyGlobal} className={cardButton}>
          Push branch
        </button>
        {kind === 'github' && (
          <button onClick={onOpenPR} disabled={!hasWork || busyGlobal} className={cardButtonPrimary}>
            Open PR
          </button>
        )}
        <button
          onClick={onCheckoutLocally}
          disabled={status == null || busyGlobal}
          title={`Remove this worktree and switch ${name}'s repo to ${branchName} so you can build/run it locally. Auto-commits the worktree and stashes any project work-in-progress first.`}
          className={cardButton}
        >
          {busy ? 'Working…' : 'Check out locally'}
        </button>
        <div className="flex-1" />
        <button
          onClick={onReveal}
          className="px-2 py-1 rounded-md text-[11px] text-ink-faint hover:text-ink hover:bg-white/[0.06] transition-colors"
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
