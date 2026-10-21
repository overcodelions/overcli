// A Team is a named group of workers that takes on ONE task at a time and
// hands back a finished piece of work — a report, a proposal, a decision pack.
//
// Where a worker's errand is one persona answering one ask, a team task is a
// short sequence of STAGES run by a coordinator: members contribute pieces
// (in parallel within a stage), the coordinator drafts between them, a member
// may challenge the draft and others respond, and the coordinator synthesizes
// the final pack. Every stage writes into one shared task folder, and every
// later stage reads it — that folder is how the members collaborate.
//
// Members stay ordinary workers. A team only COMMISSIONS them: each piece runs
// as that worker's own errand, so its spend, journal and questions are the
// worker's, and a worker can sit on several teams while still working its own
// shifts. This module is the shared contract main and renderer both validate
// against; the engine lives in src/main/flows/teamEngine.ts.

import type { UUID } from '../types';
import type { Flow } from './schema';

/// What a stage does. A small fixed set rather than free-form steps so the
/// engine can run, show and bound any plan the coordinator writes.
///
/// - `contribute`: members each produce a piece, in parallel.
/// - `challenge`: a member attacks what exists so far, as ranked objections.
/// - `respond`: members answer the objections that concern them.
/// - `draft`: the coordinator combines what exists into one document.
/// - `synthesize`: the coordinator writes the final pack. Always last.
export type TeamStageKind = 'contribute' | 'challenge' | 'respond' | 'draft' | 'synthesize';

export const TEAM_STAGE_KINDS: readonly TeamStageKind[] = [
  'contribute',
  'challenge',
  'respond',
  'draft',
  'synthesize',
];

/// Stages whose work is done by members, as commissioned runs.
export function isMemberStage(kind: TeamStageKind): boolean {
  return kind === 'contribute' || kind === 'challenge' || kind === 'respond';
}

export const TEAM_STAGE_LABEL: Record<TeamStageKind, string> = {
  contribute: 'Contribute',
  challenge: 'Challenge',
  respond: 'Respond',
  draft: 'Draft',
  synthesize: 'Synthesize',
};

/// Bounds on what one plan may ask for. A plan is approved by a person before
/// it runs, but the engine still refuses a plan nobody could sensibly approve.
export const TEAM_MAX_STAGES = 8;
export const TEAM_MAX_ASSIGNMENTS_PER_STAGE = 6;
export const TEAM_MAX_MEMBERS = 8;
export const TEAM_MAX_QUESTIONS = 5;
/// Questions when the team already knows its world: only what that leaves open.
export const TEAM_MAX_QUESTIONS_KNOWING = 2;
/// New members one plan may hire. A plan that needs more than this is a
/// different team, and that is a conversation for the team editor.
export const TEAM_MAX_HIRES_PER_PLAN = 2;

export interface TeamMember {
  workerId: UUID;
  /// What this worker does ON THIS TEAM, in the user's words ("Challenger:
  /// attacks the case"). The same worker can play a different part on another
  /// team; its job description stays its own.
  role: string;
}

/// Where the user wants to step in. Approving the plan is not here: it is
/// always required, because a plan is the thing that spends the money.
export interface TeamCheckpoints {
  /// Let the coordinator ask clarifying questions before it plans.
  askFirst: boolean;
  /// Pause before every challenge stage so you can read the draft first.
  reviewBeforeChallenge: boolean;
  /// Hold the finished pack for your review instead of filing it as done.
  finalReview: boolean;
  /// Hold work handed off from the room until you start it. On unless
  /// explicitly false: a hand-off is the model deciding a question is work,
  /// and a real run should not start on the model's say-so alone. False: it
  /// starts as soon as the coordinator hands it off, or queues behind work
  /// already running. Either way it never carries the grant for external
  /// actions (see `Team.piecesAskFirst`).
  approveRoomWork?: boolean;
}

export const DEFAULT_TEAM_CHECKPOINTS: TeamCheckpoints = {
  askFirst: true,
  reviewBeforeChallenge: false,
  finalReview: true,
  approveRoomWork: true,
};

export const DEFAULT_TEAM_BUDGET_USD = 1000;

export interface Team {
  id: UUID;
  name: string;
  /// One line: what the team is for. Shown under the name, and handed to the
  /// coordinator as the team's standing purpose.
  purpose?: string;
  /// How the team should go about its work, in the words of the people who
  /// run it: "when the ask is a PRFAQ, Hugo pulls the roadmap first, then
  /// Priya drafts". Handed to the coordinator in every planning turn, above
  /// its own habits. Up to `TEAM_GUIDANCE_MAX` characters.
  guidance?: string;
  /// Its picture: an https image, for the console and what it posts in
  /// Slack. Initials without one.
  avatarUrl?: string;
  members: TeamMember[];
  /// The project or workspace the team works in. Every member's piece runs
  /// there, whatever project the member usually works in — the member brings
  /// their skills, model and tools; the task brings the repo. Absent: each
  /// member works in their own project (a research team needs no repo).
  projectPath?: string;
  /// Hold a member's team pieces to that member's own permissions: a worker
  /// without the grant for external actions has every call outside its
  /// piece's tools refused. On unless explicitly false — the default. False:
  /// a piece of an approved plan runs with the grant, whatever the member's
  /// own settings say. Work handed off from the room never gets the grant:
  /// nobody approved a plan for it, and the room reads whatever was pasted
  /// or fetched into it. The member's own shifts and errands keep the
  /// member's settings either way. See `piecesActFreely`.
  piecesAskFirst?: boolean;
  /// Only workers from `projectPath` belong on this team: the roster
  /// drafter is shown no one else and hires for every other part.
  ownProjectOnly?: boolean;
  /// Ceiling on member spend for one task. Checked before every stage; a task
  /// that reaches it waits for you instead of continuing.
  budgetUSDPerTask: number;
  checkpoints: TeamCheckpoints;
  createdAt: number;
  updatedAt?: number;
  /// What the team knows: a brief its members wrote from their own tools
  /// (the roadmap, the customers, what's decided), read at the start of every
  /// task so the coordinator can answer from it, or ask less. Learned by a
  /// task of its own (`kind: 'learn'`); refreshed the same way.
  knowledge?: TeamKnowledge;
  /// Learn again when what it knows is a week old: `weekly` (absent means
  /// this) or only when someone asks (`off`).
  knowledgeRefresh?: 'weekly' | 'off';
  /// Disbanded: it takes no more work and is gone from every list, but kept,
  /// so what it delivered stays in the Library for the people who could see
  /// it. Its members stay hired. See `TeamEngine.disband`.
  disbanded?: { at: number; by: string };
}

/// The longest a team's guidance may be.
export const TEAM_GUIDANCE_MAX = 20_000;

/// How old what a team knows gets before a weekly refresh runs.
export const TEAM_KNOWLEDGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TeamKnowledge {
  status: 'learning' | 'ready' | 'failed';
  /// The brief itself (Markdown), once learned.
  body?: string;
  updatedAt?: number;
  /// The learning task, while it runs and after.
  taskId?: UUID;
  error?: string;
  /// When a pass last started, done or not: a refresh that keeps failing
  /// tries again a day later, not every hour.
  triedAt?: number;
}

/// The cap on one learning pass: a few minutes of each member's tools.
export const TEAM_LEARN_BUDGET_USD = 10;
/// What a learning pass writes, and what the coordinator reads from it.
export const TEAM_KNOWLEDGE_FILE = 'TEAM_KNOWLEDGE.md';

export type TeamWaitReason = 'checkpoint' | 'budget' | 'failed' | 'away';

export type TeamTaskStatus =
  /// Waiting its turn: the team is on another task, and starts this one
  /// when that one ends.
  | 'queued'
  /// The coordinator is thinking: writing questions or a plan.
  | 'planning'
  /// The coordinator asked questions; waiting on your answers.
  | 'questions'
  /// A plan is ready; waiting on your approval.
  | 'proposed'
  /// Stages are running.
  | 'running'
  /// Paused mid-plan: a checkpoint, the budget, or a stage that failed.
  | 'waiting'
  /// The pack is written; waiting on your review.
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

/// `skipped`: you dropped the piece — before it started, or by stopping its
/// run. Unlike `failed` it is a decision, so the stage carries on without it
/// instead of stopping to ask.
export type TeamAssignmentStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'skipped';

/// A piece that will not change any more on its own.
export function isPieceSettled(status: TeamAssignmentStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped';
}

export interface TeamAssignment {
  workerId: UUID;
  /// Snapshot, so a task still reads right after a worker is renamed or let go.
  workerName: string;
  /// What this member is asked to do in this stage.
  ask: string;
  /// Run the member's whole flow rather than one scoped piece: the ask IS
  /// their usual job ("produce the competitor profile"), so its steps —
  /// research, write, critique — are the point. The coordinator decides.
  full?: boolean;
  status: TeamAssignmentStatus;
  orchestrationId?: UUID;
  runId?: UUID;
  /// The shared-folder file this member's piece was filed as.
  file?: string;
  error?: string;
  /// The files the run wrote (designs, pages, data) were copied into the
  /// shared folder under `files/<member>/`. Set even when there were none,
  /// so a task is only caught up once.
  filesCopied?: boolean;
  /// The piece finished, but its changes would not merge into the task
  /// branch: why, and where to resolve it.
  mergeConflict?: string;
  /// Paused: what its run is waiting on you for ("wants your OK to use
  /// bash"). Absent while it isn't, or when you held it yourself.
  waitingFor?: string;
  /// Outside tools you already approved for this piece's run: you gave the
  /// member a tool it was refused, so its re-run doesn't ask again.
  grant?: string[];
}

/// The current stage's pieces whose runs are stopped for you: the task
/// still reads as running, but it is not moving until you act.
export function piecesWaiting(task: Pick<TeamTask, 'status' | 'stages' | 'stageIndex'>): TeamAssignment[] {
  if (task.status !== 'running') return [];
  return (task.stages[task.stageIndex]?.assignments ?? []).filter((a) => a.status === 'paused' && !!a.waitingFor);
}

export type TeamStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/// Whether you can still skip this stage (or a piece of it): it has not
/// finished, it is not the final pack — that has to be written — and the task
/// is still going. Work handed off from the room is stopped, not skipped.
export function canSkipStage(task: Pick<TeamTask, 'status' | 'stageIndex' | 'stages'>, index: number): boolean {
  const stage = task.stages[index];
  if (!stage || stage.kind === 'synthesize' || stage.fromRoom) return false;
  if (task.status !== 'running' && task.status !== 'waiting') return false;
  return index >= task.stageIndex && (stage.status === 'pending' || stage.status === 'running');
}

export interface TeamStage {
  kind: TeamStageKind;
  title: string;
  /// For coordinator stages (draft, synthesize): what to produce.
  ask?: string;
  /// For member stages; empty for coordinator stages.
  assignments: TeamAssignment[];
  status: TeamStageStatus;
  /// For coordinator stages: the shared-folder file it wrote.
  file?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /// Work handed off from the room after the pack was written, rather than
  /// part of the approved plan: the room message that proposed it, and
  /// which step of it this is when it runs in steps.
  fromRoom?: { messageId: string; exchange: number; step?: { index: number; of: number } };
}

export interface TeamTaskFile {
  /// Path relative to the task folder (`pack/PROPOSAL.md` for the final pack).
  name: string;
  /// Who wrote it: a member's name, "Coordinator", or "You".
  author: string;
  stage?: number;
  at: number;
}

