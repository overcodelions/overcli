// The roster, read as a board.
//
// The Workers sidebar used to draw the roster in hire order and let you find
// the interesting worker yourself. On a thirteen-worker crew that is a scan of
// thirteen two-line rows before you learn that one of them is waiting on you,
// so this file does the scanning: every worker lands in exactly ONE group, and
// the group says what the worker is to you right now rather than when it was
// hired.
//
// Two rules make the grouping worth having:
//
//   1. EACH WORKER APPEARS ONCE. The old "Needs you" block was a summary that
//      repeated a row already drawn below it, which cost two rows to say one
//      thing and made the count at the top disagree with the roster under it.
//      Here the most urgent group wins and the row carries every signal the
//      worker has — a worker that is both waiting on you and mid-errand sits
//      under "Needs you" wearing the review pill AND the live dot.
//   2. GROUPS KEEP ROSTER ORDER INSIDE THEM. Position is funding priority, and
//      the move controls still nudge a worker within the group it is DRAWN in
//      (see `moveWithinGroup`) — the same bargain the old active/bench split
//      already made, extended to five groups instead of two.

import type { FlowRun } from '@shared/flows/schema';
import { untilLabel } from '@shared/flows/schedule';
import { describeCadence, type Worker } from '@shared/flows/worker';
import { describeActivity, startOfDay, type WorkerActivity } from './workerDeskSelectors';

/// The groups, in the order they are drawn. Ordered by how much of your
/// attention the group is asking for, which is the whole point of grouping.
export const BOARD_GROUPS = ['needsYou', 'running', 'today', 'quiet', 'bench'] as const;
export type BoardGroupId = (typeof BOARD_GROUPS)[number];

/// One worker, with everything the row needs already reduced to counts. Built
/// by the sidebar (which owns the stores) so that every function below is
/// pure and testable.
export interface BoardEntry {
  worker: Worker;
  /// Items proposed and waiting for a person.
  review: number;
  /// Runs stopped mid-flight, waiting for a person.
  pausedRuns: number;
  /// What the worker's project or workspace is called — or empty when every
  /// worker on the board shares one, where the label would be the same word
  /// under every name. See `boardLine`, which spends it last.
  home: string;
  /// This worker's runs, newest first. The row draws the ones that are
  /// blocked or in flight (see `railRuns`); the count above is what the
  /// grouping reads, and stays because a group must not have to walk a list
  /// to learn one bit.
  runs: FlowRun[];
  /// The pay queue ran dry above this worker.
  starved: boolean;
  /// Mid-turn right now — a shift in progress, or a run still going.
  live: boolean;
  /// Today's turns, newest first. The strip's ticks and the second line both
  /// read off this, so a worker that did nothing today has an empty array and
  /// renders as visibly empty rather than as a stale yesterday.
  today: WorkerActivity[];
  /// The bounded activity list used by the expanded roster row. Keeping it on
  /// the board entry prevents every row from rescanning the orchestration map.
  recent: WorkerActivity[];
  /// The newest turn of any day — what "worked today" degrades to for a
  /// worker whose last act was Tuesday.
  newest: WorkerActivity | null;
  /// Where a click should LAND for a worker that needs you: the turn holding
  /// the decision, not the worker. Null when the row is waiting on funding
  /// alone, or the paused run's batch cannot be found.
  target: { orchestrationId: string; at: number } | null;
}

/// The one group this worker belongs in.
///
/// Deliberately a cascade rather than a set of flags: a worker is only ever
/// drawn once, so the question is not "which of these are true" but "which of
/// these is the most true", and the order of the checks IS that answer.
export function boardGroup(entry: BoardEntry): BoardGroupId {
  if (!entry.worker.enabled) return 'bench';
  if (entry.review > 0 || entry.pausedRuns > 0 || entry.starved) return 'needsYou';
  if (entry.live) return 'running';
  if (entry.today.length > 0) return 'today';
  return 'quiet';
}

/// How a worker's face in the rail is marked.
///
/// The rail keeps every worker in the slot you gave it — status must never
/// move a row, or the row you were reaching for is somewhere else by the time
/// you click. So the group a worker would be drawn under becomes a mark on its
/// face instead. "Needs you" splits in two because the rail has no caption to
/// say why: violet is waiting on a decision, amber is stopped.
export type RailMark = 'waiting' | 'stopped' | 'running' | 'today' | 'quiet' | 'bench';

export function railMark(entry: BoardEntry): RailMark {
  const group = boardGroup(entry);
  if (group === 'needsYou') return entry.review > 0 ? 'waiting' : 'stopped';
  return group;
}

/// Where a face dropped on `targetId` lands, as the `insertBefore` index
/// `dropWorker` takes — an index into the FULL roster order, moved worker
/// included, so a drop while the rail is filtered can't reshuffle the workers
/// the filter hid. Null when the target is not on the roster.
export function railDropIndex(
  ordered: readonly Pick<Worker, 'id'>[],
  targetId: string,
  after: boolean,
): number | null {
  const index = ordered.findIndex((w) => w.id === targetId);
  if (index === -1) return null;
  return after ? index + 1 : index;
}

