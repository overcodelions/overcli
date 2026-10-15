import { useMemo } from 'react';
import { StreamEvent, UUID } from '@shared/types';
import { useRunner } from '../runnersStore';
import { useStore } from '../store';
import { useTranscriptLevel } from '../hooks';
import { ActivityStrip } from './ActivityStrip';
import {
  indexToolResults,
  latestPendingToolLabel,
  pendingSubagentIds,
} from './ChatView';

const EMPTY_EVENTS: StreamEvent[] = [];

/// Pinned "it's working…" indicator rendered in the fixed composer area,
/// just above the input — NOT inside the scrolling transcript.
///
/// The activity strip used to live only at the tail of the virtualized
/// message list. That reads naturally when you're parked at the bottom,
/// but the moment a tall permission card, a subagent's output, or a
/// manual scroll-up pushed the tail off-screen, the only "still running"
/// cue vanished and the app looked idle — even while a subagent was
/// mid-flight and the user was busy approving its tool calls. Pinning the
/// indicator here keeps the signal visible no matter where the transcript
/// is scrolled.
export function RunningIndicator({ conversationId }: { conversationId: UUID }) {
  const runner = useRunner(conversationId);
  const level = useTranscriptLevel(conversationId);
  const showToolActivity = level === 'detailed';
  const isRunning = runner?.isRunning ?? false;
  const activityLabel = runner?.activityLabel ?? '';
  const events = runner?.events ?? EMPTY_EVENTS;

  const toolResultIndex = useMemo(() => indexToolResults(events), [events]);
  const taskProgress = runner?.taskProgressByToolUse;
  const pendingIds = useMemo(
    () => pendingSubagentIds(events, toolResultIndex, taskProgress),
    [events, toolResultIndex, taskProgress],
  );
  const pendingSubagents = pendingIds.length;

  // Mirror ChatView's old gate: show whenever the runner reports a label,
  // tool activity is hidden (so the user has no other in-flight cue), or a
  // subagent is still pending. Off entirely when nothing is running.
  const show =
    isRunning && (!!activityLabel || !showToolActivity || pendingSubagents > 0);
  // When tool activity is hidden the user can't see which tool is
  // running — promote the latest in-flight tool to the strip. Falls back
  // to the runner's generic label ("Thinking…", "Running tools…").
  // At Summary the live line under the transcript already names the
  // call, so the strip stays generic rather than saying it twice. The
  // subagent count is the chip's job, not the strip's.
  const label =
    show &&
    ((level === 'quiet' && latestPendingToolLabel(events, toolResultIndex)) || activityLabel);

  // Background subagents outlive the turn, so the chip doesn't hang off
  // `show` — it's the way in to them once the strip has gone quiet.
  if (!show && pendingSubagents === 0) return null;
  return (
    <div className="flex items-center gap-2">
      {label !== false && <ActivityStrip label={label} />}
      <SubagentChip conversationId={conversationId} ids={pendingIds} />
    </div>
  );
}

/// "2 subagents running ▸" — opens the drawer on the newest one; the
/// drawer's tabs reach the rest. Without it the only way in is scrolling
/// back to the Agent card that launched each one.
function SubagentChip({ conversationId, ids }: { conversationId: UUID; ids: string[] }) {
  const openSubagentDrawer = useStore((s) => s.openSubagentDrawer);
  if (ids.length === 0) return null;
  return (
    <button
      onClick={() => openSubagentDrawer(ids[ids.length - 1], conversationId)}
      className="ml-auto flex items-center gap-1.5 rounded-full border border-indigo-500/35 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-500/20 transition-colors"
    >
      <span>●</span>
      <span>{ids.length === 1 ? '1 subagent running' : `${ids.length} subagents running`}</span>
      <span className="text-ink-faint">▸</span>
    </button>
  );
}
