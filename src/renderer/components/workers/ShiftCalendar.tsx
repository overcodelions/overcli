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
//
// SCHEDULES sit on the same grid, in one steel tone with a clock mark. They
// are the other half of what runs unattended, and a week view that drew only
// the workers let a schedule fire into the same hour as three shifts without
// ever showing you the pile-up. They are a species, not a colleague: one
// colour for all of them, no trust pips, and a toggle in the header for when
// the roster is the only thing you want to look at.
//
// UP NEXT sits above the grid. The grid answers "what does the week look
// like"; it does not answer "what happens next", which needs a countdown and
// is the question you have while the week is still mostly empty. The strip is
// that answer in words, and it rings the block it names so the two readings
// are visibly the same fact.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useSchedulesStore } from '../../schedulesStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import {
  scheduleSubjects,
  upcomingAgenda,
  workerSubjects,
  type AutomationSubject,
} from '../../upcoming';
import { describeTrigger, untilLabel } from '@shared/flows/schedule';
import type { Schedule } from '@shared/flows/schedule';
import type { Worker, WorkerTrustLevel } from '@shared/flows/worker';
import { TRUST_LABEL } from './WorkerRowParts';
import { WorkerAvatar } from './WorkerAvatar';
import {
  SCHEDULE_TINT,
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
  entryKey,
  isNextUp,
  isSameDay,
  layoutDay,
  minutesIntoDay,
  startOfDay,
  workerCalendar,
  type CalendarDay,
  type CalendarEntry,
  type PlacedEntry,
} from './workerCalendar';

/// Stable identity, so the preview toggle can hand the calendar an empty
/// roster without a fresh object re-running every memo each render.
const EMPTY_ROSTER: Record<string, Worker> = {};
const EMPTY_SCHEDULES: Record<string, Schedule> = {};

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

/// How many occurrences the up-next strip names. Three fits one line at every
/// pane width the app allows and is about as far ahead as a countdown is worth
/// reading — past that you are asking about the week, which the grid answers.
const UP_NEXT = 3;

