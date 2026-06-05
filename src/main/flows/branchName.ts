// Derives a human-meaningful worktree/branch name for a flow run from the
// launch prompt, so the auto-created branch reads like `feature/WOW-1234`
// instead of `feature/flow-new-flow-d74b2db3`. Agent mode gets this for
// free because the user types a name; flows only have a prompt, so we mine
// the prompt for something better than a uuid slice.

/// Matches a Jira/Linear-style ticket key: 2+ UPPER-case letters, optional
/// trailing digits, a hyphen, and a number — e.g. WOW-1234, ABC2-17, PROJ-9.
/// Upper-case-only is deliberate: it's what people actually type for a
/// ticket, and it avoids grabbing lower-case hyphenated tokens like `utf-8`.
const TICKET_KEY = /\b[A-Z]{2,}[0-9]*-\d+\b/;

/// Derive a branch slug from the launch prompt. Priority:
///   1. A ticket key mentioned anywhere in the prompt — used verbatim
///      (upper-cased), so "fix WOW-1234" → `WOW-1234`.
///   2. A short kebab slug of the prompt's first meaningful words.
///   3. `flow-<flowId>` when the prompt yields nothing usable.
/// The caller owns uniqueness — a clean name can collide when the same
/// prompt/ticket is run twice (see uniqueWorktreeName in runtime).
export function branchSlugFromPrompt(prompt: string, flowId: string): string {
  const ticket = prompt.match(TICKET_KEY);
  if (ticket) return ticket[0].toUpperCase();

  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 50)
    .replace(/-+$/g, '');

  return slug || `flow-${flowId}`;
}
