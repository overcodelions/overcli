// What the start page offers back to you: the conversations in the
// project you're about to start a new one in.
//
// The order is plain last-activity, newest first — no status weighting.
// Running and just-finished work reaches the top on its own, because
// being live IS its last activity, and the row's marker says which it
// is. Sorting by state instead would let an approval prompt you ignored
// yesterday outrank the chat you were in four minutes ago, which is the
// exact case this section exists for.

import type { Conversation, UUID } from '@shared/types';
import { conversationActivityAt } from '../conversationLookup';

export type ResumeState = 'running' | 'finished' | 'idle';

export interface ResumeItem {
  conv: Conversation;
  state: ResumeState;
  /// What the ordering used, so the row can stamp the same number it
  /// sorted on rather than re-deriving it.
  at: number;
}

/// How many fit on one line beside the "N more" control, and how many
/// the expanded grid shows before the rest belong in the switcher.
export const RESUME_ROW_LIMIT = 3;
export const RESUME_GRID_LIMIT = 6;

export function resumeItems(
  conversations: readonly Conversation[],
  running: Readonly<Record<UUID, { isRunning: boolean; completedAt?: number } | undefined>>,
  now: number = Date.now(),
): ResumeItem[] {
  const out: ResumeItem[] = [];
  for (const conv of conversations) {
    if (conv.hidden) continue;
    const summary = running[conv.id];
    const isRunning = summary?.isRunning ?? false;
    // A conversation nobody ever sent a turn to is a shell the "+" left
    // behind — there is nothing in it to pick up.
    if (!isRunning && conv.turnCount <= 0) continue;
    out.push({
      conv,
      state: isRunning ? 'running' : summary?.completedAt != null ? 'finished' : 'idle',
      // A running conversation's activity is happening now. `lastActiveAt`
      // was stamped when the turn was sent, so a long turn would sink below
      // chats that have been idle the whole time it's been working.
      at: isRunning ? now : conversationActivityAt(conv),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}
