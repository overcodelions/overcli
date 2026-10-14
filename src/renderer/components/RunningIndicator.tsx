import { useMemo } from 'react';
import { StreamEvent, UUID } from '@shared/types';
import { useRunner } from '../runnersStore';
import { useConversation, useTranscriptLevel } from '../hooks';
import { useStore } from '../store';
import { offerSummaryHint } from '@shared/transcriptLevel';
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
///
/// `offerSummary` adds a one-time "try Summary" nudge at Quiet. Only the chat
/// pane asks for it: a flow run's conversation is synthesized, so a level
/// picked there would have nowhere to be saved.
export function RunningIndicator({
  conversationId,
  offerSummary = false,
}: {
  conversationId: UUID;
  offerSummary?: boolean;
}) {
  const runner = useRunner(conversationId);
  const level = useTranscriptLevel(conversationId);
  const showToolActivity = level === 'detailed';
  const conv = useConversation(conversationId);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const setTranscriptLevel = useStore((s) => s.setTranscriptLevel);
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

  // Quiet is the default, and from inside it nothing says there's more to
  // see. Offer the middle level once, to people who never chose.
  const hint = offerSummary && !!conv && level === 'quiet' && offerSummaryHint(settings, conv);
  if (!hint) return <ActivityStrip label={label} />;
  return (
    <div className="flex items-center gap-3">
      <ActivityStrip label={label} />
      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        Want to see what it's doing?
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => void setTranscriptLevel(conversationId, 'summary')}
        >
          Try Summary
        </button>
        <button
          type="button"
          aria-label="Don't show this again"
          title="Don't show this again"
          className="px-1 hover:text-ink"
          onClick={() => void saveSettings({ ...settings, transcriptHintDismissed: true })}
        >
          ×
        </button>
      </span>
    </div>
  );
}
