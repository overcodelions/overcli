// A Worker is a standing persona hired against a job description, not a saved
// prompt. Where a Schedule replays one frozen prompt, a Worker plans each
// shift freshly from its job description plus its own journal (what it already
// proposed, what the user approved or rejected), under a trust level that
// bounds how much may launch unattended and a monthly budget that stops the
// meter. The engine lives in src/main/flows/workerEngine.ts; this module is
// the shared contract both main and renderer validate against.

import type { Backend, UUID } from '../types';
import type { ScheduleTrigger } from './schedule';
import { SCHEDULE_AUTO_APPROVE_MAX, parseTimeOfDay } from './schedule';

export type WorkerTrustLevel = 'probation' | 'trusted' | 'autonomous';
export type WorkerMessageIntent = 'chat' | 'work';

export interface WorkerCaps {
  maxItemsPerShift: number;
  runIn: 'worktree' | 'cwd';
  /// Let worker-owned runs cross the runtime's push/message/service-update
  /// boundary without a per-step approval. Optional so workers persisted by
  /// older builds remain conservative: absent is always read as false.
  allowExternalActions?: boolean;
  /// Let this worker hand work sideways to a colleague as an errand. Off by
  /// default and off for every worker persisted before delegation existed:
  /// most workers have no business commissioning anyone, and the roster block
  /// this unlocks costs prompt budget in every planning turn that carries it.
  ///
  /// This is the "may commission" half. The "may be commissioned" half is not
  /// a flag at all — any enabled worker on the same project can receive one,
  /// because receiving an errand is a thing the user could already do to it by
  /// hand, and the receiver plans it through its own job description either
  /// way. See `canDelegate` for the trust half of the gate.
  canDelegate?: boolean;
  /// File this worker's finished deliverables into the project folder itself,
  /// not only into its private cabinet.
  ///
  /// Off for repos, and deliberately so: a repo has git, a review ceremony and
  /// a reader who knows where `userData` is, and unreviewed agent files in the
  /// tree are noise. An everyday project has none of that — the folder IS the
  /// app, so a document filed only under `worker-files/<uuid>/` is, to the
  /// person this was built for, output that does not exist.
  ///
  /// This does NOT loosen the run boundary. The run still writes only inside
  /// its disposable root (`buildWorkerRunBoundary`); Overcli copies the
  /// finished deliverable across once, at completion, and checkpoints the
  /// folder so the drop is as undoable as anything else that lands there.
  fileIntoProject?: boolean;
}