/// A comment on a team task's work, from the person who asked for it.
export interface TeamComment {
  id: string;
  at: number;
  text: string;
  /// The file it is about, by task-folder name, and the passage quoted.
  file?: string;
  quote?: string;
  /// It is about the coordinator's questions or plan, not a file.
  about?: 'questions' | 'plan' | 'coordinator';
  /// Said to one member.
  workerId?: string;
  workerName?: string;
  /// What happened to it: it went into a re-plan, was sent to a running
  /// member, went to the team conversation, or waits for the next stage.
  outcome?: 'replanned' | 'steered' | 'asked' | 'queued' | 'redo' | 'waiting';
}

/// The comments as a brief section: each with what it's about.
export function commentLines(comments: readonly TeamComment[] | undefined, forWorkerId?: string): string[] {
  // Every comment goes to everyone: one said to a teammate still shapes the work around it.
  const list = comments ?? [];
  if (!list.length) return [];
  const out = ['', 'WHAT THE USER SAID ABOUT THE WORK SO FAR (take it into account; it overrides earlier choices):'];
  for (const c of list.slice(-30)) {
    const about = c.file
      ? `on ${c.file}${c.quote ? `, the passage "${c.quote.replace(/\s+/g, ' ').slice(0, 300)}"` : ''}`
      : c.about === 'coordinator'
        ? 'to the coordinator'
        : c.about
          ? `on the ${c.about}`
          : 'on the task';
    const to = c.workerId ? (c.workerId === forWorkerId ? ' (to you)' : ` (to ${c.workerName ?? 'a teammate'})`) : '';
    out.push(`- ${about}${to}: ${c.text.replace(/\s+/g, ' ').slice(0, 1200)}`);
  }
  return out;
}

export interface TeamTask {
  id: UUID;
  teamId: UUID;
  /// Snapshot of the team name at brief time.
  teamName: string;
  /// What you asked for, verbatim.
  /// `learn`: the team finding out what it needs to know (`Team.knowledge`),
  /// not a request from someone.
  kind?: 'learn';
  /// Plan it as work, never answer it straight from what the team knows.
  forcePlan?: boolean;
  /// The coordinator answered it from what the team knows: no stages ran.
  answered?: boolean;
  brief: string;
  /// Who asked, when the task came through the org control plane (Slack,
  /// MCP, the console). Its questions, plan and checkpoints go to them.
  /// Absent for a task briefed at the desk.
  requestedBy?: { name: string; slackUserId?: string };
  /// Where this task's pieces run: chosen with the brief, else the team's.
  /// Absent: each member in their own project.
  projectPath?: string;
  /// Start the task branch from this branch where a repo has it: the code an
  /// earlier stage of a process left. Absent: from each repo's base.
  startFrom?: string;
  /// Short title the coordinator gives the task once it has planned it.
  title?: string;
  status: TeamTaskStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  questions?: string[];
  answers?: string[];
  /// Changes you asked for to the plan, oldest first.
  revisions?: string[];
  /// What you said about the work as it went: on a passage of a file, on a
  /// question, or to one member. Every later piece and the pack are briefed
  /// with them.
  comments?: TeamComment[];
  /// Files you attached to the brief, saved in the shared folder under
  /// `attachments/` (task-folder names). Every planning turn sees them.
  attachments?: string[];
  /// The coordinator's one-paragraph note on its plan.
  planNote?: string;
  /// What the coordinator says the pack will contain.
  deliverables?: string[];
  stages: TeamStage[];
  /// The stage being worked, or `stages.length` once all are done.
  stageIndex: number;
  /// Why a `waiting` task is waiting. `away`: the crew is off duty, and the
  /// next stage holds until you come back or start it yourself.
  waiting?: { reason: TeamWaitReason; message: string };
  /// The stage index whose checkpoint you already cleared, so continuing
  /// doesn't stop at the same checkpoint again.
  checkpointCleared?: number;
  /// The stage index you started while the crew was away, so it is not held
  /// again.
  awayCleared?: number;
  error?: string;
  /// Member spend so far (finished runs), in USD.
  spentUSD: number;
  budgetUSD: number;
  /// Absolute path of the shared task folder.
  folder: string;
  files: TeamTaskFile[];
  /// Set once the synthesize stage has written the pack.
  /// `changed`: the pack files this version added or rewrote, against the
  /// version before it. Absent on a first pack, and on packs updated before
  /// it was recorded.
  pack?: { summary: string; files: string[]; version?: number; updatedAt?: number; changed?: string[] };
  /// The conversation you have with the team once the pack is written. See
  /// shared/flows/teamRoom.ts.
  room?: TeamRoom;
  /// The task's code, when it works in a git project or workspace: one
  /// branch, under one name in every repo, that each piece forks from and
  /// merges back into. See main/flows/teamBranch.ts.
  code?: TeamTaskCode;
  /// Why the task has no shared branch when it should have had one.
  codeError?: string;
  /// New members the plan needs and the team does not have. Hired when you
  /// approve the plan, before the first stage runs; until then their
  /// assignments carry the hire's `key` in place of a worker id.
  hires?: TeamPlanHire[];
  /// A fresh run started from an earlier task's pack once that one had
  /// sprawled: its files are under `earlier/`, its pack under `earlier/pack/`.
  continuesFrom?: TeamContinuation;
  /// The fresh run this task was continued in.
  continuedAs?: { taskId: UUID; title?: string; at: number };
}

export interface TeamContinuation {
  taskId: UUID;
  title?: string;
  packVersion: number;
  /// Stages the earlier task ran, plan and follow-ups together.
  stages: number;
  /// Stages it left failed: the new plan starts by picking them up.
  open: string[];
  /// Whether its conversation came along, as `earlier/conversation.md`.
  conversation: boolean;
}

/// Where an earlier task's files land in the one that continues it.
export const TEAM_EARLIER_DIR = 'earlier';

export interface TeamTaskCode {
  branch: string;
  repos: Array<{
    name: string;
    projectPath: string;
    base: string;
    worktreePath: string;
    landed?: boolean;
    /// Commits on the task branch that `base` does not have, as of the last
    /// merge into it. Absent: not counted yet.
    ahead?: number;
    /// Set once you pushed the task branch from this repo; the link the
    /// remote gave for opening a pull request, when it gave one.
    pushed?: { at: number; url?: string };
  }>;
}

/// A member the coordinator wants to hire for this task's plan.
export interface TeamPlanHire {
  /// Stands in for the worker id in the plan's assignments until hired.
  key: string;
  /// What the plan calls them. The hire picks its own name; assignments take
  /// it once the worker exists.
  name: string;
  /// Their role on the team, like any member's.
  role: string;
  /// The job, in the coordinator's words — what the hire drafter works from.
  job: string;
  /// Why no member on the team could do this.
  why: string;
  status: 'proposed' | 'hiring' | 'hired' | 'failed';
  workerId?: UUID;
  error?: string;
}

const HIRE_KEY_PREFIX = 'hire:';

export function isHireKey(id: string): boolean {
  return id.startsWith(HIRE_KEY_PREFIX);
}

/// Hires the plan still needs before its first stage can run.
export function unhired(task: Pick<TeamTask, 'hires'>): TeamPlanHire[] {
  return (task.hires ?? []).filter((h) => h.status !== 'hired');
}

/// Who said something in a team's room.
export type TeamSpeaker =
  | { kind: 'you' }
  | { kind: 'coordinator' }
  | { kind: 'member'; workerId: UUID; name: string };

export interface TeamMessage {
  id: string;
  speaker: TeamSpeaker;
  text: string;
  at: number;
  /// The coordinator's "where this landed" after members have talked.
  wrapUp?: boolean;
  /// A turn that failed; `text` says why.
  failed?: boolean;
  /// Files you attached to this message (task-folder names, under
  /// `attachments/`). Every turn answering it sees them.
  attachments?: string[];
  /// Which exchange this belongs to: each question you ask starts one.
  exchange: number;
  /// Work the coordinator hands off: members can't make or change anything
  /// in the room, so a request to do work becomes real runs of theirs —
  /// started at once, queued behind running work, or held for you when the
  /// team approves follow-up work first.
  handoff?: TeamHandoff;
  /// A member reporting back on work handed off from the room: the stage it
  /// ran as.
  workReport?: { stage: number };
  /// Tools the member's run was refused because its flow doesn't list them,
  /// and the flow to add them to. `allowed` once you have.
  refused?: { tools: string[]; flowId: string; allowed?: boolean };
  /// A turn that died with the app: what to run again — the pack update, or
  /// the question that started the exchange.
  retry?: 'pack' | 'ask';
}

export interface TeamHandoffAssignment {
  workerId: UUID;
  workerName: string;
  ask: string;
  grant?: string[];
  /// Members on this hand-off whose work this one builds on: it starts once
  /// theirs reports back (the compiler after the researchers).
  after?: UUID[];
}

export interface TeamHandoff {
  title: string;
  assignments: TeamHandoffAssignment[];
  /// `proposed`: waiting for you to start it. `queued`: starts when the work
  /// running now reports back.
  status: 'proposed' | 'queued' | 'started' | 'dismissed';
  /// Once started, the stage it runs as: the first, when it runs in steps.
  stage?: number;
  /// Once started in steps, every stage it runs as, in order.
  stages?: number[];
  /// Running a stage again for members you just gave the tools it was
  /// refused: each one you allow joins this proposal.
  rerunOf?: number;
}

/// A hand-off's members in the order they run: each step starts once the
/// one before it reports back, and members in a step run side by side. A
/// member waits for everyone it names in `after`; names that are not on the
/// hand-off, and loops, are ignored rather than held forever.
export function handoffSteps<A extends Pick<TeamHandoffAssignment, 'workerId' | 'after'>>(assignments: A[]): A[][] {
  const on = new Set(assignments.map((a) => a.workerId));
  const placed = new Set<string>();
  const steps: A[][] = [];
  let left = assignments;
  while (left.length > 0) {
    let ready = left.filter((a) => (a.after ?? []).every((id) => !on.has(id) || id === a.workerId || placed.has(id)));
    // A loop: run what is left together.
    if (ready.length === 0) ready = left;
    steps.push(ready);
    for (const a of ready) placed.add(a.workerId);
    left = left.filter((a) => !ready.includes(a));
  }
  return steps;
}

/// Order follow-up work the way the approved plan ordered the same people,
/// when the coordinator said nothing about order: a member whose first part
/// in the plan came later builds on those whose part came earlier — the
/// compiler after the researchers. An `after` the coordinator gave, even an
/// empty one ("these are independent"), is kept as it is.
export function orderHandoffByPlan<A extends Pick<TeamHandoffAssignment, 'workerId' | 'after'>>(
  stages: Array<Pick<TeamStage, 'kind' | 'assignments' | 'fromRoom'>>,
  assignments: A[],
): A[] {
  if (assignments.length < 2 || assignments.some((a) => a.after !== undefined)) return assignments;
  const first = new Map<string, number>();
  stages.forEach((st, i) => {
    if (st.fromRoom || !isMemberStage(st.kind)) return;
    for (const a of st.assignments) if (!first.has(a.workerId)) first.set(a.workerId, i);
  });
  return assignments.map((a) => {
    const mine = first.get(a.workerId);
    if (mine === undefined) return a;
    const before = assignments.filter((b) => {
      const theirs = first.get(b.workerId);
      return theirs !== undefined && theirs < mine;
    });
    return before.length > 0 ? { ...a, after: before.map((b) => b.workerId) } : a;
  });
}

export interface TeamRoom {
  messages: TeamMessage[];
  /// Set while a turn is in flight: who is speaking, since when.
  /// `doing`: `pack` while the coordinator rewrites the pack, so a turn cut
  /// short can be offered again as what it was.
  busy?: { speaker: string; since: number; doing?: 'pack' } | null;
  /// What you said while someone was answering, oldest first: each goes in
  /// as its own question once the room is free.
  queue?: Array<{ text: string; at: number }>;
  /// How many messages the pack has already absorbed, so "Update the pack"
  /// knows whether there is anything new to fold in.
  foldedThrough?: number;
}

