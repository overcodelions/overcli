// How much of an agent's work the transcript shows.
//
// It used to be one eye toggle: tool cards on or off. Off reads cleanly but
// says nothing about what the agent did; on says everything, a card per
// tool call. People coming from an editor that shows each edit as it lands
// found "off" silent and "on" a wall, so there is a middle:
//
//   quiet     the conversation only — the old toggle's off state
//   summary   the conversation, plus one collapsed line per turn saying
//             what was read, run and changed; the model also says what it
//             is about to do before multi-step work
//   detailed  every tool card — the old toggle's on state
//
// Cards that need an answer (a permission, a question) show at every level.

import type { AppSettings, Conversation } from './types';

export type TranscriptLevel = 'quiet' | 'summary' | 'detailed';

export const TRANSCRIPT_LEVELS: { value: TranscriptLevel; label: string; help: string }[] = [
  { value: 'quiet', label: 'Quiet', help: 'Just the conversation. Tool calls are hidden.' },
  {
    value: 'summary',
    label: 'Summary',
    help: 'The conversation, plus a line per turn of what was read, run and changed. The agent says what it is about to do.',
  },
  { value: 'detailed', label: 'Detailed', help: 'Every tool call, with commands and diffs.' },
];

/// The app-wide default. Settings saved before levels existed carry only
/// the old boolean, which was persisted whether or not anyone touched it —
/// so `false` can't be read as "chose quiet on purpose" any more than as
/// "never looked". Both map to what they showed: on → detailed, off → quiet.
export function defaultTranscriptLevel(
  settings: Pick<AppSettings, 'defaultTranscriptLevel' | 'defaultShowToolActivity'>,
): TranscriptLevel {
  return settings.defaultTranscriptLevel ?? (settings.defaultShowToolActivity ? 'detailed' : 'quiet');
}

/// A conversation's own choice wins over the app default.
export function conversationTranscriptLevel(
  conv: Pick<Conversation, 'transcriptLevel'> | null | undefined,
  fallback: TranscriptLevel,
): TranscriptLevel {
  return conv?.transcriptLevel ?? fallback;
}

/// Whether to offer Summary under a running turn. Only to someone still on
/// Quiet by default — never chose a level in Settings or this conversation's
/// header, and never closed the hint. Anyone who picked Quiet keeps it quiet.
export function offerSummaryHint(
  settings: Pick<AppSettings, 'defaultTranscriptLevel' | 'defaultShowToolActivity' | 'transcriptHintDismissed'>,
  conv: Pick<Conversation, 'transcriptLevel'> | null | undefined,
): boolean {
  return (
    !settings.transcriptHintDismissed &&
    settings.defaultTranscriptLevel === undefined &&
    !settings.defaultShowToolActivity &&
    conv?.transcriptLevel === undefined
  );
}

/// Appended to Claude's system prompt above quiet. Short on purpose: it
/// asks for a sentence before and a few lines after, not a running
/// commentary, and the last line keeps simple questions simple.
export const NARRATION_DIRECTIVE =
  'Keep the user oriented. Before work that takes several steps, say in one or two sentences ' +
  'what you are about to do. When you finish, say briefly what you changed and anything left ' +
  'for the user to do. Skip both for a simple question that needs no tools.';