export interface Worker {
  id: UUID;
  name: string;
  /// One line under the name: what this worker IS, in the roster's own words
  /// ("the overcli innovator", "watches CI and files the flakes"). A roster of
  /// six personas is a list of names you have to remember the meaning of, and
  /// the job description is far too long to sit in a sidebar row.
  ///
  /// Optional because every worker hired before this field existed has none —
  /// `workerTagline` derives a stand-in from the job description rather than
  /// leaving those rows blank. Not used for planning: this is a label for the
  /// human, and nothing in a shift prompt reads it.
  tagline?: string;
  jobDescription: string;
  projectPath: string;
  cadence: ScheduleTrigger;
  trust: WorkerTrustLevel;
  caps: WorkerCaps;
  budgetUSDPerMonth: number;
  /// Set only while a Distribute is in effect for the month it names.
  ///
  /// Distributing rewrites `budgetUSDPerMonth` to `spend-so-far + share`,
  /// because a cap is a lifetime-for-the-month ceiling and `allocateTreasury`
  /// reads headroom as `cap - spent`. That is right for the rest of THAT
  /// month and meaningless afterwards: the spend window resets on the 1st and
  /// the cap does not, so the worker that had spent the MOST would carry the
  /// largest ceiling into the new month — inverting the funding order the
  /// feature exists to express. So the configured budget is parked here and
  /// restored on the first allocation of a later month. Absent on every
  /// worker that has never been distributed to.
  distribution?: {
    /// `monthStart()` of the month the distribution was computed for.
    month: number;
    /// The cap the user configured, to be put back when that month ends.
    budgetUSDPerMonth: number;
  };
  heartbeatModel: string;
  /// The backend `heartbeatModel` was chosen for. Optional because workers
  /// hired before this field existed only stored the bare id — those fall
  /// back to the user's default backend, with the model translated to its
  /// matching tier (`resolveProducerModel`).
  ///
  /// Flows have always stored the pair together (`FlowModelRef`); a worker
  /// storing the model alone meant switching default providers silently
  /// pinned every existing worker to a model its new backend rejects.
  heartbeatBackend?: Backend;
  flowIds: string[];
  enabled: boolean;
  createdAt: number;
  /// Point the cadence measures from when the worker has never worked a
  /// shift (or was re-enabled / had its cadence edited). Mirrors
  /// `Schedule.anchorAt` — without it, editing "daily 09:00" to "every hour"
  /// against a stale anchor would fire the instant the edit saves.
  anchorAt?: number;
  lastShiftAt?: number;
  shiftCount?: number;
  /// When a SHIFT last actually planned for this worker. Deliberately not
  /// stamped by errands: an errand is a one-off ask that need not have touched
  /// the data a shift pulls, and moving this anchor for one would make the next
  /// shift skip a window nothing ever covered.
  ///
  /// Distinct from `lastShiftAt`, which is cadence bookkeeping the
  /// scheduler clears whenever the trigger is edited or the worker is
  /// re-enabled; clearing THAT must not make a worker forget when it last
  /// looked at the project. This is the anchor a shift prompt states as "your
  /// previous shift ran at", so a worker can pull only what is new since.
  /// Cleared only by an explicit memory reset.
  lastPlannedAt?: number;
  /// When compaction last ran for this worker. Absent means never.
  lastCompactedAt?: number;
  /// When `caps.fileIntoProject` was last switched on. Runs that finished
  /// before this are not retroactively filed into the project on the next
  /// fold — only ones that finish after the cap is granted. Absent means the
  /// cap has never been turned on for this worker.
  fileIntoProjectSince?: number;
  /// Where this worker sits on the roster, low first. Absent means "wherever
  /// hire order puts it" — a roster nobody has arranged still reads newest
  /// first, and arranging one worker must not renumber the rest into an order
  /// the user never chose. See `sortRoster`.
  order?: number;
  /// Narrow who this worker may hand work to, when `caps.canDelegate` is on.
  /// Absent or empty means the whole eligible roster — every enabled worker
  /// on the same project.
  ///
  /// Deliberately opt-in narrowing rather than a required org chart: an
  /// explicit hierarchy is config that has to be drawn up front, before
  /// anyone has seen a misroute, and that silently goes stale on every hire.
  /// A misroute is cheap and self-correcting — the receiver plans the errand
  /// through its own job description and refuses work outside it — so the
  /// default is to let the roster speak for itself and let the user pin it
  /// down only where the model has actually got it wrong.
  delegatesTo?: UUID[];
  /// Which of its own outputs to render when you open this worker.
  ///
  /// A worker whose job is to produce a page — a dashboard, a report — is
  /// one you open to LOOK at something, and making you click down through
  /// Files → the job folder → the file to reach it every morning is three
  /// clicks charged for the thing the worker exists to do. Absent means
  /// `'newest'`. See `WORKER_AUTO_RENDER_*` and `isRenderableOutput`.
  autoRender?: string;
}

/// Show the most recent renderable file this worker has filed. The default,
/// because it needs no setup and is right for the case that prompted this:
/// a daily report whose filename is the same every day and whose job folder
/// is a different one every day.
export const WORKER_AUTO_RENDER_NEWEST = 'newest';
/// Open nothing. For a worker whose output is prose you read in the desk.
export const WORKER_AUTO_RENDER_OFF = 'off';

/// Files worth opening as a PAGE rather than as text.
///
/// Deliberately not markdown: every job a worker files has several .md
/// artifacts (the brief, the review, the receipts), so treating those as
/// renderable would mean picking one arbitrarily and rendering it in front
/// of you every time you clicked the worker. An .html or a component is
/// unambiguous — nothing writes one by accident.
const RENDERABLE_OUTPUT = /\.(?:html?|tsx|jsx)$/i;

export function isRenderableOutput(name: string): boolean {
  return RENDERABLE_OUTPUT.test(name);
}

/// The roster, in the order it should be read: whatever the user arranged
/// first, then the unarranged by hire date, newest first.
///
/// Seniority is not the same question as recency. "Who did I hire last" is
/// what the list answered before, and it is the wrong answer for a roster you
/// look at every morning — the worker that runs your day belongs at the top,
/// whenever you hired it.
export function sortRoster<T extends Pick<Worker, 'order' | 'createdAt'>>(workers: T[]): T[] {
  return workers.slice().sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return b.createdAt - a.createdAt;
  });
}

/// The roster split into the workers that run and the ones on the bench.
///
/// A paused worker is still yours — you want to see it, rename it, re-enable
/// it — but it does nothing today, and interleaving it with the ones actually
/// working makes the list read as "here are your workers" when half of them
/// aren't. Below a divider it reads as what it is: a bench.
///
/// Order WITHIN each group is `sortRoster`'s, untouched, so the arrangement
/// you set survives a worker being paused and un-paused.
export function benchRoster<T extends Pick<Worker, 'order' | 'createdAt' | 'enabled'>>(
  workers: T[],
): { active: T[]; benched: T[] } {
  const ordered = sortRoster(workers);
  return {
    active: ordered.filter((w) => w.enabled),
    benched: ordered.filter((w) => !w.enabled),
  };
}