/// Whether a team's pieces run with the grant for external actions: only
/// when you turned "ask first" off yourself.
export function piecesActFreely(team: Pick<Team, 'piecesAskFirst'>): boolean {
  return team.piecesAskFirst === false;
}

/// Whether work handed off from the room waits for you to start it.
export function holdsRoomWork(checkpoints: Pick<TeamCheckpoints, 'approveRoomWork'> | undefined): boolean {
  return checkpoints?.approveRoomWork !== false;
}

export function isTaskActive(status: TeamTaskStatus): boolean {
  return status === 'queued' || status === 'planning' || status === 'questions' || status === 'proposed' || status === 'running' || status === 'waiting';
}

/// Whether this task keeps its team from taking a new one. Work handed off
/// from the room doesn't: the task itself is finished, and that work is an
/// errand on the side.
export function blocksNewTask(task: Pick<TeamTask, 'status' | 'stages' | 'stageIndex'>): boolean {
  if (!isTaskActive(task.status) || task.status === 'queued') return false;
  const roomWork = (task.status === 'running' || task.status === 'waiting') && !!task.stages[task.stageIndex]?.fromRoom;
  return !roomWork;
}

/// When a task's follow-ups are long enough that a fresh run serves better.
export const TEAM_ROLLOVER_FOLLOWUPS = 8;
export const TEAM_ROLLOVER_REPEATS = 3;
export const TEAM_ROLLOVER_AGE_MS = 24 * 60 * 60 * 1000;

/// Why this task would be better continued as a fresh run from its pack, or
/// null: many follow-ups since the plan, the same follow-up run again and
/// again, or a day since the plan started. Only once the pack is written and
/// nothing is running, and never twice.
export function rolloverReason(
  task: Pick<TeamTask, 'status' | 'stages' | 'pack' | 'continuedAs' | 'room'>,
  now: number,
): { title: string; detail: string } | null {
  if (task.continuedAs || !task.pack) return null;
  if (task.status !== 'review' && task.status !== 'done') return null;
  if (task.room?.busy || task.stages.some((s) => s.status === 'running')) return null;
  // A hand-off run in steps is one follow-up.
  const followUps = task.stages.filter((s) => s.fromRoom && !s.fromRoom.step?.index);
  if (followUps.length === 0) return null;
  const n = followUps.length;
  const title = `This task has had ${n} follow-up${n === 1 ? '' : 's'} since the plan`;
  const fresh = `Starting fresh from Pack v${task.pack.version ?? 1} keeps the next ask quick and its plan readable.`;
  let run = 1;
  for (let i = 1; i < followUps.length; i++) {
    run = followUps[i].title.trim().toLowerCase() === followUps[i - 1].title.trim().toLowerCase() ? run + 1 : 1;
    if (run >= TEAM_ROLLOVER_REPEATS) {
      return { title, detail: `“${followUps[i].title}” has run ${run} times in a row. ${fresh}` };
    }
  }
  if (n >= TEAM_ROLLOVER_FOLLOWUPS) return { title, detail: `Each new stage rereads a longer history. ${fresh}` };
  const started = task.stages.find((s) => s.startedAt !== undefined)?.startedAt;
  if (started !== undefined && now - started >= TEAM_ROLLOVER_AGE_MS) {
    return { title, detail: `It has been going for over a day. ${fresh}` };
  }
  return null;
}

/// What a fresh run carries from the task it continues.
export function continuationOf(task: Pick<TeamTask, 'id' | 'title' | 'pack' | 'stages'>, conversation: boolean): TeamContinuation {
  return {
    taskId: task.id,
    ...(task.title ? { title: task.title } : {}),
    packVersion: task.pack?.version ?? 1,
    stages: task.stages.length,
    open: task.stages.filter((s) => s.status === 'failed').map((s) => s.title),
    conversation,
  };
}

/// The continuation as a prompt section, for planning the fresh run.
export function continuationLines(c: TeamContinuation | undefined): string[] {
  if (!c) return [];
  const lines = [
    '',
    `THIS CONTINUES AN EARLIER TASK${c.title ? `: "${c.title}"` : ''} (${c.stages} stages, pack v${c.packVersion}).`,
    `Its pack is in ${TEAM_EARLIER_DIR}/pack/ and its other files under ${TEAM_EARLIER_DIR}/. Start from that pack: plan only what`,
    'the brief asks beyond it, and do not redo work it already settled.',
  ];
  if (c.conversation) lines.push(`The conversation about it is in ${TEAM_EARLIER_DIR}/conversation.md.`);
  if (c.open.length > 0) {
    lines.push('It left these stages failed; pick them up first unless the brief says otherwise:');
    for (const t of c.open) lines.push(`- ${t}`);
  }
  return lines;
}

/// Stages finished, out of how many.
export function teamTaskProgress(task: Pick<TeamTask, 'stages'>): { done: number; total: number } {
  return {
    done: task.stages.filter((s) => s.status === 'done').length,
    total: task.stages.length,
  };
}

/// Where you step in on this team's tasks, in the order they happen — shown
/// beside the brief so you know what sending it commits you to. Approving
/// the plan is always there: it is not a checkpoint you can turn off.
export function describeTeamCheckpoints(checkpoints: TeamCheckpoints): string[] {
  const steps = [
    checkpoints.askFirst && 'may ask questions first',
    'you approve the plan',
    checkpoints.reviewBeforeChallenge && 'you read the draft before each challenge',
    checkpoints.finalReview && 'you review the pack',
    holdsRoomWork(checkpoints) && 'you start follow-up work',
  ].filter((s): s is string => !!s);
  return steps.map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s));
}