/// Workers hired for a team who work only for it: tagged `hiredFor`, on
/// demand, and on a team now. The rail reaches them through their team rather
/// than giving each its own row — they never work a shift and you brief the
/// team, not them. Give one a shift and it is back on the crew list.
export function teamOnlyIds(
  workers: readonly Pick<Worker, 'id' | 'hiredFor' | 'cadence'>[],
  teams: readonly { members: readonly { workerId: string }[] }[],
): Set<string> {
  const onTeam = new Set(teams.flatMap((t) => t.members.map((m) => m.workerId)));
  return new Set(workers.filter((w) => !!w.hiredFor && w.cadence === null && onTeam.has(w.id)).map((w) => w.id));
}

export interface ProjectGroup {
  /// The project path, the group's identity.
  key: string;
  label: string;
  entries: BoardEntry[];
}

/// The crew by project, for the rail. Membership is where a worker works,
/// never what it is doing, so a face only changes group when you move it.
/// Groups come in the order their first worker does, and keep the roster's
/// order inside — your order, unchanged, just with dividers in it.
export function groupByProject(entries: readonly BoardEntry[], labelOf: (path: string) => string): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const entry of entries) {
    const key = entry.worker.projectPath;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: labelOf(key), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/// What a folded group says about the faces it hides: only what you would
/// act on, most urgent first.
export function foldSummary(entries: readonly BoardEntry[]): Array<{ text: string; tone: 'waiting' | 'stopped' | 'running' }> {
  const count = (mark: RailMark) => entries.filter((e) => railMark(e) === mark).length;
  const out: Array<{ text: string; tone: 'waiting' | 'stopped' | 'running' }> = [];
  const waiting = count('waiting');
  const stopped = count('stopped');
  const running = count('running');
  if (waiting) out.push({ text: `${waiting} need${waiting === 1 ? 's' : ''} you`, tone: 'waiting' });
  if (stopped) out.push({ text: `${stopped} stopped`, tone: 'stopped' });
  if (running) out.push({ text: `${running} working`, tone: 'running' });
  return out;
}

export type BoardGroups = Record<BoardGroupId, BoardEntry[]>;

/// The whole roster, split. Input order is preserved inside every group, so
/// callers hand this the roster already sorted by funding priority and get it
/// back sorted the same way.
export function groupBoard(entries: BoardEntry[]): BoardGroups {
  const out: BoardGroups = { needsYou: [], running: [], today: [], quiet: [], bench: [] };
  for (const entry of entries) out[boardGroup(entry)].push(entry);
  return out;
}

/// Why this worker is in "Needs you", in words. Empty when it isn't.
export function boardReasons(entry: BoardEntry): string {
  return [
    entry.review > 0 && `${entry.review} to review`,
    entry.pausedRuns > 0 &&
      (entry.pausedRuns === 1 ? 'a flow paused' : `${entry.pausedRuns} flows paused`),
    entry.starved && 'unfunded',
  ]
    .filter(Boolean)
    .join(' · ');
}

/// The row's one second line.
///
/// Ordered by how perishable the fact is. What is happening now, and what is
/// waiting on you, both expire — so they come first, and they are joined
/// rather than made to compete, because "3 to review · on your errand" is two
/// different things and dropping either one loses a fact the row was carrying.
/// Then the OUTCOME of the last turn, which is what the second line is for
/// once the row is quiet: a tagline is true all day and says nothing about
/// today. The tagline is the floor, not the default — it is the only thing
/// telling six personas apart on a roster that has never run.
///
/// Null renders as no line at all. An absent line is the correct drawing of
/// nothing happening; "no work yet" on four rows is noise.
export function boardLine(
  entry: BoardEntry,
  status: string | null,
  tagline: string,
): string | null {
  const live = [boardReasons(entry), status].filter(Boolean).join(' · ');
  if (live) return live;
  const last = entry.today[0] ?? entry.newest;
  // An errand is a thing you asked for and the worker named; the name is more
  // use than its tally. A shift names itself after its number, which the row
  // already implies, so a shift is worth only what came out of it.
  if (last) return last.task === 'errand' ? last.title : describeActivity(last);
  return tagline || null;
}


/// What one worker is doing right now, for the head of its own page.
///
/// The roster row can afford two words ("working a shift"); a page given over
/// to one worker cannot, because it is the page you open to find out. So this
/// carries the live line the turn is streaming, and when nothing is running it
/// says when something next will — "idle" alone reads as broken on a worker
/// whose next shift is at nine.
export interface WorkerNow {
  tone: 'running' | 'idle' | 'bench';
  label: string;
  detail: string | null;
}

export function workerNow(
  worker: Pick<Worker, 'enabled' | 'cadence'>,
  progress: { task: 'shift' | 'errand'; text: string; tools: string[] } | undefined,
  live: boolean,
  nextShiftAt: number | null | undefined,
  now: number,
): WorkerNow {
  if (!worker.enabled) return { tone: 'bench', label: 'On the bench', detail: 'paused — no shifts or errands' };
  if (progress) {
    return {
      tone: 'running',
      label: progress.task === 'errand' ? 'On your errand' : 'Working a shift',
      detail: progressDetail(progress.text, progress.tools),
    };
  }
  if (live) return { tone: 'running', label: 'Running a flow', detail: null };
  if (worker.cadence === null) return { tone: 'idle', label: 'Idle', detail: 'works when you ask' };
  if (nextShiftAt) return { tone: 'idle', label: 'Idle', detail: `next shift ${untilLabel(nextShiftAt, now)} · ${describeCadence(worker.cadence)}` };
  return { tone: 'idle', label: 'Idle', detail: describeCadence(worker.cadence) };
}

/// The newest thing the turn said, one line of it — else the tool it reached for.
function progressDetail(text: string, tools: string[]): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[\s#>*\-`]+|[`*]+/g, '').trim())
    .filter(Boolean)
    .pop();
  if (line) return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
  const tool = tools[tools.length - 1];
  return tool ? `using ${tool}` : 'getting started…';
}

// ---- The day strip -------------------------------------------------------

// Each row carries today along its right edge, hour-aligned, so "what did each
// one do today" is answered by scanning one column instead of opening thirteen
// disclosures. Two decisions hold it together:
//
//   - THE WINDOW IS THE WHOLE LOCAL DAY, midnight to midnight. A window that
//     covered only working hours would have to do something with the 03:00
//     shift, and both options are wrong: dropping it lies, and pinning it to
//     the edge puts it on top of the 06:00 one.
//   - POSITION IS THE TIMESTAMP. Which is why the rows lost their trailing
//     "45m ago" — the tick already said when, and the age was the same fact
//     spelled a second way.

const DAY_MS = 24 * 60 * 60 * 1000;

/// How many ticks one row draws. The strip is ~60px and a tick is 3px, so a
/// worker with more turns than this is already drawing them on top of each
/// other; the cap only bounds the DOM.
export const DAY_TICKS_MAX = 24;

/// What a tick is FOR, which is what colours it. Ordinal: a turn that is
/// running outranks one that is waiting on you, which outranks a plain record
/// of something that happened.
export type TickKind = 'running' | 'review' | 'errand' | 'shift';

export interface DayTick {
  /// Stable across renders — the orchestration this tick stands for.
  id: string;
  at: number;
  /// 0 at local midnight, 1 at the next. The strip's only geometry.
  pos: number;
  kind: TickKind;
  title: string;
}

/// The ruler's marks, as fractions of the SAME day the ticks are placed on.
///
/// Exported rather than written into the header because the first version
/// drew them with `justify-between` — which puts the first label at 0.0 and
/// the last at 1.0, both of which are midnight. Two of the three labels were
/// in the wrong place while every tick was in the right one, which is the
/// worst way for this to be wrong: the strip looked authoritative and read
/// six hours out. One source for both, so they cannot disagree again.
export const DAY_MARKS: ReadonlyArray<{ label: string; pos: number }> = [
  { label: '6a', pos: 6 / 24 },
  { label: '12p', pos: 12 / 24 },
  { label: '6p', pos: 18 / 24 },
];

/// How far through the local day `now` is, on the SAME 0..1 rule the ticks
/// are placed on.
///
/// The strip is a whole day wide from the moment it is drawn, so at 10am six
/// tenths of every row is a future rendered as empty — and "quiet since
/// breakfast" and "it is only breakfast" came out as the same pixels. The
/// rule now carries its own present: everything past this fraction is shaded
/// as not-yet, and the boundary is drawn.
export function dayProgress(now: number): number {
  return Math.min(1, Math.max(0, (now - startOfDay(now)) / DAY_MS));
}

export function tickKind(item: WorkerActivity): TickKind {
  if (item.running > 0) return 'running';
  if (item.proposed > 0) return 'review';
  return item.task === 'errand' ? 'errand' : 'shift';
}

/// Today's turns as marks on a day-wide rule.
///
/// Anything outside today is dropped rather than clamped to an edge: this
/// strip is one day, and a tick sitting at 0.0 that means "some time last
/// week" is worse than no tick at all.
export function dayTicks(items: WorkerActivity[], now: number): DayTick[] {
  const day = startOfDay(now);
  return items
    .filter((item) => startOfDay(item.at) === day)
    .slice(0, DAY_TICKS_MAX)
    .map((item) => ({
      id: item.orchestration.id,
      at: item.at,
      pos: Math.min(1, Math.max(0, (item.at - day) / DAY_MS)),
      kind: tickKind(item),
      title: item.title,
    }))
    .sort((a, b) => a.at - b.at);
}
