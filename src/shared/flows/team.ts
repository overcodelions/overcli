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
  /// Hold work handed off from the room until you start it. Off (absent):
  /// it starts as soon as the coordinator hands it off, or queues behind
  /// work already running — you asked for it, and the budget still caps it.
  approveRoomWork?: boolean;
}

export const DEFAULT_TEAM_CHECKPOINTS: TeamCheckpoints = {
  askFirst: true,
  reviewBeforeChallenge: false,
  finalReview: true,
  approveRoomWork: false,
};

export const DEFAULT_TEAM_BUDGET_USD = 1000;

export interface Team {
  id: UUID;
  name: string;
  /// One line: what the team is for. Shown under the name, and handed to the
  /// coordinator as the team's standing purpose.
  purpose?: string;
  members: TeamMember[];
  /// The project or workspace the team works in. Every member's piece runs
  /// there, whatever project the member usually works in — the member brings
  /// their skills, model and tools; the task brings the repo. Absent: each
  /// member works in their own project (a research team needs no repo).
  projectPath?: string;
  /// Hold a member's team pieces to that member's own permissions: a worker
  /// without the grant for external actions has every call outside its
  /// piece's tools refused. Absent or false — the default — a piece the team
  /// commissions runs with the grant, whatever the member's own settings say:
  /// you approved the plan that asked for it, the piece is scoped by the
  /// coordinator, and it runs in its own worktree. The member's own shifts
  /// and errands keep the member's settings either way.
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
}

export type TeamTaskStatus =
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
  /// part of the approved plan: the room message that proposed it.
  fromRoom?: { messageId: string; exchange: number };
}

export interface TeamTaskFile {
  /// Path relative to the task folder (`pack/PROPOSAL.md` for the final pack).
  name: string;
  /// Who wrote it: a member's name, "Coordinator", or "You".
  author: string;
  stage?: number;
  at: number;
}

export interface TeamTask {
  id: UUID;
  teamId: UUID;
  /// Snapshot of the team name at brief time.
  teamName: string;
  /// What you asked for, verbatim.
  brief: string;
  /// Where this task's pieces run: chosen with the brief, else the team's.
  /// Absent: each member in their own project.
  projectPath?: string;
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
  /// Why a `waiting` task is waiting.
  waiting?: { reason: 'checkpoint' | 'budget' | 'failed'; message: string };
  /// The stage index whose checkpoint you already cleared, so continuing
  /// doesn't stop at the same checkpoint again.
  checkpointCleared?: number;
  error?: string;
  /// Member spend so far (finished runs), in USD.
  spentUSD: number;
  budgetUSD: number;
  /// Absolute path of the shared task folder.
  folder: string;
  files: TeamTaskFile[];
  /// Set once the synthesize stage has written the pack.
  pack?: { summary: string; files: string[]; version?: number; updatedAt?: number };
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
}

export interface TeamTaskCode {
  branch: string;
  repos: Array<{ name: string; projectPath: string; base: string; worktreePath: string; landed?: boolean }>;
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
}

export interface TeamHandoff {
  title: string;
  assignments: Array<{ workerId: UUID; workerName: string; ask: string }>;
  /// `proposed`: waiting for you to start it. `queued`: starts when the work
  /// running now reports back.
  status: 'proposed' | 'queued' | 'started' | 'dismissed';
  /// Once started, the stage it runs as.
  stage?: number;
}

export interface TeamRoom {
  messages: TeamMessage[];
  /// Set while a turn is in flight: who is speaking, since when.
  busy?: { speaker: string; since: number } | null;
  /// How many messages the pack has already absorbed, so "Update the pack"
  /// knows whether there is anything new to fold in.
  foldedThrough?: number;
}

export function isTaskActive(status: TeamTaskStatus): boolean {
  return status === 'planning' || status === 'questions' || status === 'proposed' || status === 'running' || status === 'waiting';
}

/// Whether this task keeps its team from taking a new one. Work handed off
/// from the room doesn't: the task itself is finished, and that work is an
/// errand on the side.
export function blocksNewTask(task: Pick<TeamTask, 'status' | 'stages' | 'stageIndex'>): boolean {
  if (!isTaskActive(task.status)) return false;
  const roomWork = (task.status === 'running' || task.status === 'waiting') && !!task.stages[task.stageIndex]?.fromRoom;
  return !roomWork;
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
    checkpoints.approveRoomWork && 'you start follow-up work',
  ].filter((s): s is string => !!s);
  return steps.map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s));
}