/// One short line for the rail and the task list.
export function describeTeamTaskStatus(task: Pick<TeamTask, 'status' | 'stages' | 'stageIndex' | 'waiting' | 'hires'>): string {
  switch (task.status) {
    case 'queued':
      return 'Up next';
    case 'planning':
      return 'Planning…';
    case 'questions':
      return 'Questions for you';
    case 'proposed':
      return 'Plan to approve';
    case 'running': {
      const hiring = unhired(task);
      if (hiring.length > 0) return `Hiring ${hiring.length === 1 ? hiring[0].name : `${hiring.length} new members`}…`;
      const stage = task.stages[task.stageIndex];
      if (stage?.fromRoom) return `${stage.assignments.map((a) => a.workerName).join(' & ')} working: ${stage.title}`;
      const { total } = teamTaskProgress(task);
      return `Stage ${Math.min(task.stageIndex + 1, total)} of ${total}`;
    }
    case 'waiting':
      return task.waiting?.reason === 'budget'
        ? 'Paused at the budget'
        : task.waiting?.reason === 'failed'
          ? 'A stage needs you'
          : task.waiting?.reason === 'away'
            ? 'Held while the crew is away'
            : 'Waiting on you';
    case 'review':
      return 'Pack ready to review';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function validateTeam(
  team: Partial<Team>,
  workers: Array<{ id: UUID; name: string }>,
): string | null {
  if (!team.name?.trim()) return 'Give the team a name.';
  const members = team.members ?? [];
  if (members.length < 2) return 'A team needs at least two members.';
  if (members.length > TEAM_MAX_MEMBERS) return `A team can have at most ${TEAM_MAX_MEMBERS} members.`;
  const known = new Set(workers.map((w) => w.id));
  const seen = new Set<string>();
  for (const m of members) {
    if (!known.has(m.workerId)) return 'A member of this team is no longer on the crew.';
    if (seen.has(m.workerId)) return 'Each worker can be on a team once.';
    seen.add(m.workerId);
  }
  // Names are how the coordinator addresses members in its plan, so two
  // members with one name would make every assignment ambiguous.
  const names = members.map((m) => workers.find((w) => w.id === m.workerId)?.name.trim().toLowerCase() ?? '');
  if (new Set(names).size !== names.length) return 'Two members share a name — rename one so the plan can tell them apart.';
  const budget = team.budgetUSDPerTask;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return 'Set a budget per task above $0.';
  return null;
}

// ---------------------------------------------------------------------------
// The coordinator's planning contract
// ---------------------------------------------------------------------------

export interface TeamRosterLine {
  workerId: UUID;
  name: string;
  role: string;
  jobDescription: string;
  /// Display label for the model the member runs on ("Claude", "Codex").
  backend?: string;
}

export type PlanReply =
  | { kind: 'answer'; answer: string }
  | { kind: 'questions'; questions: string[]; note: string }
  | {
      kind: 'plan';
      title: string;
      note: string;
      deliverables: string[];
      stages: TeamStage[];
      hires: TeamPlanHire[];
    }
  | { kind: 'error'; error: string };

const JOB_CHARS = 500;

export const TEAM_PLAN_SYSTEM_PROMPT = [
  'You are the COORDINATOR of a small team of AI workers. You do not do the members’ work.',
  'You plan how the team will produce what the user asked for, then later you draft and',
  'synthesize from what the members produce.',
  '',
  'A plan is a short sequence of stages. Stage kinds:',
  '- contribute: one or more members each produce a piece of work, in parallel.',
  '- challenge: one member attacks the current draft with ranked objections.',
  '- respond: members answer the objections that concern their part.',
  '- draft: you (the coordinator) combine what exists into one document.',
  '- synthesize: you write the final pack. Exactly one, and it is ALWAYS the last stage.',
  '',
  'Rules for a good plan:',
  '- Use members for what their role and job make them good at. Do not use a member just',
  '  because they are on the team: if one member is enough, say so and plan for one.',
  '- Order stages so later work builds on earlier conclusions (e.g. design after the story).',
  '- Put members in the same stage only when their pieces do not depend on each other.',
  '- If the team has a challenger-type member, challenge the draft before the final pack,',
  '  and follow it with a respond stage. Every objection must get an answer.',
  `- At most ${TEAM_MAX_STAGES} stages and ${TEAM_MAX_ASSIGNMENTS_PER_STAGE} assignments per stage. Fewer is better.`,
  '- Each assignment’s "ask" must stand alone: the member sees the brief and the shared',
  '  folder, but not this plan.',
  '- An assignment is normally ONE scoped piece, done in one go. Add "full": true only when',
  '  the ask is that member’s whole usual job, end to end (their job description says they',
  '  produce exactly this) — then they run their own full process, with its own reviews.',
  '',
  'Reply with ONE of these, and nothing after it:',
  '',
  '0) An answer, when allowed and WHAT THE TEAM KNOWS (or the brief itself) already answers',
  '   the request: a question, a status, "what is next on X". Reply with',
  '   <team_answer>the answer, in Markdown, saying where each fact comes from</team_answer>.',
  '   No stages run and it costs the user almost nothing, so prefer it whenever the answer',
  '   is there. Never answer from guesses: work that needs finding out, writing or making is',
  '   a plan.',
  '',
  'A) Questions, when allowed. The task is long and the user is not watching it: a guess that',
  '   turns out wrong costs the whole run, and members cannot ask the user once work starts.',
  '   So ask, in this one round, everything you would otherwise have to guess that would change',
  '   the plan or the result: who it is for, what good looks like, what is in and out of scope,',
  '   constraints (dates, budget, policy), decisions already made, sources to use or avoid.',
  '   Do not ask what the brief already answers, what a member can look up, or matters of taste.',
  '   End each question with the default you will use if it goes unanswered, in brackets:',
  '   "Who is the PR/FAQ for? (I’ll assume existing enterprise customers.)"',
  '<team_questions>["question 1 (default)", "question 2 (default)"]</team_questions>',
  '',
  'B) A plan, as JSON:',
  '<team_plan>',
  '{',
  '  "title": "Short title for the task",',
  '  "note": "One or two sentences on why this plan, naming any assumption it rests on that the user did not state.",',
  '  "deliverables": ["PROPOSAL.md", "PLAN.md"],',
  '  "stages": [',
  '    {"kind": "contribute", "title": "Customer and market", "assignments": [{"member": "<member name>", "ask": "..."}]},',
  '    {"kind": "draft", "title": "First draft", "ask": "..."},',
  '    {"kind": "synthesize", "title": "Final pack", "ask": "..."}',
  '  ],',
  '  "hires": []',
  '}',
  '</team_plan>',
  '',
  'You may write a sentence or two of prose before the block.',
].join('\n');

/// The coordinator's questions with the user's answers. Once answering is
/// over, a question left blank keeps the default it named.
function clarified(task: Pick<TeamTask, 'questions' | 'answers'>): Array<{ q: string; a: string }> {
  if (!task.answers) return [];
  return (task.questions ?? []).map((q, i) => ({ q, a: task.answers?.[i]?.trim() || '(no answer: the default in the question stands)' }));
}

export function buildTeamPlanMessage(args: {
  teamName: string;
  purpose?: string;
  /// How the team should work (`Team.guidance`).
  guidance?: string;
  roster: TeamRosterLine[];
  brief: string;
  allowQuestions: boolean;
  questions?: string[];
  answers?: string[];
  revisions?: string[];
  previousPlan?: Pick<TeamTask, 'title' | 'stages' | 'deliverables' | 'hires'>;
  budgetUSD: number;
  /// How many new members this plan may hire. 0: plan with the team as is.
  maxHires?: number;
  /// The project the task works in, by name.
  project?: string;
  /// Set on a retry: why the last reply could not be used.
  repair?: string;
  /// What the team knows (`Team.knowledge`), and when it was written.
  knowledge?: { body: string; updatedAt?: number };
  /// Whether this may be answered straight from what the team knows.
  allowAnswer?: boolean;
  /// The earlier task this one continues.
  continuesFrom?: TeamContinuation;
}): string {
  const lines: string[] = [];
  lines.push(`THE TEAM: ${args.teamName}${args.purpose?.trim() ? ` — ${args.purpose.trim()}` : ''}`);
  if (args.guidance?.trim()) {
    lines.push('');
    lines.push('HOW THIS TEAM WORKS (from the people who run it: follow it over your own habits. When it names a process for this kind of ask, plan that process, with the members it names.)');
    lines.push(args.guidance.trim().slice(0, TEAM_GUIDANCE_MAX));
  }
  if (args.knowledge?.body.trim()) {
    lines.push('');
    lines.push(`WHAT THE TEAM KNOWS${args.knowledge.updatedAt ? ` (written ${new Date(args.knowledge.updatedAt).toISOString().slice(0, 10)})` : ''}`);
    const body = args.knowledge.body.trim();
    lines.push(body.length > 24_000 ? `${body.slice(0, 24_000)}\n…(cut)` : body);
  }
  if (args.project) {
    lines.push(`WORKS IN: the ${args.project} project. Every member's piece runs there, whatever their usual project is.`);
  }
  lines.push('');
  lines.push('MEMBERS');
  for (const m of args.roster) {
    const job = m.jobDescription.trim().replace(/\s+/g, ' ');
    const clipped = job.length > JOB_CHARS ? `${job.slice(0, JOB_CHARS)}…` : job;
    lines.push(`- ${m.name} — role on this team: ${m.role || '(none given)'}${m.backend ? ` · runs on ${m.backend}` : ''}`);
    lines.push(`  job: ${clipped}`);
  }
  lines.push('');
  lines.push(...hiringRule(args.maxHires ?? 0));
  lines.push('');
  lines.push(`BUDGET: about $${args.budgetUSD} of member work for the whole task. Plan within it.`);
  lines.push('');
  lines.push('THE BRIEF');
  lines.push(args.brief.trim());
  lines.push(...continuationLines(args.continuesFrom));
  const answered = (args.questions ?? []).map((q, i) => ({ q, a: args.answers?.[i]?.trim() ?? '' }));
  if (answered.length > 0) {
    lines.push('');
    lines.push('YOUR QUESTIONS AND THE USER’S ANSWERS');
    for (const { q, a } of answered) {
      lines.push(`Q: ${q}`);
      lines.push(`A: ${a || '(no answer — the default in the question stands)'}`);
    }
  }
  if (args.previousPlan && (args.revisions?.length ?? 0) > 0) {
    lines.push('');
    lines.push('YOUR PREVIOUS PLAN');
    lines.push(describePlanForPrompt(args.previousPlan));
    lines.push('');
    lines.push('CHANGES THE USER ASKED FOR (apply the latest; keep the rest of the plan unless it conflicts)');
    for (const r of args.revisions ?? []) lines.push(`- ${r}`);
  }
  lines.push('');
  const knows = !!args.knowledge?.body.trim();
  if (args.allowAnswer) {
    lines.push(
      knows
        ? 'First: if what the team knows already answers this, reply with <team_answer> (see 0) and nothing else.'
        : 'If the brief is a simple question you can answer from the brief alone, reply with <team_answer> (see 0). The team has not learned about its work yet, so most requests need a plan.',
    );
  }
  if (args.allowQuestions && answered.length === 0 && !(args.revisions?.length)) {
    lines.push(
      knows
        ? `Otherwise, ask only what neither the brief nor what the team knows settles (see A): at most ${TEAM_MAX_QUESTIONS_KNOWING}, each with its default. If nothing that matters is open, plan now.`
        : `Before planning, look for what you would otherwise have to guess (see A). If there is any, ask now: up to ${TEAM_MAX_QUESTIONS} questions, each with its default. If the brief leaves nothing that matters open, plan now.`,
    );
  } else {
    lines.push(args.allowAnswer ? 'Do not ask questions now. Answer, or reply with a plan.' : 'Do not ask questions now. Reply with a plan.');
  }
  if (args.repair) {
    lines.push('');
    lines.push(`YOUR LAST REPLY COULD NOT BE USED: ${args.repair}`);
    lines.push('Reply again, following the format exactly.');
  }
  return lines.join('\n');
}

function hiringRule(maxHires: number): string[] {
  if (maxHires <= 0) return ['HIRING: not possible for this task. Plan with the members above; leave "hires" empty.'];
  return [
    `HIRING: if the brief clearly needs work that NO member's role or job covers, you may hire up to ${maxHires}`,
    'new member(s) by listing them in "hires". They are hired when the user approves the plan, and you',
    'assign them work by the name you give them, like any member. Do not hire for work a member could',
    'reasonably do, and never hire just to fill a stage. Most plans hire nobody.',
    '  "hires": [{"name": "Pricing analyst", "role": "Prices the offer", "job": "Two or three sentences:',
    '  what they do, what they are good at, what they produce.", "why": "Nobody on the team covers pricing."}]',
  ];
}

function describePlanForPrompt(plan: Pick<TeamTask, 'title' | 'stages' | 'deliverables' | 'hires'>): string {
  const out: string[] = [];
  if (plan.title) out.push(`Title: ${plan.title}`);
  if (plan.deliverables?.length) out.push(`Deliverables: ${plan.deliverables.join(', ')}`);
  for (const h of plan.hires ?? []) out.push(`Hire: ${h.name} — ${h.role}. Job: ${h.job} Why: ${h.why}`);
  plan.stages.forEach((s, i) => {
    out.push(`${i + 1}. [${s.kind}] ${s.title}`);
    if (s.ask) out.push(`   ask: ${s.ask}`);
    for (const a of s.assignments) out.push(`   - ${a.workerName}: ${a.ask}`);
  });
  return out.join('\n');
}

function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  if (m) return m[1];
  // An unclosed block at the very end of a reply is still the reply.
  const open = text.search(new RegExp(`<${tag}>`, 'i'));
  if (open >= 0) return text.slice(open + tag.length + 2);
  return null;
}

function parseJsonLoose(raw: string): unknown {
  let body = raw.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1];
  try {
    return JSON.parse(body);
  } catch {
    // Salvage the outermost object/array when prose leaked inside the tag.
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function proseBefore(text: string, tag: string): string {
  const at = text.search(new RegExp(`<${tag}>`, 'i'));
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

/// Resolve how the coordinator named a member: by name first, then by role.
export function resolveMember(ref: string, roster: Array<Pick<TeamRosterLine, 'workerId' | 'name' | 'role'>>): TeamRosterLine['workerId'] | null {
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  const byName = roster.find((m) => m.name.trim().toLowerCase() === want);
  if (byName) return byName.workerId;
  const byRole = roster.filter((m) => m.role.trim().toLowerCase() === want);
  if (byRole.length === 1) return byRole[0].workerId;
  // "Maya (market analyst)" and similar decorations.
  const prefixed = roster.filter((m) => want.startsWith(m.name.trim().toLowerCase()));
  return prefixed.length === 1 ? prefixed[0].workerId : null;
}

/// Read a coordinator planning reply into questions or a validated plan.
export function parsePlanReply(
  text: string,
  roster: Array<Pick<TeamRosterLine, 'workerId' | 'name' | 'role'>>,
  opts: { allowQuestions: boolean; maxHires?: number; allowAnswer?: boolean; maxQuestions?: number },
): PlanReply {
  const planRaw = extractTag(text, 'team_plan');
  const questionsRaw = extractTag(text, 'team_questions');
  const answerRaw = extractTag(text, 'team_answer');

  if (answerRaw !== null && !planRaw && questionsRaw === null) {
    if (!opts.allowAnswer) return { kind: 'error', error: 'Answered directly when a plan was required.' };
    const answer = answerRaw.trim();
    if (!answer) return { kind: 'error', error: 'The answer block was empty.' };
    return { kind: 'answer', answer };
  }

  if (!planRaw && questionsRaw !== null) {
    if (!opts.allowQuestions) return { kind: 'error', error: 'Asked questions when a plan was required.' };
    const parsed = parseJsonLoose(questionsRaw);
    const list = Array.isArray(parsed)
      ? parsed
      : questionsRaw
          .split('\n')
          .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ''))
          .filter((l) => l.trim());
    const questions = list
      .filter((q): q is string => typeof q === 'string')
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, opts.maxQuestions ?? TEAM_MAX_QUESTIONS);
    if (questions.length === 0) return { kind: 'error', error: 'The questions block was empty.' };
    return { kind: 'questions', questions, note: proseBefore(text, 'team_questions') };
  }

  if (!planRaw) return { kind: 'error', error: 'No <team_plan> block in the reply.' };
  const parsed = parseJsonLoose(planRaw) as
    | {
        title?: unknown;
        note?: unknown;
        deliverables?: unknown;
        stages?: unknown;
        hires?: unknown;
      }
    | undefined;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.stages)) {
    return { kind: 'error', error: 'The <team_plan> block was not JSON with a "stages" list.' };
  }

  const proposed = parseHires(parsed.hires, roster);
  if (typeof proposed === 'string') return { kind: 'error', error: proposed };
  const maxHires = opts.maxHires ?? 0;
  if (proposed.length > maxHires) {
    return {
      kind: 'error',
      error: maxHires === 0
        ? 'The plan hires new members, but this task cannot hire. Plan with the team as it is.'
        : `The plan hires ${proposed.length} new members; at most ${maxHires} are allowed.`,
    };
  }
  // Hires are members for the length of the parse: assignments name them.
  roster = [...roster, ...proposed.map((h) => ({ workerId: h.key, name: h.name, role: h.role }))];
  const byId = new Map(roster.map((m) => [m.workerId, m]));
  const stages: TeamStage[] = [];
  for (const [i, raw] of (parsed.stages as unknown[]).entries()) {
    if (!raw || typeof raw !== 'object') return { kind: 'error', error: `Stage ${i + 1} is not an object.` };
    const s = raw as { kind?: unknown; title?: unknown; ask?: unknown; assignments?: unknown };
    const kind = typeof s.kind === 'string' ? (s.kind.trim().toLowerCase() as TeamStageKind) : null;
    if (!kind || !TEAM_STAGE_KINDS.includes(kind)) {
      return { kind: 'error', error: `Stage ${i + 1} has an unknown kind "${String(s.kind)}".` };
    }
    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : TEAM_STAGE_LABEL[kind];
    if (isMemberStage(kind)) {
      const list = Array.isArray(s.assignments) ? s.assignments : [];
      const assignments: TeamAssignment[] = [];
      for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        const { member, ask, full } = a as { member?: unknown; ask?: unknown; full?: unknown };
        if (typeof member !== 'string' || typeof ask !== 'string' || !ask.trim()) continue;
        const workerId = resolveMember(member, roster);
        if (!workerId) return { kind: 'error', error: `Stage ${i + 1} names "${member}", who is not on the team.` };
        if (assignments.some((x) => x.workerId === workerId)) continue;
        assignments.push({
          workerId,
          workerName: byId.get(workerId)?.name ?? member,
          ask: ask.trim(),
          ...(full === true ? { full: true } : {}),
          status: 'pending',
        });
      }
      if (assignments.length === 0) return { kind: 'error', error: `Stage ${i + 1} (${kind}) has no assignments.` };
      if (assignments.length > TEAM_MAX_ASSIGNMENTS_PER_STAGE) {
        return { kind: 'error', error: `Stage ${i + 1} has more than ${TEAM_MAX_ASSIGNMENTS_PER_STAGE} assignments.` };
      }
      stages.push({ kind, title, assignments, status: 'pending' });
    } else {
      const ask = typeof s.ask === 'string' ? s.ask.trim() : '';
      stages.push({ kind, title, ask: ask || undefined, assignments: [], status: 'pending' });
    }
  }

  // Exactly one synthesize, last. A plan without one still ends in a pack;
  // a synthesize the model put in the middle is really a draft.
  for (let i = 0; i < stages.length - 1; i++) {
    if (stages[i].kind === 'synthesize') stages[i] = { ...stages[i], kind: 'draft' };
  }
  if (stages.length === 0 || stages[stages.length - 1].kind !== 'synthesize') {
    stages.push({
      kind: 'synthesize',
      title: 'Final pack',
      ask: 'Write the final pack from everything in the shared folder.',
      assignments: [],
      status: 'pending',
    });
  }
  if (!stages.some((s) => isMemberStage(s.kind))) {
    return { kind: 'error', error: 'The plan gives the members no work.' };
  }
  if (stages.length > TEAM_MAX_STAGES) {
    return { kind: 'error', error: `The plan has more than ${TEAM_MAX_STAGES} stages.` };
  }

  const deliverables = Array.isArray(parsed.deliverables)
    ? parsed.deliverables.filter((d): d is string => typeof d === 'string' && !!d.trim()).map((d) => d.trim()).slice(0, 12)
    : [];
  // A hire nobody gives work to is a worker you would pay for nothing.
  const used = new Set(stages.flatMap((s) => s.assignments.map((a) => a.workerId)));
  return {
    kind: 'plan',
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 120) : 'Team task',
    note: typeof parsed.note === 'string' ? parsed.note.trim() : proseBefore(text, 'team_plan'),
    deliverables,
    stages,
    hires: proposed.filter((h) => used.has(h.key)),
  };
}