/// Where a worker lands when nudged one place WITHIN its displayed group.
///
/// The roster is one ordered list, but the sidebar draws it as two (active,
/// then bench). A plain one-step move walks the flat order, so nudging a
/// benched worker swaps it with whatever sits next to it there — often an
/// active worker, which moves nothing visible and reads as a dead button.
/// This resolves the move against the group the user can actually see, and
/// returns the gap index `placeInRoster` consumes. Null when there is no
/// neighbour in that group to trade with.
export function moveWithinGroup<T extends Pick<Worker, 'id'>>(
  flatOrder: readonly T[],
  group: readonly T[],
  id: string,
  direction: -1 | 1,
): number | null {
  const from = group.findIndex((w) => w.id === id);
  if (from === -1) return null;
  const target = group[from + direction];
  if (!target) return null;
  const targetIndex = flatOrder.findIndex((w) => w.id === target.id);
  if (targetIndex === -1) return null;
  return direction === -1 ? targetIndex : targetIndex + 1;
}

/// The roster with one worker moved one place. Returns the ids in their new
/// order, which is what `workers:reorder` persists — every worker gets an
/// explicit position, so a later hire lands at the bottom instead of silently
/// jumping the queue.
export function moveInRoster<T extends Pick<Worker, 'id' | 'order' | 'createdAt'>>(
  workers: T[],
  id: string,
  direction: -1 | 1,
): string[] {
  const ordered = sortRoster(workers);
  const from = ordered.findIndex((w) => w.id === id);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= ordered.length) return ordered.map((w) => w.id);
  const next = ordered.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next.map((w) => w.id);
}

/// The roster with one worker dropped at an arbitrary slot. `insertBefore` is
/// a GAP index into the current order — 0 is above everyone, `length` is below
/// everyone — which is what a drop indicator drawn between two rows actually
/// means. Returns ids in their new order, like `moveInRoster`.
///
/// The gap is resolved against the list BEFORE the drag is removed from it,
/// because that is the list the user was looking at when they aimed. Pulling
/// the row out first would shift every gap below it up by one and land the
/// drop a row short of where it was dropped.
export function placeInRoster<T extends Pick<Worker, 'id' | 'order' | 'createdAt'>>(
  workers: T[],
  id: string,
  insertBefore: number,
): string[] {
  const ordered = sortRoster(workers);
  const from = ordered.findIndex((w) => w.id === id);
  if (from === -1) return ordered.map((w) => w.id);
  const next = ordered.slice();
  const [moved] = next.splice(from, 1);
  const target = insertBefore > from ? insertBefore - 1 : insertBefore;
  next.splice(Math.max(0, Math.min(target, next.length)), 0, moved);
  return next.map((w) => w.id);
}

// ---- Journal ------------------------------------------------------------

/// One line of a worker's episodic memory. Lives in shared (not main) because
/// the renderer renders the journal and the scorecard is computed from it.
/// Persistence is src/main/flows/workerJournal.ts.
export type WorkerJournalKind =
  | 'shift'
  | 'proposed'
  | 'launched'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'failed'
  /// A one-off instruction the user handed this worker (an "errand"), planned
  /// through its standing job description. It does not advance cadence or the
  /// shift number; its note records both the ask and the worker's response.
  | 'errand'
  /// This worker judged something outside its own remit and handed it to a
  /// colleague as an errand. Recorded on the SENDER — the receiver records
  /// its own `errand` entry, stamped with who sent it, so the referral reads
  /// from both desks. Carries no cost of its own: the work is charged to the
  /// worker that actually does it.
  | 'delegated'
  /// A trust demotion landed. Its own kind (not a 'shift' note) because the
  /// rejection streak must treat it as a terminator — the rejections that
  /// caused a demotion are spent, and must not count toward the next one.
  | 'demoted'
  /// A note the USER wrote against a turn — the one journal kind nothing
  /// automatic ever writes. It is memory, not decoration: the digest fed
  /// into every planning turn carries it, so "the Panasonic ticket is
  /// blocked on their side, stop re-proposing it" reaches the worker the
  /// same way its own history does. Carries the orchestrationId of the turn
  /// it was written against, so the desk can show it where it was left.
  | 'note'
  /// A weekly compaction pass ran and archived some of this worker's older
  /// filed work. Journal entries themselves are never folded — see
  /// `WorkerEngine.compactIfDue`.
  | 'compacted';

export interface WorkerJournalEntry {
  id: string; // unique per entry, caller-supplied
  workerId: string;
  kind: WorkerJournalKind;
  at: number; // ms epoch
  title: string; // candidate/shift title, '' for shift entries
  note?: string;
  runId?: string;
  orchestrationId?: string;
  costUSD?: number;
}