export function ShiftCalendar() {
  const previewEmpty = useWorkersStore((s) => s.previewEmpty);
  const workers = useWorkersStore((s) => (s.previewEmpty ? EMPTY_ROSTER : s.workers));
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const allSchedules = useSchedulesStore((s) => s.schedules);
  const nextFireAt = useSchedulesStore((s) => s.nextFireAt);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const closeFlowEditor = useFlowsStore((s) => s.closeEditor);
  const setLibrarySegment = useFlowsStore((s) => s.setLibrarySegment);
  const setActiveOrchestration = useOrchestratorStore((s) => s.setActiveOrchestration);
  const requestOrchestrationDetail = useOrchestratorStore(
    (s) => s.requestOrchestrationDetail,
  );

  // Whole weeks, moved a week at a time. `now` is captured once per render so
  // every column agrees on where today is.
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Schedules are on by default — they run against the same project and the
  // same machine as the roster, so hiding them by default would restore the
  // exact blind spot this view exists to close. The toggle is for the moment
  // you're arranging the roster and the machinery is in the way.
  const [showSchedules, setShowSchedules] = useState(true);
  const todayStart = startOfDay(now);

  // The empty-state preview means "as if this were a fresh install", so it
  // takes the schedules with it — a grid still full of scheduled firings is
  // not the screen the preview exists to let you look at.
  const schedules = showSchedules && !previewEmpty ? allSchedules : EMPTY_SCHEDULES;

  // The now-line, the countdowns and "is this hour past" are the only live
  // things here, and a minute is as precise as any of them needs to be.
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
    () =>
      workerCalendar({
        workers,
        orchestrations,
        nextShiftAt,
        schedules,
        nextFireAt,
        from,
        days: DAYS,
        now,
      }),
    [workers, orchestrations, nextShiftAt, schedules, nextFireAt, from, now],
  );

  // What's coming, across both species. Computed from the engines' own next
  // times rather than from the grid: the grid is one week wide, and "next" has
  // to keep answering when you page forward to look at something else.
  const agenda = useMemo(
    () =>
      upcomingAgenda(
        [
          ...workerSubjects(workers, nextShiftAt, shiftProgress),
          ...scheduleSubjects(schedules, nextFireAt),
        ],
        UP_NEXT,
      ),
    [workers, nextShiftAt, shiftProgress, schedules, nextFireAt],
  );

  // Which up-next chip the grid is ringing. Null means the soonest one, which
  // is what the strip is for; hovering another chip lends it the ring so you
  // can find its block without clicking away from the week.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const focused = agenda[focusIndex ?? 0] ?? null;
  const focusMark = focused
    ? { source: focused.source, id: focused.id, at: focused.nextAt as number }
    : null;

  const roster = useMemo(
    () => Object.values(workers).sort((a, b) => a.name.localeCompare(b.name)),
    [workers],
  );
  const armedSchedules = useMemo(
    () => Object.values(schedules).sort((a, b) => a.name.localeCompare(b.name)),
    [schedules],
  );
  const colors = useMemo(() => workerColorMap(Object.values(workers)), [workers]);

  function openSchedules(): void {
    setActiveRun(null);
    closeFlowEditor();
    setLibrarySegment('schedules');
    setDetailMode('flows');
  }

  /// Where a block goes when you click it. A shift that HAPPENED has a
  /// transcript, so it opens that turn on the worker's desk — on the right
  /// day, expanded. A schedule firing opens whatever it produced: the flow run
  /// it launched, or the batch it parked. Anything with nothing behind it yet
  /// (every projection) can only introduce you to the rule that drew it.
  function openEntry(e: CalendarEntry): void {
    if (e.source === 'worker') {
      if (e.orchestrationId) openWorkerActivity(e.subjectId, e.orchestrationId, e.at);
      else selectWorker(e.subjectId);
      return;
    }
    if (e.runId) {
      setActiveRun(e.runId);
      setDetailMode('flows');
      return;
    }
    if (e.orchestrationId) {
      setActiveOrchestration(e.orchestrationId);
      requestOrchestrationDetail(e.orchestrationId);
      setDetailMode('orchestrator');
      return;
    }
    openSchedules();
  }

  function openSubject(subject: AutomationSubject): void {
    if (subject.source === 'worker') selectWorker(subject.id);
    else openSchedules();
  }

  // Park the scroll where the answer is: on the current week that's the next
  // occurrence (the thing the strip is counting down to — an off-screen
  // countdown is a riddle), and on any other week the first block in it, so a
  // grid that opens on eight empty hours doesn't read as an empty week.
  const scroller = useRef<HTMLDivElement>(null);
  const soonestAt = agenda[0]?.nextAt ?? null;
  const parkMinute = useMemo(() => {
    if (offset === 0 && soonestAt !== null && soonestAt < from + DAYS * 86_400_000) {
      return minutesIntoDay(soonestAt);
    }
    const all = days.flatMap((d) => d.entries.map((e) => minutesIntoDay(e.at)));
    return all.length > 0 ? Math.min(...all) : 8 * 60;
    // Deliberately keyed on the SOONEST occurrence, not on the focused one:
    // hovering a chip lends it the ring, and scrolling the grid on hover would
    // make the week jump about under a pointer that is only browsing.
  }, [days, from, offset, soonestAt]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, ((parkMinute - 60) / 60) * HOUR_PX);
  }, [parkMinute, from]);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <div className="text-sm font-medium text-ink">
          {rangeLabel(days)}
          {offset === 0 && <span className="ml-2 text-[11px] text-ink-faint">this week</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {Object.keys(allSchedules).length > 0 && (
            <button
              onClick={() => setShowSchedules((v) => !v)}
              title={
                showSchedules
                  ? 'Hide scheduled flows — show the roster on its own'
                  : 'Show scheduled flows alongside the roster'
              }
              className={
                'mr-1 flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] focus:outline-none ' +
                (showSchedules
                  ? 'border-card-strong text-ink-muted hover:bg-white/5'
                  : 'border-transparent text-ink-faint hover:bg-white/5')
              }
            >
              <ClockMark color={showSchedules ? SCHEDULE_TINT : 'currentColor'} />
              Schedules
            </button>
          )}
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

      {agenda.length > 0 && (
        <UpNextStrip
          agenda={agenda}
          now={now}
          colors={colors}
          focusIndex={focusIndex ?? 0}
          onHover={setFocusIndex}
          onOpen={openSubject}
        />
      )}

      {/* A grid of seven empty columns is a confusing way to say "you have
          not hired anyone" — the roster's absence is the fact, not the week's
          emptiness. */}
      {roster.length === 0 && (
        <div className="mb-2 rounded-lg border border-dashed border-card-strong px-4 py-3 text-center text-xs text-ink-muted">
          Nobody works here yet. Hire a worker and its shifts will lay themselves out here.
        </div>
      )}

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
                focus={focusMark}
                onPick={openEntry}
              />
            ))}
          </div>
        </div>
      </div>

      {(roster.length > 0 || armedSchedules.length > 0) && (
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
          {armedSchedules.map((s) => (
            <button
              key={s.id}
              onClick={openSchedules}
              className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink focus:outline-none"
              title={`${s.name} — open Schedules`}
            >
              <ClockMark color={SCHEDULE_TINT} />
              <span className="text-ink-muted">{s.name}</span>
              <span>{s.enabled ? describeTrigger(s.trigger) : 'paused'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// "What happens next", in words, above the week.
///
/// The countdown is the point. A block at Thursday 09:00 tells you where in
/// the week something falls; "in 40m" tells you whether to wait for it, and
/// that is the thing you came to the calendar to find out.
function UpNextStrip({
  agenda,
  now,
  colors,
  focusIndex,
  onHover,
  onOpen,
}: {
  agenda: AutomationSubject[];
  now: number;
  colors: Record<string, string>;
  focusIndex: number;
  onHover: (index: number | null) => void;
  onOpen: (subject: AutomationSubject) => void;
}) {
  return (
    <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
        Up next
      </span>
      {agenda.map((item, i) => {
        const at = item.nextAt as number;
        const tint =
          item.source === 'worker' ? workerColorFor(colors, item.id) : SCHEDULE_TINT;
        // Only the leader is drawn as the answer. The other two are context —
        // giving all three the same weight turns a countdown into a list, and
        // a list has no "next" in it.
        const lead = i === focusIndex;
        return (
          <button
            key={`${item.source}:${item.id}`}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
            onClick={() => onOpen(item)}
            title={`${item.name} · ${item.cadence} · ${new Date(at).toLocaleString()}`}
            className={
              'flex items-center gap-1.5 rounded-full py-0.5 pl-1.5 pr-2.5 text-[11px] focus:outline-none ' +
              (lead ? 'text-ink' : 'text-ink-muted hover:text-ink')
            }
            style={{
              background: lead
                ? `color-mix(in srgb, ${tint} 14%, transparent)`
                : 'color-mix(in srgb, var(--c-ink) 4%, transparent)',
              border: `1px solid color-mix(in srgb, ${tint} ${lead ? 45 : 16}%, transparent)`,
            }}
          >
            {item.source === 'schedule' ? (
              <ClockMark color={tint} />
            ) : (
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: tint }}
              />
            )}
            <span className="max-w-[14rem] truncate">{item.name}</span>
            <span className={'tabular-nums ' + (lead ? 'text-ink-muted' : 'text-ink-faint')}>
              {item.running ? 'running now' : untilLabel(at, now)}
            </span>
            <span className="tabular-nums text-ink-faint">{clockTime(at)}</span>
          </button>
        );
      })}
    </div>
  );
}

/// A schedule's mark: a clock face at pip size. One glyph for the whole
/// species, so "this is machinery, not a colleague" is readable at 11px
/// without spending a colour on it.
function ClockMark({ color, className }: { color?: string; className?: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className={'shrink-0 ' + (className ?? '')}
      style={color ? { color } : undefined}
    >
      <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 2.8V5l1.7 1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
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
  focus,
  onPick,
}: {
  day: CalendarDay;
  now: number;
  colors: Record<string, string>;
  focus: { source: string; id: string; at: number } | null;
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
        <ShiftBlock
          key={entryKey(p.entry)}
          placed={p}
          colors={colors}
          nextUp={isNextUp(p.entry, focus)}
          onPick={onPick}
        />
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
  nextUp,
  onPick,
}: {
  placed: PlacedEntry;
  colors: Record<string, string>;
  nextUp: boolean;
  onPick: (entry: CalendarEntry) => void;
}) {
  const { entry, lane, lanes, startMinutes, endMinutes } = placed;
  const schedule = entry.source === 'schedule';
  const tint = schedule ? SCHEDULE_TINT : workerColorFor(colors, entry.subjectId);
  const worked = entry.kind === 'worked';
  // A 1px inset on each side, and lanes split what's left — the gap is what
  // makes two adjacent lanes read as two blocks rather than one wide one.
  const width = 100 / lanes;

  return (
    <button
      onClick={() => onPick(entry)}
      title={blockTitle(entry)}
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
        // The block the up-next strip is naming. A ring rather than a louder
        // fill: the block still has to read as the projection it is, and the
        // ring is the only mark on the grid that means "this one, the one I
        // just told you about".
        boxShadow: nextUp ? `0 0 0 1.5px color-mix(in srgb, ${tint} 75%, transparent)` : undefined,
        zIndex: nextUp ? 5 : undefined,
      }}
    >
      {/* One line: the time, then the name with whatever width is left. Two
          stacked lines fit the box and clipped the name — and the name is the
          block's whole point. */}
      {schedule && <ClockMark color={tint} />}
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
        {entry.subjectName}
      </span>
      {entry.outcome === 'failed' && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
          title="This firing failed"
        />
      )}
      {entry.needsReview && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
          title="Proposals waiting for your review"
        />
      )}
      {entry.trust && <TrustPips trust={entry.trust} color={tint} />}
    </button>
  );
}

function blockTitle(entry: CalendarEntry): string {
  const when = clockTime(entry.at);
  if (entry.source === 'schedule') {
    const tail =
      entry.kind === 'planned'
        ? 'scheduled to fire'
        : entry.runId || entry.orchestrationId
          ? `${entry.title ?? 'fired'} — open it`
          : (entry.title ?? 'fired');
    return `${entry.subjectName} (schedule) · ${when} · ${tail}`;
  }
  const trust = entry.trust ? ` (${TRUST_LABEL[entry.trust].text})` : '';
  const tail =
    entry.kind === 'worked' ? `${entry.title ?? 'shift'} — open it` : 'projected shift';
  return `${entry.subjectName}${trust} · ${when} · ${tail}`;
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
