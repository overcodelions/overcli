// Bounded accumulation for `Conversation.pendingContextUpdate`.
//
// Workspace edits (member list, instructions, agent provisioning) queue an
// in-band notice onto every conversation in the workspace, because a live
// CLI subprocess only reads CLAUDE.md / AGENTS.md / GEMINI.md at session
// start. The notice is prepended to that conversation's next prompt and
// then cleared.
//
// A conversation you never send to again never clears it, so the field grew
// without bound — one real workspace had 103 stacked notices (52 KB) on a
// single conversation, which both bloated the persisted store and would have
// prepended ~13k tokens of stale churn to the next message. Each notice also
// states that the on-disk context files were already refreshed with the
// current member list, so older entries are superseded by newer ones anyway.
//
// We therefore dedupe (newest copy of a repeated notice wins) and keep only
// the most recent few.

/// Notices are joined with a blank line, and each one opens with a bracketed
/// label on its own line (`[Workspace context update]`, `[Workspace agent
/// update]`). Splitting on that header rather than on the blank line matters:
/// the notice bodies contain blank lines of their own.
const NOTICE_HEADER = /^\[[^\]\n]+\]$/gm;

/// How many notices to retain. They supersede one another, so this only needs
/// to be deep enough that a burst of distinct edits before the next send still
/// reaches the agent.
export const MAX_PENDING_CONTEXT_NOTICES = 5;

function splitNotices(value: string): string[] {
  const starts: number[] = [];
  const re = new RegExp(NOTICE_HEADER.source, NOTICE_HEADER.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) starts.push(match.index);
  // No recognizable header — some other format we don't own. Treat the whole
  // string as one block so we never silently drop content we can't parse.
  if (starts.length === 0) return [value.trim()].filter(Boolean);
  // Anything before the first header rides along with it rather than getting
  // dropped.
  starts[0] = 0;

  const out: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : value.length;
    const block = value.slice(starts[i], end).trim();
    if (block) out.push(block);
  }
  return out;
}

/// Dedupe and cap an accumulated `pendingContextUpdate`. Returns `undefined`
/// for empty input so callers can drop the key entirely.
export function trimContextNotices(
  value: string | null | undefined,
): string | undefined {
  if (!value || !value.trim()) return undefined;
  const blocks = splitNotices(value);

  // Walk newest → oldest so a repeated notice keeps its most recent position,
  // then restore chronological order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (seen.has(block)) continue;
    seen.add(block);
    deduped.push(block);
  }
  deduped.reverse();

  const capped = deduped.slice(-MAX_PENDING_CONTEXT_NOTICES);
  return capped.length ? capped.join('\n\n') : undefined;
}

/// Append a fresh notice to whatever is already queued, keeping the result
/// deduped and capped.
export function appendContextNotice(
  existing: string | null | undefined,
  notice: string,
): string {
  const merged = existing ? `${existing}\n\n${notice}` : notice;
  return trimContextNotices(merged) ?? notice;
}