// ---- Caps and trust -----------------------------------------------------

/// How far back a worker reaches on its FIRST pass at something, when it has
/// no cursor of its own to resume from. Stated in the prompt rather than
/// enforced in code — only the worker's own flow knows what "pull" means for
/// its data source. Long enough that a first report has a trend in it, short
/// enough that shift #1 doesn't cost more than the next fifty combined.
export const WORKER_FIRST_RUN_WINDOW_DAYS = 90;

/// A note is a line to a worker, not a brief. It rides in every planning
/// digest from here on, so an essay pasted here costs prompt budget on every
/// shift forever — and the thing you wanted to say is nearly always one
/// sentence.
export const WORKER_NOTE_MAX = 600;

export const WORKER_MAX_ITEMS_PER_SHIFT = 5;
export const WORKER_MIN_JOB_DESCRIPTION = 20;
export const WORKER_MIN_INTERVAL_MINUTES = 15;
/// This many consecutive rejections demote the worker one trust level. The
/// streak counts only explicit verdicts (approved/rejected) — completed runs
/// and shift notes don't interrupt it, and one approval resets it.
export const WORKER_DEMOTE_REJECTION_STREAK = 3;

/// Probation means nothing runs unattended — the cap is literally zero.
/// SCHEDULE_AUTO_APPROVE_MAX is dominated by WORKER_MAX_ITEMS_PER_SHIFT today;
/// it stays in the Math.min so raising the worker cap can never silently
/// exceed the app-wide unattended-launch ceiling.
export function workerAutoApproveCap(w: Pick<Worker, 'trust' | 'caps'>): number {
  if (w.trust === 'probation') return 0;
  if (w.trust === 'trusted') return Math.min(2, w.caps.maxItemsPerShift);
  return Math.min(w.caps.maxItemsPerShift, WORKER_MAX_ITEMS_PER_SHIFT, SCHEDULE_AUTO_APPROVE_MAX);
}

/// One step down the ladder. Probation is the floor — there is nothing below
/// "everything parks for approval".
export function demotedTrust(level: WorkerTrustLevel): WorkerTrustLevel {
  if (level === 'autonomous') return 'trusted';
  return 'probation';
}

/// Leading run of 'rejected' among the explicit verdicts, newest first.
/// This is the number the auto-demotion rule watches. An approval OR a
/// prior demotion ends the streak — rejections that already cost a trust
/// level are spent, or a worker would fall two rungs off one bad patch.
export function rejectionStreak(entries: Array<Pick<WorkerJournalEntry, 'kind'>>): number {
  let streak = 0;
  for (const e of entries) {
    if (e.kind === 'approved' || e.kind === 'demoted') return streak;
    if (e.kind === 'rejected') streak++;
  }
  return streak;
}

export function describeWorker(w: Worker): string {
  return `${w.name} — ${w.trust}, ${w.caps.maxItemsPerShift} items/shift`;
}

// ---- Scorecard ----------------------------------------------------------

/// The performance review: everything the promote/demote/fire decision needs,
/// derived entirely from the journal plus the run-summary cost rollup. Never
/// stored — recomputed so it can't drift from the journal it summarizes.
export interface WorkerScorecard {
  proposed: number;
  approved: number;
  rejected: number;
  completed: number;
  failed: number;
  spentThisMonthUSD: number;
  /// Spend divided by completed items; null until something completed.
  costPerCompletedUSD: number | null;
  rejectionStreak: number;
}

/// What one errand turn produced. Returned to the renderer so a desk can show
/// the outcome inline, including the case where the worker launched nothing.
export interface WorkerErrandResult {
  intent: WorkerMessageIntent;
  orchestrationId: string;
  /// Candidates recorded after the orchestrator's exclusion and item caps.
  count: number;
  /// Candidates which launched immediately under the worker's trust cap.
  queued: number;
  /// Zero candidates may mean a refusal, an answered question, or simply
  /// nothing useful to do. `reply` contains the worker's own explanation.
  launchedNothing: boolean;
  /// Planning prose with the machine candidate payload removed and bounded.
  reply: string;
}

export function computeWorkerScorecard(
  entries: Array<Pick<WorkerJournalEntry, 'kind'>>,
  spentThisMonthUSD: number,
): WorkerScorecard {
  const count = (kind: WorkerJournalKind) => entries.filter((e) => e.kind === kind).length;
  const completed = count('completed');
  return {
    proposed: count('proposed'),
    approved: count('approved'),
    rejected: count('rejected'),
    completed,
    failed: count('failed'),
    spentThisMonthUSD,
    costPerCompletedUSD: completed > 0 ? spentThisMonthUSD / completed : null,
    rejectionStreak: rejectionStreak(entries),
  };
}

// ---- Validation ---------------------------------------------------------

