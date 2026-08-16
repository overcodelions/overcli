// The roster's week, on a clock.
//
// The Workers tab answers "what is this worker doing" well and "when does
// everyone work" not at all — that question was only answerable by opening six
// pages and holding six sentences in your head. This is the other view: hours
// down the side, seven days across, every worker's shifts placed where they
// actually fall.
//
// Three things carry the meaning:
//   - POSITION IS TIME. A list of times is a list; a block at 06:45 next to a
//     block at 07:00 is a collision you see without reading either label.
//   - COLOUR IS IDENTITY, TRUST IS A SHAPE. Tinting by trust made the four
//     workers on probation the same amber, which answers a question the grid
//     wasn't asking; whose block this is IS the question. Trust rides along as
//     a rung count — an ordinal mark for an ordinal fact.
//   - WORKED IS SOLID, PLANNED IS OUTLINED. History happened; a projection is
//     invalidated by a pause, a cadence edit or a missed window. Drawing them
//     alike would make a forecast look like a record.
//   - OVERLAPS SHARE THE COLUMN. Two workers at the same hour split the width
//     the way a calendar app does, so a stacked hour reads as stacked rather
//     than as one worker.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useOrchestratorStore } from '../../orchestratorStore';
import { useWorkersStore } from '../../workersStore';
import { describeTrigger } from '@shared/flows/schedule';
import type { WorkerTrustLevel } from '@shared/flows/worker';
import { TRUST_LABEL } from './WorkerRowParts';
import { WorkerAvatar } from './WorkerAvatar';
import {
  TRUST_RUNG_TOTAL,
  trustRungs,
  workerColorFor,
  workerColorMap,
} from './workerPalette';
import {
  MINUTES_IN_DAY,
  clockTime,
  dayHeading,
  dayLoad,
  isSameDay,
  layoutDay,
  minutesIntoDay,
  startOfDay,
  workerCalendar,
  type CalendarDay,
  type CalendarEntry,
  type PlacedEntry,
} from './workerCalendar';

const DAYS = 7;
/// Pixels per hour. A 30-minute block is half of this, and it has to hold a
/// worker's name on ONE line — two stacked lines at this size clipped the name
/// to its first few letters, which is the one thing the block has to say.
const HOUR_PX = 48;
const GUTTER_PX = 52;

// The grid's own lines. Written as color-mix rather than a Tailwind opacity
// modifier because these design tokens are plain `var(--c-…)` colours: Tailwind
// can only apply `/[0.07]` to a colour it can decompose into channels, so
// `bg-ink-faint/[0.07]` compiles to NOTHING (invisible hour lines) and
// `border-ink-faint/[0.09]` drops its colour and falls back to the preflight
// default (columns far louder than intended). color-mix always resolves.
//
// The hour lines carry slightly more weight than the day separators: the hours
// are what you read a block's position against, and the columns are already
// separated by the blocks themselves stopping.
const HOUR_RULE = 'color-mix(in srgb, var(--c-ink) 9%, transparent)';
const DAY_RULE = 'color-mix(in srgb, var(--c-ink) 6%, transparent)';
const TODAY_TINT = 'color-mix(in srgb, var(--c-accent) 5%, transparent)';

