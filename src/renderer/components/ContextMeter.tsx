// How full the model's context window is, as a footer-scale caption.
//
// Exists because the only warning you used to get was the model itself
// mentioning it was running low — by which point a long flow step had
// already been degrading for a while. Auto-compact does eventually fire
// (the CLI's threshold sits just under the window), but the useful moment
// to act is well before that, so this reads as a quiet number until it
// isn't.

import { useContextOccupancy } from '../runnersStore';

/// Fraction of the window at which the caption starts drawing attention.
/// Below this the number is informational; above it, acting on it (a
/// /compact, or splitting the work) is usually the right call.
const WARN_AT = 0.6;
const DANGER_AT = 0.85;

export function ContextMeter({ conversationId }: { conversationId: string | undefined }) {
  const { tokens, window, fraction } = useContextOccupancy(conversationId);
  // Nothing to show until the conversation's first turn reports usage.
  if (tokens == null) return null;

  // Darker shades in light mode — amber/red-400 on a near-white surface at
  // 10px is unreadable, and this only earns attention if it can be read.
  const tone =
    fraction == null
      ? 'text-ink-faint'
      : fraction >= DANGER_AT
        ? 'text-red-600 dark:text-red-400'
        : fraction >= WARN_AT
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-ink-faint';

  const label =
    fraction == null
      ? `ctx ${formatTokens(tokens)}`
      : `ctx ${Math.round(fraction * 100)}% · ${formatTokens(tokens)}/${formatTokens(window!)}`;

  return (
    <span
      className={tone}
      title={
        window
          ? `${tokens.toLocaleString()} of ${window.toLocaleString()} context tokens in use as of the last request. ` +
            `Use "compact" to summarize the conversation and reclaim room.`
          : `${tokens.toLocaleString()} context tokens in use as of the last request.`
      }
    >
      · {label}
    </span>
  );
}

/// 412_003 → "412k". Matches the parser's compaction-notice formatting.
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