/// `parseTimeOfDay` (shared with the scheduler) accepts what the scheduler
/// can execute — including a single-digit hour like "9:30" — so the worker
/// editor can never reject a time the engine would happily fire on.
function validTimeOfDay(time: string): boolean {
  return parseTimeOfDay(time) !== null;
}

export function validateWorker(w: Partial<Worker>): string | null {
  if (!w.name?.trim()) return 'Give the worker a name.';
  if ((w.jobDescription ?? '').trim().length < WORKER_MIN_JOB_DESCRIPTION)
    return 'A job description needs at least 20 characters — the worker plans its own shifts from it.';
  if (!w.projectPath?.trim()) return 'Pick a project for this worker.';
  if (!w.flowIds || w.flowIds.length === 0) return 'A worker needs at least one flow to run.';
  if (!w.heartbeatModel?.trim()) return 'Pick a heartbeat model.';
  if (!Number.isFinite(w.budgetUSDPerMonth) || (w.budgetUSDPerMonth ?? 0) <= 0)
    return 'Set a monthly budget above zero.';

  const caps = w.caps;
  if (!caps) return 'Set the worker caps.';
  if (!Number.isInteger(caps.maxItemsPerShift) || caps.maxItemsPerShift < 1)
    return 'A shift must allow at least one item.';
  if (caps.maxItemsPerShift > WORKER_MAX_ITEMS_PER_SHIFT)
    return `A shift is capped at ${WORKER_MAX_ITEMS_PER_SHIFT} items.`;
  if (w.trust !== 'autonomous' && caps.runIn === 'cwd')
    return 'Only an autonomous worker may run in the working copy.';

  const cadence = w.cadence;
  if (!cadence) return 'Pick when this worker works.';
  if (cadence.days && cadence.days.length === 0)
    return 'Pick at least one day, or leave every day selected.';
  if (cadence.kind === 'interval') {
    if (!Number.isFinite(cadence.everyMinutes) || cadence.everyMinutes < WORKER_MIN_INTERVAL_MINUTES)
      return `A worker shift can be no more often than every ${WORKER_MIN_INTERVAL_MINUTES} minutes.`;
    const win = cadence.window;
    if (win) {
      if (!validTimeOfDay(win.start) || !validTimeOfDay(win.end) || win.start === win.end)
        return 'Active hours must look like 08:00 and 17:00.';
      // Same rule validateSchedule enforces: an interval longer than the
      // window silently means "once a day", which is never what was typed.
      const start = parseTimeOfDay(win.start)!;
      const end = parseTimeOfDay(win.end)!;
      const startMinutes = start.hours * 60 + start.minutes;
      const endMinutes = end.hours * 60 + end.minutes;
      if (startMinutes < endMinutes && cadence.everyMinutes > endMinutes - startMinutes)
        return `That interval is longer than the ${endMinutes - startMinutes}-minute window, so it would only fire once a day.`;
    }
  } else if (!validTimeOfDay(cadence.time)) {
    return 'Time must look like 09:30.';
  }
  return null;
}

/// How long a tagline may be. A sidebar row truncates anything longer, so a
/// paragraph pasted here would read as a name that trails off — clamp at the
/// point where it still fits the column it was written for.
export const WORKER_TAGLINE_MAX = 72;

