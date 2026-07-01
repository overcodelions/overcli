// Sidebar entry for an in-flight (or recently completed) flow run.
// Renders under its project/workspace alongside conversations, with a
// distinct flow icon + state pip so a user can tell at a glance that
// "this isn't a chat — it's a multi-step pipeline."
//
// Click → switches detail mode to 'flows' and points the FlowRunPane at
// this run.

import { useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { useAllRunners } from '../../runnersStore';
import type { FlowRun } from '@shared/flows/schema';
import { flowRunActivityAt, flowRunOwnerPath } from '@shared/flows/schema';
import { ACTIVE_CONVERSATION_WINDOW_MS } from '../../conversationLookup';
import { deleteFlowRunWithDirtyGuard } from './deleteRun';
import { FlowMonogram } from './FlowMonogram';
import { SidebarMarker } from '../SidebarMarker';

/// True when the run's orchestrator is running, or any of its
/// participant convs is currently streaming (e.g. you're hijack-chatting
/// after the run finished). Drives the sidebar "still alive" indicator
/// so a `done` run that's still responding to you doesn't read as idle.
function runIsLive(
  run: FlowRun,
  runners: Record<string, { isRunning: boolean } | undefined>,
): boolean {
  if (run.state.kind === 'running') return true;
  return Object.values(run.conversationIds).some((cid) => runners[cid]?.isRunning);
}

/// Whether a run belongs in the top-of-sidebar "Active" set. A run
/// qualifies while it's live (orchestrating or a participant is
/// streaming) or paused, AND — mirroring how recently-touched
/// conversations linger in Active — for a grace window after its last
/// activity. Without the recency clause a finished run dropped out of
/// Active instantly, even seconds after completing.
function runIsActive(
  run: FlowRun,
  runners: Record<string, { isRunning: boolean } | undefined>,
  cutoff: number,
): boolean {
  if (runIsLive(run, runners)) return true;
  if (run.state.kind === 'running' || run.state.kind === 'paused') return true;
  // A watching run is an ongoing commitment (it's polling for follow-ups),
  // so it stays in Active until the user archives it.
  if (run.state.kind === 'watching') return true;
  return flowRunActivityAt(run) > cutoff;
}

interface FlowRunsSectionProps {
  /// Filesystem path used to match flow runs to this container. For
  /// projects: the project's repo path. For workspaces: the workspace's
  /// symlink root. Runs whose `projectPath` equals this string surface
  /// here.
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

export function FlowRunsSection({ path, query = '' }: FlowRunsSectionProps) {
  const runs = useFlowsStore((s) => s.runs);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const runners = useAllRunners();
  const matches = Object.values(runs)
    .filter((r) => flowRunOwnerPath(r) === path && flowRunMatchesQuery(r, query))
    .sort((a, b) => b.createdAt - a.createdAt);
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

/// Cheap subscription used by Sidebar to decide whether to draw the
/// Active section when there are no active conversations but a flow
/// is still live (running/paused, or you're hijack-chatting it).
export function useHasActiveFlows(): boolean {
  const runs = useFlowsStore((s) => s.runs);
  const runners = useAllRunners();
  return useMemo(() => {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    return Object.values(runs).some((r) => runIsActive(r, runners, cutoff));
  }, [runs, runners]);
}

/// Top-of-sidebar "Active" listing for flow runs. Surfaces a run when
/// it's mid-orchestration, paused waiting for the user, or when the
/// user is hijack-chatting and a participant conv is currently
/// streaming. Mirrors the conversations Active section so live work is
/// reachable from the top of the sidebar regardless of which
/// project/workspace it lives under.
export function ActiveFlowsList({ limit = 4 }: { limit?: number }) {
  const runs = useFlowsStore((s) => s.runs);
  const runners = useAllRunners();
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const setDetailMode = useStore((s) => s.setDetailMode);

  const active = useMemo(() => {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    return Object.values(runs)
      .map((run) => ({ run, live: runIsLive(run, runners) }))
      .filter(({ run }) => runIsActive(run, runners, cutoff))
      .sort((a, b) => {
        // Live > paused > recently-finished, then by recency.
        const aRank = a.live ? 2 : a.run.state.kind === 'paused' ? 1 : 0;
        const bRank = b.live ? 2 : b.run.state.kind === 'paused' ? 1 : 0;
        if (aRank !== bRank) return bRank - aRank;
        return flowRunActivityAt(b.run) - flowRunActivityAt(a.run);
      })
      .slice(0, limit);
  }, [runs, runners, limit]);

  if (active.length === 0) return null;
  return (
    <>
      {active.map(({ run, live }) => {
        const owner = resolveOwner(flowRunOwnerPath(run), projects, workspaces);
        return (
          <ActiveFlowRow
            key={run.id}
            run={run}
            isLive={live}
            ownerName={owner.name}
            ownerKind={owner.kind}
            onClick={() => {
              setActiveRun(run.id);
              setDetailMode('flows');
            }}
          />
        );
      })}
    </>
  );
}

/// Top-active row designed to be a visual sibling of RecentConversationRow:
/// left marker (pulsing while live, ✓ when done, dot otherwise), title +
/// quiet owner subtitle. No monogram, no right-side state badge — the
/// marker carries the live/done signal so the row reads like a chat.
function ActiveFlowRow({
  run,
  isLive,
  ownerName,
  ownerKind,
  onClick,
}: {
  run: FlowRun;
  isLive: boolean;
  ownerName: string;
  ownerKind: 'project' | 'workspace' | 'unknown';
  onClick: () => void;
}) {
  const completed = !isLive && run.state.kind === 'done';
  // Neutral tint matches the FlowMonogram palette feel without trying to
  // map a single backend color onto a multi-participant flow.
  const restColor = 'rgb(168 85 247 / 0.65)';
  return (
    <button
      onClick={onClick}
      className={
        'sidebar-row group mt-0.5 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs ' +
        'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card'
      }
      title={`${runTitle(run)} · ${ownerName} · ${run.state.kind}${isLive ? ' (responding)' : ''}`}
    >
      <SidebarMarker color={restColor} active={isLive} completed={completed} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{runTitle(run)}</span>
        <span className="block truncate text-[9px] leading-3.5 text-ink-faint">
          {ownerKind === 'workspace' ? 'workspace · ' : ''}
          {ownerName}
        </span>
      </span>
    </button>
  );
}

function resolveOwner(
  projectPath: string,
  projects: { id: string; name: string; path: string }[],
  workspaces: { id: string; name: string; rootPath: string }[],
): { kind: 'project' | 'workspace' | 'unknown'; name: string } {
  const ws = workspaces.find((w) => w.rootPath === projectPath);
  if (ws) return { kind: 'workspace', name: ws.name };
  const p = projects.find((p) => p.path === projectPath);
  if (p) return { kind: 'project', name: p.name };
  // Last resort: basename of the path so the row isn't blank.
  const tail = projectPath.split('/').filter(Boolean).pop() ?? projectPath;
  return { kind: 'unknown', name: tail };
}

function FlowRunRow({
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
  const setDetailMode = useStore((s) => s.setDetailMode);
  const detailMode = useStore((s) => s.detailMode);
  const [confirming, setConfirming] = useState(false);

  async function commitDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const res = await deleteFlowRunWithDirtyGuard(run.id);
    if (res.deleted) removeRun(run.id);
    setConfirming(false);
  }
  // Only show as selected when the user is actually viewing the flows
  // pane — otherwise the selection feels stale (highlighted even when
  // the user navigated to Chat / Local / etc).
  const visiblySelected = selected && detailMode === 'flows';
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
      {confirming ? (
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
            onClick={() => {
              setActiveRun(run.id);
              setDetailMode('flows');
            }}
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
            />
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

/// Sidebar title for a run. Uses the first non-empty line of the user
/// prompt so runs of the same flow are distinguishable at a glance;
/// falls back to the flow name when the prompt is blank.
function runTitle(run: FlowRun): string {
  const firstLine = run.userPrompt?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return firstLine || run.flowSnapshot.name;
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
}: {
  state: FlowRun['state']['kind'];
  isLive: boolean;
  escalated?: boolean;
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
  if (state === 'running' || (state === 'done' && isLive)) {
    return (
      <svg
        className="w-3 h-3 animate-spin text-sky-700 dark:text-sky-300 flex-shrink-0"
        viewBox="0 0 16 16"
        fill="none"
        aria-label={state === 'done' ? 'responding' : 'running'}
        role="img"
      >
        <title>{state === 'done' ? 'responding' : 'running'}</title>
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
  // it competing with active items.
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