export function ShiftCalendar() {
  const workers = useWorkersStore((s) => s.workers);
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  // Whole weeks, moved a week at a time. `now` is captured once per render so
  // every column agrees on where today is.
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const todayStart = startOfDay(now);

  // The now-line and "is this hour past" are the only live things here, and a
  // minute is as precise as either needs to be.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const from = useMemo(() => {
    const d = new Date(todayStart);
    d.setDate(d.getDate() + offset * DAYS);
    return d.getTime();
  }, [offset, todayStart]);

  const days = useMemo(
    () => workerCalendar({ workers, orchestrations, nextShiftAt, from, days: DAYS, now }),
    [workers, orchestrations, nextShiftAt, from, now],
  );

  const roster = useMemo(
    () => Object.values(workers).sort((a, b) => a.name.localeCompare(b.name)),
    [workers],
  );
  const colors = useMemo(() => workerColorMap(Object.values(workers)), [workers]);

  // Park the scroll on the first shift of the week rather than at midnight —
  // a grid that opens on eight empty hours reads as an empty week.
  const scroller = useRef<HTMLDivElement>(null);
  const firstMinute = useMemo(() => {
    const all = days.flatMap((d) => d.entries.map((e) => minutesIntoDay(e.at)));
    return all.length > 0 ? Math.min(...all) : 8 * 60;
  }, [days]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, ((firstMinute - 60) / 60) * HOUR_PX);
  }, [firstMinute, from]);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <div className="text-sm font-medium text-ink">
          {rangeLabel(days)}
          {offset === 0 && <span className="ml-2 text-[11px] text-ink-faint">this week</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <NavButton label="‹" title="Previous week" onClick={() => setOffset((o) => o - 1)} />
          <button
            onClick={() => setOffset(0)}
            disabled={offset === 0}
            className="rounded border border-card-strong px-2 py-0.5 text-[11px] text-ink-muted hover:bg-white/5 focus:outline-none disabled:opacity-40"
          >
            Today
          </button>
          <NavButton label="›" title="Next week" onClick={() => setOffset((o) => o + 1)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-strong">
        {/* Day headers sit outside the scroller so the dates stay put while
            the hours move under them. */}
        <div className="flex shrink-0 border-b border-card-strong bg-card">
          <div className="shrink-0" style={{ width: GUTTER_PX }} />
          {days.map((day) => (
            <DayHeader key={day.at} day={day} now={now} />
          ))}
        </div>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto bg-card">
          <div className="relative flex" style={{ height: MINUTES_IN_DAY * (HOUR_PX / 60) }}>
            <HourGutter />
            {days.map((day) => (
              <DayColumn
                key={day.at}
                day={day}
                now={now}
                colors={colors}
                // A shift that HAPPENED has a transcript, so clicking it opens
                // that turn on the worker's desk — on the right day, expanded.
                // A projection has nothing to open yet; it can only introduce
                // you to the worker whose rule drew it.
                onPick={(e) =>
                  e.orchestrationId
                    ? openWorkerActivity(e.workerId, e.orchestrationId, e.at)
                    : selectWorker(e.workerId)
                }
              />
            ))}
          </div>
        </div>
      </div>

      {roster.length > 0 && (
        // The legend does what the grid can't: say in words what each cadence
        // IS, so a column that looks wrong traces back to the rule that made it.
        <div className="mt-2 flex shrink-0 flex-wrap gap-x-5 gap-y-1">
          {roster.map((w) => (
            <button
              key={w.id}
              onClick={() => selectWorker(w.id)}
              className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink focus:outline-none"
              title={`${w.name} · ${TRUST_LABEL[w.trust].text} — open`}
            >
              <WorkerAvatar worker={w} />
              <span className="text-ink-muted">{w.name}</span>
              <span>{w.enabled ? describeTrigger(w.cadence) : 'paused'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NavButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded border border-card-strong px-2 py-0.5 text-[11px] leading-4 text-ink-muted hover:bg-white/5 focus:outline-none"
    >
      {label}
    </button>
  );
}

function DayHeader({ day, now }: { day: CalendarDay; now: number }) {
  const { weekday, day: dayNum } = dayHeading(day.at);
  const today = isSameDay(day.at, now);
  const load = dayLoad(day);
  return (
    <div
      className="flex-1 px-2 py-1.5"
      style={{
        borderLeft: `1px solid ${DAY_RULE}`,
        background: today ? TODAY_TINT : undefined,
      }}
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className={
            'text-[10px] uppercase tracking-wider ' + (today ? 'text-accent' : 'text-ink-faint')
          }
        >
          {weekday}
        </span>
        <span className={'text-sm ' + (today ? 'font-semibold text-ink' : 'text-ink-muted')}>
          {dayNum}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-ink-faint">
          {load > 0 ? load : ''}
        </span>
      </div>
    </div>
  );
}

/// The hour axis. Labels hang at the line they name, which is why they sit a
/// few pixels above it — a label centred in the band belongs to no line.
function HourGutter() {
  return (
    <div
      className="relative shrink-0"
      style={{ width: GUTTER_PX, borderRight: `1px solid ${DAY_RULE}` }}
    >
      {Array.from({ length: 24 }, (_, hour) => (
        <div
          key={hour}
          className="absolute right-1.5 text-[10px] tabular-nums leading-none text-ink-faint"
          style={{ top: hour * HOUR_PX - 4 }}
        >
          {hour === 0 ? '' : hourLabel(hour)}
        </div>
      ))}
    </div>
  );
}

function DayColumn({
  day,
  now,
  colors,
  onPick,
}: {
  day: CalendarDay;
  now: number;
  colors: Record<string, string>;
  onPick: (entry: CalendarEntry) => void;
}) {
  const today = isSameDay(day.at, now);
  const placed = useMemo(() => layoutDay(day.entries), [day.entries]);

  return (
    <div
      className="relative flex-1"
      style={{
        borderLeft: `1px solid ${DAY_RULE}`,
        background: today ? TODAY_TINT : undefined,
      }}
    >
      {/* Hour rules. Barely there on purpose: they are a ruler, and a ruler
          that competes with what it measures makes the grid read as a table.
          Absolutely positioned rather than a repeating gradient so they land on
          exactly the pixels the blocks are positioned against. */}
      {Array.from({ length: 24 }, (_, hour) => (
        <div
          key={hour}
          className="absolute inset-x-0 h-px"
          style={{ top: hour * HOUR_PX, background: HOUR_RULE }}
        />
      ))}

      {today && <NowLine now={now} />}

      {placed.map((p) => (
        <ShiftBlock key={blockKey(p)} placed={p} colors={colors} onPick={onPick} />
      ))}
    </div>
  );
}

function NowLine({ now }: { now: number }) {
  const top = minutesIntoDay(now) * (HOUR_PX / 60);
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top }}>
      <div
        className="h-px w-full"
        style={{ background: 'color-mix(in srgb, var(--c-accent) 70%, transparent)' }}
      />
      <div className="absolute -left-[3px] -top-[2px] h-[5px] w-[5px] rounded-full bg-accent" />
    </div>
  );
}

function ShiftBlock({
  placed,
  colors,
  onPick,
}: {
  placed: PlacedEntry;
  colors: Record<string, string>;
  onPick: (entry: CalendarEntry) => void;
}) {
  const { entry, lane, lanes, startMinutes, endMinutes } = placed;
  const tint = workerColorFor(colors, entry.workerId);
  const worked = entry.kind === 'worked';
  // A 1px inset on each side, and lanes split what's left — the gap is what
  // makes two adjacent lanes read as two blocks rather than one wide one.
  const width = 100 / lanes;

  return (
    <button
      onClick={() => onPick(entry)}
      title={
        `${entry.workerName} (${TRUST_LABEL[entry.trust].text}) · ${clockTime(entry.at)} · ` +
        (worked ? `${entry.title ?? 'shift'} — open it` : 'projected shift')
      }
      className={
        'absolute flex items-center gap-1 overflow-hidden rounded-[3px] pl-1 pr-1 text-left ' +
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ' +
        (worked ? 'hover:brightness-125' : 'hover:brightness-110')
      }
      style={{
        top: startMinutes * (HOUR_PX / 60),
        height: Math.max(16, (endMinutes - startMinutes) * (HOUR_PX / 60) - 2),
        left: `calc(${lane * width}% + 1px)`,
        width: `calc(${width}% - 2px)`,
        background: worked
          ? `color-mix(in srgb, ${tint} 20%, transparent)`
          : `color-mix(in srgb, ${tint} 6%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} ${worked ? 45 : 22}%, transparent)`,
        borderLeft: `2px solid ${worked ? tint : `color-mix(in srgb, ${tint} 40%, transparent)`}`,
      }}
    >
      {/* One line: the time, then the name with whatever width is left. Two
          stacked lines fit the box and clipped the name — and the name is the
          block's whole point. */}
      <span
        className={
          'shrink-0 text-[9px] leading-none tabular-nums ' +
          (worked ? 'text-ink-muted' : 'text-ink-faint')
        }
      >
        {clockTime(entry.at)}
      </span>
      <span
        className={
          'min-w-0 flex-1 truncate text-[11px] leading-none ' +
          (worked ? 'text-ink' : 'text-ink-muted')
        }
      >
        {entry.workerName}
      </span>
      {entry.needsReview && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
          title="Proposals waiting for your review"
        />
      )}
      <TrustPips trust={entry.trust} color={tint} />
    </button>
  );
}

/// Trust as a three-rung ladder: one filled bar on probation, two when
/// trusted, three when autonomous — rising, so standing reads as height. Drawn
/// in the worker's own colour so it belongs to the block rather than looking
/// like a second, competing status.
function TrustPips({
  trust,
  color,
  className,
}: {
  trust: WorkerTrustLevel;
  color?: string;
  className?: string;
}) {
  const rungs = trustRungs(trust);
  return (
    <span
      className={'flex shrink-0 items-end gap-[1px] ' + (className ?? '')}
      style={color ? { color } : undefined}
      title={TRUST_LABEL[trust].text}
      aria-label={TRUST_LABEL[trust].text}
    >
      {Array.from({ length: TRUST_RUNG_TOTAL }, (_, i) => (
        <span
          key={i}
          className="w-[2px] rounded-[1px] bg-current"
          style={{ height: 3 + i * 2, opacity: i < rungs ? 0.85 : 0.18 }}
        />
      ))}
    </span>
  );
}

function blockKey(p: PlacedEntry): string {
  return `${p.entry.kind}:${p.entry.workerId}:${p.entry.orchestrationId ?? p.entry.at}`;
}

function hourLabel(hour: number): string {
  const d = new Date(2000, 0, 1, hour);
  return d.toLocaleTimeString([], { hour: 'numeric' });
}

function rangeLabel(days: CalendarDay[]): string {
  if (days.length === 0) return '';
  const first = new Date(days[0].at);
  const last = new Date(days[days.length - 1].at);
  const sameMonth = first.getMonth() === last.getMonth();
  const fmt = (d: Date, withMonth: boolean) =>
    d.toLocaleDateString([], withMonth ? { month: 'short', day: 'numeric' } : { day: 'numeric' });
  return `${fmt(first, true)} – ${fmt(last, !sameMonth)}`;
}
