import { useMemo } from 'react';
import { StreamEvent, UUID } from '@shared/types';
import { useRunner } from '../runnersStore';
import { useStore } from '../store';
import { ActivityStrip } from './ActivityStrip';
import {
  countPendingSubagents,
  indexToolResults,
  latestPendingToolLabel,
  withSubagentSuffix,
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
  const showToolActivity = useStore((s) => s.showToolActivity);
  const isRunning = runner?.isRunning ?? false;
  const activityLabel = runner?.activityLabel ?? '';
  const events = runner?.events ?? EMPTY_EVENTS;

  const toolResultIndex = useMemo(() => indexToolResults(events), [events]);
  const pendingSubagents = useMemo(
    () => countPendingSubagents(events, toolResultIndex),
    [events, toolResultIndex],
  );

  // Mirror ChatView's old gate: show whenever the runner reports a label,
  // tool activity is hidden (so the user has no other in-flight cue), or a
  // subagent is still pending. Off entirely when nothing is running.
  const show =
    isRunning && (!!activityLabel || !showToolActivity || pendingSubagents > 0);
  if (!show) return null;

  const label = withSubagentSuffix(
    // When tool activity is hidden the user can't see which tool is
    // running — promote the latest in-flight tool to the strip. Falls back
    // to the runner's generic label ("Thinking…", "Running tools…").
    (!showToolActivity && latestPendingToolLabel(events, toolResultIndex)) ||
      activityLabel,
    pendingSubagents,
  );

  return <ActivityStrip label={label} />;
}
