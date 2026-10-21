// Today's rows for things that are not one worker's run on its own: a team
// task or a process item waiting on you, and the In flight list of
// everything moving, whatever kind it is. The words and the order come
// from todayBoard.ts; this only draws them.

import { SectionLabel } from './NowSection';
import { elapsedLabel } from './nowCards';
import type { BoardKind, FlightRow, OtherNeed, TrackSeg } from './todayBoard';

const MARK: Record<BoardKind, { label: string; tile: string; tag: string }> = {
  worker: { label: 'Worker', tile: 'bg-sky-400/15 text-sky-600 dark:text-sky-300', tag: 'text-sky-600 dark:text-sky-300' },
  team: { label: 'Team', tile: 'bg-violet-400/15 text-violet-600 dark:text-violet-300', tag: 'text-violet-600 dark:text-violet-300' },
  process: { label: 'Process', tile: 'bg-emerald-400/15 text-emerald-700 dark:text-emerald-300', tag: 'text-emerald-700 dark:text-emerald-300' },
};

/// A person, a group of three, or a flow of steps: what kind of thing a row
/// is, before you read a word of it.
function KindIcon({ kind }: { kind: BoardKind }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'worker')
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
      </svg>
    );
  if (kind === 'team')
    return (
      <svg {...common}>
        <circle cx="9" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M3 20c0-3.5 3-5.5 6-5.5s6 2 6 5.5" />
        <path d="M15 14.6c3 0 6 1.6 6 4.9" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h4a3 3 0 0 1 3 3v4" />
    </svg>
  );
}

/// The kind's tile: worker, team or process, at a glance.
export function TypeMark({ kind, who }: { kind: BoardKind; who?: string }) {
  const mark = MARK[kind];
  return (
    <span
      title={who ? `${mark.label} · ${who}` : mark.label}
      aria-label={mark.label}
      className={'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ' + mark.tile}
    >
      <KindIcon kind={kind} />
    </span>
  );
}

/// "TEAM · Break-Even Cost Review": the kind in words, then whose it is.
function KindWho({ kind, who }: { kind: BoardKind; who: string }) {
  return (
    <>
      <span className={'mr-1.5 text-[10px] font-bold uppercase tracking-[0.06em] ' + MARK[kind].tag}>{MARK[kind].label}</span>
      {who}
    </>
  );
}

const SEG_INK: Record<TrackSeg, string> = {
  done: 'bg-emerald-400',
  now: 'bg-accent',
  stuck: 'bg-red-400',
  ahead: 'bg-card-strong',
};

/// One thin segment per step or stage.
export function MiniTrack({ track }: { track: TrackSeg[] }) {
  if (track.length === 0) return null;
  return (
    <span className="mt-1.5 flex h-1 w-full gap-[3px]" aria-hidden>
      {track.map((seg, i) => (
        <span key={i} className={'flex-1 rounded-full ' + SEG_INK[seg]} />
      ))}
    </span>
  );
}

/// A team task or process item waiting on you, drawn like the worker rows
/// above and below it in Needs you.
export function OtherNeedLine({
  need,
  now,
  selected,
  onOpen,
}: {
  need: OtherNeed;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className="flex w-full items-start gap-3 border-b px-3 py-2.5 text-left last:border-b-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      style={{
        borderColor: 'color-mix(in srgb, #fbbf24 18%, var(--c-card-border))',
        background: selected
          ? 'color-mix(in srgb, #fbbf24 22%, var(--c-card))'
          : 'color-mix(in srgb, #fbbf24 4%, var(--c-card))',
        boxShadow: selected ? 'inset 3px 0 0 #fbbf24' : undefined,
      }}
    >
      <TypeMark kind={need.kind} who={need.who} />
      <span className="min-w-0 flex-1">
        <span className={'block truncate text-[13px] text-ink ' + (selected ? 'font-semibold' : 'font-medium')}>{need.title}</span>
        <span className="block truncate text-[11.5px] text-ink-muted">
          <KindWho kind={need.kind} who={need.who} />
        </span>
        <span className="block truncate text-[11.5px] font-medium text-amber-700 dark:text-amber-300/90">{need.ask}</span>
      </span>
      <span className="shrink-0 text-[11px] text-ink-faint">{elapsedLabel(now - need.at)}</span>
    </button>
  );
}

/// Everything moving right now, one compact row each, with a quiet line of
/// what starts next under it.
export function InFlightSection({
  rows,
  now,
  upNext,
  isSelected,
  onOpen,
}: {
  rows: FlightRow[];
  now: number;
  /// "Up next: …", or empty.
  upNext: string;
  isSelected: (row: FlightRow) => boolean;
  onOpen: (row: FlightRow) => void;
}) {
  if (rows.length === 0 && !upNext) return null;
  return (
    <section className="flex flex-col gap-0.5">
      {rows.length > 0 && (
        <>
          <SectionLabel>In flight</SectionLabel>
          <div className="mt-1 flex flex-col">
            {rows.map((row) => (
              <FlightLine key={row.key} row={row} now={now} selected={isSelected(row)} onOpen={() => onOpen(row)} />
            ))}
          </div>
        </>
      )}
      {upNext && <p className="mt-1 truncate px-3 text-[11.5px] text-ink-faint" title={upNext}>{upNext}</p>}
    </section>
  );
}

function FlightLine({ row, now, selected, onOpen }: { row: FlightRow; now: number; selected: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      title={`${row.who}: ${row.title}`}
      className={
        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
        (selected ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-card-strong/50')
      }
      style={selected ? { boxShadow: 'inset 3px 0 0 var(--c-accent)' } : undefined}
    >
      <TypeMark kind={row.kind} who={row.who} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{row.title}</span>
          <span className={'shrink-0 text-[11px] ' + (row.stuck ? 'text-red-600 dark:text-red-400' : 'text-ink-faint')}>
            {row.stuck ? 'stuck · ' : ''}
            {elapsedLabel(now - row.startedAt)}
          </span>
        </span>
        <span className="block truncate text-[11.5px] text-ink-muted">
          <KindWho kind={row.kind} who={row.who} />
        </span>
        <span className={'block truncate text-[11.5px] ' + (row.stuck ? 'text-red-600 dark:text-red-400' : 'text-ink')}>{row.now}</span>
        <MiniTrack track={row.track} />
      </span>
    </button>
  );
}