function parseHires(
  raw: unknown,
  roster: Array<Pick<TeamRosterLine, 'name'>>,
): TeamPlanHire[] | string {
  if (!Array.isArray(raw)) return [];
  const taken = new Set(roster.map((m) => m.name.trim().toLowerCase()));
  const hires: TeamPlanHire[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const h = entry as { name?: unknown; role?: unknown; job?: unknown; why?: unknown };
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const name = str(h.name);
    const job = str(h.job);
    if (!name || !job) continue;
    if (taken.has(name.toLowerCase())) return `The hire "${name}" has the same name as someone on the team. Give it another.`;
    taken.add(name.toLowerCase());
    hires.push({
      key: `${HIRE_KEY_PREFIX}${hires.length + 1}`,
      name: name.slice(0, 60),
      role: str(h.role) || name,
      job,
      why: str(h.why),
      status: 'proposed',
    });
  }
  return hires;
}

// ---------------------------------------------------------------------------
// Putting a team together: the roster drafter and team hires
// ---------------------------------------------------------------------------

/// One member of a drafted roster: someone already on the crew, or a job to
/// hire for.
export type TeamRosterPick =
  | { kind: 'worker'; workerId: UUID; role: string }
  | { kind: 'hire'; job: string; role: string };

export interface TeamRosterDraft {
  name: string;
  purpose: string;
  /// The project the brief is about, when it names one of yours.
  projectPath?: string;
  /// Why this shape, in a sentence or two.
  note: string;
  members: TeamRosterPick[];
}

/// A crew worker as the roster drafter sees them.
export interface TeamCrewLine {
  workerId: UUID;
  name: string;
  /// The tagline, or the start of the job description.
  summary: string;
  /// The project they usually work in, by name.
  project?: string;
}

export const TEAM_ROSTER_SYSTEM_PROMPT = [
  'You help a user put together a TEAM of AI workers. A team takes on one task at a time and',
  'hands back a finished piece of work: a coordinator plans the stages, and members each do',
  'pieces of it — contributing, challenging the draft, answering objections.',
  '',
  'From what the user wants the team for and the workers already on their crew, propose the team:',
  '- Reuse a crew worker when their job fits a part the team needs, and say what their role on',
  '  this team is.',
  '- Propose a NEW hire only for a part no crew worker covers. Describe the job in two or three',
  '  sentences: what they do, what they are good at, what they produce.',
  `- 2 to ${TEAM_MAX_MEMBERS} members; three or four is usual. Fewer, sharper members beat a crowd.`,
  '- A team that produces a case or a decision is better for one member whose role is to',
  '  challenge the work.',
  '- Roles are short: "Challenger: attacks the case", "Writes the customer story".',
  '- Projects: the team works in ONE project, and every piece runs there. A crew worker from',
  '  another project can still join for a skill that is not tied to a product (design, writing,',
  '  a sharp review) — say so in their role. For work that IS the product — checking its code,',
  '  cutting its release, knowing its users — prefer someone from the team\'s project, else a hire.',
  '- If the user has not chosen the project and the brief clearly names one of theirs, put its',
  '  name in "project" exactly as listed. Otherwise leave "project" out.',
  '',
  'Reply with ONE block, and nothing after it:',
  '<team_roster>',
  '{',
  '  "name": "Short team name",',
  '  "purpose": "One line: what the team is for.",',
  '  "project": "<one of their projects, only when the brief names it>",',
  '  "note": "One or two sentences on why this shape.",',
  '  "members": [',
  '    {"worker": "<crew worker name>", "role": "..."},',
  '    {"hire": "<the job, two or three sentences>", "role": "..."}',
  '  ]',
  '}',
  '</team_roster>',
].join('\n');

export function buildTeamRosterMessage(args: {
  brief: string;
  crew: TeamCrewLine[];
  /// The project the user chose for the team, by name.
  project?: string;
  /// The user's projects and workspaces, by name, when none is chosen.
  projects?: string[];
  /// The crew shown is only the team's project, by the user's choice.
  ownProjectOnly?: boolean;
  /// The team as it stands, when you are editing one.
  current?: { name?: string; purpose?: string; members: Array<{ name: string; role: string }> };
  repair?: string;
}): string {
  const lines: string[] = ['WHAT THE USER WANTS THE TEAM FOR', args.brief.trim(), '', 'THE CREW'];
  if (args.crew.length === 0) lines.push('(nobody yet — every member is a new hire)');
  for (const w of args.crew) {
    const summary = w.summary.trim().replace(/\s+/g, ' ');
    lines.push(
      `- ${w.name}${w.project ? ` [works in ${w.project}]` : ''} — ${summary.length > 240 ? `${summary.slice(0, 240)}…` : summary}`,
    );
  }
  lines.push('');
  if (args.project) {
    lines.push(`THE TEAM WORKS IN: ${args.project} (chosen by the user — leave "project" out)`);
    if (args.ownProjectOnly) {
      lines.push(`The user wants only ${args.project} people on it: use only the crew above, and hire for every other part.`);
    }
  } else if (args.projects?.length) {
    lines.push(`THE USER'S PROJECTS: ${args.projects.join(', ')} (none chosen for the team yet)`);
  }
  const current = args.current;
  if (current && (current.members.length > 0 || current.name?.trim())) {
    lines.push('');
    lines.push(`THE TEAM SO FAR${current.name?.trim() ? `: ${current.name.trim()}` : ''}`);
    if (current.purpose?.trim()) lines.push(current.purpose.trim());
    for (const m of current.members) lines.push(`- ${m.name}${m.role.trim() ? ` — ${m.role.trim()}` : ''}`);
    lines.push('Keep these members unless they clearly do not fit what the user wants now.');
  }
  if (args.repair) {
    lines.push('');
    lines.push(`YOUR LAST REPLY COULD NOT BE USED: ${args.repair}`);
    lines.push('Reply again, following the format exactly.');
  }
  return lines.join('\n');
}

/// Read a roster drafter reply. Crew workers it names that are not on the
/// crew are dropped rather than failing the whole draft — you are about to
/// review it anyway.
export function parseTeamRosterReply(
  text: string,
  crew: Array<Pick<TeamCrewLine, 'workerId' | 'name'>>,
  projects: Array<{ name: string; path: string }> = [],
): { ok: true; draft: TeamRosterDraft } | { ok: false; error: string } {
  const raw = extractTag(text, 'team_roster');
  if (raw === null) return { ok: false, error: 'No <team_roster> block in the reply.' };
  const parsed = parseJsonLoose(raw) as
    | { name?: unknown; purpose?: unknown; project?: unknown; note?: unknown; members?: unknown }
    | undefined;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.members)) {
    return { ok: false, error: 'The <team_roster> block was not JSON with a "members" list.' };
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const lookup = crew.map((w) => ({ workerId: w.workerId, name: w.name, role: '' }));
  const members: TeamRosterPick[] = [];
  for (const entry of parsed.members) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as { worker?: unknown; hire?: unknown; role?: unknown };
    const role = str(m.role);
    if (str(m.worker)) {
      const workerId = resolveMember(str(m.worker), lookup);
      if (!workerId || members.some((x) => x.kind === 'worker' && x.workerId === workerId)) continue;
      members.push({ kind: 'worker', workerId, role });
    } else if (str(m.hire)) {
      members.push({ kind: 'hire', job: str(m.hire), role: role || roleFromJob(str(m.hire)) });
    }
  }
  if (members.length < 2) return { ok: false, error: 'The team needs at least two members.' };
  const projectName = str(parsed.project).toLowerCase();
  const project = projectName ? projects.find((p) => p.name.trim().toLowerCase() === projectName) : undefined;
  return {
    ok: true,
    draft: {
      name: str(parsed.name).slice(0, 80),
      purpose: str(parsed.purpose).slice(0, 200),
      ...(project ? { projectPath: project.path } : {}),
      note: str(parsed.note) || proseBefore(text, 'team_roster'),
      members: members.slice(0, TEAM_MAX_MEMBERS),
    },
  };
}

/// A role line from a job you typed: its first sentence, kept short.
export function roleFromJob(job: string): string {
  const first = job.trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? '';
  const clipped = first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
  return clipped.replace(/[.]$/, '');
}

/// What a team hire asks the hire drafter for. Team hires work on demand: a
/// team commissions them one piece at a time, so a shift rota would only
/// spend their budget on work nobody asked for.
export interface TeamHireRequest {
  job: string;
  role: string;
  teamName: string;
  teamId?: UUID;
  purpose?: string;
  /// The project the team works in: the hire lands there.
  projectPath?: string;
  /// Its name, for the drafter.
  projectName?: string;
}

