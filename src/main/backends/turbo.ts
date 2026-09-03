// The tool-call batching directive, and turbo's effort rule.
//
// These used to be one thing. They are separable, and worth separating:
// batching is free (it costs ~50 tokens and never lowers answer quality),
// while turbo's other half — pinning effort to `low` — is a real tradeoff
// you only want when the work is mechanical. Tying them together meant the
// free half was only ever on when the expensive half was.
//
// So the directive is now unconditional, on both backends. Claude carries
// it in `--append-system-prompt`: argv is fixed at spawn, but a value that
// never varies never forces a respawn, and the system-prompt slot outranks
// anything mixed into a user message. Codex has no equivalent flag, so it
// rides in the envelope — same wording, weaker placement, which is the best
// that backend allows.

import type { EffortLevel } from '../../shared/types';
import { BATCHING_DIRECTIVE } from '../../shared/turbo';
export { BATCHING_DIRECTIVE } from '../../shared/turbo';

/// Targets tool-call *count*, not parallelism. Parallel tool use is already
/// on by default and already prompted for, so the unexploited axis is
/// consolidation: folding four greps into one shell command removes three
/// round trips outright, which beats parallelising the same four. The final
/// sentence is load-bearing — without it "fewer calls" reads as licence to
/// skip verification, which is the last thing you want stacked on low effort.
/// Turbo still pins the cheapest thinking tier for every backend that has one —
/// claude via `--effort`, codex via `model_reasoning_effort`. It deliberately
/// overrides an explicit per-conversation effort: turbo is opt-in and speed is
/// the whole point, so a turbo step on `max` would be self-contradictory.
export function resolveTurboEffort(
  turbo: boolean | undefined,
  effortLevel: EffortLevel | undefined,
): EffortLevel | undefined {
  return turbo ? 'low' : effortLevel;
}

/// Attach the directive to a prompt, for backends with no system-prompt
/// flag to put it in. Codex only — claude passes it as argv instead.
///
/// Applies unconditionally, like claude's flag: this is the "free half" of
/// what turbo used to gate. Round trips were measurably the second-largest
/// cost in a real session (16-21 requests per turn, each re-reading the
/// whole prefix), and unlike low effort, asking for consolidation does not
/// make the answer worse. The caveat sentence is what keeps that true.
///
/// Appended, not prepended, and behind a rule so it doesn't read as part of
/// what the user said. Placement matters for a reason that has nothing to do
/// with the model: codex app-server turns surface as conversations in the
/// ChatGPT client, which titles each one from the opening line of the first
/// message. A prepended directive made every conversation identically titled
/// "Prefer fewer, larger tool calls…" and unfindable. Trailing placement puts
/// the user's own words back at the top, and costs nothing in adherence —
/// instructions at the end of a prompt are followed at least as well.
export function withBatchingDirective(prompt: string): string {
  return `${prompt}\n\n---\n\n${BATCHING_DIRECTIVE}`;
}
