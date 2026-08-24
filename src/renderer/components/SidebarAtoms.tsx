// Two small pieces both sidebar layouts render, kept together because they
// only exist to be shared between them.

import { momentumBars } from '../sidebarMomentum';

/// How hard something is being worked, as three bars.
///
/// A meter that is always present but usually blank is noise in a list this
/// dense, so below one turn an hour this renders nothing at all — the absence
/// of a meter is itself the reading.
export function MomentumMeter({ score }: { score: number }) {
  const bars = momentumBars(score);
  if (bars === 0) return null;
  const heights = ['h-1', 'h-1.5', 'h-2.5'];
  return (
    <span
      className="flex h-2.5 flex-shrink-0 items-end gap-px"
      title={
        bars === 3
          ? 'Heads-down here'
          : bars === 2
            ? 'Steady back-and-forth'
            : 'Touched now and then'
      }
      aria-hidden
    >
      {heights.map((h, i) => (
        <span
          key={h}
          className={
            'block w-0.5 rounded-full ' +
            (i < bars ? h + (bars === 3 ? ' bg-accent' : ' bg-ink-faint') : 'h-0.5 bg-ink-faint/30')
          }
        />
      ))}
    </span>
  );
}

/// The count line that stands in for rows that have gone to sleep.
///
/// Dashed rather than filled so it reads as a fold in the list and not as
/// another row you could open — and labelled with what it is holding, because
/// a bare number ("28") next to a list of chats reads as an unread badge.
export function SleepRollup({
  count,
  open,
  onToggle,
  label = 'Sleeping',
  openLabel = 'Sleeping',
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  /// What the fold holds, when it isn't conversations — "More projects".
  label?: string;
  /// Wording once expanded. Same noun, so the control doesn't rename itself
  /// out from under the person who just clicked it.
  openLabel?: string;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={
        'mt-1 flex w-full items-center gap-2 rounded border border-dashed px-2 py-1 text-left ' +
        'text-[10px] uppercase tracking-wide transition-colors ' +
        (open
          ? 'border-ink-faint/60 text-ink-muted'
          : 'border-card-strong text-ink-faint hover:border-ink-faint hover:bg-card hover:text-ink-muted')
      }
      title={
        open
          ? 'Fold these away again'
          : `${count} not touched in a while — still here, still searchable`
      }
    >
      <span className="flex flex-shrink-0 items-center" aria-hidden>
        <span className="-mr-0.5 block h-1 w-1 rounded-full bg-ink-faint opacity-60" />
        <span className="-mr-0.5 block h-1 w-1 rounded-full bg-ink-faint opacity-40" />
        <span className="block h-1 w-1 rounded-full bg-ink-faint opacity-25" />
      </span>
      <span className="flex-1 truncate">{open ? openLabel : label}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}