/// Names a team hire falls back on when the drafter's pick is taken. Short,
/// distinct first names, so a plan can address each one unambiguously.
const SPARE_NAMES = [
  'Ada', 'Bram', 'Cleo', 'Dev', 'Esme', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonah',
  'Kit', 'Lior', 'Maren', 'Nico', 'Orla', 'Pax', 'Quinn', 'Rafa', 'Sana', 'Tomas',
  'Uma', 'Vik', 'Wren', 'Xavi', 'Yara', 'Zeno',
];

/// A drafted hire whose name someone on the crew already has gets another,
/// and its own words follow: hires drafted side by side each see the crew as
/// it was, so two of them can pick the same name — and two members with one
/// name leave a plan unable to tell them apart.
export function renameIfTaken<T extends { name: string; jobDescription: string; tagline?: string; errandStarters?: string[] }>(
  draft: T,
  taken: string[],
): T {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(draft.name.trim().toLowerCase())) return draft;
  const name =
    SPARE_NAMES.find((n) => !used.has(n.toLowerCase())) ??
    Array.from({ length: 100 }, (_, i) => `${draft.name} ${i + 2}`).find((n) => !used.has(n.toLowerCase()))!;
  const escaped = draft.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const swap = (text: string) => text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), name);
  return {
    ...draft,
    name,
    jobDescription: swap(draft.jobDescription),
    ...(draft.tagline !== undefined ? { tagline: swap(draft.tagline) } : {}),
    ...(draft.errandStarters ? { errandStarters: draft.errandStarters.map(swap) } : {}),
  };
}

