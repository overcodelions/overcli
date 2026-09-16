import { ToolUseBlock } from '@shared/types';

/// Which tool cards survive the "show tool activity" toggle, and which the
/// transient flash slot is allowed to show.
///
/// These two questions are one policy and have to be answered together: the
/// slot exists to say "something is happening" for calls the transcript
/// otherwise swallows, so any card that renders inline must NOT flash or the
/// same call paints twice. That invariant was spread across three hand-kept
/// lists in two files and duly drifted — Artifact was made persistent without
/// being taken out of the flash set, and every Artifact call rendered once
/// inline and once in the footer slot until the next assistant text cleared
/// it. One module, one invariant, one test.

/// Tool names that represent user-blocking interactive prompts. These must
/// stay visible even when tool activity is hidden — otherwise the
/// conversation deadlocks silently on a question the user can't see.
export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/// Tool names whose cards stay visible even when tool activity is hidden —
/// edits and writes are the meaningful output of a turn, TodoWrite is live
/// state the user is tracking against, and Task/Agent dispatches are the
/// inline SubagentCard, which is the user's only handle to open the drawer
/// and see what the subagent is doing.
///
/// Artifact is here conditionally — see `rendersWhenToolActivityHidden`.
export const PERSISTENT_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'TodoWrite',
  'Task',
  'Agent',
  'Artifact',
]);

const ALWAYS_VISIBLE = new Set([...PERSISTENT_TOOLS, ...INTERACTIVE_TOOLS]);

/// Does this call render its own card with tool activity hidden?
///
/// Name alone answers it for every tool but Artifact, whose actions are not
/// all the same kind of event. A publish is the turn's deliverable — a page
/// that now exists, with a file behind it — and belongs in the transcript
/// permanently. A `read`, `list`, `open` or `pin` is a lookup, no different
/// from a Read or a Grep, and a full card for one is just noise sitting
/// between the prose that matters.
///
/// Judged from the input rather than the result so the card doesn't change
/// its mind when the result lands. While the input is still streaming the
/// JSON doesn't parse yet and this says no, so a card can appear late but
/// never appears and then vanishes.
export function rendersWhenToolActivityHidden(use: ToolUseBlock): boolean {
  if (use.name === 'Artifact') return isArtifactPublish(use);
  return ALWAYS_VISIBLE.has(use.name);
}

/// Is this Artifact call a publish — the action that leaves something behind?
///
/// `action` defaults to publish when omitted, which is the common case: most
/// publishes name only a `file_path`. A recorded `filePath` settles it on its
/// own, since main only attaches one to a call that wrote a page. Every other
/// publish shape counts too — a create from a `type_url`, an update that only
/// swaps `files` — so the test is the action, not the presence of a file.
export function isArtifactPublish(use: ToolUseBlock): boolean {
  if (use.filePath) return true;
  let args: Record<string, any>;
  try {
    const parsed = JSON.parse(use.inputJSON);
    if (typeof parsed !== 'object' || !parsed) return false;
    args = parsed;
  } catch {
    // Input still streaming, or malformed. Not yet knowable.
    return false;
  }
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  return !action || action === 'publish';
}

/// May the transient "now doing…" slot show this call? Anything that renders
/// inline is already on screen, so flashing it would duplicate it.
///
/// Note this is deliberately name-level for Artifact: a non-publish Artifact
/// call renders no inline card, but it doesn't flash either. Letting it flash
/// would pop a card into the footer at the exact moment the inline one
/// resolves away, which is the flicker this policy exists to prevent — and a
/// lookup against claude.ai is not what the slot is for.
export function shouldFlash(name: string): boolean {
  return !ALWAYS_VISIBLE.has(name);
}

/// Does this turn hold a card that must survive `filterRendered`?
export function hasAlwaysVisibleTool(uses: ToolUseBlock[]): boolean {
  return uses.some(rendersWhenToolActivityHidden);
}
