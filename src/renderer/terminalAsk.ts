// Asking an agent about what a terminal printed.
//
// Pure decisions, like askAboutOutput (which this reuses for the prompt):
// WHAT is handed over — the selection when there is one, otherwise the
// recent screenful — and WHERE it goes. The drawer sits under whatever the
// user is looking at, so a conversation on screen is the one being asked;
// with none, a new conversation opens in the project the shell is in. The
// text is seeded as a draft, never sent: the user still says what they want
// to know.

import type { Project } from '@shared/types';
import { isPathAtOrUnder } from '@shared/pathScope';

/// How much of the scrollback counts as "what just happened" when nothing is
/// selected: about two screens, which covers a failed command and its trace
/// without dragging in the whole session.
export const RECENT_LINES = 80;

/// The last `max` lines of a terminal buffer, with the trailing blank rows
/// below the prompt dropped (xterm reports every row of the screen).
export function recentOutput(lines: readonly string[], max = RECENT_LINES): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end -= 1;
  return lines
    .slice(Math.max(0, end - max), end)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
}

export type TerminalAskTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'project'; projectId: string }
  | null;

export function terminalAskTarget(args: {
  cwd: string;
  /// The conversation on screen, if any.
  conversationId: string | null;
  projects: readonly Pick<Project, 'id' | 'path'>[];
}): TerminalAskTarget {
  if (args.conversationId) return { kind: 'conversation', conversationId: args.conversationId };
  // The innermost project wins, for a project registered inside another.
  const owner = args.projects
    .filter((p) => isPathAtOrUnder(args.cwd, p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return owner ? { kind: 'project', projectId: owner.id } : null;
}

/// Adds the prompt below anything already being written, rather than
/// replacing a half-typed message.
export function appendToDraft(draft: string, prompt: string): string {
  const kept = draft.replace(/\s+$/, '');
  return kept ? `${kept}\n\n${prompt}` : prompt;
}