export function teamHireJobDescription(req: TeamHireRequest): string {
  const team = `the "${req.teamName.trim() || 'new'}" team${req.purpose?.trim() ? ` (${req.purpose.trim()})` : ''}`;
  return [
    req.job.trim(),
    '',
    `This worker is being hired for ${team}, where their role is: ${req.role.trim() || roleFromJob(req.job)}.`,
    ...(req.projectName ? [`They work in the ${req.projectName} project.`] : []),
    "The team's coordinator commissions them for one piece of a larger task at a time, so they work",
    'ON DEMAND — no shifts and no schedule. Their flow should do one well-scoped piece of this job',
    'from the instruction it is given and hand back the result.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Stage prompts
// ---------------------------------------------------------------------------

export interface FolderFile {
  name: string;
  author: string;
  body: string;
}

/// Fit the shared folder into a prompt budget. Every file is named. The budget
/// is shared out so that files under their fair share are kept whole and only
/// the long ones are cut — an even split cut a 25k-character piece to make
/// room for nothing, while a 155k one still overflowed.
///
/// `pointToFiles` says where the rest of a cut file is. Only for readers that
/// can open files (members' runs): the coordinator has no tools, and a path
/// in front of it invites a read that waits forever on a permission prompt
/// nobody can see.
export function folderForPrompt(
  files: FolderFile[],
  budget: number,
  folder: string,
  opts: { pointToFiles?: boolean } = {},
): string {
  if (files.length === 0) return '(empty — you are the first to contribute)';
  const allowance = shareBudget(files.map((f) => f.body.length), budget);
  return files
    .map((f, i) => {
      const each = allowance[i];
      const cut = f.body.length - each;
      const body = cut > 0
        ? `${f.body.slice(0, each)}\n[… ${cut.toLocaleString('en-US')} more characters cut to fit${
            opts.pointToFiles !== false ? `; the full file is ${joinPath(folder, f.name)}` : ''
          }]`
        : f.body;
      return `=== ${f.name} (by ${f.author}) ===\n${body}`;
    })
    .join('\n\n');
}

/// Water-fill: everyone gets up to an equal share; what the short ones don't
/// use is handed on to the long ones, until the budget is spent.
export function shareBudget(lengths: number[], budget: number): number[] {
  const out = lengths.map(() => 0);
  let left = Math.max(0, budget);
  let open = lengths.map((_, i) => i);
  while (open.length > 0 && left > 0) {
    const share = Math.floor(left / open.length);
    if (share === 0) break;
    const still: number[] = [];
    for (const i of open) {
      const want = lengths[i] - out[i];
      const give = Math.min(want, share);
      out[i] += give;
      left -= give;
      if (out[i] < lengths[i]) still.push(i);
    }
    open = still;
  }
  return out;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

const STAGE_GUIDANCE: Record<TeamStageKind, string> = {
  contribute: 'Produce your piece of the work, from your role’s point of view.',
  challenge: [
    'Your job in this stage is to ATTACK the case, not to improve the prose. Find the weakest',
    'assumptions, who would say no and why, what is missing, and what would make this not worth',
    'doing. Write a numbered list of objections. For each: a one-line objection, severity',
    '(High / Medium / Low), why it matters, and which member’s part it concerns. Rank them',
    'most severe first. Do not soften them, and do not invent facts to support them.',
  ].join('\n'),
  respond: [
    'An objection list is in the shared folder. Answer every objection that concerns your part.',
    'For each, say one of: RESOLVED (and how — a change, or evidence it does not hold),',
    'ACCEPTED RISK (and why it is worth carrying), or SCOPE CHANGE (what to cut or change).',
    'Reference objections by their number.',
  ].join('\n'),
  draft: '',
  synthesize: '',
};

/// The prompt a member's run receives for its piece of a stage.
/// Where one step of follow-up work run in steps stands.
export interface FollowUpSteps {
  index: number;
  of: number;
  /// What each member in the steps before made in this run.
  before: Array<{ name: string; files: string[] }>;
  /// Who builds on this step next.
  next: string[];
}

export function buildMemberStagePrompt(args: {
  teamName: string;
  task: Pick<TeamTask, 'brief' | 'title' | 'questions' | 'answers' | 'deliverables' | 'comments'>;
  /// The member being briefed, so comments said to them are marked so.
  workerId?: string;
  stageNumber: number;
  stageCount: number;
  stage: Pick<TeamStage, 'kind' | 'title'>;
  role: string;
  ask: string;
  teammates: Array<{ name: string; role: string }>;
  folder: string;
  files: FolderFile[];
  budget: number;
  /// The project this task works in, when it is not the member's own.
  project?: { name: string; path: string; usual?: string };
  /// The task's shared branch, when it works in code (TeamTask.code).
  code?: { branch: string };
  /// Work handed off from the room after the pack was written.
  followUp?: {
    /// The conversation that led to it, as text.
    conversation: string;
    /// Files the team made earlier, as task-folder names (`files/lena/designs/01.html`).
    madeFiles: string[];
    /// Where this member's own earlier files sit (`files/lena/`).
    ownFilesDir: string;
    /// When the work runs in steps: what the steps before this one just
    /// made, and who builds on this one next.
    steps?: FollowUpSteps;
  };
}): string {
  const lines: string[] = [];
  lines.push(`YOU ARE WORKING AS PART OF A TEAM: ${args.teamName}`);
  lines.push(`Your role on this team: ${args.role || '(not given)'}`);
  if (args.teammates.length > 0) {
    lines.push(`Teammates: ${args.teammates.map((t) => `${t.name} (${t.role || 'member'})`).join(', ')}`);
  }
  if (args.followUp) {
    lines.push(`This is FOLLOW-UP WORK: ${args.stage.title}. The team already finished the task below and wrote`);
    lines.push('its pack; the user then talked it over with the team and asked for this. The pack is in the');
    lines.push('shared folder; the coordinator folds your work into it afterwards, so you do not rewrite the pack.');
  } else {
    lines.push(`This is stage ${args.stageNumber} of ${args.stageCount}: ${args.stage.title} [${args.stage.kind}].`);
    lines.push('A coordinator combines everyone’s pieces into the final pack; you do not write the pack.');
  }
  if (args.project) {
    lines.push('');
    lines.push(`THE PROJECT: ${args.project.name} — ${args.project.path}`);
    lines.push('This task is about this project, and your working folder is in it. Read, check and change this');
    lines.push(
      `project's code and files${args.project.usual ? `, not ${args.project.usual} (the project you usually work in — your job description may describe that one)` : ''}.`,
    );
  }
  if (args.code) {
    // Said outright because a member's own job description often says to
    // cut a branch per ticket, or to push and open a PR — and work committed
    // anywhere but the checked-out branch never reaches the team.
    lines.push('');
    lines.push(`THE CODE: the team's work lives on one git branch, ${args.code.branch}. Your checkout is`);
    lines.push('already on the branch for your piece, which starts from everything earlier stages committed.');
    lines.push('- Commit on the branch you are on. Several commits are fine (one per ticket, say).');
    lines.push('- Do NOT create, switch to or rename branches, check out other commits, or rebase onto');
    lines.push('  another base. Overcli merges only the branch you were given; work on any other branch is');
    lines.push('  lost to the team.');
    lines.push('- Do NOT push or open pull requests. The user pushes the team branch when the task is done.');
  }
  lines.push('');
  lines.push(`THE TASK${args.task.title ? `: ${args.task.title}` : ''}`);
  lines.push(args.task.brief.trim());
  const qa = clarified(args.task);
  if (qa.length > 0) {
    lines.push('');
    lines.push('WHAT THE USER CLARIFIED');
    for (const { q, a } of qa) lines.push(`- ${q} → ${a}`);
  }
  lines.push(...commentLines(args.task.comments, args.workerId));
  if (args.task.deliverables?.length) {
    lines.push('');
    lines.push(`The final pack will contain: ${args.task.deliverables.join(', ')}.`);
  }
  if (args.followUp) {
    lines.push('');
    lines.push('THE CONVERSATION THAT LED TO THIS');
    lines.push(args.followUp.conversation);
  }
  lines.push('');
  lines.push('YOUR ASSIGNMENT');
  lines.push(args.ask.trim());
  if (args.followUp) {
    lines.push('');
    lines.push('You have your tools for this: read code, open files, write files. Do the work itself;');
    lines.push('do not stop at describing it.');
    if (args.followUp.madeFiles.length > 0) {
      lines.push('');
      lines.push('FILES THE TEAM MADE EARLIER (in the shared folder):');
      for (const f of args.followUp.madeFiles.slice(0, 60)) lines.push(`- ${args.folder}/${f}`);
      if (args.followUp.madeFiles.length > 60) lines.push(`- … and ${args.followUp.madeFiles.length - 60} more`);
    }
    lines.push(...followUpStepLines(args.followUp.steps, args.folder));
    lines.push('');
    lines.push('Everything you write in your working folder is copied into the shared folder when you finish.');
    lines.push(`Your own earlier files are under ${args.folder}/${args.followUp.ownFilesDir}. To revise one, start from`);
    lines.push('that copy and write the new version at the SAME relative path in your working folder (for');
    lines.push(`${args.followUp.ownFilesDir}designs/01-page.html, write designs/01-page.html): it replaces the old one.`);
  }
  const guidance = args.followUp ? '' : STAGE_GUIDANCE[args.stage.kind];
  if (guidance) {
    lines.push('');
    lines.push(guidance);
  }
  lines.push('');
  lines.push('THE SHARED FOLDER');
  lines.push(`Everything the team has produced so far is at: ${args.folder}`);
  lines.push('Read it before you start; build on it rather than repeating it. Its contents so far:');
  lines.push('');
  lines.push(folderForPrompt(args.files, args.budget, args.folder));
  lines.push('');
  lines.push('YOUR OUTPUT');
  if (args.followUp) {
    lines.push('End with a short Markdown report: what you did, which files you made or changed, and what');
    lines.push('you could not do and why. It is posted back to the user in the team conversation.');
    lines.push('Never invent figures, quotes or sources.');
  } else {
    lines.push('End with your piece as ONE self-contained Markdown document. It is filed into the shared');
    lines.push('folder under your name for the rest of the team to read. Say plainly what you could not');
    lines.push('establish; never invent figures, quotes or sources. Use placeholders like [MARKET SIZE] instead.');
  }
  return lines.join('\n');
}

/// Where a member stands in follow-up work run in steps: build on what the
/// step before just made, not last round's copies; and know who builds on
/// yours.
function followUpStepLines(steps: FollowUpSteps | undefined, folder: string): string[] {
  if (!steps || steps.of < 2) return [];
  const lines = ['', `THIS WORK RUNS IN STEPS: you are step ${steps.index + 1} of ${steps.of}.`];
  if (steps.before.length > 0) {
    lines.push('It builds on what was done just before you, in this same piece of work. Start from these');
    lines.push('files: they are newer than anything else in the folder, including the pack.');
    for (const b of steps.before) {
      if (b.files.length === 0) {
        lines.push(`- ${b.name}: made no files (read their report in the folder).`);
        continue;
      }
      lines.push(`- ${b.name}:`);
      for (const f of b.files.slice(0, 30)) lines.push(`  - ${folder}/${f}`);
      if (b.files.length > 30) lines.push(`  - … and ${b.files.length - 30} more`);
    }
  }
  if (steps.next.length > 0) {
    lines.push(`${steps.next.join(' and ')} build${steps.next.length === 1 ? 's' : ''} on your work next: put what you find or change in`);
    lines.push('files, and say in your report where it is.');
  }
  return lines;
}

export const TEAM_COORDINATOR_SYSTEM_PROMPT = [
  'You have NO tools. Do not try to read, open or search for files: everything you need is in',
  'the message below. Start writing your reply straight away.',
  '',
  'You are the COORDINATOR of a small team of AI workers. The members have produced pieces of',
  'work, filed in a shared folder that is reproduced in the message. You combine them; you do',
  'not add research of your own. Where members disagree, decide and say why in one line.',
  'Where something is missing because a piece failed or was not done, say so plainly rather',
  'than filling the gap with a guess. Never invent figures, quotes or sources.',
].join('\n');

/// The deliverables a member already made: for each the task asked for by
/// name, the newest file of that name a member (not the coordinator, not an
/// earlier pack) wrote in the folder. The plan gave someone that document to
/// make; it goes in the pack as they made it.
export function madeDeliverables(
  deliverables: readonly string[] | undefined,
  files: ReadonlyArray<{ name: string; author: string; at?: number }>,
): Array<{ deliverable: string; from: string; author: string }> {
  const out: Array<{ deliverable: string; from: string; author: string }> = [];
  for (const d of deliverables ?? []) {
    const want = d.trim().toLowerCase();
    if (!want) continue;
    const hit = files
      .filter((f) => f.author !== 'Coordinator' && f.author !== 'You' && !f.name.startsWith('pack/') && (f.name.split('/').pop() ?? '').toLowerCase() === want)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    if (hit) out.push({ deliverable: safeTeamFileName(d), from: hit.name, author: hit.author });
  }
  return out;
}

/// The coordinator's message for a draft or synthesize stage.
export function buildCoordinatorStageMessage(args: {
  teamName: string;
  task: Pick<TeamTask, 'brief' | 'title' | 'questions' | 'answers' | 'deliverables' | 'comments'>;
  stage: Pick<TeamStage, 'kind' | 'title' | 'ask'>;
  stageNumber: number;
  stageCount: number;
  folder: string;
  files: FolderFile[];
  budget: number;
  /// Deliverables members already made (`madeDeliverables` over every file,
  /// the ones runs wrote under files/ included, which `files` leaves out).
  made?: Array<{ deliverable: string; from: string; author: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`TEAM: ${args.teamName}`);
  lines.push(`TASK${args.task.title ? `: ${args.task.title}` : ''}`);
  lines.push(args.task.brief.trim());
  const qa = clarified(args.task);
  if (qa.length > 0) {
    lines.push('');
    lines.push('WHAT THE USER CLARIFIED');
    for (const { q, a } of qa) lines.push(`- ${q} → ${a}`);
  }
  lines.push(...commentLines(args.task.comments));
  lines.push('');
  lines.push(`STAGE ${args.stageNumber} of ${args.stageCount}: ${args.stage.title} [${args.stage.kind}]`);
  if (args.stage.ask) lines.push(args.stage.ask);
  lines.push('');
  lines.push('THE SHARED FOLDER');
  lines.push(folderForPrompt(args.files, args.budget, args.folder, { pointToFiles: false }));
  lines.push('');
  if (args.stage.kind === 'draft') {
    lines.push('Write the draft as ONE Markdown document. Reply with the document only.');
  } else {
    const wanted = args.task.deliverables?.length ? args.task.deliverables.join(', ') : 'report.md';
    lines.push('Write the FINAL PACK. Reply in exactly this shape:');
    lines.push('');
    lines.push('<summary>');
    lines.push('One short paragraph: the verdict or headline, and anything the user must know before relying on it.');
    lines.push('</summary>');
    lines.push('<file name="NAME.md">');
    lines.push('…the full document…');
    lines.push('</file>');
    lines.push('(one <file> block per document)');
    lines.push('<include name="NAME.html" from="files/hugo/report.html"/>');
    lines.push('(one per document a member already made, by its name in the folder above)');
    lines.push('');
    // A member's report, deck or page is the work: retyped into this one
    // reply it comes back shorter and from memory. The server copies an
    // include byte for byte.
    lines.push('When a member already made a document the user asked for (a page, a report, a deck,');
    lines.push('data), put THAT file in the pack with <include>: do not write it again. Write a <file>');
    lines.push('only for what nobody has written yet, such as a summary that ties the pieces together.');
    const made = args.made ?? madeDeliverables(args.task.deliverables, args.files);
    if (made.length) {
      lines.push('Already made, and going in the pack as they are (the server adds them; do not write them):');
      for (const m of made) lines.push(`- ${m.deliverable}: by ${m.author}, ${m.from}`);
    }
    const rest = (args.task.deliverables ?? []).filter((d) => !made.some((m) => m.deliverable.toLowerCase() === safeTeamFileName(d).toLowerCase()));
    lines.push(`The documents to write: ${args.task.deliverables?.length ? rest.join(', ') || 'none beyond the summary' : wanted}.`);
    lines.push('If a challenge stage ran, also write challenge-log.md: a table of every objection, its');
    lines.push('severity, and how it was answered (resolved, accepted risk, or scope change).');
  }
  return lines.join('\n');
}

/// Read the synthesize reply into a summary and its files. A reply that
/// ignored the format still yields a pack: the whole text as report.md.
export function parsePackReply(text: string): { summary: string; files: Array<{ name: string; body: string }>; includes: Array<{ name: string; from: string }> } {
  const summary = (text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? '').trim();
  const files: Array<{ name: string; body: string }> = [];
  const used = new Set<string>();
  // Documents a member already made, by their name in the folder. The engine
  // copies only a file the folder lists; this only reads the tag.
  const includes: Array<{ name: string; from: string }> = [];
  const inc = /<include\s+name\s*=\s*["']([^"']+)["']\s+from\s*=\s*["']([^"']+)["']\s*\/?>(?:\s*<\/include>)?/gi;
  let i: RegExpExecArray | null;
  while ((i = inc.exec(text))) {
    const name = safeTeamFileName(i[1]);
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    includes.push({ name, from: i[2].trim() });
  }
  const re = /<file\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/file>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let name = safeTeamFileName(m[1]);
    const body = m[2].replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    if (!body.trim()) continue;
    // Included as the member made it: a retyped copy of the same name is dropped.
    if (includes.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    let n = 2;
    while (used.has(name.toLowerCase())) name = name.replace(/(\.[^.]+)?$/, (ext) => `-${n++}${ext}`);
    used.add(name.toLowerCase());
    files.push({ name, body });
  }
  if (files.length === 0 && includes.length === 0) {
    const body = text.replace(/<summary>[\s\S]*?<\/summary>/i, '').trim();
    if (body) files.push({ name: 'report.md', body: `${body}\n` });
  }
  return { summary: summary || firstParagraph(text), files, includes };
}

/// A pack update: only what changes. Documents it does not name stay as
/// they are, so a one-line correction does not retype a whole pack.
export interface PackUpdate {
  summary: string;
  /// Documents rewritten whole, or new ones.
  files: Array<{ name: string; body: string }>;
  /// Passages replaced in place: `find` must appear exactly once.
  edits: Array<{ name: string; find: string; replace: string }>;
  /// Documents taken out of the pack.
  drops: string[];
  /// Files members made, put in the pack as they are: `from` is the
  /// shared-folder name, copied byte for byte by the engine.
  includes: Array<{ name: string; from: string }>;
}

export function parsePackUpdate(text: string): PackUpdate {
  const edits: PackUpdate['edits'] = [];
  const editRe =
    /<edit\s+name\s*=\s*["']([^"']+)["']\s*>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>\s*<\/edit>/gi;
  let m: RegExpExecArray | null;
  while ((m = editRe.exec(text))) {
    if (!m[2].trim()) continue;
    edits.push({ name: safeTeamFileName(m[1]), find: m[2], replace: m[3] });
  }
  const drops: string[] = [];
  const dropRe = /<drop\s+name\s*=\s*["']([^"']+)["']\s*\/?>(?:\s*<\/drop>)?/gi;
  while ((m = dropRe.exec(text))) drops.push(safeTeamFileName(m[1]));
  // Edits out first: a <file> tag quoted inside a passage is not a document.
  const rest = text.replace(editRe, '').replace(dropRe, '');
  const whole = parsePackReply(rest);
  // No stray reply text turned into a document: an update that names no
  // file changes none.
  const files = /<file\s/i.test(rest) ? whole.files : [];
  const summary = (text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? '').trim() || whole.summary;
  return { summary, files, edits, drops, includes: whole.includes };
}

/// The pack after an update: every document, by name, and which ones
/// changed. An edit whose passage is missing or ambiguous is not guessed
/// at: it is listed in `failed` and that document keeps its text.
export function applyPackUpdate(
  current: Array<{ name: string; body: string }>,
  update: Pick<PackUpdate, 'files' | 'edits' | 'drops'>,
): { files: Array<{ name: string; body: string }>; changed: string[]; failed: Array<{ name: string; why: string }> } {
  const key = (n: string) => n.toLowerCase();
  const out = new Map<string, { name: string; body: string }>();
  for (const f of current) out.set(key(f.name), { ...f });
  const dropped = new Set(update.drops.map(key));
  for (const k of dropped) out.delete(k);
  const rewritten = new Set<string>();
  for (const f of update.files) {
    const was = out.get(key(f.name));
    out.set(key(f.name), { name: was?.name ?? f.name, body: f.body });
    rewritten.add(key(f.name));
  }
  const failed: Array<{ name: string; why: string }> = [];
  for (const e of update.edits) {
    // A document rewritten whole already carries its changes.
    if (rewritten.has(key(e.name))) continue;
    const doc = out.get(key(e.name));
    if (!doc) {
      if (!dropped.has(key(e.name))) failed.push({ name: e.name, why: 'no document by that name' });
      continue;
    }
    // Exact first; then without the blank lines models put round a passage.
    const find = doc.body.includes(e.find) ? e.find : e.find.replace(/^\n+|\n+$/g, '');
    const replace = find === e.find ? e.replace : e.replace.replace(/^\n+|\n+$/g, '');
    const at = doc.body.indexOf(find);
    if (!find || at < 0) {
      failed.push({ name: doc.name, why: 'the text it replaces was not found' });
      continue;
    }
    if (doc.body.indexOf(find, at + 1) >= 0) {
      failed.push({ name: doc.name, why: 'the text it replaces appears more than once' });
      continue;
    }
    doc.body = doc.body.slice(0, at) + replace + doc.body.slice(at + find.length);
  }
  const before = new Map(current.map((f) => [key(f.name), f.body]));
  const files = [...out.values()];
  const changed = files.filter((f) => before.get(key(f.name))?.trim() !== f.body.trim()).map((f) => f.name);
  return { files, changed, failed };
}

function firstParagraph(text: string): string {
  // Tags out, then any angle bracket left over: one pass of a tag pattern can
  // leave a tag behind in crafted text ("<scr<x>ipt>"), and this summary is
  // shown to you.
  const clean = text.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').trim();
  const para = clean.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith('#')) ?? '';
  return para.trim().slice(0, 600);
}

/// A model-supplied file name, made safe to write inside the task folder:
/// one segment, no traversal, no hidden files, a document extension.
export function safeTeamFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\- ]+/, '');
  if (!name) name = 'document';
  if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) name = `${name}.md`;
  if (name.length > 80) {
    const ext = name.slice(name.lastIndexOf('.'));
    name = `${name.slice(0, 80 - ext.length)}${ext}`;
  }
  return name;
}

