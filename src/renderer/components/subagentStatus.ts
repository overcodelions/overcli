// Where a Task/Agent subagent stands, from whatever the card has to go on.
//
// A foreground subagent is easy: it's done when its tool_result lands. A
// background one (Claude Code's default now) gets an "async launched" result
// the moment it starts, so that result says nothing about whether it has
// finished — the real lifecycle arrives out-of-band as task progress, and on
// a reopened conversation there is none of that, only the subagent's own
// transcript.

import { StreamEvent, TaskProgressInfo, ToolResultBlock } from '@shared/types';

export type SubagentStatus =
  /// Still working.
  | 'running'
  | 'done'
  | 'error'
  /// Reopened background agent whose transcript doesn't show it finishing —
  /// it may have been stopped, or its file was never written. Don't claim
  /// either way.
  | 'ranInBackground';

export function isBackgroundLaunch(result: ToolResultBlock | undefined): boolean {
  return !!result && /async agent launched|async_launched/i.test(result.content);
}

/// A subagent's last word is an assistant message with text and no tool
/// calls — that's its report. Anything after a tool call means it was still
/// mid-loop when the transcript stops.
export function finishedFromEvents(events: StreamEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i].kind;
    if (k.type === 'toolResult') return false;
    if (k.type !== 'assistant') continue;
    return k.info.toolUses.length === 0 && k.info.text.trim().length > 0;
  }
  return false;
}

export function subagentStatus(args: {
  result: ToolResultBlock | undefined;
  progress: TaskProgressInfo | undefined;
  events: StreamEvent[];
}): SubagentStatus {
  const { result, progress, events } = args;
  if (!isBackgroundLaunch(result)) {
    // No result yet but progress says it finished: trust the progress.
    if (!result) return progress?.phase === 'completed' ? progressOutcome(progress) : 'running';
    return result.isError ? 'error' : 'done';
  }
  if (progress) return progress.phase === 'completed' ? progressOutcome(progress) : 'running';
  return finishedFromEvents(events) ? 'done' : 'ranInBackground';
}

function progressOutcome(progress: TaskProgressInfo): SubagentStatus {
  return progress.status && /fail|error|kill|stop/i.test(progress.status) ? 'error' : 'done';
}
