// Shared turbo text. Claude takes it via `--append-system-prompt`; codex has
// no equivalent flag, so its backend prepends it to the prompt envelope.
// Same wording either way — turbo should mean one thing across backends.

import type { EffortLevel } from '../../shared/types';

/// Targets tool-call *count*, not parallelism. Parallel tool use is already
/// on by default and already prompted for, so the unexploited axis is
/// consolidation: folding four greps into one shell command removes three
/// round trips outright, which beats parallelising the same four. The final
/// sentence is load-bearing — without it "fewer calls" reads as licence to
/// skip verification, which is the last thing you want stacked on low effort.
/// Turbo pins the cheapest thinking tier for every backend that has one —
/// claude via `--effort`, codex via `model_reasoning_effort`. It deliberately
/// overrides an explicit per-conversation effort: turbo is opt-in and speed is
/// the whole point, so a turbo step on `max` would be self-contradictory.
export function resolveTurboEffort(
  turbo: boolean | undefined,
  effortLevel: EffortLevel | undefined,
): EffortLevel | undefined {
  return turbo ? 'low' : effortLevel;
}

export const TURBO_SYSTEM_PROMPT =
  'Prefer fewer, larger tool calls. Batch independent calls into a single message, ' +
  'and combine several shell steps into one command rather than issuing them one at ' +
  'a time. Never skip a check you would otherwise run just to reduce the call count.';