/// Openers a job description almost always starts with, which say nothing
/// once the text is sitting under the worker's own name.
const TAGLINE_PREAMBLE = /^(?:you(?:'re| are)\s+)?(?:the|a|an)\s+/i;

/// The line to show under a worker's name. Explicit tagline when it has one;
/// otherwise the opening of its job description, which is where a hired
/// worker's "what it is" already lives. Returns '' when there is nothing to
/// say — callers render no second line at all rather than an empty one.
export function workerTagline(worker: Pick<Worker, 'tagline' | 'jobDescription'>): string {
  const explicit = worker.tagline?.trim();
  if (explicit) return clampTagline(explicit);
  return clampTagline(deriveTagline(worker.jobDescription ?? ''));
}

function deriveTagline(job: string): string {
  const first = job
    .trim()
    // Only the first line matters: job descriptions are written as briefs, and
    // a bulleted one whose opening line is "Your job:" says more in that line
    // than in the paragraph it introduces.
    .split(/\n/)[0]
    // The first sentence, or the first clause when the opening sentence is a
    // colon-introduced list ("You're the Support Triage Worker: read new
    // tickets…" — the half before the colon is the persona).
    .split(/(?<=[.!?])\s|:\s/)[0]
    .trim();
  return first.replace(TAGLINE_PREAMBLE, '').replace(/[.,;:]+$/, '');
}

function clampTagline(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= WORKER_TAGLINE_MAX) return one;
  // Cut on a word so the ellipsis reads as "there is more" rather than as a
  // typo in the middle of a word.
  const cut = one.slice(0, WORKER_TAGLINE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > WORKER_TAGLINE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

// ---- Hire contract ------------------------------------------------------

/// What the hire drafter proposes and the user reviews before clicking Hire.
/// Everything a `Worker` needs except identity and bookkeeping — plus an
/// optional request to draft a new flow when none of the existing ones fit.
export interface WorkerContract {
  name: string;
  /// The one-line "what this is" shown under the name on the roster.
  tagline?: string;
  jobDescription: string;
  cadence: ScheduleTrigger;
  maxItemsPerShift: number;
  budgetUSDPerMonth: number;
  heartbeatModel: string;
  /// The backend the hire drafter picked `heartbeatModel` from. Not something
  /// the model emits — the caller stamps it, since it knows which CLI it just
  /// ran.
  heartbeatBackend?: Backend;
  /// One of the flow ids the drafter was shown, when one fit.
  flowId?: string;
  /// Set when no existing flow fit: a description for the flow drafter to
  /// turn into a new flow, reviewed alongside the contract.
  flowRequest?: string;
  /// One of the project/workspace paths the drafter was shown — set only
  /// when the job description clearly concerns one of them. The hire screen
  /// uses it as a suggestion, never over an explicit user choice.
  projectPath?: string;
}

/// Pull the `<worker>…</worker>` JSON block out of a hire-drafter reply and
/// coerce it into a WorkerContract. Tolerant like `parseCandidates` — the
/// model is told to emit clean JSON, but a near-miss is clamped into range
/// rather than thrown away. Returns null only when nothing parseable exists.
/// Trust is NOT part of the contract: every worker is hired on probation.
export function parseWorkerContract(
  reply: string,
  opts: {
    knownFlowIds: string[];
    defaultHeartbeatModel: string;
    /// Backend `defaultHeartbeatModel` came from, stamped onto the contract so
    /// the pair travels together from the moment of hire.
    defaultHeartbeatBackend?: Backend;
    knownProjectPaths?: string[];
  },
): WorkerContract | null {
  const block =
    reply.match(/<worker>([\s\S]*?)<\/worker>/i)?.[1] ??
    reply.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const e = parsed as Record<string, unknown>;

  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const tagline =
    typeof e.tagline === 'string' && e.tagline.trim() ? clampTagline(e.tagline) : undefined;
  const jobDescription = typeof e.jobDescription === 'string' ? e.jobDescription.trim() : '';
  if (!name && !jobDescription) return null;

  const flowId =
    typeof e.flowId === 'string' && opts.knownFlowIds.includes(e.flowId.trim())
      ? e.flowId.trim()
      : undefined;
  const flowRequest =
    typeof e.flowRequest === 'string' && e.flowRequest.trim() ? e.flowRequest.trim() : undefined;
  const projectPath =
    typeof e.projectPath === 'string' && opts.knownProjectPaths?.includes(e.projectPath.trim())
      ? e.projectPath.trim()
      : undefined;

  const rawItems = Number(e.maxItemsPerShift);
  const maxItemsPerShift = Number.isFinite(rawItems)
    ? Math.max(1, Math.min(WORKER_MAX_ITEMS_PER_SHIFT, Math.floor(rawItems)))
    : 3;
  const rawBudget = Number(e.budgetUSDPerMonth);
  const budgetUSDPerMonth = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 10;
  const heartbeatModel =
    typeof e.heartbeatModel === 'string' && e.heartbeatModel.trim()
      ? e.heartbeatModel.trim()
      : opts.defaultHeartbeatModel;

  return {
    name: name || 'Worker',
    tagline,
    jobDescription,
    cadence: coerceCadence(e.cadence),
    maxItemsPerShift,
    budgetUSDPerMonth,
    heartbeatModel,
    heartbeatBackend: opts.defaultHeartbeatBackend,
    flowId,
    flowRequest,
    projectPath,
  };
}

/// Weekday-mornings is the fallback cadence: frequent enough to feel alive,
/// bounded enough to never surprise anyone with a 2am shift.
const DEFAULT_CADENCE: ScheduleTrigger = { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };

/// Coerce a loosely-typed cadence into one the scheduler can fire. Shared
/// with the worker share format, which reads cadences written by hand or by
/// another install rather than by the editor.
export function coerceCadence(raw: unknown): ScheduleTrigger {
  if (!raw || typeof raw !== 'object') return DEFAULT_CADENCE;
  const c = raw as Record<string, unknown>;
  const days = Array.isArray(c.days)
    ? c.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
    : undefined;
  if (c.kind === 'interval') {
    const every = Number(c.everyMinutes);
    if (!Number.isFinite(every)) return DEFAULT_CADENCE;
    const win = c.window as { start?: unknown; end?: unknown } | undefined;
    const window =
      win &&
      typeof win.start === 'string' &&
      typeof win.end === 'string' &&
      parseTimeOfDay(win.start) &&
      parseTimeOfDay(win.end) &&
      win.start !== win.end
        ? { start: win.start, end: win.end }
        : undefined;
    return {
      kind: 'interval',
      everyMinutes: Math.max(WORKER_MIN_INTERVAL_MINUTES, Math.floor(every)),
      days: days && days.length > 0 ? days : undefined,
      window,
    };
  }
  if (c.kind === 'daily') {
    const time = typeof c.time === 'string' && parseTimeOfDay(c.time) ? c.time : '09:00';
    return { kind: 'daily', time, days: days && days.length > 0 ? days : undefined };
  }
  return DEFAULT_CADENCE;
}

// ---- What the worker calls an errand ------------------------------------

/// The worker's own name for the errand it was just handed.
///
/// An errand arrives as whatever you typed — "can you give me a report of the
/// test coverage in the parser" — which is the right thing to show in the
/// message you sent, and the wrong thing to use as a label everywhere else: it
/// is long, it leads with politeness rather than subject, and three related
/// errands read as three near-identical rows. The worker has just understood
/// the ask well enough to plan against it, so it is the one that should name
/// it. Lives in shared because main writes it into the journal and the
/// renderer reads it off the reply for the desk and sidebar.
export function parseWorkerSubject(reply: string): string | null {
  const match = /<subject>([\s\S]*?)<\/subject>/i.exec(reply);
  const line = match?.[1]?.trim().split('\n')[0]?.trim();
  if (!line) return null;
  const cleaned = line.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > WORKER_SUBJECT_MAX
    ? `${cleaned.slice(0, WORKER_SUBJECT_MAX - 1)}…`
    : cleaned;
}

/// A title, not a sentence — long enough for a verb and an object, short
/// enough for a 200px sidebar row.
export const WORKER_SUBJECT_MAX = 60;

export function stripWorkerSubject(reply: string): string {
  return reply.replace(/<subject>[\s\S]*?<\/subject>/gi, '').trim();
}

// ---- Delegation ---------------------------------------------------------

/// May this worker hand work to a colleague?
///
/// Two conditions, and the trust one is the load-bearing half. Handing work
/// sideways is an unattended act: the sender decides alone, and something
/// starts moving on another desk before anyone has read it. That is exactly
/// the question the trust ladder already answers, so it answers this one too
/// — probation means nothing acts unattended, delegation included.
///
/// It is also what closes the laundering hole. Without the trust condition, a
/// worker whose own proposals all park for approval could get work running
/// anyway by handing it to an autonomous colleague, borrowing a cap it was
/// deliberately denied. With it, the two gates sit in series and each is owned
/// by the right worker: the sender's trust decides whether the referral leaves,
/// the receiver's decides what the referral is allowed to launch.
export function canDelegate(w: Pick<Worker, 'trust' | 'caps'>): boolean {
  return w.caps.canDelegate === true && w.trust !== 'probation';
}

/// Most handoffs a turn can make. A worker that has noticed one thing outside
/// its remit has probably noticed one; a turn emitting six is a turn that has
/// decided its whole job belongs to someone else.
export const WORKER_MAX_HANDOFFS_PER_TURN = 2;

/// How much of a colleague's job description rides in the roster block.
export const WORKER_ROSTER_LINE_MAX = 180;

/// One roster row: a colleague's name and enough of their job description to
/// route against.
///
/// Taken from the START of the job description rather than a separate `role`
/// field the user would have to write and maintain, because the opening of a
/// job description is already a role statement in every one anyone writes —
/// "You are the Ticket Triage Worker. Every weekday morning, find and solve
/// the sprint's open tickets end to end." A description too vague to route
/// against is a description that also plans vague shifts, so the fix belongs
/// in the description, not in a second field that can disagree with it.
///
/// Sentences, not a hard slice, and more than one when the first is short: a
/// lot of job descriptions open with a bare "You are the Test Warden.", which
/// names the worker without saying what it does.
export function rosterLine(w: Pick<Worker, 'name' | 'jobDescription'>): string {
  const flat = w.jobDescription.replace(/\s+/g, ' ').trim();
  let out = '';
  for (const sentence of splitSentences(flat)) {
    if (out && out.length + 1 + sentence.length > WORKER_ROSTER_LINE_MAX) break;
    out = out ? `${out} ${sentence}` : sentence;
    if (out.length >= WORKER_ROSTER_LINE_MAX) break;
  }
  if (!out) out = flat;
  const clipped =
    out.length > WORKER_ROSTER_LINE_MAX ? `${out.slice(0, WORKER_ROSTER_LINE_MAX - 1)}…` : out;
  return `${w.name} — ${clipped}`;
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const next = text[i + 1];
    if (next !== undefined && next !== ' ') continue;
    out.push(text.slice(start, i + 1).trim());
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/// Who this worker is allowed to hand work to.
///
/// Scoped to the sender's own project, and that bound is enforced HERE rather
/// than asked for in the prompt. A roster is a list of names, and two installs
/// of the same job on two workspaces produce two workers called "Triage" that
/// a name cannot tell apart — so an off-project colleague must never reach the
/// roster block in the first place, because once it is nameable it is
/// reachable. Same reason disabled workers are excluded: a paused worker is
/// one the user switched off, and a colleague must not be able to switch it
/// back on by sending it work.
export function delegationTargets<
  T extends Pick<Worker, 'id' | 'order' | 'createdAt' | 'enabled' | 'projectPath' | 'caps'>,
>(sender: Worker, roster: T[]): T[] {
  if (!canDelegate(sender)) return [];
  const narrowed =
    sender.delegatesTo && sender.delegatesTo.length > 0 ? new Set(sender.delegatesTo) : null;
  return sortRoster(
    roster.filter(
      (t) =>
        t.id !== sender.id &&
        t.enabled &&
        t.projectPath === sender.projectPath &&
        (!narrowed || narrowed.has(t.id)) &&
        (sender.caps.allowExternalActions || !t.caps.allowExternalActions),
    ),
  );
}

/// One referral a planning turn asked for: who it wants, and the errand to
/// hand them. `to` is whatever the worker wrote — resolving it to an actual
/// colleague is the engine's job, and may fail.
export interface WorkerHandoff {
  to: string;
  instruction: string;
}

const HANDOFF_RE = /<handoff\s+to\s*=\s*["']?([^"'>\n]+?)["']?\s*>([\s\S]*?)<\/handoff\s*>/gi;

export function parseHandoffs(reply: string): WorkerHandoff[] {
  const out: WorkerHandoff[] = [];
  for (const m of reply.matchAll(HANDOFF_RE)) {
    const to = m[1]?.trim();
    const instruction = m[2]?.trim();
    if (to && instruction) out.push({ to, instruction });
  }
  return out;
}

export function stripHandoffs(reply: string): string {
  return reply.replace(HANDOFF_RE, '').trim();
}

/// Resolve what a worker wrote in `to=` against the colleagues it may actually
/// reach. Case- and space-insensitive, because the worker is copying a name
/// out of a prompt block, not quoting an id.
///
/// An ambiguous name resolves to nothing rather than to a guess: two enabled
/// colleagues sharing a name on one project is rare, and picking one of them
/// silently would send real work to a coin flip. Failing loudly puts the
/// clash on the sender's desk where it can be fixed by renaming.
export function resolveHandoffTarget<T extends Pick<Worker, 'id' | 'name'>>(
  to: string,
  targets: T[],
): T | null {
  const wanted = to.trim().toLowerCase();
  if (!wanted) return null;
  const hits = targets.filter((t) => t.name.trim().toLowerCase() === wanted);
  return hits.length === 1 ? hits[0] : null;
}

/// The provenance stamp a worker-owned batch carries.
///
/// One function rather than a literal at each site because the stamp is
/// authority, not decoration: `allowExternalActions` is what waives the
/// runtime's external-effect gate for the batch's child runs, and a call site
/// that forgets it silently re-gates a worker the user already authorized.
/// That is exactly the shape of the bug this replaced — the drafted-flow
/// errand path built its own literal and dropped the capability.
///
/// Absent rather than `false` when the worker has no such authority, matching
/// how the field is persisted: older batches have no key at all, and both read
/// as "ask first".
/// `from` marks an errand a COLLEAGUE sent rather than the user. The receiver
/// plans it identically either way — the stamp exists so the desk can say
/// where it came from, and so the engine can tell a delegated errand apart
/// from a typed one when deciding whether it may delegate onward (it may not).
export function workerOrigin(
  w: Pick<Worker, 'id' | 'name' | 'caps'>,
  task: 'shift' | 'errand',
  errand?: string,
  from?: { workerId: UUID; workerName: string },
  intent?: WorkerMessageIntent,
): {
  kind: 'worker';
  workerId: UUID;
  workerName: string;
  task: 'shift' | 'errand';
  errand?: string;
  allowExternalActions?: boolean;
  from?: { workerId: UUID; workerName: string };
  intent?: WorkerMessageIntent;
} {
  return {
    kind: 'worker',
    workerId: w.id,
    workerName: w.name,
    task,
    ...(errand !== undefined ? { errand } : {}),
    ...(task === 'errand' && intent !== undefined ? { intent } : {}),
    ...(w.caps.allowExternalActions ? { allowExternalActions: true } : {}),
    ...(from ? { from } : {}),
  };
}
