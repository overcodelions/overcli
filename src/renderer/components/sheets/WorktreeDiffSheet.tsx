// Worktree diff sheet — unified diff viewer + merge/push/PR actions for a
// single agent. Mirrors the Swift WorktreeDiffSheet: a two-pane layout
// (file list + diff body) with the same action buttons in the header
// (Refresh, Rebase onto base, Merge to base, Merge to current, Push, Open PR).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore } from '../../store';
import { useRunner } from '../../runnersStore';
import { Conversation, RemoteKind, UUID, WorktreeStatus } from '@shared/types';
import {
  DiffMatch,
  FileDiff,
  agentDescription,
  fileBaseName,
  findDiffMatches,
  findOwningProjectPath,
  lastAssistantText,
  parseUnifiedDiffByFile,
} from '../../diff-utils';

export function WorktreeDiffSheet({ convId }: { convId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const runner = useRunner(convId);
  const openSheet = useStore((s) => s.openSheet);
  const checkoutAgentLocally = useStore((s) => s.checkoutAgentLocally);

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
  // A workspace-agent member's coordinator lives on a workspace and
  // lists this conv in `workspaceAgentMemberIds`. Per-member local
  // checkout is the bug that left coordinators half-demoted, so we
  // hide that button here and point users at the coordinator's
  // "Check out all locally" action instead.
  const workspaceCoordinator = useMemo<Conversation | null>(() => {
    for (const ws of workspaces) {
      const coord = (ws.conversations ?? []).find((c) =>
        c.workspaceAgentMemberIds?.includes(convId),
      );
      if (coord) return coord;
    }
    return null;
  }, [workspaces, convId]);

  const reload = async () => {
    if (!conv?.worktreePath || !projectPath || !conv.branchName) {
      // Demoted/stripped conv — nothing to diff. Clear the spinner so
      // the sheet shows "No changes" instead of "Running git diff…"
      // forever (seen when a workspace-agent member gets "Check out
      // locally" invoked on it).
      setLoading(false);
      setFiles([]);
      setStatus(null);
      return;
    }
    setLoading(true);
    // `git diff <base>` (two-dot, working-tree-vs-base) rolls committed
    // and uncommitted changes into one view — the most useful
    // "everything the agent has done" diff for the reviewer. `worktreeDiff`
    // adds the untracked new files a plain `git diff` would drop.
    const [diff, stat] = await Promise.all([
      window.overcli.invoke('git:worktreeDiff', {
        cwd: conv.worktreePath,
        baseBranch,
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

  const runCheckoutLocally = async () => {
    if (!conv.worktreePath || !conv.branchName) return;
    const dirty = status?.mainTreeDirtyFiles ?? 0;
    const stashNote =
      dirty > 0
        ? ` Your ${dirty} uncommitted project file${dirty === 1 ? '' : 's'} will be stashed (recover with \`git stash pop\`).`
        : '';
    if (
      !window.confirm(
        `Check out ${branchShort} locally? The agent's worktree will be removed and your main project repo switched to this branch.${stashNote} Uncommitted worktree changes will be auto-committed first. The conversation will be kept (demoted to a regular chat under this project).`,
      )
    )
      return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const desc = description();
    const res = await checkoutAgentLocally(convId, desc.subject, desc.body);
    if (res.ok) {
      setActionMessage(res.message);
      openSheet(null);
    } else {
      setActionError(res.error);
      setWorking(false);
    }
  };

  const checkoutLocallyHelp = (() => {
    if (loading) return 'Loading project branch state…';
    const dirty = status?.mainTreeDirtyFiles ?? 0;
    const stashHint =
      dirty > 0
        ? ` Your ${dirty} dirty project file${dirty === 1 ? '' : 's'} will be stashed first.`
        : '';
    return `Remove the worktree, switch the project repo to ${branchShort}, and demote the agent to a normal conversation.${stashHint}`;
  })();

  const runOpenPR = async () => {
    if (!conv.worktreePath || !conv.branchName) return;
    setWorking(true);
    setActionError(null);
    setActionMessage(null);
    const desc = description();
    const body =
      (desc.body ?? '') + `\n\n—\nOpened from overcli · \`${conv.branchName}\` → \`${baseBranch}\``;
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
          {workspaceCoordinator ? (
            <ActionButton
              onClick={() =>
                openSheet({ type: 'workspaceAgentReview', coordinatorId: workspaceCoordinator.id })
              }
              disabled={working}
              label="Check out (workspace)…"
              title="Workspace agents check out every project at once from the coordinator's review sheet, so the workspace doesn't end up half in agents and half in local branches."
            />
          ) : conv.adoptedWorktree ? (
            /* Checking out locally does `git worktree remove --force` —
               on a borrowed worktree that would pull the tree out from
               under the flow run that owns it. The run's own Review &
               merge sheet is the sanctioned way home. */
            <ActionButton
              onClick={() => {}}
              disabled
              label="Check out locally"
              title="This worktree belongs to a flow run — check it out from that run's Review & merge instead, so the run isn't left without its tree."
            />
          ) : (
            <ActionButton
              onClick={() => void runCheckoutLocally()}
              disabled={loading || working || !projectPath || !conv.worktreePath || !conv.branchName}
              label="Check out locally"
              title={checkoutLocallyHelp}
            />
          )}
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

export function ActionButton({
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
      className={prominent ? 'review-btn-primary' : 'review-btn'}
    >
      {label}
    </button>
  );
}

export function StatusFooter({ status, remote }: { status: WorktreeStatus; remote: RemoteKind }) {
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
/// file, we just need hunk + line styling. Tracks old/new line numbers
/// from the @@ hunk headers so we can render an editor-style gutter.
export function UnifiedDiffBody({ text, searchable = true }: { text: string; searchable?: boolean }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const rows = useMemo(() => buildDiffRows(lines), [lines]);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => (searchable && findOpen ? findDiffMatches(lines, query) : []),
    [searchable, findOpen, lines, query],
  );
  // Clamp rather than reset: the query and the diff can both change under
  // us (switching files in a sheet keeps the bar open), and an index past
  // the end would leave the counter reading "5/2".
  const current = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);
  const activeMatch = current < 0 ? undefined : matches[current];
  const matchesByLine = useMemo(() => {
    const map = new Map<number, DiffMatch[]>();
    for (const m of matches) {
      const list = map.get(m.line);
      if (list) list.push(m);
      else map.set(m.line, [m]);
    }
    return map;
  }, [matches]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, text]);

  // Keep the current hit on screen. `nearest` means a match already in
  // view doesn't yank the scroll position around as you type.
  useEffect(() => {
    if (!activeMatch) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(
      `[data-diff-line="${activeMatch.line}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeMatch]);

  const openFind = () => {
    setFindOpen(true);
    // The input may not exist yet on the first open, so focus after paint.
    requestAnimationFrame(() => inputRef.current?.select());
  };
  const closeFind = () => {
    setFindOpen(false);
    setQuery('');
  };
  const step = (delta: number) => {
    if (matches.length === 0) return;
    setActiveIndex((current + delta + matches.length) % matches.length);
  };

  // ⌘F while a diff is on screen opens the bar, matching the CodeMirror
  // editor's search keymap. Several diff bodies can be mounted at once (a
  // sheet over the explorer pane), so only the most recently mounted one —
  // the topmost — claims the key.
  useEffect(() => {
    if (!searchable) return;
    const claim = () => openFind();
    findKeyStack.push(claim);
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== 'f' && e.key !== 'F')) return;
      if (findKeyStack[findKeyStack.length - 1] !== claim) return;
      e.preventDefault();
      claim();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = findKeyStack.indexOf(claim);
      if (i !== -1) findKeyStack.splice(i, 1);
    };
  }, [searchable]);

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  };

  return (
    <div ref={bodyRef} className="group font-mono text-[11px] leading-[1.5]">
      {searchable &&
        (findOpen ? (
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-card bg-surface-muted px-2 py-1.5 font-sans">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Find in diff"
              spellCheck={false}
              autoFocus
              className="w-56 rounded border border-card bg-card px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
            <span className="w-20 tabular-nums text-ink-faint">
              {!query ? '' : matches.length === 0 ? 'no results' : `${current + 1}/${matches.length}`}
            </span>
            <FindButton label="Previous match (⇧↵)" onClick={() => step(-1)} disabled={!matches.length}>
              ↑
            </FindButton>
            <FindButton label="Next match (↵)" onClick={() => step(1)} disabled={!matches.length}>
              ↓
            </FindButton>
            <button
              type="button"
              onClick={closeFind}
              title="Close find (Esc)"
              className="ml-auto px-1 text-ink-faint hover:text-ink"
            >
              ×
            </button>
          </div>
        ) : (
          // Zero-height sticky row so the affordance floats over the diff
          // without shifting a single line of it.
          <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-end">
            <button
              type="button"
              onClick={openFind}
              className="pointer-events-auto mr-3 mt-1 rounded border border-card bg-surface px-1.5 py-0.5 font-sans text-[10px] text-ink-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
            >
              Find ⌘F
            </button>
          </div>
        ))}
      {rows.map(({ raw, kind, oldNum, newNum }, i) => {
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
            data-diff-line={i}
            className={'flex whitespace-pre select-text ' + bg + ' ' + fg}
          >
            <span className="select-none text-ink-faint pl-2 pr-1 text-right tabular-nums w-10 shrink-0">
              {oldNum ?? ''}
            </span>
            <span className="select-none text-ink-faint pr-2 text-right tabular-nums w-10 shrink-0">
              {newNum ?? ''}
            </span>
            <span className="px-1 flex-1">
              {renderRowText(raw, matchesByLine.get(i), activeMatch)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/// Mounted-diff-body stack for the ⌘F binding — the last entry is the
/// topmost body on screen and is the only one allowed to answer the key.
const findKeyStack: Array<() => void> = [];

type DiffRowKind = 'add' | 'remove' | 'context' | 'hunk' | 'fileHeader' | 'meta';

/// Classify each raw diff line and thread the old/new line numbers
/// through from the @@ hunk headers, so the body can render an
/// editor-style gutter.
function buildDiffRows(
  lines: string[],
): Array<{ raw: string; kind: DiffRowKind; oldNum: number | null; newNum: number | null }> {
  const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let oldLine = 0;
  let newLine = 0;
  return lines.map((raw) => {
    let kind: DiffRowKind = 'context';
    if (raw.startsWith('+++') || raw.startsWith('---')) kind = 'fileHeader';
    else if (raw.startsWith('@@')) kind = 'hunk';
    else if (raw.startsWith('diff ') || raw.startsWith('index ')) kind = 'meta';
    else if (raw.startsWith('+')) kind = 'add';
    else if (raw.startsWith('-')) kind = 'remove';

    let oldNum: number | null = null;
    let newNum: number | null = null;
    if (kind === 'hunk') {
      const m = raw.match(hunkHeader);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
    } else if (kind === 'context') {
      if (oldLine && newLine) {
        oldNum = oldLine++;
        newNum = newLine++;
      }
    } else if (kind === 'add') {
      if (newLine) newNum = newLine++;
    } else if (kind === 'remove') {
      if (oldLine) oldNum = oldLine++;
    }
    return { raw, kind, oldNum, newNum };
  });
}

/// Split one diff line around its search hits. Returns the plain string
/// when there's nothing to highlight so the common (no search) path stays
/// a single text node.
function renderRowText(
  raw: string,
  hits: DiffMatch[] | undefined,
  active: DiffMatch | undefined,
): React.ReactNode {
  if (!hits?.length) return raw || ' ';
  const out: React.ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, i) => {
    if (hit.start > cursor) out.push(raw.slice(cursor, hit.start));
    const isActive = active?.line === hit.line && active?.start === hit.start;
    out.push(
      <mark
        key={i}
        className={
          'rounded-[2px] text-inherit ' + (isActive ? 'bg-amber-500/50' : 'bg-amber-500/25')
        }
      >
        {raw.slice(hit.start, hit.end)}
      </mark>,
    );
    cursor = hit.end;
  });
  if (cursor < raw.length) out.push(raw.slice(cursor));
  return out;
}

function FindButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded border border-card px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}
