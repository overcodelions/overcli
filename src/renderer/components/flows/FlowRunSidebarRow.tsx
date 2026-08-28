// Sidebar entry for an in-flight (or recently completed) flow run.
// Renders under its project/workspace alongside conversations, with a
// distinct flow icon + state pip so a user can tell at a glance that
// "this isn't a chat — it's a multi-step pipeline."
//
// Click → switches detail mode to 'flows' and points the FlowRunPane at
// this run.

import { useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { useRunningMap } from '../../runnersStore';
import type { FlowRun } from '@shared/flows/schema';
import {
  flowRunActivityAt,
  flowRunIsOwnedBy,
  flowRunTitle as runTitle,
  isWorkerRun,
} from '@shared/flows/schema';
import { isSamePath } from '@shared/pathScope';
import { deleteFlowRunWithDirtyGuard } from './deleteRun';
import { FlowMonogram } from './FlowMonogram';
import { SidebarMarker } from '../SidebarMarker';

/// True when the run's orchestrator is running, or any of its
/// participant convs is currently streaming (e.g. you're hijack-chatting
/// after the run finished). Drives the sidebar "still alive" indicator
/// so a `done` run that's still responding to you doesn't read as idle.
export function runIsLive(
  run: FlowRun,
  runners: Record<string, { isRunning: boolean } | undefined>,
): boolean {
  if (run.state.kind === 'running') return true;
  return Object.values(run.conversationIds).some((cid) => runners[cid]?.isRunning);
}

/// Whether the badge should spin: the run isn't orchestrating, but a
/// participant is streaming, so something IS happening even though the run's
/// own state says it stopped. True for a `done` run you're hijack-chatting
/// and for a `paused` step you're talking your way through — both are runs
/// whose resting badge (✓ / ⏸) would otherwise claim nothing is going on.
export function runIsResponding(state: FlowRun['state']['kind'], isLive: boolean): boolean {
  return isLive && (state === 'done' || state === 'paused');
}

/// Whether a run's badge should say it finished with work nobody reviewed.
/// `unreviewed` comes from the main process (`unreviewedDoneRunIds`), which
/// only ever flags `done` runs; the state check here keeps the badge honest
/// if that ever changes. `isLive` matters because StateBadge intercepts a
/// live `done` run with the spinner before reaching the done branch — a run
/// you're still chatting with hasn't been abandoned, so it isn't flagged.
export function doneWithUnreviewedChanges(
  state: FlowRun['state']['kind'],
  isLive: boolean,
  unreviewed: boolean,
): boolean {
  return state === 'done' && !isLive && unreviewed;
}

/// Whether a run earns a slot in the top-of-sidebar "Active" set on merit. A
/// run qualifies while it's live (orchestrating or a participant is
/// streaming) or paused, AND — mirroring how recently-touched conversations
/// linger in Active — for a grace window after its last activity. Without the
/// recency clause a finished run dropped out of Active instantly, even
/// seconds after completing. Past that window it can still be held in Active
/// by the section's floor (see selectActiveEntries), just not on merit.
/// How long a run that is WAITING ON YOU keeps its slot in Working on.
///
/// Longer than the flat touch window, because a paused run is a question
/// somebody asked you and forgetting it is worse than forgetting a chat you
/// wandered away from. Finite, because it used to be forever: paused and
/// watching runs were unconditionally active, so a run you left mid-flow last
/// week sat at the top of the section indefinitely and crowded out the work
/// you were actually doing.
///
/// Deliberately a day longer than the sleep threshold rather than equal to
/// it: a chat that goes quiet is just old, but a paused run is a question
/// somebody asked and nobody answered, and that outlives the chat. Past this
/// it is a backlog item rather than what you are in the middle of, and it is
/// still right there in the stream with its paused badge on.
export const WAITING_RUN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function runIsActive(
  run: FlowRun,
  runners: Record<string, { isRunning: boolean } | undefined>,
  cutoff: number,
  /// Separate, older cutoff for the states that are waiting on the user.
  /// Defaults to `cutoff` so a caller that doesn't care keeps one window.
  waitingCutoff: number = cutoff,
): boolean {
  if (runIsLive(run, runners)) return true;
  if (run.state.kind === 'running') return true;
  // Paused and watching both mean the run is waiting on you — one for an
  // answer, one by polling for follow-ups. They get the longer window rather
  // than an unlimited one.
  if (run.state.kind === 'paused' || run.state.kind === 'watching') {
    return flowRunActivityAt(run) > waitingCutoff;
  }
  return flowRunActivityAt(run) > cutoff;
}

interface FlowRunsSectionProps {
  /// Filesystem path used to match flow runs to this container. For
  /// projects: the project's repo path. For workspaces: the workspace's
  /// symlink root. User-originated runs whose logical owner equals this path
  /// surface here; worker-originated runs render at their worker's desk.
  path: string;
  /// Lowercased sidebar search query. When non-empty, only runs whose
  /// title/flow name match are shown — so a search narrows the Flows
  /// list the same way it narrows conversations. Empty (the default)
  /// shows every run for the path.
  query?: string;
}

/// Whether a flow run matches the sidebar search query. Matches against
/// the run's display title (first prompt line, or flow name when blank)
/// and the underlying flow name, so users can find a run by either what
/// they asked for or which flow produced it. `query` is expected to be
/// already trimmed + lowercased; an empty query matches everything.
export function flowRunMatchesQuery(run: FlowRun, query: string): boolean {
  if (!query) return true;
  return (
    runTitle(run).toLowerCase().includes(query) ||
    run.flowSnapshot.name.toLowerCase().includes(query)
  );
}

/// The runs the Flows section shows for one project/workspace. Worker runs
/// render under their worker's desk instead, so each machine-started run has
/// one home in the sidebar.
export function flowRunsForPath(
  runs: Record<string, FlowRun>,
  path: string,
  query: string,
): FlowRun[] {
  return Object.values(runs)
    .filter(
      (run) =>
        !isWorkerRun(run) &&
        flowRunIsOwnedBy(run, path) &&
        flowRunMatchesQuery(run, query),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function FlowRunsSection({ path, query = '' }: FlowRunsSectionProps) {
  const runs = useFlowsStore((s) => s.runs);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const runners = useRunningMap();
  const matches = flowRunsForPath(runs, path, query);
  if (matches.length === 0) return null;
  return (
    <>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-ink-faint px-2">
        Flows
      </div>
      {matches.map((run) => (
        <FlowRunRow
          key={run.id}
          run={run}
          selected={run.id === activeRunId}
          isLive={runIsLive(run, runners)}
        />
      ))}
    </>
  );
}

/// Whether a WORKER's run earns a slot in Active. Stricter than
/// `runIsActive` on purpose: a worker run is machine-started, and the Active
/// section is the user's own workbench. It gets in while it is genuinely
/// happening — orchestrating, streaming a turn, or stopped waiting for the
/// user — and leaves the moment it stops, with no recency grace and no
/// backfill. The worker's desk remains the place to read a finished one.
export function workerRunIsActive(
  run: FlowRun,
  runners: Record<string, { isRunning: boolean } | undefined>,
): boolean {
  if (run.state.kind === 'archived') return false;
  // Liveness is checked before `done` is ruled out: hijack-chatting a
  // finished run still streams turns through its participant conversations,
  // and a run answering you right now belongs in Active whatever its state
  // says. Without this the row vanished mid-reply.
  if (runIsLive(run, runners)) return true;
  if (run.state.kind === 'done') return false;
  return run.state.kind === 'paused' || run.state.kind === 'watching';
}

/// Top-active row designed to be a visual sibling of RecentConversationRow:
/// left marker (pulsing while live, ✓ when done, dot otherwise), title +
/// quiet owner subtitle. No monogram, no right-side state badge — the
/// marker carries the live/done signal so the row reads like a chat.
///
/// Sidebar owns the Active section's ranking (flow runs and conversations
/// share one ordered pool), so this component just renders the row it's told
/// to.
export function ActiveFlowRow({
  run,
  isLive,
  ownerName,
  ownerKind,
  onClick,
}: {
  run: FlowRun;
  isLive: boolean;
  ownerName: string;
  ownerKind: 'project' | 'workspace' | 'unknown' | 'worker';
  onClick: () => void;
}) {
  const renameRun = useFlowsStore((s) => s.renameRun);
  const unreviewedFlag = useFlowsStore((s) => s.unreviewedRunIds[run.id] === true);
  // Same double-click-to-rename affordance as the per-project Flows row.
  // A live run is usually only visible up here, so this is where the user
  // reaches for it first.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const completed = !isLive && run.state.kind === 'done';
  const unreviewed = doneWithUnreviewedChanges(run.state.kind, isLive, unreviewedFlag);
  // Neutral tint matches the FlowMonogram palette feel without trying to
  // map a single backend color onto a multi-participant flow.
  const restColor = 'rgb(168 85 247 / 0.65)';

  if (renameValue !== null) {
    const commit = () => {
      const next = renameValue;
      setRenameValue(null);
      void renameRun(run.id, next);
    };
    return (
      <div className="mt-0.5 flex w-full items-center gap-1 rounded px-2 py-1">
        <SidebarMarker color={restColor} active={isLive} completed={completed} />
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenameValue(null);
            }
          }}
          placeholder={runTitle(run)}
          aria-label="Run name"
          className="min-w-0 flex-1 rounded border border-accent bg-transparent px-1.5 py-0.5 text-xs text-ink outline-none"
        />
      </div>
    );
  }

  return (
    <button
      onClick={onClick}
      onDoubleClick={() => setRenameValue(run.title ?? '')}
      className={
        'sidebar-row group mt-0.5 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs ' +
        'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card'
      }
      title={`${runTitle(run)} · ${ownerName} · ${run.state.kind}${isLive ? ' (responding)' : ''}${unreviewed ? ' — finished with unreviewed changes' : ''} — double-click to rename`}
    >
      <SidebarMarker color={restColor} active={isLive} completed={completed} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {runTitle(run)}
          {/* The Active section has no StateBadge, so the dot rides on the
              title itself — same amber, same meaning as the Flows row. */}
          {unreviewed && (
            <span
              className="ml-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500 align-middle"
              aria-label="finished with unreviewed changes"
            />
          )}
        </span>
        <span className="block truncate text-[9px] leading-3.5 text-ink-faint">
          {ownerKind === 'workspace' ? 'workspace · ' : ''}
          {/* Named for its WORKER, not its project: this run is one nobody
              started by hand, and the row has to say so before you click it. */}
          {ownerKind === 'worker' ? `${ownerName} · worker` : ownerName}
        </span>
      </span>
    </button>
  );
}