/// Find the task file a reference in text means. Members and the coordinator
/// name files the way they knew them — `designs/00-index.html`, `DESIGNS.md`,
/// `04-acme-partner-collateral.html` — not by their place in the shared
/// folder (`files/lena/designs/00-index.html`, `pack/DESIGNS.md`). Exact
/// name first, then a unique path ending, then a unique base name.
export function resolveTaskFileRef(names: string[], ref: string): string | null {
  const want = ref.trim().replace(/^\.?\//, '').replace(/:\d+(?:[-:]\d+)?$/, '');
  if (!want) return null;
  if (names.includes(want)) return want;
  const lower = want.toLowerCase();
  const ending = names.filter((n) => n.toLowerCase().endsWith(`/${lower}`));
  if (ending.length === 1) return ending[0];
  const base = lower.split('/').pop()!;
  const byBase = names.filter((n) => n.toLowerCase().split('/').pop() === base);
  if (byBase.length === 1) return byBase[0];
  // Several copies of one name (the pack and its old version): the newest
  // pack wins over an archived one.
  const current = byBase.filter((n) => !/^pack-v\d+\//.test(n));
  return current.length === 1 ? current[0] : null;
}

/// Files the desk reads in place; anything else opens in its own app.
export function isReadableInDesk(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

export function slugify(text: string, max = 32): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug.slice(0, max).replace(/-+$/, '') || 'part');
}

/// The shared-folder name for one stage's piece: ordered by stage so the
/// folder reads in the order the work happened.
export function stageFileName(stageIndex: number, stageTitle: string, author: string): string {
  return `${String(stageIndex + 1).padStart(2, '0')}-${slugify(stageTitle)}-${slugify(author, 20)}.md`;
}

/// The id a member's one-step team flow is saved under — one per source flow,
/// rewritten on every commission so it follows edits to the original.
export function teamPieceFlowId(flowId: string, opts: { check?: boolean } = {}): string {
  return `team-piece-${opts.check ? 'checked-' : ''}${flowId}`;
}

/// The member's own flow a team piece was made from: the inverse of
/// `teamPieceFlowId`. Any other id is already the member's own.
export function sourceFlowIdOfPiece(flowId: string): string {
  return flowId.replace(/^team-piece-(?:checked-)?/, '');
}

/// The flow with `tools` added to its first step. A piece takes every step's
/// tools (`teamPieceFlow`), so the first is enough; null when nothing changes.
export function withStepTools(flow: Flow, tools: string[]): Flow | null {
  const first = flow.steps[0];
  const missing = tools.filter((t) => !first?.tools.includes(t));
  if (!first || missing.length === 0) return null;
  return { ...flow, steps: [{ ...first, tools: [...first.tools, ...missing] }, ...flow.steps.slice(1)] };
}

/// Roles whose step checks work rather than doing it.
const CHECK_ROLES = new Set<string>(['reviewer', 'code-reviewer', 'security-reviewer', 'test-writer', 'debugger']);
const CHECK_NAME = /test|verif|check|lint|review|qa\b/i;

/// The member's own checking step — tests, a build, a review — if its flow
/// has one after its first step. A piece that changes code keeps it.
export function checkStepOf(flow: Flow): Flow['steps'][number] | null {
  const later = flow.steps.slice(1);
  for (let i = later.length - 1; i >= 0; i--) {
    const step = later[i];
    if (CHECK_ROLES.has(step.role) || CHECK_NAME.test(step.id)) return step;
  }
  return null;
}

const TEAM_CHECK_SYSTEM_PROMPT = [
  'You check a teammate\'s piece of a team task before it is merged into the team\'s branch.',
  'The previous step did the work in this working folder; its reply is in piece.md. Check what',
  'changed the way this project checks its work — run its tests, build or linter as they apply',
  'to the change — and fix anything small that fails. Do not take on new work.',
  '',
  'Reply with the piece as piece.md has it, corrected where your checks required, then end with',
  'a short "## Checked" section: what you ran, and how it came out. If something is broken and',
  'you could not fix it, say so plainly there.',
].join('\n');

/// Tools a piece needs whatever the member's own flow allows: the prompt
/// tells it to write its files into its working folder, which is how they
/// reach the shared folder. Claude's names; other backends keep their own.
const PIECE_WRITE_TOOLS = ['Write', 'Edit'];

const TEAM_PIECE_SYSTEM_PROMPT = [
  'You are a member of a team, doing ONE piece of a larger task. The message tells you who',
  'you are on the team, what the task is, exactly what your piece is, and where the team\u2019s',
  'shared folder is. Do that piece and only that piece: the coordinator planned the stages,',
  'so work another stage owns is not yours, however your usual job goes.',
  '',
  'Read the shared folder first and build on it. If an earlier piece already covers part of',
  'your assignment, use it and say so rather than doing it again.',
  '',
  'Write any files your assignment names into your current working folder (relative paths);',
  'they are copied into the shared folder when you finish. End your reply with your piece as',
  'the message asks.',
].join('\n');

/// A member's flow collapsed to the one step a team piece needs.
///
/// A team commissions a member for a piece the coordinator has already
/// scoped, and running the member's own pipeline instead re-did its whole job
/// every time: a spec writer asked only to survey the code wrote a full tech
/// spec, then, asked for the architecture two stages later, surveyed the code
/// again. One step keeps who the member is — backend, model, tools — and
/// drops the pipeline: no fixed steps, critic loops, pauses or handoffs.
///
/// The model is the participant that runs most of the flow's steps (ties go
/// to the one declared first): that is the member's working voice, where a
/// single fast polish step is not.
export function teamPieceFlow(flow: Flow, opts: { check?: boolean } = {}): Flow {
  const counts = new Map<string, number>();
  for (const step of flow.steps) counts.set(step.participantId, (counts.get(step.participantId) ?? 0) + 1);
  const participant =
    [...flow.participants].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0] ??
    flow.participants[0];
  const tools = [...new Set(flow.steps.flatMap((step) => step.tools))];
  if (participant?.backend === 'claude') {
    for (const t of PIECE_WRITE_TOOLS) if (!tools.includes(t)) tools.push(t);
    // A member allowed to read the web researches with search as well as
    // fetch: a piece is usually research, and a search outside the list
    // stopped every one to ask you.
    if (tools.includes('WebFetch') && !tools.includes('WebSearch')) tools.splice(tools.indexOf('WebFetch') + 1, 0, 'WebSearch');
  }
  // No stricter than the member's own flow: a flow whose steps run on the
  // runtime's default (or bypass prompts) runs its piece the same way, rather
  // than asking you about every Bash call its own job never asks about. The
  // runtime still holds a worker with no grant for external actions to
  // `acceptEdits` (see resolvePermissionMode). Only a flow that is careful
  // on every step keeps its piece careful — at `acceptEdits`, since a piece
  // has to write its files.
  const careful = flow.steps.length > 0 && flow.steps.every((step) => step.permissionMode && step.permissionMode !== 'bypassPermissions');
  // A piece that can do what the member's flow does outside the machine —
  // publish to Claude Design, post, send — is an external step too, so a
  // member without the grant for external actions stops before it rather
  // than doing it quietly. Everything else stays local.
  const external = flow.steps.some((step) => step.effect === 'external');
  // A piece that changes code keeps the member's own check, as a second step
  // on the model that ran it in the member's flow. The check's reply ends
  // with the piece, so the piece is still what files into the shared folder.
  const checkStep = opts.check ? checkStepOf(flow) : null;
  const checker = checkStep ? flow.participants.find((p) => p.id === checkStep.participantId) : undefined;
  const checkTools = checkStep ? [...new Set([...checkStep.tools, ...tools])] : [];
  const participants = participant ? [participant] : [];
  if (checker && !participants.some((p) => p.id === checker.id)) participants.push(checker);
  return {
    id: teamPieceFlowId(flow.id, { check: !!checkStep }),
    name: `${flow.name} — team piece${checkStep ? ', checked' : ''}`,
    description: checkStep
      ? `"${flow.name}" for pieces of a team task: the piece, then the flow's own check.`
      : `One-step version of "${flow.name}" for pieces of a team task.`,
    input: 'user_prompt',
    participants,
    steps: [
      {
        id: 'piece',
        participantId: participant?.id ?? '',
        role: 'custom',
        systemPromptOverride: TEAM_PIECE_SYSTEM_PROMPT,
        inputs: ['user_prompt'],
        tools,
        ...(careful ? { permissionMode: 'acceptEdits' as const } : {}),
        // Local unless the member's own flow acts outside the machine.
        effect: external ? 'external' : 'local',
        output: 'piece.md',
      },
      ...(checkStep && checker
        ? [
            {
              id: 'check',
              participantId: checker.id,
              role: 'custom' as const,
              systemPromptOverride: TEAM_CHECK_SYSTEM_PROMPT,
              inputs: ['user_prompt', 'piece.md'],
              tools: checkTools,
              ...(careful ? { permissionMode: 'acceptEdits' as const } : {}),
              effect: 'local' as const,
              output: 'checked.md',
              // A piece that only researched or wrote has nothing to test,
              // and the check's Bash would stop it to ask you first.
              onlyIfChanged: true,
            },
          ]
        : []),
    ],
    source: 'generated',
    filePath: '',
  };
}

/// The learning pass for a team: each member reports, from its own tools and
/// files, what the team will need to know; the coordinator writes it up as
/// TEAM_KNOWLEDGE.md. A fixed plan: nothing to ask or approve.
export function learnStages(team: Pick<Team, 'name' | 'purpose' | 'members'>, names: Map<string, string>): TeamStage[] {
  const purpose = team.purpose?.trim() ? ` (${team.purpose.trim()})` : '';
  return [
    {
      kind: 'contribute',
      title: 'What each member knows',
      status: 'pending',
      assignments: team.members.map((m) => ({
        workerId: m.workerId,
        workerName: names.get(m.workerId) ?? 'A member',
        ask: [
          `${team.name}${purpose} is learning what it needs to know, so that later it can answer questions straight away and start work without asking the basics.`,
          `As ${m.role || 'a member'}, use your own tools and files to find the current state of things in your area: what exists, what is planned and when, what has been decided, who owns what, and where it lives.`,
          'Facts with their source (a link, a ticket, a page, a file) and date. No opinions or recommendations. Say what you could not find. A page or two at most.',
        ].join(' '),
        status: 'pending' as const,
      })),
    },
    {
      kind: 'synthesize',
      title: 'What the team knows',
      status: 'pending',
      ask: `Write ${TEAM_KNOWLEDGE_FILE}: what the team knows, by topic, each fact with its source and date, then what is unknown or out of date. Facts only, under about 2,000 words. The summary says in a line what it covers.`,
      assignments: [],
    },
  ];
}
