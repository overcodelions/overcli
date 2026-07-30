// "Compact" affordance, parked next to the context meter in the footer —
// the number that tells you the window is filling up is the place you go
// to do something about it.
//
// All it does is send `/compact` as an ordinary turn. Both transports
// route slash commands to the CLI, which summarizes the transcript in
// place and keeps the same session id, so a flow's next step resumes the
// compacted thread rather than the bloated one.
//
// Two-step by design: compaction is irreversible and throws away detail,
// and this button sits a few pixels from the composer of a running flow.
// One stray click shouldn't summarize an hour of work.

import { useEffect, useRef, useState } from 'react';

export function CompactButton({
  onCompact,
  disabled,
  disabledReason,
}: {
  onCompact: () => void;
  disabled?: boolean;
  /// Shown as the tooltip when disabled — "why can't I click this" is the
  /// only question a greyed-out control ever raises.
  disabledReason?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Disarm after a few seconds so a half-forgotten click doesn't leave a
  // live trigger sitting under the cursor.
  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), 4000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [armed]);

  // A turn in flight owns the session; queuing a /compact behind it would
  // land at an unpredictable point.
  useEffect(() => {
    if (disabled) setArmed(false);
  }, [disabled]);

  return (
    <button
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onCompact();
      }}
      className={
        'underline decoration-dotted underline-offset-2 disabled:no-underline disabled:opacity-40 ' +
        (armed ? 'text-amber-600 dark:text-amber-400' : 'text-ink-faint hover:text-ink-muted')
      }
      title={
        disabled
          ? (disabledReason ?? 'Available once the current turn finishes')
          : 'Summarize this conversation to free up context (sends /compact). ' +
            'Detail is replaced by a summary — this cannot be undone.'
      }
    >
      {armed ? 'compact?' : 'compact'}
    </button>
  );
}