/// One short line for the rail and the task list.
export function describeTeamTaskStatus(task: Pick<TeamTask, 'status' | 'stages' | 'stageIndex' | 'waiting' | 'hires'>): string {
  switch (task.status) {
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
  'A) Questions, only when allowed and only when the answers would change the plan:',
  '<team_questions>["question 1", "question 2"]</team_questions>',
  '',
  'B) A plan, as JSON:',
  '<team_plan>',
  '{',
  '  "title": "Short title for the task",',
  '  "note": "One or two sentences on why this plan.",',
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

export function buildTeamPlanMessage(args: {
  teamName: string;
  purpose?: string;
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
}): string {
  const lines: string[] = [];
  lines.push(`THE TEAM: ${args.teamName}${args.purpose?.trim() ? ` — ${args.purpose.trim()}` : ''}`);
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
  const answered = (args.questions ?? []).map((q, i) => ({ q, a: args.answers?.[i]?.trim() ?? '' }));
  if (answered.length > 0) {
    lines.push('');
    lines.push('YOUR QUESTIONS AND THE USER’S ANSWERS');
    for (const { q, a } of answered) {
      lines.push(`Q: ${q}`);
      lines.push(`A: ${a || '(no answer — use your judgment)'}`);
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
  if (args.allowQuestions && answered.length === 0 && !(args.revisions?.length)) {
    lines.push(
      `You may ask up to ${TEAM_MAX_QUESTIONS} questions first if the answers would change the plan. Otherwise plan now.`,
    );
  } else {
    lines.push('Do not ask questions now. Reply with a plan.');
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
  opts: { allowQuestions: boolean; maxHires?: number },
): PlanReply {
  const planRaw = extractTag(text, 'team_plan');
  const questionsRaw = extractTag(text, 'team_questions');

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
      .slice(0, TEAM_MAX_QUESTIONS);
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
export function buildMemberStagePrompt(args: {
  teamName: string;
  task: Pick<TeamTask, 'brief' | 'title' | 'questions' | 'answers' | 'deliverables'>;
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
  /// Work handed off from the room after the pack was written.
  followUp?: {
    /// The conversation that led to it, as text.
    conversation: string;
    /// Files the team made earlier, as task-folder names (`files/lena/designs/01.html`).
    madeFiles: string[];
    /// Where this member's own earlier files sit (`files/lena/`).
    ownFilesDir: string;
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
  lines.push('');
  lines.push(`THE TASK${args.task.title ? `: ${args.task.title}` : ''}`);
  lines.push(args.task.brief.trim());
  const qa = (args.task.questions ?? []).map((q, i) => ({ q, a: args.task.answers?.[i]?.trim() ?? '' })).filter((x) => x.a);
  if (qa.length > 0) {
    lines.push('');
    lines.push('WHAT THE USER CLARIFIED');
    for (const { q, a } of qa) lines.push(`- ${q} → ${a}`);
  }
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

/// The coordinator's message for a draft or synthesize stage.
export function buildCoordinatorStageMessage(args: {
  teamName: string;
  task: Pick<TeamTask, 'brief' | 'title' | 'questions' | 'answers' | 'deliverables'>;
  stage: Pick<TeamStage, 'kind' | 'title' | 'ask'>;
  stageNumber: number;
  stageCount: number;
  folder: string;
  files: FolderFile[];
  budget: number;
}): string {
  const lines: string[] = [];
  lines.push(`TEAM: ${args.teamName}`);
  lines.push(`TASK${args.task.title ? `: ${args.task.title}` : ''}`);
  lines.push(args.task.brief.trim());
  const qa = (args.task.questions ?? []).map((q, i) => ({ q, a: args.task.answers?.[i]?.trim() ?? '' })).filter((x) => x.a);
  if (qa.length > 0) {
    lines.push('');
    lines.push('WHAT THE USER CLARIFIED');
    for (const { q, a } of qa) lines.push(`- ${q} → ${a}`);
  }
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
    lines.push('');
    lines.push(`The documents to write: ${wanted}.`);
    lines.push('If a challenge stage ran, also write challenge-log.md: a table of every objection, its');
    lines.push('severity, and how it was answered (resolved, accepted risk, or scope change).');
  }
  return lines.join('\n');
}

/// Read the synthesize reply into a summary and its files. A reply that
/// ignored the format still yields a pack: the whole text as report.md.
export function parsePackReply(text: string): { summary: string; files: Array<{ name: string; body: string }> } {
  const summary = (text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? '').trim();
  const files: Array<{ name: string; body: string }> = [];
  const re = /<file\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/file>/gi;
  let m: RegExpExecArray | null;
  const used = new Set<string>();
  while ((m = re.exec(text))) {
    let name = safeTeamFileName(m[1]);
    const body = m[2].replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    if (!body.trim()) continue;
    let n = 2;
    while (used.has(name.toLowerCase())) name = name.replace(/(\.[^.]+)?$/, (ext) => `-${n++}${ext}`);
    used.add(name.toLowerCase());
    files.push({ name, body });
  }
  if (files.length === 0) {
    const body = text.replace(/<summary>[\s\S]*?<\/summary>/i, '').trim();
    if (body) files.push({ name: 'report.md', body: `${body}\n` });
  }
  return { summary: summary || firstParagraph(text), files };
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
            },
          ]
        : []),
    ],
    source: 'generated',
    filePath: '',
  };
}