export function resolveOwner(
  projectPath: string,
  projects: { id: string; name: string; path: string }[],
  workspaces: { id: string; name: string; rootPath: string }[],
): { kind: 'project' | 'workspace' | 'unknown'; name: string; id: string | null } {
  // `isSamePath`, not `===`: a run persisted before the app declared its
  // productName holds `…/Application Support/overcli/workspaces/<id>` where
  // the store now holds `…/Overcli/…`. A strict compare called every one of
  // those workspaces unknown, and the lane printed the bare uuid.
  const ws = workspaces.find((w) => isSamePath(w.rootPath, projectPath));
  if (ws) return { kind: 'workspace', name: ws.name, id: ws.id };
  const p = projects.find((p) => isSamePath(p.path, projectPath));
  if (p) return { kind: 'project', name: p.name, id: p.id };
  // Last resort: basename of the path so the row isn't blank.
  const tail = projectPath.split('/').filter(Boolean).pop() ?? projectPath;
  return { kind: 'unknown', name: tail, id: null };
}

export function FlowRunRow({
  run,
  selected,
  isLive,
}: {
  run: FlowRun;
  selected: boolean;
  isLive: boolean;
}) {
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const removeRun = useFlowsStore((s) => s.removeRun);
  const renameRun = useFlowsStore((s) => s.renameRun);
  // Subscribe to this run's flag only, so a change elsewhere in the map
  // doesn't re-render every row.
  const unreviewed = useFlowsStore((s) => s.unreviewedRunIds[run.id] === true);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const detailMode = useStore((s) => s.detailMode);
  const [confirming, setConfirming] = useState(false);
  // Non-null while this row's title is an input. Renaming is allowed at
  // any point in the run's life — a run in flight is exactly the one you
  // want to label, since that's what's sitting in the list.
  const [renameValue, setRenameValue] = useState<string | null>(null);

  async function commitDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const res = await deleteFlowRunWithDirtyGuard(run.id);
    if (res.deleted) removeRun(run.id);
    setConfirming(false);
  }

  function commitRename() {
    const next = renameValue ?? '';
    setRenameValue(null);
    void renameRun(run.id, next);
  }
  // A worker's run lives on the Workers tab, next to the worker that launched
  // it — the Flows library deliberately doesn't list it, so sending a click
  // there would land on a pane with no row for what you just opened.
  const openRun = () => {
    if (run.workerId) {
      // Order matters: selectWorker clears the active run (picking a worker
      // means "show me the desk"), so it has to happen BEFORE we point at
      // this one.
      useWorkersStore.getState().selectWorker(run.workerId);
      setDetailMode('workers');
    }
    setActiveRun(run.id);
    if (!run.workerId) setDetailMode('flows');
  };

  // Only show as selected when the user is actually viewing the pane this run
  // opens in — otherwise the selection feels stale (highlighted even when
  // the user navigated to Chat / Local / etc).
  const visiblySelected = selected && detailMode === (run.workerId ? 'workers' : 'flows');
  return (
    <div
      className={
        'sidebar-row group w-full rounded text-xs truncate flex items-center gap-1.5 pr-1 ' +
        (visiblySelected
          ? 'sidebar-row-selected text-ink'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card')
      }
      title={`${runTitle(run)} — ${run.flowSnapshot.name} · ${run.state.kind}`}
    >
      {renameValue !== null ? (
        // Inline rename — same "replace the row contents" treatment as the
        // delete confirm, so the sidebar never grows a popover. Enter or
        // blur commits, Escape backs out, and an empty value clears the
        // custom title (back to the prompt-derived one).
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenameValue(null);
            }
          }}
          placeholder={runTitle(run)}
          aria-label="Run name"
          className="flex-1 min-w-0 mx-1 my-0.5 rounded border border-accent bg-transparent px-1.5 py-0.5 text-xs text-ink outline-none"
        />
      ) : confirming ? (
        // Inline confirm — replaces the row contents so we don't have to
        // squeeze native dialog styling into the app. Compact two-button
        // affordance keyed off the same row chrome.
        <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1">
          <span className="text-[11px] text-red-700 dark:text-red-300 truncate flex-1">
            Delete this run?
          </span>
          <button
            onClick={commitDelete}
            className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/80 text-white hover:bg-red-500"
          >
            Delete
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
            className="text-[10px] px-1.5 py-0.5 rounded bg-card hover:bg-card-strong text-ink-muted"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={openRun}
            onDoubleClick={() => setRenameValue(run.title ?? '')}
            className="flex items-center gap-2 flex-1 min-w-0 text-left px-2 py-1"
          >
            <FlowMonogram name={run.flowSnapshot.name} size="sm" live={isLive} />
            <span className={'truncate flex-1 ' + (visiblySelected ? 'font-semibold' : '')}>
              {runTitle(run)}
            </span>
            <StateBadge
              state={run.state.kind}
              isLive={isLive}
              escalated={run.state.kind === 'watching' && run.state.watch.escalated}
              unreviewed={doneWithUnreviewedChanges(run.state.kind, isLive, unreviewed)}
            />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Seed with the current custom title only — otherwise the
              // input opens pre-filled with the whole first line of the
              // prompt, which the user then has to clear before typing.
              // The prompt-derived title shows as the placeholder instead.
              setRenameValue(run.title ?? '');
            }}
            className={
              'w-4 h-4 flex items-center justify-center text-[10px] text-ink-faint hover:text-ink rounded transition-opacity ' +
              (visiblySelected ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100')
            }
            title="Rename this run"
            aria-label="Rename this run"
          >
            ✎
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className={
              'w-4 h-4 flex items-center justify-center text-[11px] text-ink-faint hover:text-red-400 rounded transition-opacity ' +
              (visiblySelected ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100')
            }
            title="Delete this run"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

/// Explicit state badge — spinner for running, glyph for paused, no badge
/// for completed/aborted (the run sits in the list as history but its
/// state is no longer actionable, so we don't keep drawing attention).
/// `isLive` overrides a `done` checkmark with the spinner when the user
/// is hijack-chatting a participant whose conv is currently streaming.
function StateBadge({
  state,
  isLive,
  escalated,
  unreviewed,
}: {
  state: FlowRun['state']['kind'];
  isLive: boolean;
  escalated?: boolean;
  unreviewed?: boolean;
}) {
  if (state === 'watching') {
    // A small eye with a live pulse dot, so a watching run reads as an
    // ongoing commitment in the sidebar. Turns amber with a solid dot when
    // the watcher has escalated (a comment asked for work — needs the user).
    const tone = escalated
      ? 'text-amber-600 dark:text-amber-300'
      : 'text-sky-700 dark:text-sky-300';
    return (
      <span
        className={'relative flex-shrink-0 ' + tone}
        title={escalated ? 'watching — needs you (a comment asked for work)' : 'watching for follow-ups'}
        aria-label={escalated ? 'watching, needs you' : 'watching'}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        <span className="absolute -right-0.5 -top-0.5 flex h-1.5 w-1.5">
          {!escalated && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-70" />
          )}
          <span
            className={
              'relative inline-flex h-1.5 w-1.5 rounded-full ' +
              (escalated ? 'bg-amber-500' : 'bg-sky-500')
            }
          />
        </span>
      </span>
    );
  }
  // A paused run that is streaming gets the spinner too, not the ⏸ glyph.
  // The step is genuinely paused, but while you're mid-conversation with the
  // participant the row saying only "waiting for you" is the sidebar
  // contradicting the words appearing on screen — there was no sign at all
  // that anything was happening. It keeps the amber of its paused state
  // rather than borrowing the blue of a run that resumed, and drops back to
  // ⏸ the moment the reply lands.
  const respondingWhilePaused = state === 'paused' && isLive;
  if (state === 'running' || runIsResponding(state, isLive)) {
    const label = state === 'running' ? 'running' : 'responding';
    return (
      <svg
        className={
          'w-3 h-3 animate-spin flex-shrink-0 ' +
          (respondingWhilePaused
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-sky-700 dark:text-sky-300')
        }
        viewBox="0 0 16 16"
        fill="none"
        aria-label={respondingWhilePaused ? 'paused, responding' : label}
        role="img"
      >
        <title>{respondingWhilePaused ? 'paused — responding to you' : label}</title>
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === 'paused') {
    return (
      <span
        className="text-[10px] text-amber-700 dark:text-amber-300 flex-shrink-0 leading-none"
        title="paused — waiting for you"
        aria-label="paused"
      >
        ⏸
      </span>
    );
  }
  if (state === 'aborted') {
    return (
      <span
        className="text-[10px] text-red-700 dark:text-red-300 flex-shrink-0 leading-none"
        title="aborted"
        aria-label="aborted"
      >
        ✕
      </span>
    );
  }
  // done: subtle checkmark so the user knows it finished cleanly without
  // it competing with active items. When the run left uncommitted work in
  // its worktree, the checkmark turns amber and carries a dot — same shape
  // as the escalated watching badge above — because "finished" and
  // "finished, and there's something here you haven't looked at" are
  // different facts and only the second one needs you.
  if (unreviewed) {
    return (
      <span
        className="relative text-[10px] text-amber-700 dark:text-amber-300 flex-shrink-0 leading-none"
        title="done — finished with unreviewed changes"
        aria-label="done, finished with unreviewed changes"
      >
        ✓
        <span className="absolute -right-1 -top-0.5 inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
      </span>
    );
  }
  return (
    <span
      className="text-[10px] text-emerald-700 dark:text-emerald-300/70 flex-shrink-0 leading-none"
      title="done"
      aria-label="done"
    >
      ✓
    </span>
  );
}
