// The org control plane: every action a person can take on the workers from
// outside the desktop app — over MCP, from a Slack command, from the web
// console — goes through here, so every one of them asks the same question
// first: may THIS caller do THAT (`shared/org/policy.ts`)?
//
// It holds no state of its own beyond hires in progress. Workers live in the
// worker engine, runs in the runtime; this is a policy gate in front of both,
// returning plain data each surface renders in its own way.

import { randomUUID } from 'node:crypto';
import type { FlowRun } from '../../shared/flows/schema';
import { flowRunTitle } from '../../shared/flows/schema';
import type { HireMessage, Worker, WorkerErrandResult, WorkerJournalEntry, WorkerTrustLevel, WorkerVisibility } from '../../shared/flows/worker';
import { WORKER_NOTE_MAX, isSlackUserId, validateOrgFields, workerTagline } from '../../shared/flows/worker';
import { describeTrigger, type ScheduleTrigger } from '../../shared/flows/schedule';
import type { Orchestration } from '../../shared/flows/orchestration';
import { buildOrgTree, managerFor, type OrgNode } from '../../shared/flows/org';
import {
  rollUpWorkerReport,
  WORKER_HUMAN_TIME_SAVED_MULTIPLIER,
  type WorkerReport,
  type WorkerReportRow,
} from '../../shared/flows/workerReport';
import {
  allowanceFor,
  approversFor,
  canHire,
  canManage,
  canSee,
  committedBudget,
  hireDecision,
  isAdmin,
  type OrgCaller,
  type OrgPolicy,
  type OrgRole,
} from '../../shared/org/policy';
import { buildThreads, nowLine, type WorkThread } from './workThreads';
import { isReadOnlyMcpTool, parseMcpToolName } from '../../shared/flows/mcpTools';
import { stepsARunGrantCovers } from '../flows/stepEffect';
import { initialsPicture } from '../../shared/flows/avatars';
import { describeScope, mcpServerKey, parseToolScope, withinScope, type ToolScope, type ToolScopes } from '../../shared/flows/toolScope';
import { answerOptions, projectMonthEnd, trustReadiness, workerState, type TrustReadiness, type WorkerState } from '../../shared/org/insights';
import type { Team, TeamCheckpoints, TeamRosterDraft, TeamStageKind, TeamTask } from '../../shared/flows/team';
import { DEFAULT_TEAM_CHECKPOINTS, TEAM_GUIDANCE_MAX, TEAM_MAX_MEMBERS, TEAM_STAGE_LABEL, isMemberStage, isTaskActive } from '../../shared/flows/team';
import { parseWorkerYaml } from '../../shared/flows/workerYaml';
import type { Attachment, UUID } from '../../shared/types';
import type { DraftedHire, HireDraftResult } from './hireDraft';
import type { ToolInput, ToolSummary, ToolTemplate } from './tools';
import { TOOL_NAME } from './tools';
import type { Discovery, SignInSummary } from './toolSignIn';
import type { Deliverable, Destination, TriggerService, WorkerTrigger } from './triggers';
import { newPullRequestLink, prFlowId as prFlowIdFor, prFlowYaml as prFlowFor, workspaceFlowId, workspaceFlowYaml, type ConnectedRepo, type OrgWorkspace } from './repos';
import type { ModelProvider, SecretStatus } from './secrets/service';
import type { AskRecord, AskStore, AuditEntry, AuditStore, HireStore, KeptFile, PublishedState, PublishedStore, Rating, RatingStore, SavedFile, TeamFileStore, TeamPublishShape } from './orgStores';
import type { ToolCall } from './mcpDirect';
import { classifyServer, fileTitle, isText, listFolder, linkFrom, mimeFor, pickUploadTool, readInFolder, slugFor, uploadArgs, type DestinationKind } from './teamFiles';
import { buildZip, type ZipEntry } from './zip';
import { personKey } from './connections';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// One new member being hired for a team that is being made.
export interface TeamRunHire {
  key: string;
  role: string;
  job: string;
  state: 'drafting' | 'hired' | 'waiting' | 'failed' | 'skipped';
  /// The worker's name, once its offer is written.
  name?: string;
  error?: string;
}

/// A team being made, as the console follows it.
export interface TeamRunView {
  id: string;
  name: string;
  status: 'hiring' | 'needsYou' | 'making' | 'done' | 'failed';
  startedAt: number;
  members: Array<{ workerId: UUID; name: string; role: string }>;
  hires: TeamRunHire[];
  team?: { id: UUID; name: string };
  error?: string;
}

interface TeamRun extends TeamRunView {
  by: string;
  caller: OrgCaller;
  input: { name: string; purpose?: string; budgetUSDPerTask: number; members: Array<{ workerId: UUID; role: string }>; workIn?: string; checkpoints?: TeamCheckpoints };
  hireIds: Record<string, string>;
  workerIds: Record<string, UUID>;
  skipFailed: boolean;
  hireVisibility?: WorkerVisibility;
  settled?: Promise<void>;
  finishedAt?: number;
  failedErrors?: Array<{ role: string; error: string }>;
}

export interface PendingHire {
  id: string;
  status: 'drafted' | 'awaitingApproval';
  createdAt: number;
  requestedBy: { name: string; slackUserId?: string };
  jobDescription: string;
  /// The interview so far, when the drafter asked questions first.
  conversation: HireMessage[];
  /// The drafter's latest questions, while it is still asking.
  questions?: string[];
  drafted?: DraftedHire;
  options: HireOptions;
  /// Why it needs an approver.
  reasons?: string[];
  /// Hired from the org's role catalog: its tools are cleared by the role.
  role?: OrgRole;
  /// A worker the person can see that already does this job, found when the
  /// hire started: said, so they can ask it instead.
  overlap?: { workerId: UUID; why: string };
  /// Hired for a team made while it waited on an approver: it joins that
  /// team, with this role, once it is hired.
  joinTeam?: { teamId: UUID; role: string };
  /// Published from someone's own install as a worker share file, rather
  /// than drafted here. The file is kept until the hire is made.
  imported?: {
    yaml: string;
    name: string;
    tagline?: string;
    jobDescription: string;
    budgetUSDPerMonth: number;
    mcpServers: string[];
    flows: string[];
    cadence: ScheduleTrigger | null;
    /// Its id on the install it was published from.
    localId?: string;
  };
}

export interface HireOptions {
  /// When it runs; null is "when asked". Absent: the drafter's schedule.
  cadence?: ScheduleTrigger | null;
  reportsTo?: UUID;
  visibility?: WorkerVisibility;
  projectPath?: string;
  budgetUSDPerMonth?: number;
}

export interface WorkerSummary {
  id: UUID;
  name: string;
  tagline: string;
  enabled: boolean;
  trust: Worker['trust'];
  manager?: string;
  /// Set when the manager is inherited from a worker above, not its own.
  managerInherited?: boolean;
  /// Its own manager's Slack member ID, when it has one.
  managerSlackUserId?: string;
  reportsTo?: { id: UUID; name: string };
  visibility: WorkerVisibility;
  /// Its picture, when it has one; initials otherwise.
  avatarUrl?: string;
  budgetUSDPerMonth: number;
  spentThisMonthUSD: number;
  waiting: number;
  youManage: boolean;
  /// What it is doing now: working, waiting on a person, paused, stuck, idle.
  state: WorkerState;
  /// The tools (MCP servers) it lists, whether this server has each, and how
  /// much of it the worker may use (absent: the whole tool).
  tools: Array<{ name: string; ok: boolean; scope?: ToolScope; scopeFrom?: 'default' | 'own' }>;
  /// When it runs, in words ("Weekdays at 09:00"), and the next time.
  schedule: string;
  cadence: ScheduleTrigger | null;
  nextRunAt?: number | null;
}

/// One run's worth of work a worker on probation proposed, waiting for its
/// manager to say which items go ahead.
export interface ProposalBatch {
  batchId: UUID;
  workerId: UUID;
  workerName: string;
  at: number;
  /// A scheduled run, or an errand someone asked for.
  task: 'shift' | 'errand';
  items: Array<{ candidateId: string; title: string; detail?: string; size?: string }>;
}

export interface WaitingItem {
  runId: UUID;
  workerId: UUID;
  workerName: string;
  kind: 'question' | 'approval';
  title: string;
  stepId: string;
  question?: string;
  why?: string;
  since: number;
  /// One-tap answers, when the question is a plain either-or.
  options?: string[];
  /// For an approval: what the step is told to do, and what it will use —
  /// as close to "exactly what will happen" as can be known before it runs.
  instructions?: string;
  /// What in the step reaches outside, for an approval: "opens web pages".
  reaches?: string[];
  /// For an approval: the later steps of the run that need only the same
  /// outside tools, which approving "for this run" lets through too.
  coversLater?: number;
  inputs?: Array<{ name: string; preview: string }>;
}

export interface WorkItem {
  /// The journal entry; what a rating attaches to.
  entryId: string;
  workerId: UUID;
  workerName: string;
  /// The person the worker answers to.
  forManager?: string;
  title: string;
  summary?: string;
  at: number;
  costUSD?: number;
  runId?: UUID;
  rating?: { useful: boolean; by: string; note?: string };
  /// What a run produced, when the item comes from the run itself rather
  /// than a journal entry: its newest artifact.
  body?: string;
}

export interface TeamTaskSummary {
  id: UUID;
  /// `learn`: the team learning what it needs to know, not someone's request.
  kind?: 'learn';
  /// Answered from what the team knows, with no stages run.
  answered?: boolean;
  teamId: UUID;
  teamName: string;
  title: string;
  status: TeamTask['status'];
  requestedBy?: string;
  /// What it needs from a person, when it is stopped on one.
  needs?: 'answers' | 'plan' | 'checkpoint' | 'budget' | 'failed';
  waitingOnYou: boolean;
  questions?: string[];
  planNote?: string;
  waitingMessage?: string;
  spentUSD: number;
  budgetUSD: number;
  stages: Array<{ label: string; state: 'done' | 'now' | 'next' | 'failed'; who: string[] }>;
  packSummary?: string;
  /// Its code, when it changed some: the task branch, and per repo how far
  /// ahead it is and whether it's been pushed (with the link to open a PR).
  code?: { branch: string; repos: Array<{ name: string; ahead?: number; pushed?: { url?: string } }> };
  updatedAt: number;
}

/// A desktop's setup, published to the org: its tools as templates, the
/// repos and workspaces its owner picked. An admin installs and connects
/// from it; keys only arrive when the person sent them on purpose.
export interface SetupOffer {
  id: string;
  by: string;
  slackUserId?: string;
  at: number;
  tools: ToolTemplate[];
  repos: Array<{ name: string; url?: string; localPath?: string }>;
  workspaces: Array<{ name: string; repos: string[]; instructions?: string }>;
  /// Tools installed as it arrived, because their keys came with them.
  installed: string[];
}

export interface SetupPublishInput {
  tools: ToolTemplate[];
  repos: Array<{ name: string; url?: string; localPath?: string }>;
  workspaces: Array<{ name: string; repos: string[]; instructions?: string }>;
  /// Values for some tools' keys, by tool: only what its template names.
  keys?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
}

export interface TeamTaskDetail extends TeamTaskSummary {
  brief: string;
  createdAt: number;
  finishedAt?: number;
  deliverables?: string[];
  answers?: string[];
  error?: string;
  files: Array<{ name: string; author: string; at: number }>;
  pack?: { summary: string; files: string[] };
  stagesDetail: Array<{
    title: string;
    label: string;
    status: string;
    ask?: string;
    file?: string;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    current: boolean;
    pieces: Array<{
      workerId: UUID;
      workerName: string;
      ask: string;
      status: string;
      runId?: UUID;
      step?: { index: number; total: number; name: string };
      startedAt?: number;
      costUSD?: number;
      file?: string;
      error?: string;
      waiting?: WaitingItem;
    }>;
  }>;
  /// Where it stands, in one sentence.
  nowSentence: string;
  /// Members' steps in the current stage waiting for the caller's OK.
  piecesNeedYou: number;
}

export interface TeamMemberRow {
  workerId: UUID;
  name: string;
  role: string;
  state: WorkerState;
  doing?: string;
}

/// One file in a team task's shared folder, for its Files tab.
export interface TeamTaskFileRow {
  name: string;
  size: number;
  modifiedAt: number;
  /// The member who wrote it; null for the coordinator (or you).
  writtenBy: { workerId: string; name: string } | null;
  stage: { index: number; title: string } | null;
  kept: { library: boolean; saved: Array<{ destination: string; label: string; at: number; link?: string }> };
}

/// Somewhere a team file can be kept.
export interface FileDestination {
  id: string;
  label: string;
  kind: DestinationKind;
  ready: boolean;
  why?: string;
}

/// Something moving right now, for the bar every page shows.
export interface WorkingItem {
  kind: 'run' | 'deciding' | 'waiting' | 'team';
  id: string;
  /// When it started.
  at: number;
  title: string;
  /// Where it is, in a few words: "step 2 of 3, compare".
  detail: string;
  workerId?: UUID;
  workerName?: string;
  teamId?: UUID;
  teamName?: string;
  costUSD?: number;
}

export interface TodayView {
  org: string;
  waiting: WaitingItem[];
  hireApprovals: HireSummary[];
  teamTasks: TeamTaskSummary[];
  proposals: ProposalBatch[];
  delivered: WorkItem[];
  crew: Array<{ id: UUID; name: string; state: WorkerState; nextShiftAt?: number | null }>;
  spend: { spentUSD: number; projectedUSD: number; allowanceUSD?: number; committedUSD?: number };
}

export type TriggerView = Omit<WorkerTrigger, 'webhook' | 'seen'> & { webhook?: { idPath?: string }; seenCount: number; handledToday: number; handledTotal: number };

/// Where a Library item came from — one shape per kind of source.
export type LibraryOrigin =
  | {
      kind: 'run';
      /// Absent only for a journal entry whose run is not recorded.
      runId?: UUID;
      workerId: string;
      workerName: string;
      /// What started it: its schedule, Run now, a trigger, someone's
      /// question; 'other' when the run does not say.
      how: 'schedule' | 'runNow' | 'trigger' | 'asked' | 'other';
      triggerName?: string;
      flowName?: string;
    }
  | { kind: 'event'; triggerId?: string; triggerName: string; workerId: string; workerName: string }
  | { kind: 'errand'; askId: string; workerId: string; workerName: string; askedBy: string; question: string; via?: 'console' | 'slack' | 'mcp' | 'app' }
  | { kind: 'task'; teamId: string; teamName: string; taskId: string; taskTitle: string; stage?: { index: number; title: string } };

export type LibraryKind = 'event' | 'work' | 'file' | 'answer' | 'task';

export interface LibraryItem {
  id: string;
  /// event: delivered on a trigger; work: a finished run; file: a team
  /// task's file someone kept; answer: an errand's reply; task: a finished
  /// team task, its pieces folded in.
  kind: LibraryKind;
  origin: LibraryOrigin;
  /// Who can see it: the source worker's setting, or a team's.
  visibility: WorkerVisibility;
  /// The same, in a few words: "Only its manager", "Everyone".
  visibleTo: string;
  /// A team task's final pack, and who wrote each file.
  pack?: { files: Array<{ name: string; writtenBy: string | null }> };
  /// A team task's other files in its shared folder.
  workingFiles?: number;
  workerId: string;
  workerName: string;
  at: number;
  title: string;
  status: Deliverable['status'];
  /// The run it came from, for a work item: reading it in full fetches the report.
  runId?: UUID;
  body?: string;
  error?: string;
  links: string[];
  deliveredTo: string[];
  /// `file` is absent on a task item: the whole task, not one of its files.
  source: Deliverable['source'] | { kind: 'team'; teamId: string; teamName: string; taskId: string; file?: string };
  minutes?: number;
  rating?: { useful: boolean; by: string };
}

export interface WorkerValue {
  handled: number;
  failed: number;
  medianMinutes: number | null;
  useful: number;
  rated: number;
  spentUSD: number;
  costPerItemUSD: number | null;
}

export type { Destination };

export interface WorkerDetail {
  worker: WorkerSummary;
  jobDescription: string;
  readiness: TrustReadiness;
  stats: { runs: number; failed: number; rated: number; usefulPct: number | null };
  delivered: WorkItem[];
  questions: Array<{ question: string; answer?: string; answeredBy?: string; at: number; waiting: boolean }>;
  learned: Array<{ at: number; note: string }>;
  recent: Array<{ at: number; kind: string; title: string; note?: string }>;
  /// What people asked it lately, newest first, with the answers.
  asks: AskRecord[];
  /// Tools it names that this server does not have: it works without them.
  missingTools: string[];
  /// Its triggers, and what its events came to this month.
  triggers: TriggerView[];
  value: WorkerValue | null;
  /// What it's doing right now: each run under way, the step it's on, what
  /// it has finished, and whether it's waiting on someone.
  now: RunNow[];
  /// Set while it's deciding what to do — a shift's or an errand's planning
  /// turn, which can take a minute before any run exists.
  deciding: { since: number; task: 'shift' | 'errand' } | null;
  /// Its runs that have ended, newest first: what each did and how it went.
  history: RunPast[];
  /// Its scheduled shifts (and Run now): what it decided each time, with its
  /// reasoning — including the ones where it decided to start nothing.
  shifts: ShiftPast[];
  /// What it's waiting on its manager for, when that's the caller.
  proposals: ProposalBatch[];
  waiting: WaitingItem[];
}

export interface RoleOffer extends OrgRole {
  fit: 'fits' | 'needsApproval' | 'notAllowed';
  why?: string;
  hiredCount: number;
}

export interface HealthItem {
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface PersonRow {
  name: string;
  slackUserId?: string;
  role: 'Admin' | 'Approver' | 'Hirer' | 'Member';
  workers: number;
  spentUSD: number;
  allowanceUSD?: number;
  lastSeen?: number;
  /// Where they are signed in: one entry per token.
  devices: Array<{ id: string; where: string; lastUsedAt?: number }>;
}

export interface HireSummary {
  hireId: string;
  status: PendingHire['status'];
  requestedBy: string;
  questions?: string[];
  contract?: {
    name: string;
    tagline?: string;
    jobDescription: string;
    budgetUSDPerMonth: number;
    flows: string[];
    connectors: string[];
    projectPath?: string;
    cadence: ScheduleTrigger | null;
    schedule: string;
    /// Who may ask it, once hired.
    visibility?: WorkerVisibility;
    /// The worker it will report to, by name.
    reportsTo?: string;
  };
  reasons?: string[];
  /// A worker the person can see that already does this job.
  alreadyDoes?: { workerId: UUID; name: string; tagline?: string; why: string };
}

/// One worker's line on the console's report: the desktop's row, plus who
/// answers for it and what it may spend.
export type OrgReportRow = WorkerReportRow & {
  manager?: string;
  youManage: boolean;
  budgetUSDPerMonth: number;
};

export type OrgReport = Omit<WorkerReport, 'byWorker'> & {
  /// The window asked for: 7, 30, or 0 for all time.
  days: number;
  byWorker: OrgReportRow[];
};

const REPORT_WINDOWS = new Set([7, 30, 0]);

/// Who sees a worker's output, by its visibility, as the Library says it.
const VISIBLE_TO: Record<WorkerVisibility, string> = { private: 'Only its manager', team: 'Its manager’s team', org: 'Everyone' };

export interface OrgServiceDeps {
  workers: {
    roster(): Worker[];
    get(id: UUID): Worker | null;
    save(input: Worker): { ok: true; worker: Worker } | { ok: false; error: string };
    setEnabled(id: UUID, enabled: boolean): { ok: true } | { ok: false; error: string };
    remove(id: UUID): { ok: true } | { ok: false; error: string };
    /// `conversation`: a conversation of its own (a Slack thread), not today's desk.
    runErrand(id: UUID, instruction: string, attachments?: Attachment[], conversation?: string, untrusted?: boolean): Promise<{ ok: true; result: WorkerErrandResult } | { ok: false; error: string }>;
    journalFor(id: UUID): WorkerJournalEntry[];
    /// A note into its memory, read by every later turn (`WorkerEngine.remember`).
    remember?(id: UUID, text: string): Result;
    /// A note out of it (`WorkerEngine.forgetNote`).
    forgetNote?(id: UUID, entryId: string): Result;
    spentThisMonth(): Map<UUID, number>;
    workerNames(): string[];
  };
  runs: {
    listRuns(): FlowRun[];
    getRun(id: UUID): FlowRun | null;
    steerRun(args: { runId: UUID; text: string }): { ok: true } | { ok: false; error: string };
    resumeRun(args: { runId: UUID; forRun?: boolean }): { ok: true } | { ok: false; error: string };
  };
  rejectRun(runId: UUID): { ok: true } | { ok: false; error: string };
  /// Stop a worker's run that is going: its batch, so nothing queued behind
  /// it starts either. Absent: runs can't be stopped from here.
  stopRun?(runId: UUID): { ok: true } | { ok: false; error: string };
  policy(): OrgPolicy;
  draft(args: { crew: string[]; jobDescription: string; conversation: HireMessage[]; interview: boolean }): Promise<HireDraftResult>;
  saveHire(
    drafted: DraftedHire,
    opts: {
      projectPath?: string;
      mcpServers: string[];
      budgetUSDPerMonth?: number;
      cadence?: ScheduleTrigger | null;
      extra: Partial<Pick<Worker, 'manager' | 'reportsTo' | 'visibility'>>;
    },
  ): { ok: true; worker: Worker } | { ok: false; error: string };
  hires: HireStore;
  /// Worker batches, for proposals waiting on a manager.
  batches?: {
    list(): Orchestration[];
    approve(id: UUID, candidateIds: string[] | 'all'): Promise<{ ok: true; queued: number } | { ok: false; error: string }>;
    reject(id: UUID, candidateId: string): { ok: true } | { ok: false; error: string };
  };
  /// Start a worker's scheduled run now.
  runNow?(id: UUID): Promise<{ ok: true } | { ok: false; error: string }>;
  /// The planning turn a worker is in (a shift or an errand deciding what to
  /// do), so its page shows it thinking rather than idle.
  planning?(id: UUID): { since: number; task: 'shift' | 'errand'; manual?: boolean } | null;
  /// The rest are optional so a host can bring the plane up a piece at a time.
  snapshots?(): Array<{ worker: Worker; nextShiftAt: number | null }>;
  setTrust?(id: UUID, trust: WorkerTrustLevel): { ok: true } | { ok: false; error: string };
  /// A note into the worker's journal against one of its turns — memory its
  /// next planning reads.
  note?(id: UUID, orchestrationId: string, text: string): { ok: true } | { ok: false; error: string };
  runCost?(runId: UUID): number | undefined;
  /// The roster's report card from `sinceMs` (0 = all time) — the desktop's
  /// timesheet. Absent: the console has no Reports page on this host.
  report?(sinceMs: number): WorkerReport;
  teams?: {
    list(): { teams: Team[]; tasks: TeamTask[] };
    brief(teamId: UUID, text: string, attachments: [], projectPath: undefined, opts: { requestedBy?: TeamTask['requestedBy'] }): Result<{ task: TeamTask }>;
    /// Learn (or refresh) what the team knows. Absent: not offered.
    learn?(teamId: UUID, opts: { requestedBy?: TeamTask['requestedBy'] }): Result<{ task: TeamTask }>;
    /// Ask an answered question again, as work.
    planAsTask?(taskId: UUID): Result<{ task: TeamTask }>;
    /// Weekly refresh of what the team knows, or only when asked.
    setKnowledgeRefresh?(teamId: UUID, mode: 'weekly' | 'off'): Result;
    /// Retire a team, keeping what it delivered (`TeamEngine.disband`).
    disband?(teamId: UUID, by: string): Result<{ cancelled: number }>;
    /// Delete a team and every task it ran, files and all.
    remove?(teamId: UUID): Result;
    answer(taskId: UUID, answers: string[]): Result;
    approve(taskId: UUID): Result;
    revise(taskId: UUID, feedback: string): Result;
    continueTask(taskId: UUID): Result;
    cancel(taskId: UUID): Result;
    /// Run one member's failed piece of the current stage again.
    retryPiece?(taskId: UUID, workerId: UUID): Result;
    /// The pack held for review is good: the task is done.
    accept?(taskId: UUID): Result;
    /// Push the task branch from one of its repos.
    pushCode?(taskId: UUID, projectPath: string): Result<{ message: string; url?: string }>;
    /// One of a task's shared files, by its name in the task folder.
    readFile?(taskId: UUID, name: string): Result<{ body: string }>;
    save?(input: Omit<Team, 'id' | 'createdAt' | 'updatedAt'> & { id?: UUID }): Result<{ team: Team }>;
    /// Suggest a crew for what a team is for, from these workers only.
    draftRoster?(args: { brief: string; current?: { name?: string; members: [] }; onlyWorkerIds: UUID[] }): Promise<Result<{ draft: TeamRosterDraft }>>;
  };
  /// What was published from people's installs, by its id there. Absent:
  /// kept in memory only.
  published?: PublishedStore;
  /// What a run has done so far, step by step (see flows/runActivity.ts).
  runActivity?(runId: UUID, after: number): Array<{ at: number; kind: 'tool' | 'said' | 'error' | 'denied'; text: string }>;
  /// Setups people published from their desktops, waiting on an admin.
  /// Absent: kept in memory only.
  setupOffers?: { load(): { offers: SetupOffer[] }; save(value: { offers: SetupOffer[] }): void };
  /// An errand's batch, to follow the work it started to the end.
  orchestration?(id: UUID): Orchestration | null;
  /// Repos workers may change, landing work as pull requests. Absent: none.
  repos?: {
    list(): ConnectedRepo[];
    connect(input: { url: string; name?: string; testCommand?: string }, by: string): Promise<Result<{ repo: ConnectedRepo }>>;
    disconnect(name: string): Result;
    /// Whether the server can push to this repo (an ssh key, or the host's token).
    canPush(repo: ConnectedRepo): boolean;
    /// The secret it needs to push over https, or null.
    tokenFor(repo: ConnectedRepo): string | null;
    workspaces(): OrgWorkspace[];
    createWorkspace(input: { name: string; repos: string[]; instructions?: string }, by: string): Result<{ workspace: OrgWorkspace }>;
    updateWorkspace(id: string, patch: { repos?: string[]; instructions?: string }): Result<{ workspace: OrgWorkspace }>;
    removeWorkspace(id: string): Result;
    changed(): void;
  };
  /// Put a flow (YAML) into the server's library under this id.
  saveFlow?(id: string, yaml: string): Result;
  /// Secrets admins manage on Setup → Secrets. Absent: the environment only.
  secrets?: {
    store: { kind: string; where: string; readOnly: boolean; warning?: string };
    status(neededBy: (name: string) => string[]): { secrets: SecretStatus[]; error: string | null; model?: ModelProvider };
    set(name: string, value: string, by: string): Promise<Result>;
    remove(name: string): Promise<Result>;
  };
  /// What a finished run produced: its artifacts (the answer last) and files.
  runDeliverables?(runId: UUID): Array<{ name: string; body?: string; sourcePath?: string; bytes?: number }>;
  /// A file a run wrote, whole. Absent or null: it cannot be read here.
  readRunFile?(path: string): Buffer | null;
  /// Change org.json in place (a tool's default scope).
  updateOrg?(mutate: (raw: Record<string, unknown>) => void): void;
  /// A worker's own files (its cabinet): what it filed from runs, and what
  /// it wrote there while answering.
  workerFiles?: {
    list(workerId: UUID): Array<{ name: string; bytes: number; modifiedAt: number }>;
    read(workerId: UUID, name: string): Buffer | null;
  };
  /// Land a published worker share file: its flows into the library, the
  /// worker onto the roster. Absent: publishing is not offered.
  importWorker?(
    yaml: string,
    opts: { projectPath?: string; mcpServers: string[]; extra: Partial<Pick<Worker, 'manager' | 'reportsTo' | 'visibility'>> },
  ): { ok: true; worker: Worker } | { ok: false; error: string };
  audit?: AuditStore;
  ratings?: RatingStore;
  /// The MCP servers installed on this server. Absent: the Tools page is off.
  tools?: {
    list(roster: Worker[], statuses?: Record<string, string>): { tools: ToolSummary[]; missing: Array<{ name: string; workers: string[]; template?: ToolTemplate }> };
    /// How a published worker's tools were set up where it came from.
    remember?(templates: ToolTemplate[], onlyNew?: boolean): void;
    install(input: ToolInput): { ok: true } | { ok: false; error: string };
    uninstall(name: string): { ok: true } | { ok: false; error: string };
    /// Start the model CLI once and read what each server reports.
    check(): Promise<Record<string, string> | null>;
  };
  /// Workers acting on business events. Absent: no triggers on this host.
  triggers?: () => TriggerService | null;
  /// Team task files kept in the Library or saved elsewhere. Absent: kept
  /// in memory only.
  teamFiles?: TeamFileStore;
  /// Whether a worker the person can see already does a job they're about to
  /// hire for (hireOverlap.ts). Absent: no such check.
  overlap?(job: string, workers: Array<{ id: string; name: string; tagline?: string; job?: string }>): Promise<{ workerId: string; why: string } | null>;
  /// A picture for a worker, from its name and job, not one in `taken`.
  /// Null: nothing suited it (`pickPicture`).
  pickPicture?(worker: { name: string; job: string; tagline?: string }, taken: string[]): Promise<string | null>;
  /// Remote tools an admin signed in to for everyone (toolSignIn.ts).
  /// Absent: remote tools take a pasted token only.
  toolSignIn?: {
    summaries(): Record<string, SignInSummary>;
    discover(url: string, base: string): Promise<Discovery | { ok: false; error: string }>;
    start(caller: OrgCaller, input: { name: string; url: string; base: string; next?: string; clientId?: string; clientSecret?: string }): Promise<Result<{ url: string; browserKey: string }>>;
    callback(query: URLSearchParams, browserKey: string | undefined): Promise<{ location: string; ok: boolean; reason?: string; name?: string; by?: string }>;
    forget(name: string): Promise<void>;
  };
  /// People's own connected accounts (connections.ts): "Your Google Drive".
  /// Absent: files go only where the server's tools reach.
  connections?: {
    status(caller: OrgCaller): Promise<{ configured: boolean; connected: boolean; why?: string }>;
    upload(caller: OrgCaller, file: { name: string; mimeType: string; data: Buffer }): Promise<Result<{ link?: string }>>;
  };
  /// The tools an installed MCP server offers with their input schemas, to
  /// fill a call's arguments in. Absent: files can't be saved through one.
  serverToolSchemas?(name: string): Promise<{ ok: true; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> } | { ok: false; error: string }>;
  /// Call one tool on an installed MCP server, no model in the loop (see mcpDirect.ts).
  callServerTool?(server: string, tool: string, args: Record<string, unknown>): Promise<ToolCall>;
  /// The tools an installed MCP server offers, for the trigger builder.
  serverTools?(name: string): Promise<{ ok: true; tools: Array<{ name: string; description?: string }> } | { ok: false; error: string }>;
  /// Questions people asked, and their answers. Absent: kept in memory only.
  asks?: AskStore;
  /// An answer that took long enough that the asker has likely moved on.
  onAskDone?(ask: AskRecord): void;
  health?(): HealthItem[];
  /// Everyone holding access, from the token list.
  people?(): Array<{ id?: string; name: string; slackUserId?: string; admin: boolean; device?: string; lastUsedAt?: number }>;
  /// Tell the approvers a hire is waiting on them (a Slack DM, usually).
  onHireAwaitingApproval?(hire: PendingHire, approvers: string[]): void;
  /// Tell the person who asked how it went.
  onHireDecided?(hire: PendingHire, outcome: { approved: boolean; by: string; worker?: Worker; error?: string }): void;
  now?(): number;
}

function pauseKind(run: FlowRun): 'question' | 'approval' | null {
  if (run.state.kind !== 'paused' || !run.workerId) return null;
  if (run.state.reason === 'needsInput') return 'question';
  if (run.state.reason === 'externalAction') return 'approval';
  return null;
}

/// What an approval can show before the step runs: its instructions and the
/// artifacts it reads. The exact message a step will post does not exist
/// until it runs, so this is the closest honest preview.
/// Why a step stops for a yes, in words: what in it reaches outside.
/// A connector's name as people say it: `claude_ai_Acme_Tracker` →
/// "Acme Tracker", `acme-wiki-official` → "Acme Wiki".
function connectorName(server: string): string {
  return server
    .replace(/^claude_ai_/i, '')
    .replace(/[-_](official|mcp|server)$/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/// What a step will do outside the server, as the approval card says it:
/// what it may change first, then the shell and the web, and last, in one
/// line, what it only reads.
export function reachesOutside(step: Pick<FlowRun['flowSnapshot']['steps'][number], 'role' | 'effect' | 'tools'>): string[] {
  const changes: string[] = [];
  const other: string[] = [];
  const writes = new Map<string, string[]>();
  const reads = new Set<string>();
  if (step.role === 'shipper') changes.push('ships its work (a push, a message or a publish)');
  for (const t of step.tools ?? []) {
    const bash = /^bash(?:\((.+?)(?::\*)?\))?$/i.exec(t);
    if (bash) {
      // Moving around and looking don't reach anywhere: only say what acts.
      if (!/^(git (diff|log|show|status|ls-files|rev-parse)|cd|pwd|ls|echo)\b/.test(bash[1] ?? '')) other.push(bash[1] ? `runs ${bash[1]}` : 'runs shell commands');
    } else if (/^webfetch/i.test(t)) other.push('opens web pages');
    else if (/^websearch/i.test(t)) other.push('searches the web');
    else if (t.startsWith('mcp__')) {
      const parsed = parseMcpToolName(t);
      if (!parsed) continue;
      const who = connectorName(parsed.server);
      if (isReadOnlyMcpTool(t)) reads.add(who);
      else writes.set(who, [...(writes.get(who) ?? []), parsed.tool.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()]);
    }
  }
  for (const [who, tools] of writes) changes.push(`may change ${who} (${tools.join(', ')})`);
  const out = [...changes, ...other, ...(reads.size ? [`reads ${[...reads].join(', ')}`] : [])];
  if (!out.length && step.effect === 'external') out.push('is marked as acting outside the server');
  return [...new Set(out)];
}

function approvalDetail(run: FlowRun, stepId: string): Pick<WaitingItem, 'instructions' | 'inputs' | 'reaches' | 'coversLater'> {
  const step = run.flowSnapshot.steps.find((s) => s.id === stepId);
  if (!step) return {};
  const reaches = reachesOutside(step);
  const inputs = (step.inputs ?? [])
    .map((name) => run.artifacts?.[name])
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ name: a.name, preview: a.body.length > 1500 ? `${a.body.slice(0, 1500)}…` : a.body }));
  return {
    ...(step.systemPromptOverride ? { instructions: step.systemPromptOverride.slice(0, 2000) } : {}),
    ...(inputs.length ? { inputs } : {}),
    ...(reaches.length ? { reaches } : {}),
    ...(run.state.kind === 'paused' && run.state.reason === 'externalAction' && stepsARunGrantCovers(run.flowSnapshot.steps, stepId).length
      ? { coversLater: stepsARunGrantCovers(run.flowSnapshot.steps, stepId).length }
      : {}),
  };
}

const TEAM_NEEDS: Partial<Record<TeamTask['status'], TeamTaskSummary['needs']>> = {
  questions: 'answers',
  proposed: 'plan',
};

/// The caller is this worker's own manager, not merely an admin over it.
function managesDirectly(roster: readonly Worker[], workerId: UUID, caller: OrgCaller): boolean {
  return !!caller.slackUserId && managerFor(roster, workerId)?.slackUserId === caller.slackUserId;
}

/// A schedule in words, "When asked" for a worker that only works when asked.
export function scheduleText(cadence: ScheduleTrigger | null | undefined): string {
  if (!cadence) return 'When asked';
  try {
    return describeTrigger(cadence);
  } catch {
    return 'On a schedule';
  }
}

const NOT_FOUND = 'No worker by that name or id that you can see.';
/// The caller's own Google Drive, through the account they connected.
const GOOGLE_ME = 'google:me';
const YOUR_DRIVE = 'Your Google Drive';

export interface RunNow {
  runId: UUID;
  title: string;
  startedAt: number;
  /// 1-based: "step 2 of 4, capture".
  step: { index: number; total: number; name: string };
  finished: string[];
  state: 'working' | 'question' | 'approval' | 'interrupted' | 'paused';
  costUSD?: number;
}

export interface ShiftPast {
  at: number;
  title: string;
  /// What it came to: nothing put forward; put forward and waiting on its
  /// manager; work started; or all of it turned down.
  decision: 'nothing' | 'proposed' | 'started' | 'declined';
  /// Items it put forward, how many got going, and how many still wait.
  proposed: number;
  started: number;
  waiting: number;
  /// The runs it started, to show under it.
  runIds: UUID[];
  /// Its batch, for deciding what it proposed.
  batchId?: UUID;
  note?: string;
  reasoning?: string;
}

export interface RunPast {
  runId: UUID;
  title: string;
  at: number;
  minutes: number;
  outcome: 'done' | 'failed' | 'stopped';
  steps: number;
  costUSD?: number;
  /// What it produced last: the answer, or the last step's output.
  result?: { name: string; body: string };
  error?: string;
}

export interface ErrandProgress {
  done: boolean;
  /// Each piece; one running says where it is, since when, and the last
  /// thing it said, so whoever asked can see it moving.
  items: Array<{ title: string; status: string; runId?: UUID; branch?: string; note?: string; step?: { index: number; total: number; name: string }; startedAt?: number; said?: string }>;
  files: Array<{ name: string; body?: string; sourcePath?: string }>;
  /// Pull requests (and pages to open one), and documents the work links to.
  links: string[];
}

/// A worker or team id from someone's install: kept as a key, so held to a
/// plain shape.
const LOCAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/// A team published from someone's install: its members' share files, by the
/// ids they have there.
export interface TeamPublishInput {
  localId: string;
  name: string;
  purpose?: string;
  budgetUSDPerTask: number;
  checkpoints?: Partial<TeamCheckpoints>;
  piecesAskFirst?: boolean;
  members: Array<{ localId: string; role: string; yaml: string; tools?: ToolTemplate[] }>;
}

function checkTeamPublish(input: TeamPublishInput): string | null {
  if (!LOCAL_ID.test(input.localId)) return 'That team has no id overcli can use.';
  if (!input.name.trim()) return 'Give the team a name.';
  if (input.members.length < 2) return 'A team needs at least two members.';
  if (input.members.length > TEAM_MAX_MEMBERS) return `A team can have at most ${TEAM_MAX_MEMBERS} members.`;
  if (!Number.isFinite(input.budgetUSDPerTask) || input.budgetUSDPerTask <= 0) return 'Set a budget per task above $0.';
  const ids = new Set<string>();
  for (const m of input.members) {
    if (!LOCAL_ID.test(m.localId) || ids.has(m.localId)) return 'Each member needs its own id.';
    ids.add(m.localId);
    if (!m.yaml.trim()) return 'A member arrived without its worker file.';
  }
  return null;
}

/// Workers made autonomous before `setTrust` carried the grant with it: the
/// label says "on its own" but every outside action still stops for you.
/// The server gives them the grant when it starts, the same rule as `setTrust`.
export function autonomousWithoutGrant(roster: Worker[]): Worker[] {
  return roster
    .filter((w) => w.trust === 'autonomous' && !w.caps.allowExternalActions)
    .map((w) => ({ ...w, caps: { ...w.caps, allowExternalActions: true } }));
}

export class OrgService {
  constructor(private readonly deps: OrgServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private policy(): OrgPolicy {
    return this.deps.policy();
  }

  /// A worker by id or (case-insensitive) name, if the caller may see it.
  resolve(caller: OrgCaller, idOrName: string): Worker | null {
    const roster = this.deps.workers.roster();
    const key = idOrName.trim().toLowerCase();
    const w = roster.find((x) => x.id === idOrName) ?? roster.find((x) => x.name.trim().toLowerCase() === key);
    if (!w || !canSee(this.policy(), roster, w.id, caller)) return null;
    return w;
  }

  // ---- READ -------------------------------------------------------------

  listWorkers(caller: OrgCaller): WorkerSummary[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const spent = this.deps.workers.spentThisMonth();
    const waiting = this.waitingCounts();
    const next = new Map((this.deps.snapshots?.() ?? []).map((x) => [x.worker.id, x.nextShiftAt]));
    const runs = this.deps.runs.listRuns();
    // What this server has installed, by name. Unknown (no tools hook): say nothing is missing.
    const installed = this.deps.tools ? new Set(this.deps.tools.list([]).tools.map((t) => t.name)) : null;
    return roster
      .filter((w) => canSee(policy, roster, w.id, caller))
      .map((w) => {
        const manager = managerFor(roster, w.id);
        const shared = (this.policy().sharedMcpServers ?? []).filter((n) => !(w.mcpServers ?? []).includes(n));
        const tools = [
          ...(w.mcpServers ?? []).map((name) => ({ name, ok: !installed || installed.has(name), ...this.scopeOf(w, name) })),
          // The org's shared tools, which it gets without anyone giving them.
          ...shared.map((name) => ({ name, ok: !installed || installed.has(name), shared: true, ...this.scopeOf(w, name) })),
        ];
        const boss = w.reportsTo ? roster.find((x) => x.id === w.reportsTo) : undefined;
        return {
          id: w.id,
          name: w.name,
          tagline: workerTagline(w),
          enabled: w.enabled,
          trust: w.trust,
          ...(manager ? { manager: manager.name } : {}),
          ...(manager && !w.manager ? { managerInherited: true } : {}),
          ...(w.manager?.slackUserId ? { managerSlackUserId: w.manager.slackUserId } : {}),
          ...(boss ? { reportsTo: { id: boss.id, name: boss.name } } : {}),
          visibility: w.visibility ?? 'private',
          ...(w.avatarUrl ? { avatarUrl: w.avatarUrl } : {}),
          budgetUSDPerMonth: w.budgetUSDPerMonth,
          spentThisMonthUSD: spent.get(w.id) ?? 0,
          waiting: waiting.get(w.id) ?? 0,
          youManage: canManage(policy, roster, w.id, caller),
          schedule: scheduleText(w.cadence),
          cadence: w.cadence,
          nextRunAt: w.enabled ? next.get(w.id) ?? null : null,
          state: this.deps.planning?.(w.id) && workerState(w, runs) === 'idle' ? 'working' : workerState(w, runs),
          tools,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getWorker(caller: OrgCaller, idOrName: string): Result<{ worker: WorkerSummary; jobDescription: string; recent: Array<{ at: number; kind: string; title: string; note?: string }> }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const summary = this.listWorkers(caller).find((s) => s.id === w.id)!;
    const recent = this.deps.workers
      .journalFor(w.id)
      .slice(-8)
      .reverse()
      .map((e) => ({ at: e.at, kind: e.kind, title: e.title, ...(e.note ? { note: e.note } : {}) }));
    return { ok: true, worker: summary, jobDescription: w.jobDescription, recent };
  }

  /// A worker's journal: its standing notes (instructions it keeps, from
  /// people and from itself), then everything it did, newest first. Notes
  /// are what every planning turn reads; managers add and remove them.
  workerJournal(caller: OrgCaller, idOrName: string, opts: { before?: number; limit?: number } = {}): Result<{
    notes: Array<{ id: string; at: number; note: string }>;
    entries: Array<{ id: string; at: number; kind: string; title: string; note?: string; costUSD?: number; runId?: string }>;
    nextBefore: number | null;
    canChange: boolean;
  }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const all = [...this.deps.workers.journalFor(w.id)].sort((a, b) => b.at - a.at);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
    const page = (opts.before != null ? all.filter((e) => e.at < opts.before!) : all).filter((e) => e.kind !== 'note');
    const shown = page.slice(0, limit);
    return {
      ok: true,
      notes: all.filter((e) => e.kind === 'note' && e.note).map((e) => ({ id: e.id, at: e.at, note: e.note! })),
      entries: shown.map((e) => ({ id: e.id, at: e.at, kind: e.kind, title: e.title, ...(e.note ? { note: e.note.slice(0, 600) } : {}), ...(e.costUSD ? { costUSD: e.costUSD } : {}), ...(e.runId ? { runId: e.runId } : {}) })),
      nextBefore: page.length > limit ? shown[shown.length - 1].at : null,
      canChange: canManage(this.policy(), this.deps.workers.roster(), w.id, caller),
    };
  }

  /// A standing note to a worker, from its manager: read by every later turn.
  addWorkerNote(caller: OrgCaller, idOrName: string, text: string): Result {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.workers.remember) return { ok: false, error: 'Notes are not available on this server.' };
    const note = text.trim();
    if (!note) return { ok: false, error: 'Write the note first.' };
    if (note.length > WORKER_NOTE_MAX) return { ok: false, error: `A note is at most ${WORKER_NOTE_MAX} characters.` };
    const res = this.deps.workers.remember(found.worker.id, `From ${caller.name}: ${note}`);
    if (res.ok) this.record(caller, `Left ${found.worker.name} a note: "${note.slice(0, 120)}".`);
    return res;
  }

  /// Take a standing note back.
  forgetWorkerNote(caller: OrgCaller, idOrName: string, entryId: string): Result {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.workers.forgetNote) return { ok: false, error: 'Notes are not available on this server.' };
    const note = this.deps.workers.journalFor(found.worker.id).find((e) => e.id === entryId)?.note;
    const res = this.deps.workers.forgetNote(found.worker.id, entryId);
    if (res.ok) this.record(caller, `Removed a note from ${found.worker.name}${note ? `: "${note.slice(0, 120)}"` : ''}.`);
    return res;
  }

  /// The chart, restricted to what the caller can see. A visible worker
  /// whose boss is hidden is drawn as a root rather than leaking the boss.
  orgChart(caller: OrgCaller): Array<{ manager?: string; roots: OrgNode<{ id: UUID; name: string }>[] }> {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const visible = roster.filter((w) => canSee(policy, roster, w.id, caller));
    const strip = (n: OrgNode<Worker>): OrgNode<{ id: UUID; name: string }> => ({
      worker: { id: n.worker.id, name: n.worker.name },
      reports: n.reports.map(strip),
    });
    return buildOrgTree(visible).map((b) => ({ ...(b.manager ? { manager: b.manager.name } : {}), roots: b.roots.map(strip) }));
  }

  /// The timesheet for the last `days` local days (7 or 30; 0 = all time),
  /// narrowed to the workers the caller can see. Totals and the day-by-day
  /// are re-added from the visible rows only, so a hidden worker's cost never
  /// shows up in a number the caller can read.
  report(caller: OrgCaller, days: number): Result<{ report: OrgReport; savedMultiplier: number }> {
    if (!this.deps.report) return { ok: false, error: 'Reports are not available on this server.' };
    const span = Number.isFinite(days) ? days : 30;
    if (!REPORT_WINDOWS.has(span)) return { ok: false, error: 'Pick 7 days, 30 days or all time (0).' };
    // Whole local days, as the desktop counts them: "30 days" is today and
    // the 29 before it, not the instant 30×24h ago.
    let sinceMs = 0;
    if (span > 0) {
      const from = new Date(this.now());
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - (span - 1));
      sinceMs = from.getTime();
    }
    const full = this.deps.report(sinceMs);
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const byId = new Map(roster.map((w) => [w.id, w]));
    const byWorker: OrgReportRow[] = [];
    for (const row of full.byWorker) {
      const w = byId.get(row.workerId);
      if (!w || !canSee(policy, roster, w.id, caller)) continue;
      const manager = managerFor(roster, w.id);
      byWorker.push({
        ...row,
        ...(manager ? { manager: manager.name } : {}),
        youManage: canManage(policy, roster, w.id, caller),
        budgetUSDPerMonth: w.budgetUSDPerMonth,
      });
    }
    // All time starts at the first thing that ever happened — on the whole
    // roster, as built. Re-start it at the first day a VISIBLE worker did
    // anything, or the axis would date a hidden worker's first activity.
    let axis = full.daily.map((d) => d.day);
    if (span === 0 && axis.length > 0) {
      const busy = (i: number) =>
        byWorker.some((r) => {
          const d = r.daily[i];
          return !!d && (d.shifts > 0 || d.itemsDone > 0 || d.costUSD > 0 || d.workedMs > 0 || d.tokens > 0);
        });
      let first = 0;
      while (first < axis.length - 1 && !busy(first)) first++;
      if (first > 0) {
        axis = axis.slice(first);
        for (const r of byWorker) r.daily = r.daily.slice(first);
      }
    }
    const { totals, daily } = rollUpWorkerReport(byWorker, axis);
    return {
      ok: true,
      report: { generatedAt: full.generatedAt, sinceMs: full.sinceMs, days: span, byWorker, totals, daily },
      savedMultiplier: WORKER_HUMAN_TIME_SAVED_MULTIPLIER,
    };
  }

  private waitingCounts(): Map<UUID, number> {
    const out = new Map<UUID, number>();
    for (const run of this.deps.runs.listRuns()) {
      if (pauseKind(run) && run.workerId) out.set(run.workerId, (out.get(run.workerId) ?? 0) + 1);
    }
    for (const b of this.proposalBatches()) out.set(b.workerId, (out.get(b.workerId) ?? 0) + 1);
    return out;
  }

  // ---- PROPOSALS --------------------------------------------------------

  private proposalBatches(): ProposalBatch[] {
    const out: ProposalBatch[] = [];
    for (const o of this.deps.batches?.list() ?? []) {
      if (o.origin?.kind !== 'worker') continue;
      const items = o.items.filter((i) => i.status === 'proposed');
      if (!items.length) continue;
      out.push({
        batchId: o.id,
        workerId: o.origin.workerId,
        workerName: o.origin.workerName,
        at: o.createdAt,
        task: o.origin.task === 'errand' ? 'errand' : 'shift',
        items: items.map((i) => ({
          candidateId: i.candidate.id,
          title: i.candidate.title,
          ...(i.candidate.note ? { detail: i.candidate.note } : {}),
          ...(i.candidate.size ? { size: i.candidate.size } : {}),
        })),
      });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /// Work proposed by the workers the caller manages, waiting on a yes.
  proposals(caller: OrgCaller): ProposalBatch[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    return this.proposalBatches().filter((b) => canManage(policy, roster, b.workerId, caller));
  }

  /// Approve some or all of a proposal, and skip the rest.
  async decideProposal(
    caller: OrgCaller,
    batchId: UUID,
    decision: { approve: string[] | 'all'; skip?: string[] },
  ): Promise<Result<{ queued: number; skipped: number }>> {
    const batch = this.proposalBatches().find((b) => b.batchId === batchId);
    if (!batch || !this.deps.batches) return { ok: false, error: 'Nothing from that run is waiting any more.' };
    if (!canManage(this.policy(), this.deps.workers.roster(), batch.workerId, caller)) {
      return { ok: false, error: `Only ${batch.workerName}'s manager can decide its work.` };
    }
    const ids = new Set(batch.items.map((i) => i.candidateId));
    const skip = (decision.skip ?? []).filter((id) => ids.has(id));
    for (const id of skip) {
      const res = this.deps.batches.reject(batchId, id);
      if (!res.ok) return res;
    }
    const approve = decision.approve === 'all' ? batch.items.map((i) => i.candidateId).filter((id) => !skip.includes(id)) : decision.approve.filter((id) => ids.has(id) && !skip.includes(id));
    let queued = 0;
    if (approve.length) {
      const res = await this.deps.batches.approve(batchId, approve.length === batch.items.length ? 'all' : approve);
      if (!res.ok) return res;
      queued = res.queued;
    }
    this.record(caller, `${approve.length ? `Approved ${approve.length}` : 'Approved none'}${skip.length ? `, skipped ${skip.length},` : ''} of ${batch.workerName}'s proposed work.`);
    return { ok: true, queued, skipped: skip.length };
  }

  /// Who to ask about a worker's proposals: its manager, inherited if need be.
  /// A tool's scope on one worker as it applies, and where it comes from.
  private scopeOf(w: Worker, name: string): { scope?: ToolScope; scopeFrom?: 'default' | 'own' } {
    const own = w.toolScopes?.[name];
    if (own) return { scope: own, scopeFrom: 'own' };
    const def = this.policy().toolDefaults?.[name];
    return def ? { scope: def, scopeFrom: 'default' } : {};
  }

  /// A tool's scope page (Setup → Tools → Manage): its default, its calls
  /// sorted into reads and changes, and each worker that has it with its own
  /// scope and the last week's use. Admins.
  async toolScopePage(caller: OrgCaller, name: string): Promise<Result<{
    default?: ToolScope;
    calls: Array<{ name: string; read: boolean }>;
    workers: Array<{ id: UUID; name: string; manager?: string; own?: ToolScope; calls: number; refused: number }>;
  }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can manage tools.' };
    const listed = this.deps.serverTools ? await this.deps.serverTools(name) : { ok: false as const, error: '' };
    const key = mcpServerKey(name);
    const calls = listed.ok ? listed.tools.map((t) => ({ name: t.name, read: isReadOnlyMcpTool(`mcp__${key}__${t.name}`) })) : [];
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const has = (w: Worker) => (w.mcpServers ?? []).includes(name) || (policy.sharedMcpServers ?? []).includes(name);
    const since = this.now() - 7 * 24 * 3_600_000;
    // What its runs did with this tool this week, by the run activity log:
    // calls made, and calls refused (by its scope, or for want of approval).
    // As runActivity's describeTool names it.
    const shown = key.replace(/^claude_ai_/, '').replace(/_/g, ' ');
    const usage = new Map<string, { calls: number; refused: number }>();
    for (const r of this.deps.runs.listRuns()) {
      if (!r.workerId || r.createdAt < since) continue;
      const u = usage.get(r.workerId) ?? { calls: 0, refused: 0 };
      for (const a of this.deps.runActivity?.(r.id, 0) ?? []) {
        if (a.kind === 'tool' && a.text.startsWith(`${shown}:`)) u.calls++;
        else if (a.kind === 'denied' && a.text.includes(`mcp__${key}__`)) u.refused++;
      }
      usage.set(r.workerId, u);
    }
    return {
      ok: true,
      ...(policy.toolDefaults?.[name] ? { default: policy.toolDefaults[name] } : {}),
      calls,
      workers: roster.filter(has).map((w) => ({
        id: w.id,
        name: w.name,
        ...(managerFor(roster, w.id)?.name ? { manager: managerFor(roster, w.id)!.name } : {}),
        ...(w.toolScopes?.[name] ? { own: w.toolScopes[name] } : {}),
        ...(usage.get(w.id) ?? { calls: 0, refused: 0 }),
      })),
    };
  }

  /// Set a tool's default scope for every worker that has it; null for the
  /// whole tool. Workers with their own scope keep it.
  setToolDefault(caller: OrgCaller, name: string, value: unknown): Result<{ default?: ToolScope }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can set a tool’s default scope.' };
    if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(name)) return { ok: false, error: 'That is not a tool name.' };
    if (!this.deps.updateOrg) return { ok: false, error: 'The org’s rules cannot be changed here.' };
    const scope = value === null ? null : parseToolScope(value);
    if (value !== null && !scope) return { ok: false, error: 'The default is the whole tool, read only, or a list of calls.' };
    this.deps.updateOrg((raw) => {
      const defaults = { ...((raw.toolDefaults as Record<string, unknown> | undefined) ?? {}) };
      if (!scope || scope.mode === 'full') delete defaults[name];
      else defaults[name] = scope;
      if (Object.keys(defaults).length) raw.toolDefaults = defaults;
      else delete raw.toolDefaults;
    });
    this.record(caller, `Set ${name}'s default scope to ${describeScope(scope ?? undefined)}.`);
    return { ok: true, ...(scope && scope.mode !== 'full' ? { default: scope } : {}) };
  }

  /// A sign-in has just been linked to Slack (see `AccessService.linkSlackConfirm`):
  /// the workers it manages by name alone get the Slack id, so what they
  /// send their manager reaches them. Returns how many.
  linkManagers(name: string, slackUserId: string, slackName?: string): number {
    let n = 0;
    for (const w of this.deps.workers.roster()) {
      // Theirs by name alone, or already picked by Slack id but saved under
      // the bare id because no name was known for it then.
      const byName = !w.manager?.slackUserId && w.manager?.name === name;
      const bareId = w.manager?.slackUserId === slackUserId && w.manager.name === slackUserId && !!slackName;
      if (!w.manager || (!byName && !bareId)) continue;
      const res = this.deps.workers.save({ ...w, manager: { name: slackName || w.manager.name, slackUserId } });
      if (res.ok) n++;
    }
    return n;
  }

  managerSlackId(workerId: UUID): string | undefined {
    return managerFor(this.deps.workers.roster(), workerId)?.slackUserId;
  }

  async runNow(caller: OrgCaller, idOrName: string): Promise<Result<{ name: string }>> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.runNow) return { ok: false, error: 'Runs cannot be started from here.' };
    if (!found.worker.enabled) return { ok: false, error: `${found.worker.name} is paused.` };
    const res = await this.deps.runNow(found.worker.id);
    if (!res.ok) return res;
    this.record(caller, `Started a run of ${found.worker.name} now.`);
    return { ok: true, name: found.worker.name };
  }

  /// Questions and approvals waiting on the caller: on workers they manage,
  /// or on every worker for an admin.
  listWaiting(caller: OrgCaller): WaitingItem[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const out: WaitingItem[] = [];
    for (const run of this.deps.runs.listRuns()) {
      const kind = pauseKind(run);
      if (!kind || run.state.kind !== 'paused' || !run.workerId) continue;
      if (!canManage(policy, roster, run.workerId, caller)) continue;
      const stepId = run.state.nextStepId;
      const exchange =
        kind === 'question'
          ? [...(run.workerExchanges ?? [])].reverse().find((x) => x.stepId === stepId && x.status !== 'answered')
          : undefined;
      out.push({
        runId: run.id,
        workerId: run.workerId,
        workerName: run.workerName ?? roster.find((w) => w.id === run.workerId)?.name ?? 'A worker',
        kind,
        title: flowRunTitle(run),
        stepId,
        ...(exchange ? { question: exchange.question } : {}),
        ...(exchange?.note ? { why: exchange.note } : {}),
        ...(exchange && answerOptions(exchange.question).length ? { options: answerOptions(exchange.question) } : {}),
        ...(kind === 'approval' ? approvalDetail(run, stepId) : {}),
        since: exchange?.answeredAt ?? exchange?.askedAt ?? run.lastUserTurnAt ?? 0,
      });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  // ---- ACT ON RUNS ------------------------------------------------------

  private pausedFor(caller: OrgCaller, runId: UUID, want: 'question' | 'approval'): Result<{ run: FlowRun }> {
    const run = this.deps.runs.getRun(runId);
    if (!run || !run.workerId) return { ok: false, error: 'No worker run with that id.' };
    if (!canManage(this.policy(), this.deps.workers.roster(), run.workerId, caller)) {
      return { ok: false, error: "Only this worker's manager can do that." };
    }
    if (pauseKind(run) !== want) {
      return { ok: false, error: want === 'question' ? 'That run is not waiting on an answer.' : 'That run is not waiting on an approval.' };
    }
    return { ok: true, run };
  }

  answer(caller: OrgCaller, runId: UUID, text: string): Result {
    const answer = text.trim();
    if (!answer) return { ok: false, error: 'Type an answer.' };
    const found = this.pausedFor(caller, runId, 'question');
    if (!found.ok) return found;
    const steer = this.deps.runs.steerRun({ runId, text: `${caller.name} answered your question:\n${answer}` });
    if (!steer.ok) return steer;
    const title = flowRunTitle(found.run);
    const res = this.deps.runs.resumeRun({ runId });
    if (res.ok) this.record(caller, `Answered ${found.run.workerName ?? 'a worker'}'s question on "${title}".`);
    return res;
  }

  /// Approve or reject the step a run waits on. `forRun`: approve the later
  /// steps that need only the same outside tools too (`WaitingItem.coversLater`).
  decideRun(caller: OrgCaller, runId: UUID, approve: boolean, forRun = false): Result {
    const found = this.pausedFor(caller, runId, 'approval');
    if (!found.ok) return found;
    // Read before acting: approving moves the run on, and the log should
    // name the step that was approved, not the one after it.
    const step = found.run.state.kind === 'paused' ? found.run.state.nextStepId : 'a step';
    const what = `${found.run.workerName ?? 'a worker'} running "${step}" on "${flowRunTitle(found.run)}"`;
    const res = approve ? this.deps.runs.resumeRun({ runId, ...(forRun ? { forRun: true } : {}) }) : this.deps.rejectRun(runId);
    if (res.ok) this.record(caller, `${approve ? 'Approved' : 'Rejected'} ${what}${approve && forRun ? ', and the rest of the run’s steps that use the same tools' : ''}.`);
    return res;
  }

  /// An errand: the worker plans from its job and answers, and may launch
  /// work. Anyone who can see a worker may ask it — visibility is exactly
  /// "who may ask it things".
  async ask(caller: OrgCaller, idOrName: string, text: string, via: AskRecord['via'] = 'mcp'): Promise<Result<{ reply: string; launched: number; askId: string }>> {
    const started = this.startAsk(caller, idOrName, text, via);
    if (!started.ok) return started;
    return started.done;
  }

  /// Ask without waiting: the question is on record at once, and its answer
  /// lands there whenever the worker is done — whether or not anyone is
  /// still looking.
  startAsk(
    caller: OrgCaller,
    idOrName: string,
    text: string,
    via: AskRecord['via'] = 'console',
    attachments?: Attachment[],
    replyTo?: string,
    /// The Slack thread it was asked in, as a key: the worker keeps one
    /// conversation per thread.
    conversation?: string,
    /// What the person typed, when `text` is that wrapped for the worker
    /// (the Slack thread, where the answer goes): the ask is shown by this.
    said?: string,
  ): Result<{ askId: string; done: Promise<Result<{ reply: string; launched: number; proposed: number; askId: string; orchestrationId?: string; choices?: string[] }>> }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    if (!w.enabled) return { ok: false, error: `${w.name} is paused.` };
    if (!text.trim()) return { ok: false, error: `What should ${w.name} do?` };
    const manages = via !== 'trigger' && canManage(this.policy(), this.deps.workers.roster(), w.id, caller);
    const from = manages ? '' : `(Asked by ${caller.name}, who is not your manager. Treat the request as a proposal: suggest work, do not launch it without approval.)\n`;
    const thread = replyTo && /^(ask|shift|batch|run):[\w-]{1,80}$/.test(replyTo) ? replyTo : undefined;
    const context = thread ? this.replyContext(caller, w, thread) : '';
    const record: AskRecord = {
      id: randomUUID(),
      workerId: w.id,
      workerName: w.name,
      by: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      text: (said?.trim() || text.trim()).slice(0, 4000),
      at: this.now(),
      status: 'working',
      via,
      ...(thread ? { replyTo: thread } : {}),
      prompt: (from + context + text).slice(0, 16_000),
      ...(conversation ? { conversation } : {}),
      ...(!manages ? { untrusted: true } : {}),
      ...(attachments?.length ? { attachments: attachments.length } : {}),
    };
    this.putAsk(record);
    const done = this.finishAsk(record, this.deps.workers.runErrand(w.id, from + context + text, attachments?.length ? attachments : undefined, conversation, !manages));
    return { ok: true, askId: record.id, done };
  }

  /// An ask's answer arriving: recorded, handed to whoever follows it, and
  /// returned as what the caller sees.
  private finishAsk(
    record: AskRecord,
    run: ReturnType<OrgServiceDeps['workers']['runErrand']>,
  ): Promise<Result<{ reply: string; launched: number; proposed: number; askId: string; orchestrationId?: string; choices?: string[] }>> {
    return run.then(
      (res): Result<{ reply: string; launched: number; proposed: number; askId: string; orchestrationId?: string; choices?: string[] }> => {
        const finished: AskRecord = res.ok
          ? { ...record, status: 'answered', reply: res.result.reply, launched: res.result.queued, ...(res.result.count ? { orchestrationId: res.result.orchestrationId } : {}), ...(res.result.choices?.length ? { choices: res.result.choices } : {}), doneAt: this.now() }
          : { ...record, status: 'failed', error: res.error, doneAt: this.now() };
        this.putAsk(finished);
        this.deps.onAskDone?.(finished);
        // Work it started, or proposed and is waiting on its manager for:
        // either way the batch is worth following to the end.
        if (!res.ok) return res;
        const proposed = Math.max(0, res.result.count - res.result.queued);
        return { ok: true, reply: res.result.reply, launched: res.result.queued, proposed, askId: record.id, ...(res.result.count ? { orchestrationId: res.result.orchestrationId } : {}), ...(res.result.choices?.length ? { choices: res.result.choices } : {}) };
      },
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        const failed: AskRecord = { ...record, status: 'failed', error, doneAt: this.now() };
        this.putAsk(failed);
        this.deps.onAskDone?.(failed);
        return { ok: false as const, error };
      },
    );
  }

  /// Work an ask handed off has finished: its result goes back to the
  /// worker, in the same conversation, to finish what it told the asker it
  /// would do (a chart from the counts, a write-up of the findings) instead
  /// of the run's raw output reaching them. Hangs on the ask as a reply.
  /// Null when there's nothing to hand back: still running, already handed
  /// back, nothing finished, or the worker is paused.
  handBack(askId: string): { askId: string; done: ReturnType<OrgService['finishAsk']> } | null {
    const a = this.allAsks().find((x) => x.id === askId);
    if (!a || a.handedBack || !a.orchestrationId || a.status !== 'answered') return null;
    const p = this.errandProgress(a.orchestrationId);
    if (!p?.done || !p.items.some((i) => i.status === 'done')) return null;
    const w = this.deps.workers.get(a.workerId);
    if (!w?.enabled) return null;
    this.putAsk({ ...a, handedBack: true });
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut)` : s);
    const done = p.items.filter((i) => i.status === 'done').map((i) => i.title);
    const broke = p.items.filter((i) => i.status === 'failed').map((i) => `${i.title}${i.note ? ` (${i.note})` : ''}`);
    let room = 14_000;
    const produced = p.files.map((f) => {
      const body = f.body && room > 0 ? cut(f.body, room) : '';
      room -= body.length;
      return body ? `--- ${f.name}${f.sourcePath ? ` (${f.sourcePath})` : ''}\n${body}` : `--- ${f.name}${f.sourcePath ? `: ${f.sourcePath}` : ''}`;
    });
    const prompt = [
      `The work you handed off for ${a.by}'s request has finished: ${done.join('; ')}.${broke.length ? ` This failed: ${broke.join('; ')}.` : ''}`,
      `Their request: "${a.text.slice(0, 600)}"`,
      produced.length ? `\nWhat it produced:\n${produced.join('\n\n')}` : '\nIt produced no files.',
      '',
      `Now finish what you told ${a.by} you would do, written for a business reader: the answer first, in plain words, with the few numbers that matter. No raw JSON, field names or query syntax. If you said you would build something (a chart, a report, a page), build it now in your own files folder and name its full path in your reply. Mention a caveat only if it changes what the numbers mean. Don't start more work unless this result can't be used.`,
    ].join('\n');
    const record: AskRecord = {
      id: randomUUID(),
      workerId: w.id,
      workerName: w.name,
      by: a.by,
      ...(a.slackUserId ? { slackUserId: a.slackUserId } : {}),
      text: `Finishing up now that ${done.length === 1 ? `"${done[0]}" is done` : `${done.length} pieces of work are done`}`,
      at: this.now(),
      status: 'working',
      ...(a.via ? { via: a.via } : {}),
      replyTo: `ask:${a.id}`,
      prompt: prompt.slice(0, 16_000),
      ...(a.conversation ? { conversation: a.conversation } : {}),
      handedBack: true,
    };
    this.putAsk(record);
    return { askId: record.id, done: this.finishAsk(record, this.deps.workers.runErrand(w.id, prompt, undefined, a.conversation, a.untrusted === true)) };
  }

  /// Asks made in the console whose handed-off work has finished, handed
  /// back (see `handBack`). Slack's front door hands back its own, to post
  /// the answer in its thread. Call every so often.
  handBackDue(): number {
    // Only asks made since this server started: one from earlier in the day
    // was answered the old way and already read.
    let n = 0;
    for (const a of this.allAsks()) {
      if (a.via !== 'console' || a.handedBack || !a.orchestrationId || a.at < this.bootAt) continue;
      if (this.handBack(a.id)) n++;
    }
    return n;
  }

  /// Asks a restart cut short while the worker was still working out its
  /// answer, asked again. Work an ask had already started is a run, and runs
  /// carry on by themselves. Once per ask, and within a day: one caught by a
  /// second restart, or older, fails as it always did. The answer reaches its
  /// asker by Slack (`onAskDone`), since whoever was waiting has gone.
  /// Call once, at start, after the workers have loaded. Returns how many.
  resumeAsks(): number {
    if (!this.deps.asks) return 0;
    this.asksRestored = true;
    const now = this.now();
    let n = 0;
    for (const a of this.deps.asks.list().filter((x) => x.status === 'working')) {
      const again = !a.resumed && now - a.at < 24 * 3_600_000 && !!this.deps.workers.get(a.workerId)?.enabled;
      if (!again) {
        this.putAsk({ ...a, status: 'failed', error: 'The server restarted before it finished. Ask again.', doneAt: now });
        continue;
      }
      const record: AskRecord = { ...a, resumed: true };
      this.putAsk(record);
      const lost = a.attachments ? `\n\n(The ${a.attachments === 1 ? 'file' : `${a.attachments} files`} attached to this were lost when the server restarted. Say so if you need ${a.attachments === 1 ? 'it' : 'them'}.)` : '';
      void this.finishAsk(record, this.deps.workers.runErrand(a.workerId, (a.prompt ?? a.text) + lost, undefined, a.conversation, a.untrusted === true));
      n++;
    }
    return n;
  }

  /// What a reply answers, quoted into the errand: the thread may be from
  /// yesterday, or a shift whose reasoning never was in the conversation.
  private replyContext(caller: OrgCaller, w: Worker, thread: string): string {
    const [kind, id] = [thread.slice(0, thread.indexOf(':')), thread.slice(thread.indexOf(':') + 1)];
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
    const clean = (s: string) => s.replace(/<candidates>[\s\S]*?<\/candidates>|<replies>[\s\S]*?<\/replies>|<\/?subject>/g, '').trim();
    let quoted = '';
    if (kind === 'ask') {
      const a = this.visibleAsks(caller, w.id).find((x) => x.id === id);
      if (a) quoted = `I asked: "${cut(a.text, 400)}"${a.reply ? `\nYou answered: "${cut(clean(a.reply), 1500)}"` : ''}`;
    } else if (kind === 'shift') {
      const e = this.deps.workers.journalFor(w.id).find((x) => x.id === id);
      const reply = e?.orchestrationId ? this.deps.orchestration?.(e.orchestrationId)?.producer?.reply : undefined;
      if (e) quoted = `On your ${e.title || 'check'}, you said: "${cut(clean(reply ?? e.note ?? ''), 1500)}"`;
    } else if (kind === 'run') {
      const r = this.deps.runs.getRun(id);
      if (r?.workerId === w.id) quoted = `About your run "${flowRunTitle(r)}".`;
    }
    return quoted ? `(This is a reply in the thread where ${quoted})\n\nMy reply: ` : '';
  }

  private memoryAsks: AskRecord[] = [];
  private asksRestored = false;
  private readonly bootAt = Date.now();

  private allAsks(): AskRecord[] {
    if (!this.deps.asks) return this.memoryAsks;
    const all = this.deps.asks.list();
    // Questions still "working" from before a restart are not coming back.
    if (!this.asksRestored) {
      this.asksRestored = true;
      if (all.some((a) => a.status === 'working')) {
        const settled = all.map((a) => (a.status === 'working' ? { ...a, status: 'failed' as const, error: 'The server restarted before it finished. Ask again.', doneAt: this.now() } : a));
        this.deps.asks.save(settled);
        return settled;
      }
    }
    return all;
  }

  private putAsk(record: AskRecord): void {
    const all = this.allAsks().filter((a) => a.id !== record.id);
    all.push(record);
    if (this.deps.asks) this.deps.asks.save(all);
    else this.memoryAsks = all.slice(-1000);
  }

  // ---- TOOLS --------------------------------------------------------------

  private toolStatuses: { at: number; statuses: Record<string, string> } | null = null;

  /// What MCP servers workers here can use, who uses each, and what a worker
  /// names that is not installed. Admins see it all; a manager sees whether
  /// their workers' tools are here.
  tools(caller: OrgCaller): Result<{ tools: Array<ToolSummary & { access: 'picked' | 'managers' | 'everyone'; signIn?: SignInSummary }>; missing: Array<{ name: string; workers: string[]; template?: ToolTemplate }>; checkedAt?: number; canEdit: boolean; signIn: boolean }> {
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const roster = this.deps.workers.roster();
    const admin = isAdmin(this.policy(), caller);
    const mine = admin ? roster : roster.filter((w) => canManage(this.policy(), roster, w.id, caller));
    const listed = this.deps.tools.list(mine, this.toolStatuses?.statuses);
    const policy = this.policy();
    // Who can use each: workers given it one by one, any manager may give
    // it (the org allows it for any hire), or every worker has it already.
    const shared = new Set(policy.sharedMcpServers ?? []);
    const allowed = new Set(policy.allowedMcpServers ?? []);
    const signedIn = this.deps.toolSignIn?.summaries() ?? {};
    const withAccess = listed.tools.map((t) => ({
      ...t,
      access: (shared.has(t.name) ? 'everyone' : allowed.has(t.name) ? 'managers' : 'picked') as 'picked' | 'managers' | 'everyone',
      ...(t.kind === 'http' && signedIn[t.name] ? { signIn: signedIn[t.name] } : {}),
    }));
    return {
      ok: true,
      tools: admin ? withAccess : withAccess.filter((t) => t.usedBy.length || t.access === 'everyone'),
      missing: listed.missing,
      ...(this.toolStatuses ? { checkedAt: this.toolStatuses.at } : {}),
      canEdit: admin,
      signIn: !!this.deps.toolSignIn,
    };
  }

  private memoryOffers: SetupOffer[] = [];
  private loadOffers(): SetupOffer[] {
    return this.deps.setupOffers ? this.deps.setupOffers.load().offers : this.memoryOffers;
  }
  private saveOffers(offers: SetupOffer[]): void {
    if (this.deps.setupOffers) this.deps.setupOffers.save({ offers });
    else this.memoryOffers = offers;
  }

  /// A desktop's setup, published: its tools, repos and workspaces become a
  /// checklist under Setup for an admin. Keys only come with a tool its
  /// owner ticked, from an admin, over a channel nobody else can read
  /// (`secure`: TLS, a trusted proxy that saw https, or this machine) — and
  /// then the tool is installed at once, so the values are never stored
  /// anywhere but where the model CLI reads them.
  publishSetup(caller: OrgCaller, input: SetupPublishInput, secure: boolean): Result<{ installed: string[]; offered: { tools: number; repos: number; workspaces: number } }> {
    if (!canHire(this.policy(), caller) && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only people who may hire workers can publish a setup.' };
    const keys = input.keys ?? {};
    const keyed = Object.keys(keys).filter((n) => Object.keys(keys[n]?.env ?? {}).length || Object.keys(keys[n]?.headers ?? {}).length);
    if (keyed.length) {
      if (!secure) return { ok: false, error: 'Keys only travel over https, or to a server on this same machine. Publish without them, or use the server’s https address.' };
      if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can send keys with a setup. Publish without them, and an admin adds the keys on the server.' };
      if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    }
    const byName = new Map(input.tools.map((t) => [t.name, t]));
    const installed: string[] = [];
    for (const name of keyed) {
      const t = byName.get(name);
      if (!t) return { ok: false, error: `Keys came for ${name}, which isn't in the setup.` };
      const env = keys[name]?.env ?? {};
      const headers = keys[name]?.headers ?? {};
      const stray = [...Object.keys(env).filter((k) => !t.envKeys.includes(k)), ...Object.keys(headers).filter((k) => !t.headerKeys.includes(k))];
      if (stray.length) return { ok: false, error: `${name} doesn't use ${stray.join(', ')}.` };
      const res = this.deps.tools!.install({ name, kind: t.kind, command: t.command ?? '', args: t.args ?? [], env, url: t.url ?? '', headers });
      if (!res.ok) return { ok: false, error: `${name}: ${res.error}` };
      installed.push(name);
      // Names only: what was sent, never what it was.
      this.record(caller, `Sent the keys for ${name} from their desktop (${[...Object.keys(env), ...Object.keys(headers)].join(', ')}) and installed it.`);
    }
    this.deps.tools?.remember?.(input.tools, !isAdmin(this.policy(), caller));
    const offer: SetupOffer = {
      id: randomUUID(),
      by: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      at: this.now(),
      tools: input.tools,
      repos: input.repos,
      workspaces: input.workspaces,
      installed,
    };
    // One offer per person: publishing again replaces it.
    const same = (o: SetupOffer) => (caller.slackUserId ? o.slackUserId === caller.slackUserId : !o.slackUserId && o.by === caller.name);
    this.saveOffers([...this.loadOffers().filter((o) => !same(o)), offer].slice(-20));
    this.record(caller, `Published their desktop setup: ${input.tools.length} tool${input.tools.length === 1 ? '' : 's'}, ${input.repos.length} repo${input.repos.length === 1 ? '' : 's'}, ${input.workspaces.length} workspace${input.workspaces.length === 1 ? '' : 's'}.`);
    return { ok: true, installed, offered: { tools: input.tools.length, repos: input.repos.length, workspaces: input.workspaces.length } };
  }

  /// Published setups, each item marked with whether it's here already.
  setupOffers(caller: OrgCaller): Result<{ offers: Array<Omit<SetupOffer, 'tools' | 'repos' | 'workspaces'> & {
    tools: Array<ToolTemplate & { installed: boolean }>;
    repos: Array<{ name: string; url?: string; localPath?: string; connected: boolean; needsToken?: string }>;
    workspaces: Array<{ name: string; repos: string[]; instructions?: string; made: boolean }>;
  }>; allowLocalRepos: boolean }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const tools = new Set(this.deps.tools ? this.deps.tools.list([]).tools.map((t) => t.name) : []);
    const repos = this.deps.repos?.list() ?? [];
    const spaces = this.deps.repos?.workspaces() ?? [];
    const norm = (u: string) => u.replace(/\.git$/, '').toLowerCase();
    return {
      ok: true,
      allowLocalRepos: process.env.OVERCLI_ALLOW_LOCAL_REPOS === '1',
      offers: this.loadOffers()
        .slice()
        .reverse()
        .map((o) => ({
          ...o,
          tools: o.tools.map((t) => ({ ...t, installed: tools.has(t.name) })),
          repos: o.repos.map((r) => {
            const connected = repos.some((c) => (r.url && norm(c.url) === norm(r.url)) || c.name === r.name);
            // The host's token, when cloning over https needs one that isn't set.
            const needsToken = !connected && r.url && this.deps.repos && !this.deps.repos.canPush({ url: r.url } as ConnectedRepo) ? this.deps.repos.tokenFor({ url: r.url } as ConnectedRepo) ?? undefined : undefined;
            return { ...r, connected, ...(needsToken ? { needsToken } : {}) };
          }),
          workspaces: o.workspaces.map((w) => ({ ...w, made: spaces.some((s) => s.name.toLowerCase() === w.name.toLowerCase()) })),
        })),
    };
  }

  dismissSetupOffer(caller: OrgCaller, id: string): Result {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server.' };
    const all = this.loadOffers();
    if (!all.some((o) => o.id === id)) return { ok: false, error: 'No such setup.' };
    this.saveOffers(all.filter((o) => o.id !== id));
    return { ok: true };
  }

  installTool(caller: OrgCaller, input: ToolInput): Result {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can install tools on the server.' };
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const res = this.deps.tools.install(input);
    if (res.ok) this.record(caller, `Installed the ${input.name} tool (${input.kind === 'http' ? input.url : input.command}).`);
    return res;
  }

  uninstallTool(caller: OrgCaller, name: string): Result {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can remove tools from the server.' };
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const res = this.deps.tools.uninstall(name);
    if (res.ok) {
      this.record(caller, `Removed the ${name} tool.`);
      void this.deps.toolSignIn?.forget(name).catch(() => {});
    }
    return res;
  }

  /// How a remote tool signs in: nothing, a pasted token, or a sign-in page.
  async discoverToolSignIn(caller: OrgCaller, url: string, base: string): Promise<Result<{ signIn: 'none' | 'token' | 'oauth'; issuer?: string; registers?: boolean; redirectUri?: string }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can install tools on the server.' };
    if (!this.deps.toolSignIn) return { ok: false, error: 'Signing tools in isn’t available on this server.' };
    return this.deps.toolSignIn.discover(url, base);
  }

  /// Start signing a remote tool in for the whole org: the service's page.
  async startToolSignIn(
    caller: OrgCaller,
    input: { name: string; url: string; next?: string; clientId?: string; clientSecret?: string },
    base: string,
  ): Promise<Result<{ url: string; browserKey: string }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can sign tools in for the org.' };
    if (!this.deps.toolSignIn) return { ok: false, error: 'Signing tools in isn’t available on this server.' };
    const name = input.name.trim();
    if (!TOOL_NAME.test(name)) return { ok: false, error: 'A name is letters, numbers, dashes or underscores, and must match what workers list (e.g. jira).' };
    return this.deps.toolSignIn.start(caller, { ...input, name, base });
  }

  /// Back from the service's sign-in page.
  async finishToolSignIn(query: URLSearchParams, browserKey: string | undefined): Promise<{ location: string; ok: boolean; reason?: string }> {
    if (!this.deps.toolSignIn) return { ok: false, reason: 'server', location: '/#setup/tools' };
    const back = await this.deps.toolSignIn.callback(query, browserKey);
    if (back.ok && back.name) this.record({ name: back.by ?? 'An admin', admin: true }, `Signed the ${back.name} tool in for the org.`);
    return back;
  }

  async checkTools(caller: OrgCaller): Promise<Result<{ statuses: Record<string, string> }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can check the server\'s tools.' };
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const statuses = await this.deps.tools.check();
    if (!statuses) return { ok: false, error: 'Claude did not start on the server, so the tools could not be checked. See Admin → health.' };
    this.toolStatuses = { at: this.now(), statuses };
    return { ok: true, statuses };
  }

  /// Stop a worker's run now, for its manager or an admin. What it already
  /// wrote stays; nothing it was about to do happens.
  stopRun(caller: OrgCaller, runId: UUID): Result {
    if (!this.deps.stopRun) return { ok: false, error: 'Runs can’t be stopped from here.' };
    const run = this.deps.runs.getRun(runId);
    if (!run?.workerId) return { ok: false, error: 'No worker run by that id.' };
    const policy = this.policy();
    if (!isAdmin(policy, caller) && !canManage(policy, this.deps.workers.roster(), run.workerId, caller)) return { ok: false, error: 'Only its manager or an admin can stop it.' };
    if (run.state.kind === 'done' || run.state.kind === 'aborted') return { ok: false, error: 'It has already ended.' };
    const res = this.deps.stopRun(runId);
    if (res.ok) this.record(caller, `Stopped ${this.deps.workers.get(run.workerId)?.name ?? 'a worker'}'s run "${flowRunTitle(run)}".`);
    return res;
  }

  // ---- TRIGGERS -------------------------------------------------------------

  private triggerSvc(): TriggerService | null {
    return this.deps.triggers?.() ?? null;
  }

  /// A trigger as people see it: never its webhook secret or the ids it has seen.
  private showTrigger(t: WorkerTrigger, s: TriggerService): TriggerView {
    const { webhook, seen, ...rest } = t;
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const mine = s.deliverables().filter((d) => d.source.triggerId === t.id);
    return {
      ...rest,
      ...(webhook ? { webhook: { ...(webhook.idPath ? { idPath: webhook.idPath } : {}) } } : {}),
      seenCount: seen?.length ?? 0,
      handledToday: mine.filter((d) => d.at >= start.getTime()).length,
      handledTotal: mine.filter((d) => d.status === 'delivered').length,
    };
  }

  private deliverableList(): Deliverable[] {
    return this.triggerSvc()?.deliverables() ?? [];
  }

  triggers(caller: OrgCaller, idOrName: string): Result<{ triggers: TriggerView[]; canEdit: boolean }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Triggers run on the org server.' };
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    return { ok: true, triggers: s.list(w.id).map((t) => this.showTrigger(t, s)), canEdit: canManage(this.policy(), this.deps.workers.roster(), w.id, caller) };
  }

  createTrigger(
    caller: OrgCaller,
    idOrName: string,
    input: Pick<WorkerTrigger, 'name' | 'kind' | 'instructions' | 'deliver' | 'maxPerDay' | 'watch' | 'slack'> & { webhook?: { idPath?: string } },
  ): Result<{ trigger: TriggerView; webhookPath?: string }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Triggers run on the org server.' };
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const res = s.create({ ...input, workerId: found.worker.id, enabled: true, createdBy: caller.name });
    if (!res.ok) return res;
    this.record(caller, `Gave ${found.worker.name} a trigger: ${res.trigger.name}.`);
    return { ok: true, trigger: this.showTrigger(res.trigger, s), ...(res.token ? { webhookPath: `/hooks/${res.trigger.id}/${res.token}` } : {}) };
  }

  private managedTrigger(caller: OrgCaller, id: string): Result<{ trigger: WorkerTrigger; s: TriggerService }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Triggers run on the org server.' };
    const t = s.get(id);
    if (!t) return { ok: false, error: 'No such trigger.' };
    if (!canManage(this.policy(), this.deps.workers.roster(), t.workerId, caller)) return { ok: false, error: 'Only the worker’s manager can change its triggers.' };
    return { ok: true, trigger: t, s };
  }

  updateTrigger(caller: OrgCaller, id: string, patch: Partial<Pick<WorkerTrigger, 'name' | 'enabled' | 'instructions' | 'deliver' | 'maxPerDay' | 'watch' | 'slack'>>): Result<{ trigger: TriggerView }> {
    const found = this.managedTrigger(caller, id);
    if (!found.ok) return found;
    const res = found.s.update(id, patch);
    if (!res.ok) return res;
    this.record(caller, `${patch.enabled === false ? 'Paused' : patch.enabled === true ? 'Resumed' : 'Changed'} the trigger ${res.trigger.name}.`);
    return { ok: true, trigger: this.showTrigger(res.trigger, found.s) };
  }

  removeTrigger(caller: OrgCaller, id: string): Result {
    const found = this.managedTrigger(caller, id);
    if (!found.ok) return found;
    found.s.remove(id);
    this.record(caller, `Removed the trigger ${found.trigger.name}.`);
    return { ok: true };
  }

  /// Check a trigger's watch once, now, without waiting for its timer.
  async checkTriggerNow(caller: OrgCaller, id: string): Promise<Result> {
    const found = this.managedTrigger(caller, id);
    if (!found.ok) return found;
    await found.s.poll(id);
    return { ok: true };
  }

  async testWatch(caller: OrgCaller, watch: NonNullable<WorkerTrigger['watch']>): Promise<Result<{ items: Array<{ id: string; title: string; url?: string }> }>> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Triggers run on the org server.' };
    if (!canHire(this.policy(), caller) && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only people who manage workers can test triggers.' };
    const res = await s.test(watch);
    return res.ok ? { ok: true, items: res.items.slice(0, 25).map((i) => ({ id: i.id, title: i.title, ...(i.url ? { url: i.url } : {}) })) } : res;
  }

  async serverTools(caller: OrgCaller, name: string): Promise<Result<{ tools: Array<{ name: string; description?: string }> }>> {
    if (!this.deps.serverTools) return { ok: false, error: 'Tools cannot be listed here.' };
    if (!canHire(this.policy(), caller) && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only people who manage workers can list a tool’s calls.' };
    return this.deps.serverTools(name);
  }

  // ---- LIBRARY ---------------------------------------------------------------

  /// Everything workers and teams made that the caller can see, newest
  /// first: what they delivered on events, their finished work, errands they
  /// answered, team tasks (each one entry, its members' piece runs folded
  /// in) and team files someone kept. Each says where it came from and who
  /// can see it.
  library(
    caller: OrgCaller,
    opts: { workerId?: string; query?: string; limit?: number; kind?: LibraryKind; visibility?: WorkerVisibility } = {},
  ): LibraryItem[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const visible = new Set(roster.filter((w) => canSee(policy, roster, w.id, caller)).map((w) => w.id));
    const byId = new Map(roster.map((w) => [w.id, w]));
    const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const linksIn = (s: string) => [...new Set(s.match(/https?:\/\/[^\s<>)"'\]]+/g) ?? [])].slice(0, 10);
    const seenBy = (workerId: string): { visibility: WorkerVisibility; visibleTo: string } => {
      const v = byId.get(workerId)?.visibility ?? 'private';
      return { visibility: v, visibleTo: VISIBLE_TO[v] };
    };
    const deliverables = this.deliverableList();

    const fromEvents: LibraryItem[] = deliverables
      .filter((d) => d.status !== 'skipped' && visible.has(d.workerId))
      .map((d) => ({
        id: d.id,
        kind: 'event',
        origin: {
          kind: 'event',
          ...(d.source.triggerId ? { triggerId: d.source.triggerId } : {}),
          triggerName: d.source.triggerName || (d.source.kind === 'ask' ? 'A question' : `A ${d.source.kind} event`),
          workerId: d.workerId,
          workerName: d.workerName,
        },
        ...seenBy(d.workerId),
        workerId: d.workerId,
        workerName: d.workerName,
        at: d.doneAt ?? d.at,
        title: d.title,
        status: d.status,
        ...(d.result ? { body: d.result } : {}),
        ...(d.error ? { error: d.error } : {}),
        links: d.links,
        deliveredTo: d.deliveredTo,
        source: d.source,
        ...(d.doneAt ? { minutes: Math.max(0.1, Math.round(((d.doneAt - d.at) / 60_000) * 10) / 10) } : {}),
        ...(d.rating ? { rating: d.rating } : {}),
      }));

    // What each run's start looks like on record: its batch, the question
    // or trigger behind an errand, the shift that planned it.
    const workers = roster.filter((w) => visible.has(w.id));
    const runs = new Map(this.deps.runs.listRuns().map((r) => [r.id, r]));
    const batches = new Map((this.deps.batches?.list() ?? []).map((b) => [b.id, b]));
    const batchFor = (id: string | undefined) => (id ? (batches.get(id) ?? this.deps.orchestration?.(id) ?? undefined) : undefined);
    const asks = this.allAsks();
    const askByBatch = new Map(asks.filter((a) => a.orchestrationId).map((a) => [a.orchestrationId!, a]));
    const triggerByAsk = new Map(deliverables.filter((d) => d.askId).map((d) => [d.askId!, d]));
    const entries = new Map<string, WorkerJournalEntry>();
    const shiftByBatch = new Map<string, WorkerJournalEntry>();
    for (const w of workers) {
      for (const e of this.deps.workers.journalFor(w.id)) {
        if (e.kind === 'completed') entries.set(e.id, e);
        else if (e.kind === 'shift' && e.orchestrationId) shiftByBatch.set(e.orchestrationId, e);
      }
    }
    // Run now pressed before the journal carried `manual`: the audit says so.
    const pressed = (this.deps.audit?.recent(5000) ?? []).filter((e) => /^Started a run of .+ now\.$/.test(e.what));
    const manualShift = (e: WorkerJournalEntry, workerName: string) => !!e.manual || pressed.some((p) => p.what === `Started a run of ${workerName} now.` && Math.abs(p.at - e.at) < 5000);
    const howFor = (run: FlowRun | undefined, entry: WorkerJournalEntry | undefined, workerName: string): Pick<Extract<LibraryOrigin, { kind: 'run' }>, 'how' | 'triggerName'> => {
      const batchId = run?.parentOrchestrationId ?? entry?.orchestrationId;
      const a = batchId ? askByBatch.get(batchId) : undefined;
      if (a) return a.via === 'trigger' ? { how: 'trigger', triggerName: triggerByAsk.get(a.id)?.source.triggerName || a.by } : { how: 'asked' };
      const o = batchFor(batchId)?.origin;
      if (o?.kind === 'worker') {
        if (o.task === 'errand') return { how: 'asked' };
        const shift = shiftByBatch.get(o.wrapUpOf ?? batchId!);
        return { how: shift && manualShift(shift, workerName) ? 'runNow' : 'schedule' };
      }
      if (o?.kind === 'schedule' || run?.scheduleId) return { how: 'schedule' };
      // The batch is gone, but the shift that planned it is on record.
      const shift = batchId ? shiftByBatch.get(batchId) : undefined;
      if (shift) return { how: manualShift(shift, workerName) ? 'runNow' : 'schedule' };
      return { how: 'other' };
    };

    // Team tasks: who can see each, and which runs and batches are pieces of one.
    const teamsSeen = new Set(this.teams(caller, { disbanded: true }).map((t) => t.id));
    const teamData = this.deps.teams?.list() ?? { teams: [], tasks: [] };
    const taskById = new Map(teamData.tasks.map((t) => [t.id, t]));
    const pieceRuns = new Set<string>();
    const pieceBatches = new Set<string>();
    for (const t of teamData.tasks) {
      for (const s of t.stages) {
        for (const a of s.assignments ?? []) {
          if (a.runId) pieceRuns.add(a.runId);
          if (a.orchestrationId) pieceBatches.add(a.orchestrationId);
        }
      }
    }
    const isPiece = (run: FlowRun | undefined, runId: string | undefined, entry: WorkerJournalEntry | undefined) => {
      if (run?.team || (runId && pieceRuns.has(runId))) return true;
      const batchId = run?.parentOrchestrationId ?? entry?.orchestrationId;
      if (!batchId) return false;
      if (pieceBatches.has(batchId)) return true;
      const o = batchFor(batchId)?.origin;
      return o?.kind === 'worker' && !!o.team;
    };
    const teamSeenBy = (teamId: string, teamName: string): { visibility: WorkerVisibility; visibleTo: string } => {
      const team = teamData.teams.find((t) => t.id === teamId);
      // Anyone who can see one member sees the team: one open to everyone
      // opens the whole team.
      return team?.members.some((m) => byId.get(m.workerId)?.visibility === 'org')
        ? { visibility: 'org', visibleTo: VISIBLE_TO.org }
        : { visibility: 'team', visibleTo: `${teamName}’s managers` };
    };
    const taskTitle = (t: TeamTask) => t.title?.trim() || t.brief.trim().split('\n')[0].slice(0, 120) || 'A team task';

    const fromWork: LibraryItem[] = this.workItems(workers, 0, 300)
      .filter((x) => {
        const entry = entries.get(x.entryId);
        return !isPiece(x.runId ? runs.get(x.runId) : undefined, x.runId, entry);
      })
      .map((x) => {
        const run = x.runId ? runs.get(x.runId) : undefined;
        const flowName = run?.flowSnapshot?.name;
        return {
          id: x.entryId,
          kind: 'work',
          origin: {
            kind: 'run',
            ...(x.runId ? { runId: x.runId } : {}),
            workerId: x.workerId,
            workerName: x.workerName,
            ...howFor(run, entries.get(x.entryId), x.workerName),
            ...(flowName ? { flowName } : {}),
          },
          ...seenBy(x.workerId),
          workerId: x.workerId,
          workerName: x.workerName,
          at: x.at,
          title: x.title,
          status: 'delivered',
          ...(x.runId ? { runId: x.runId } : {}),
          ...(x.body || x.summary ? { body: x.body || x.summary } : {}),
          links: linksIn(x.body || x.summary || ''),
          deliveredTo: [],
          source: { kind: 'ask' as const },
          ...(x.rating ? { rating: { useful: x.rating.useful, by: x.rating.by } } : {}),
        };
      });

    // Errands answered — a trigger's answer is its event item already.
    const fromAnswers: LibraryItem[] = asks
      .filter((a) => a.status === 'answered' && a.reply && a.via !== 'trigger' && this.maySeeAsk(caller, a))
      .map((a) => {
        const name = byId.get(a.workerId)?.name ?? a.workerName;
        const question = a.text.trim();
        return {
          id: `ask:${a.id}`,
          kind: 'answer',
          origin: {
            kind: 'errand',
            askId: a.id,
            workerId: a.workerId,
            workerName: name,
            askedBy: a.by,
            question,
            ...(a.via === 'console' || a.via === 'slack' || a.via === 'mcp' ? { via: a.via } : {}),
          },
          // An answer is for whoever asked and the worker's manager, whatever
          // the worker's own setting.
          visibility: 'private',
          visibleTo: 'Who asked and its manager',
          workerId: a.workerId,
          workerName: name,
          at: a.doneAt ?? a.at,
          title: question.length > 120 ? `${question.slice(0, 119).trimEnd()}…` : question,
          status: 'delivered',
          body: a.reply!,
          links: linksIn(a.reply!),
          deliveredTo: [],
          source: { kind: 'ask' as const },
          ...(a.doneAt ? { minutes: Math.max(0.1, Math.round(((a.doneAt - a.at) / 60_000) * 10) / 10) } : {}),
        };
      });

    const fromTasks: LibraryItem[] = teamData.tasks
      .filter((t) => teamsSeen.has(t.teamId) && (t.status === 'done' || t.status === 'review' || ((t.status === 'failed' || t.status === 'cancelled') && !!t.pack)))
      .map((t) => {
        const origins = this.fileOrigins(t);
        const packFiles = t.pack?.files ?? [];
        const inPack = new Set(packFiles);
        let workingFiles = 0;
        try {
          workingFiles = t.folder ? listFolder(t.folder).filter((f) => !inPack.has(f.name)).length : 0;
        } catch {
          workingFiles = 0;
        }
        const title = taskTitle(t);
        const body = t.pack?.summary ?? '';
        return {
          id: `task:${t.id}`,
          kind: 'task',
          origin: { kind: 'task', teamId: t.teamId, teamName: t.teamName, taskId: t.id, taskTitle: title },
          ...teamSeenBy(t.teamId, t.teamName),
          pack: { files: packFiles.map((name) => ({ name, writtenBy: origins.get(name)?.writtenBy?.name ?? null })) },
          workingFiles,
          workerId: '',
          workerName: t.teamName,
          at: t.finishedAt ?? t.pack?.updatedAt ?? t.updatedAt,
          title,
          status: t.status === 'done' || t.status === 'review' ? 'delivered' : 'failed',
          ...(body ? { body } : {}),
          ...(t.error && t.status !== 'done' && t.status !== 'review' ? { error: t.error } : {}),
          links: linksIn(body),
          deliveredTo: [],
          source: { kind: 'team' as const, teamId: t.teamId, teamName: t.teamName, taskId: t.id },
        };
      });

    const ratings = this.ratingsByEntry();
    const fromFiles: LibraryItem[] = this.keptFiles()
      .filter((k) => teamsSeen.has(k.teamId))
      .map((k) => {
        const r = ratings.get(`file:${k.id}`);
        const task = taskById.get(k.taskId);
        const stage = task ? this.fileOrigins(task).get(k.name)?.stage : undefined;
        return {
          id: `file:${k.id}`,
          kind: 'file',
          origin: { kind: 'task', teamId: k.teamId, teamName: k.teamName, taskId: k.taskId, taskTitle: task ? taskTitle(task) : k.teamName, ...(stage ? { stage } : {}) },
          ...teamSeenBy(k.teamId, k.teamName),
          workerId: k.writer?.workerId ?? '',
          workerName: k.writer?.name ?? k.teamName,
          at: k.at,
          title: k.title,
          status: 'delivered',
          ...(k.body ? { body: k.body } : {}),
          links: linksIn(k.body),
          deliveredTo: [],
          source: { kind: 'team' as const, teamId: k.teamId, teamName: k.teamName, taskId: k.taskId, file: k.name },
          ...(r ? { rating: { useful: r.useful, by: r.by } } : {}),
        };
      });
    return [...fromEvents, ...fromWork, ...fromAnswers, ...fromTasks, ...fromFiles]
      .filter((x) => !opts.workerId || x.workerId === opts.workerId)
      .filter((x) => !opts.kind || x.kind === opts.kind)
      .filter((x) => !opts.visibility || x.visibility === opts.visibility)
      .filter((x) => words.every((w) => `${x.title} ${x.workerName} ${x.body ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.min(500, opts.limit ?? 200));
  }

  /// One Library item in full. The list carries a preview (a run's report is
  /// cut at 6,000 characters there); reading it fetches the whole thing.
  libraryItem(caller: OrgCaller, id: string): Result<{ item: LibraryItem }> {
    const item = this.library(caller, { limit: 500 }).find((x) => x.id === id);
    if (!item) return { ok: false, error: 'Nothing in the Library by that id that you can see.' };
    if (item.kind === 'work' && item.runId) {
      const run = this.deps.runs.getRun(item.runId);
      const full = run ? OrgService.newestArtifact(run) : undefined;
      if (full) return { ok: true, item: { ...item, body: full.body.slice(0, 500_000) } };
    }
    return { ok: true, item };
  }

  rateDeliverable(caller: OrgCaller, id: string, useful: boolean): Result {
    const s = this.triggerSvc();
    const d = this.deliverableList().find((x) => x.id === id);
    if (!s || !d) return { ok: false, error: 'Nothing by that id.' };
    if (!canSee(this.policy(), this.deps.workers.roster(), d.workerId, caller)) return { ok: false, error: 'Nothing by that id.' };
    s.rate(id, useful, caller.name);
    this.record(caller, `Rated ${d.workerName}'s "${d.title}" ${useful ? 'useful' : 'not useful'}.`);
    return { ok: true };
  }

  /// What a worker delivered on events this month: the number the org pays for.
  workerValue(workerId: string): WorkerValue | null {
    const s = this.triggerSvc();
    if (!s) return null;
    const start = new Date(this.now());
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const st = s.stats(workerId, start.getTime());
    const spent = this.deps.workers.spentThisMonth().get(workerId) ?? 0;
    return { ...st, spentUSD: spent, costPerItemUSD: st.handled ? Math.round((spent / st.handled) * 100) / 100 : null };
  }

  /// One question, for whoever asked it, the worker's manager, or an admin.
  askStatus(caller: OrgCaller, askId: string): Result<{ ask: AskRecord }> {
    const ask = this.allAsks().find((a) => a.id === askId);
    if (!ask || !this.maySeeAsk(caller, ask)) return { ok: false, error: 'No question by that id that you can see.' };
    return { ok: true, ask };
  }

  private maySeeAsk(caller: OrgCaller, ask: AskRecord): boolean {
    const mine = caller.slackUserId ? ask.slackUserId === caller.slackUserId : ask.by === caller.name;
    return mine || canManage(this.policy(), this.deps.workers.roster(), ask.workerId, caller);
  }

  // ---- MANAGE -----------------------------------------------------------

  private managed(caller: OrgCaller, idOrName: string): Result<{ worker: Worker }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    if (!canManage(this.policy(), this.deps.workers.roster(), w.id, caller)) {
      return { ok: false, error: `Only ${w.name}'s manager or an admin can change it.` };
    }
    return { ok: true, worker: w };
  }

  update(
    caller: OrgCaller,
    idOrName: string,
    patch: {
      manager?: { name: string; slackUserId?: string } | null;
      reportsTo?: string | null;
      visibility?: WorkerVisibility;
      budgetUSDPerMonth?: number;
      cadence?: ScheduleTrigger | null;
      jobDescription?: string;
      /// The MCP servers it may use, by name.
      mcpServers?: string[];
      /// How much of each it may use, by tool name: `{ mode: 'read' }`,
      /// `{ mode: 'only', calls }`, or null for the whole tool again.
      toolScopes?: Record<string, unknown>;
      /// Its picture: an https image link, or null for initials again.
      avatarUrl?: string | null;
    },
  ): Result<{ worker: WorkerSummary }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const w = found.worker;
    const policy = this.policy();
    const admin = isAdmin(policy, caller);
    const next: Worker = structuredClone(w);
    if (patch.manager !== undefined) {
      // Handing a worker (and its budget) to someone else is an admin's call;
      // a manager may only make themselves its direct manager.
      const toSelf = patch.manager !== null && !!caller.slackUserId && patch.manager.slackUserId === caller.slackUserId;
      if (!admin && !toSelf) return { ok: false, error: 'Only an admin can hand a worker to someone else. Ask an admin.' };
      if (patch.manager === null) delete next.manager;
      else next.manager = { name: patch.manager.name, ...(patch.manager.slackUserId ? { slackUserId: patch.manager.slackUserId } : {}) };
    }
    if (patch.reportsTo !== undefined) {
      if (patch.reportsTo === null) delete next.reportsTo;
      else {
        const boss = this.resolve(caller, patch.reportsTo);
        if (!boss) return { ok: false, error: 'No worker by that name to report to.' };
        next.reportsTo = boss.id;
      }
    }
    if (patch.visibility !== undefined) {
      if (patch.visibility === 'org' && policy.orgVisibilityNeedsAdmin && !admin && w.visibility !== 'org') {
        return { ok: false, error: 'Making a worker visible to the whole org needs an admin.' };
      }
      if (patch.visibility === 'private') delete next.visibility;
      else next.visibility = patch.visibility;
    }
    if (patch.budgetUSDPerMonth !== undefined) {
      if (!Number.isFinite(patch.budgetUSDPerMonth) || patch.budgetUSDPerMonth <= 0) {
        return { ok: false, error: 'A budget must be above zero.' };
      }
      // A raise counts against the allowance of whoever answers for the
      // worker — directly or up the chain — the same rule a hire meets.
      const roster = this.deps.workers.roster().map((x) => (x.id === w.id ? next : x));
      const owner = managerFor(roster, w.id)?.slackUserId ?? caller.slackUserId;
      if (!admin && patch.budgetUSDPerMonth > w.budgetUSDPerMonth) {
        if (!owner) return { ok: false, error: 'Raising a budget needs an admin.' };
        const after = committedBudget(roster.filter((x) => x.id !== w.id), owner) + patch.budgetUSDPerMonth;
        if (after > allowanceFor(policy, owner)) {
          return { ok: false, error: `That takes this manager's workers to $${after.toFixed(0)}/month, over the allowance. Ask an admin.` };
        }
      }
      next.budgetUSDPerMonth = patch.budgetUSDPerMonth;
    }
    if (patch.cadence !== undefined) next.cadence = patch.cadence;
    if (patch.avatarUrl !== undefined) {
      if (patch.avatarUrl === null || !patch.avatarUrl.trim()) delete next.avatarUrl;
      else next.avatarUrl = patch.avatarUrl.trim().slice(0, 500);
    }
    if (patch.mcpServers !== undefined) {
      const names = [...new Set((Array.isArray(patch.mcpServers) ? patch.mcpServers : []).map(String))];
      if (names.some((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n))) return { ok: false, error: 'A tool name is letters, digits, dashes and underscores.' };
      // A tool reaches outside the server with the org's keys: a manager may
      // give one the org allows any hire; anything else is an admin's call.
      const added = names.filter((n) => !(w.mcpServers ?? []).includes(n));
      const allowed = new Set(policy.allowedMcpServers ?? []);
      const notAllowed = added.filter((n) => !allowed.has(n));
      if (notAllowed.length && !admin) return { ok: false, error: `Giving ${notAllowed.join(', ')} to a worker needs an admin.` };
      if (names.length) next.mcpServers = names;
      else delete next.mcpServers;
    }
    if (patch.toolScopes !== undefined) {
      const raw = patch.toolScopes && typeof patch.toolScopes === 'object' ? patch.toolScopes : {};
      const scopes: ToolScopes = { ...(w.toolScopes ?? {}) };
      const defaults = policy.toolDefaults ?? {};
      for (const [name, value] of Object.entries(raw)) {
        if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(name)) return { ok: false, error: 'A tool name is letters, digits, spaces, dots, dashes and underscores.' };
        // null: the tool's default again, which an admin already settled.
        if (value === null) {
          delete scopes[name];
          continue;
        }
        const scope = parseToolScope(value);
        if (!scope) return { ok: false, error: `The scope for ${name} is the whole tool, read only, or a list of calls.` };
        // Narrower than the org's default is any manager's call; wider is an admin's.
        if (!admin && !withinScope(scope, defaults[name], name)) return { ok: false, error: `That gives ${w.name} more of ${name} than the org's default. An admin can.` };
        // The whole tool with no default is just the default.
        if (scope.mode === 'full' && !defaults[name]) delete scopes[name];
        else scopes[name] = scope;
      }
      if (Object.keys(scopes).length) next.toolScopes = scopes;
      else delete next.toolScopes;
    }
    if (patch.jobDescription !== undefined) {
      const job = String(patch.jobDescription).trim();
      if (job.length < 20) return { ok: false, error: 'Describe the job in a sentence or more.' };
      if (job.length > 20_000) return { ok: false, error: 'That job description is too long.' };
      next.jobDescription = job;
    }
    const invalid = validateOrgFields(next);
    if (invalid) return { ok: false, error: invalid };
    const saved = this.deps.workers.save(next);
    if (!saved.ok) return saved;
    this.record(caller, `Changed ${w.name}: ${Object.keys(patch).join(', ')}.`);
    // Re-read through the caller's eyes: moving a worker to another manager
    // can take it out of the caller's sight.
    const summary = this.listWorkers(caller).find((s) => s.id === w.id);
    if (!summary) return { ok: true, worker: { ...this.listWorkers({ name: 'admin', admin: true }).find((s) => s.id === w.id)!, youManage: false } };
    return { ok: true, worker: summary };
  }

  /// Someone is leaving: every worker they manage directly, and every hire
  /// they have in progress, goes to `to`. Workers under those come along,
  /// since they answer through their boss.
  handOverAll(caller: OrgCaller, fromSlackUserId: string, to: { name: string; slackUserId: string }): Result<{ workers: string[]; hires: number }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can hand someone\'s workers on.' };
    if (!isSlackUserId(to.slackUserId) || !to.name.trim()) return { ok: false, error: 'Pick who takes the workers over.' };
    if (to.slackUserId === fromSlackUserId) return { ok: false, error: 'Pick someone else to take them over.' };
    const moved: string[] = [];
    for (const w of this.deps.workers.roster()) {
      if (w.manager?.slackUserId !== fromSlackUserId) continue;
      const saved = this.deps.workers.save({ ...structuredClone(w), manager: { name: to.name.trim(), slackUserId: to.slackUserId } });
      if (!saved.ok) return { ok: false, error: `Could not hand over ${w.name}: ${saved.error}` };
      moved.push(w.name);
    }
    const hires = this.deps.hires.list();
    const theirs = hires.filter((h) => h.requestedBy.slackUserId === fromSlackUserId);
    if (theirs.length) this.deps.hires.save(hires.filter((h) => h.requestedBy.slackUserId !== fromSlackUserId));
    this.record(caller, `Handed ${moved.length ? moved.join(', ') : 'no workers'} from ${fromSlackUserId} to ${to.name}${theirs.length ? `, and dropped ${theirs.length} hire${theirs.length === 1 ? '' : 's'} in progress` : ''}.`);
    return { ok: true, workers: moved, hires: theirs.length };
  }

  setPaused(caller: OrgCaller, idOrName: string, paused: boolean): Result<{ name: string }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const res = this.deps.workers.setEnabled(found.worker.id, !paused);
    if (res.ok) this.record(caller, `${paused ? 'Paused' : 'Resumed'} ${found.worker.name}.`);
    return res.ok ? { ok: true, name: found.worker.name } : res;
  }

  retire(caller: OrgCaller, idOrName: string): Result<{ name: string }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const res = this.deps.workers.remove(found.worker.id);
    if (res.ok) this.record(caller, `Let ${found.worker.name} go.`);
    return res.ok ? { ok: true, name: found.worker.name } : res;
  }

  // ---- HIRE -------------------------------------------------------------

  private hire(id: string): PendingHire | undefined {
    return this.deps.hires.list().find((h) => h.id === id);
  }

  private putHire(hire: PendingHire | null, removeId?: string): void {
    const rest = this.deps.hires.list().filter((h) => h.id !== (hire?.id ?? removeId));
    this.deps.hires.save(hire ? [...rest, hire] : rest);
  }

  summarize(hire: PendingHire): HireSummary {
    if (hire.imported) {
      const i = hire.imported;
      return {
        hireId: hire.id,
        status: hire.status,
        requestedBy: hire.requestedBy.name,
        contract: {
          name: i.name,
          ...(i.tagline ? { tagline: i.tagline } : {}),
          jobDescription: i.jobDescription,
          budgetUSDPerMonth: hire.options.budgetUSDPerMonth ?? i.budgetUSDPerMonth,
          flows: i.flows,
          connectors: i.mcpServers,
          cadence: hire.options.cadence !== undefined ? hire.options.cadence : i.cadence,
          schedule: scheduleText(hire.options.cadence !== undefined ? hire.options.cadence : i.cadence),
          ...(hire.options.projectPath ? { projectPath: hire.options.projectPath } : {}),
        },
        ...(hire.reasons ? { reasons: hire.reasons } : {}),
      };
    }
    const c = hire.drafted?.contract;
    const flows = hire.drafted?.flowPlan.map((p) => p.flow?.name ?? p.flowId) ?? [];
    return {
      hireId: hire.id,
      status: hire.status,
      requestedBy: hire.requestedBy.name,
      ...(hire.questions?.length && !c ? { questions: hire.questions } : {}),
      ...(c
        ? {
            contract: {
              name: c.name,
              ...(c.tagline ? { tagline: c.tagline } : {}),
              jobDescription: c.jobDescription,
              budgetUSDPerMonth: hire.options.budgetUSDPerMonth ?? c.budgetUSDPerMonth,
              flows,
              connectors: c.mcpServers ?? [],
              cadence: hire.options.cadence !== undefined ? hire.options.cadence : c.cadence,
              schedule: scheduleText(hire.options.cadence !== undefined ? hire.options.cadence : c.cadence),
              ...(hire.options.projectPath ?? c.projectPath ? { projectPath: hire.options.projectPath ?? c.projectPath } : {}),
              visibility: hire.options.visibility ?? 'private',
              ...(hire.options.reportsTo ? { reportsTo: this.deps.workers.get(hire.options.reportsTo)?.name ?? hire.options.reportsTo } : {}),
            },
          }
        : {}),
      ...(hire.reasons ? { reasons: hire.reasons } : {}),
      ...this.alreadyDoes(hire),
    };
  }

  private alreadyDoes(hire: PendingHire): { alreadyDoes?: HireSummary['alreadyDoes'] } {
    const w = hire.overlap && this.deps.workers.get(hire.overlap.workerId);
    return w ? { alreadyDoes: { workerId: w.id, name: w.name, ...(w.tagline ? { tagline: w.tagline } : {}), why: hire.overlap!.why } } : {};
  }

  /// Start a hire, or continue one the drafter asked questions about. Nothing
  /// is hired here: the caller reads the contract and confirms.
  async draftHire(
    caller: OrgCaller,
    args: { jobDescription?: string; hireId?: string; answer?: string; options?: HireOptions; skipQuestions?: boolean },
  ): Promise<Result<{ hire: HireSummary }>> {
    // Checked before the model turn, so a refusal costs nothing.
    if (!canHire(this.policy(), caller)) {
      return { ok: false, error: 'You are not on the list of people who may hire workers. Ask an admin to add you to the org policy.' };
    }
    let hire: PendingHire;
    if (args.hireId) {
      const existing = this.hire(args.hireId);
      if (!existing || existing.status !== 'drafted') return { ok: false, error: 'No hire in progress with that id.' };
      if (!this.mayTouchHire(caller, existing)) return { ok: false, error: 'That hire belongs to someone else.' };
      hire = existing;
      if (args.answer?.trim()) {
        const asked = (hire.questions ?? []).join('\n');
        hire.conversation = [
          ...hire.conversation,
          ...(asked ? [{ role: 'assistant' as const, text: asked }] : []),
          { role: 'user' as const, text: args.answer.trim() },
        ];
      }
      if (args.options) hire.options = { ...hire.options, ...args.options };
    } else {
      const jobDescription = args.jobDescription?.trim() ?? '';
      if (jobDescription.length < 20) return { ok: false, error: 'Describe the job in a sentence or two — what it does, for whom, from which sources.' };
      hire = {
        id: randomUUID(),
        status: 'drafted',
        createdAt: this.now(),
        requestedBy: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) },
        jobDescription,
        conversation: [],
        options: args.options ?? {},
      };
    }
    // A new hire also asks whether someone already does this, at the same
    // time, so the answer costs no extra wait.
    const visible = !args.hireId && this.deps.overlap ? this.listWorkers(caller).filter((w) => w.enabled) : [];
    const roster = new Map(this.deps.workers.roster().map((w) => [w.id, w]));
    const [res, overlap] = await Promise.all([
      this.deps.draft({
        crew: this.deps.workers.workerNames(),
        jobDescription: hire.jobDescription,
        conversation: hire.conversation,
        interview: !args.skipQuestions,
      }),
      visible.length
        ? this.deps.overlap!(hire.jobDescription, visible.map((w) => ({ id: w.id, name: w.name, ...(w.tagline ? { tagline: w.tagline } : {}), job: roster.get(w.id)?.jobDescription ?? '' }))).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!res.ok) return res;
    if (overlap) hire.overlap = overlap;
    // The model turn takes minutes. A hire made, cancelled or sent for
    // approval meanwhile must not come back as a draft.
    if (args.hireId && this.hire(args.hireId)?.status !== 'drafted') {
      return { ok: false, error: 'That hire was settled while this was drafting.' };
    }
    if (res.kind === 'questions') {
      hire.questions = res.questions;
      delete hire.drafted;
    } else {
      delete hire.questions;
      hire.drafted = res.drafted;
    }
    this.putHire(hire);
    return { ok: true, hire: this.summarize(hire) };
  }

  /// Change an offer before it is accepted: its name, budget, who may ask
  /// it, its tools, where it works and who it reports to. Whatever changes,
  /// confirming weighs it against the policy again.
  editHire(
    caller: OrgCaller,
    hireId: string,
    patch: { name?: string; budgetUSDPerMonth?: number; visibility?: WorkerVisibility; mcpServers?: string[]; projectPath?: string | null; reportsTo?: string | null },
  ): Result<{ hire: HireSummary }> {
    const hire = this.hire(hireId);
    if (!hire) return { ok: false, error: 'No hire in progress with that id — drafts expire after a day.' };
    if (!this.mayTouchHire(caller, hire)) return { ok: false, error: 'That hire belongs to someone else.' };
    if (hire.status !== 'drafted') return { ok: false, error: 'That hire is already waiting on an approver.' };
    const contract = hire.drafted?.contract;
    if (!contract && !hire.imported) return { ok: false, error: 'The drafter still has questions — answer them first.' };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 40) return { ok: false, error: 'A name is 1 to 40 characters.' };
      const taken = this.deps.workers.roster().some((w) => w.name.trim().toLowerCase() === name.toLowerCase());
      if (taken) return { ok: false, error: `There’s already a worker called ${name}.` };
      if (contract) contract.name = name;
      else hire.imported!.name = name;
    }
    if (patch.budgetUSDPerMonth !== undefined) {
      const b = patch.budgetUSDPerMonth;
      if (!Number.isFinite(b) || b < 1 || b > 10_000) return { ok: false, error: 'A monthly budget is between $1 and $10,000.' };
      hire.options.budgetUSDPerMonth = Math.round(b);
    }
    if (patch.visibility !== undefined) hire.options.visibility = patch.visibility;
    if (patch.mcpServers !== undefined) {
      const installed = new Set(this.deps.tools?.list([]).tools.map((t) => t.name) ?? []);
      const unknown = patch.mcpServers.find((n) => !installed.has(n));
      if (unknown) return { ok: false, error: `${unknown} isn’t installed on this server.` };
      if (contract) contract.mcpServers = [...patch.mcpServers];
      else hire.imported!.mcpServers = [...patch.mcpServers];
    }
    if (patch.projectPath !== undefined) {
      if (patch.projectPath === null) delete hire.options.projectPath;
      else hire.options.projectPath = patch.projectPath;
    }
    if (patch.reportsTo !== undefined) {
      if (patch.reportsTo === null) delete hire.options.reportsTo;
      else {
        const boss = this.resolve(caller, patch.reportsTo);
        if (!boss) return { ok: false, error: 'No worker by that name to report to.' };
        hire.options.reportsTo = boss.id;
      }
    }
    this.putHire(hire);
    return { ok: true, hire: this.summarize(hire) };
  }

  /// Drop a hire in progress: a draft the person decided against, or one
  /// waiting on an approver they no longer want.
  cancelHire(caller: OrgCaller, hireId: string): Result {
    const hire = this.deps.hires.list().find((h) => h.id === hireId);
    if (!hire) return { ok: true };
    if (!this.mayTouchHire(caller, hire)) return { ok: false, error: 'That hire belongs to someone else.' };
    this.putHire(null, hireId);
    this.record(caller, `Cancelled the hire of ${this.summarize(hire).contract?.name ?? 'a worker'}.`);
    return { ok: true };
  }

  private mayTouchHire(caller: OrgCaller, hire: PendingHire): boolean {
    if (isAdmin(this.policy(), caller)) return true;
    return !!caller.slackUserId && caller.slackUserId === hire.requestedBy.slackUserId;
  }

  /// Hire it — now, or once an approver says yes.
  confirmHire(caller: OrgCaller, hireId: string, options?: HireOptions): Result<{ hired?: WorkerSummary; hire: HireSummary }> {
    const hire = this.hire(hireId);
    if (!hire) return { ok: false, error: 'No hire in progress with that id — drafts expire after a day.' };
    if (!this.mayTouchHire(caller, hire)) return { ok: false, error: 'That hire belongs to someone else.' };
    if (hire.status !== 'drafted') return { ok: false, error: 'That hire is already waiting on an approver.' };
    if (!hire.drafted && !hire.imported) return { ok: false, error: 'The drafter still has questions — answer them first.' };
    if (options) hire.options = { ...hire.options, ...options };
    if (hire.options.reportsTo) {
      const boss = this.resolve(caller, hire.options.reportsTo);
      if (!boss) return { ok: false, error: 'No worker by that name to report to.' };
      hire.options.reportsTo = boss.id;
    }
    const contract = hire.imported
      ? { name: hire.imported.name, budgetUSDPerMonth: hire.imported.budgetUSDPerMonth, mcpServers: hire.imported.mcpServers }
      : hire.drafted!.contract;
    const budget = hire.options.budgetUSDPerMonth ?? contract.budgetUSDPerMonth;
    const decision = hireDecision(this.policy(), this.deps.workers.roster(), caller, {
      budgetUSDPerMonth: budget,
      visibility: hire.options.visibility,
      mcpServers: contract.mcpServers,
      role: hire.role,
    });
    if (decision.kind === 'refused') return { ok: false, error: decision.reason };
    if (decision.kind === 'needsApproval') {
      const approvers = approversFor(this.policy());
      if (approvers.length === 0) {
        return { ok: false, error: `${decision.reasons.join(' ')} Nobody is set up to approve hires — ask an admin to add approvers to the org policy.` };
      }
      hire.status = 'awaitingApproval';
      hire.reasons = decision.reasons;
      this.putHire(hire);
      this.deps.onHireAwaitingApproval?.(hire, approvers);
      this.record(caller, `Asked to hire ${contract.name} ($${budget}/month); sent for approval.`);
      return { ok: true, hire: this.summarize(hire) };
    }
    // Allowed outright: connectors only as far as the policy clears them.
    const clearedList = [...(this.policy().allowedMcpServers ?? []), ...(hire.role?.tools ?? [])];
    const cleared = (contract.mcpServers ?? []).filter((s) => clearedList.includes(s));
    const made = this.make(hire, cleared);
    if (!made.ok) return made;
    this.record(caller, `Hired ${made.worker.name} ($${made.worker.budgetUSDPerMonth}/month).`);
    return { ok: true, hired: made.summary, hire: this.summarize(hire) };
  }

  private make(hire: PendingHire, mcpServers: string[]): Result<{ worker: Worker; summary: WorkerSummary }> {
    const by = hire.requestedBy;
    if (hire.imported) {
      if (!this.deps.importWorker) return { ok: false, error: 'This server cannot take published workers.' };
      const landed = this.deps.importWorker(hire.imported.yaml, {
        projectPath: hire.options.projectPath,
        mcpServers,
        extra: {
          manager: { name: by.name, ...(by.slackUserId ? { slackUserId: by.slackUserId } : {}) },
          ...(hire.options.reportsTo ? { reportsTo: hire.options.reportsTo } : {}),
          ...(hire.options.visibility && hire.options.visibility !== 'private' ? { visibility: hire.options.visibility } : {}),
        },
      });
      if (!landed.ok) return landed;
      this.putHire(null, hire.id);
      if (hire.imported.localId) this.landedPublished(hire.imported.localId, hire.id, landed.worker.id);
      const summary = this.listWorkers({ name: 'admin', admin: true }).find((s) => s.id === landed.worker.id)!;
      return { ok: true, worker: landed.worker, summary };
    }
    const saved = this.deps.saveHire(hire.drafted!, {
      projectPath: hire.options.projectPath,
      mcpServers,
      budgetUSDPerMonth: hire.options.budgetUSDPerMonth,
      cadence: hire.options.cadence !== undefined ? hire.options.cadence : hire.drafted!.contract.cadence,
      extra: {
        manager: { name: by.name, ...(by.slackUserId ? { slackUserId: by.slackUserId } : {}) },
        ...(hire.options.reportsTo ? { reportsTo: hire.options.reportsTo } : {}),
        ...(hire.options.visibility && hire.options.visibility !== 'private' ? { visibility: hire.options.visibility } : {}),
      },
    });
    if (!saved.ok) return saved;
    this.putHire(null, hire.id);
    // Its face, picked while it settles in: nobody waits on it.
    void this.choosePicture(saved.worker.id);
    const summary = this.listWorkers({ name: 'admin', admin: true }).find((s) => s.id === saved.worker.id)!;
    return { ok: true, worker: saved.worker, summary };
  }

  /// Pick a picture for a worker that has none (`force`: replace the one
  /// it has), unlike any other worker's. The link, or null if nothing suited.
  async choosePicture(id: UUID, force = false): Promise<string | null> {
    const w = this.deps.workers.get(id);
    if (!w || (w.avatarUrl && !force) || !this.deps.pickPicture) return null;
    const taken = this.deps.workers.roster().flatMap((x) => (x.avatarUrl ? [x.avatarUrl] : []));
    const url = await this.deps.pickPicture({ name: w.name, job: w.jobDescription, ...(w.tagline ? { tagline: w.tagline } : {}) }, taken).catch(() => null);
    const fresh = this.deps.workers.get(id);
    // Someone picked one while it looked: theirs stands.
    if (!url || !fresh || (fresh.avatarUrl && fresh.avatarUrl !== w.avatarUrl)) return null;
    this.deps.workers.save({ ...fresh, avatarUrl: url });
    return url;
  }

  /// The Slack thread a piece of work came from, and who asked there: so
  /// what it needs (an OK, an answer) is asked in that thread, not as a new
  /// message beside it. By its batch, or by a run one of its items started.
  slackThreadFor(ref: { orchestrationId?: UUID; runId?: UUID }): { channel: string; threadTs: string; slackUserId?: string } | null {
    let batchId = ref.orchestrationId;
    if (!batchId && ref.runId) {
      batchId = this.allAsks().map((a) => a.orchestrationId).find((id) => !!id && !!this.deps.orchestration?.(id)?.items.some((i) => i.runId === ref.runId));
    }
    const ask = batchId ? this.allAsks().find((a) => a.orchestrationId === batchId && a.conversation?.startsWith('slack:')) : undefined;
    const m = ask?.conversation ? /^slack:([^:]+):(.+)$/.exec(ask.conversation) : null;
    return m ? { channel: m[1], threadTs: m[2], ...(ask!.slackUserId ? { slackUserId: ask!.slackUserId } : {}) } : null;
  }

  /// "Pick one for me", from the picture picker: for its manager.
  async pickWorkerPicture(caller: OrgCaller, idOrName: string): Promise<Result<{ avatarUrl: string }>> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.pickPicture) return { ok: false, error: 'Picking a picture isn’t available on this server.' };
    const url = await this.choosePicture(found.worker.id, true);
    return url ? { ok: true, avatarUrl: url } : { ok: false, error: 'Nothing suited it this time. Try again, or search for one.' };
  }

  /// An approver's yes or no on a hire over someone's allowance.
  decideHire(caller: OrgCaller, hireId: string, approve: boolean): Result<{ hired?: WorkerSummary }> {
    const hire = this.hire(hireId);
    if (!hire || hire.status !== 'awaitingApproval') return { ok: false, error: 'No hire waiting on approval with that id.' };
    const policy = this.policy();
    const approver = isAdmin(policy, caller) || (!!caller.slackUserId && approversFor(policy).includes(caller.slackUserId));
    if (!approver) return { ok: false, error: 'Only an approver or an admin can decide hires.' };
    if (caller.slackUserId && caller.slackUserId === hire.requestedBy.slackUserId && !isAdmin(policy, caller)) {
      return { ok: false, error: 'You cannot approve your own hire.' };
    }
    const name = hire.imported?.name ?? hire.drafted?.contract.name ?? 'a worker';
    if (!approve) {
      this.putHire(null, hire.id);
      this.deps.onHireDecided?.(hire, { approved: false, by: caller.name });
      this.record(caller, `Turned down ${hire.requestedBy.name}'s hire of ${name}.`);
      this.dropTeamsWaitingOn(caller, hire.id, name);
      return { ok: true };
    }
    this.record(caller, `Approved ${hire.requestedBy.name}'s hire of ${name}.`);
    // Approval covers what the approver was shown, connectors included.
    const made = this.make(hire, hire.imported?.mcpServers ?? hire.drafted?.contract.mcpServers ?? []);
    if (!made.ok) {
      this.deps.onHireDecided?.(hire, { approved: true, by: caller.name, error: made.error });
      return made;
    }
    this.deps.onHireDecided?.(hire, { approved: true, by: caller.name, worker: made.worker });
    if (hire.joinTeam) this.joinTeam(hire.joinTeam, made.worker, caller);
    return { ok: true, hired: made.summary };
  }

  /// Put a newly hired worker on the team it was hired for.
  private joinTeam(join: { teamId: UUID; role: string }, worker: Worker, caller: OrgCaller): void {
    const team = this.deps.teams?.list().teams.find((t) => t.id === join.teamId);
    if (!team || !this.deps.teams?.save) return;
    if (team.members.some((m) => m.workerId === worker.id) || team.members.length >= TEAM_MAX_MEMBERS) return;
    const saved = this.deps.teams.save({ ...team, members: [...team.members, { workerId: worker.id, role: join.role }] });
    this.record(caller, saved.ok ? `${worker.name} joined the team ${team.name}.` : `${worker.name} could not join the team ${team.name}: ${saved.error}`);
  }

  listHires(caller: OrgCaller): HireSummary[] {
    const policy = this.policy();
    const approver = isAdmin(policy, caller) || (!!caller.slackUserId && approversFor(policy).includes(caller.slackUserId));
    return this.deps.hires
      .list()
      .filter((h) => this.mayTouchHire(caller, h) || (approver && h.status === 'awaitingApproval'))
      .map((h) => this.summarize(h));
  }


  // ---- AUDIT ------------------------------------------------------------

  private record(caller: OrgCaller, what: string): void {
    const entry: AuditEntry = {
      at: this.now(),
      by: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      what,
    };
    this.deps.audit?.append(entry);
  }

  /// The decision log, newest first: the latest few for the Admin page, or a
  /// search by time, person and words for the full log and its export.
  auditLog(
    caller: OrgCaller,
    opts: number | { limit?: number; from?: number; to?: number; query?: string } = 50,
  ): Result<{ entries: AuditEntry[]; total: number }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can read the decision log.' };
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    const limit = Math.min(10_000, Math.max(1, o.limit ?? 50));
    const audit = this.deps.audit;
    if (!audit) return { ok: true, entries: [], total: 0 };
    if (!o.from && !o.to && !o.query) {
      const entries = audit.recent(limit);
      return { ok: true, entries, total: entries.length };
    }
    const words = (o.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = (audit.all?.() ?? audit.recent(10_000).reverse()).filter(
      (e) =>
        (!o.from || e.at >= o.from) &&
        (!o.to || e.at < o.to) &&
        words.every((w) => `${e.by} ${e.slackUserId ?? ''} ${e.what}`.toLowerCase().includes(w)),
    );
    return { ok: true, entries: all.slice(-limit).reverse(), total: all.length };
  }

  // ---- WORK -------------------------------------------------------------

  private ratingsByEntry(): Map<string, Rating> {
    const out = new Map<string, Rating>();
    for (const r of this.deps.ratings?.list() ?? []) out.set(r.entryId, r);
    return out;
  }

  /// Finished work since `sinceMs` and, when given, before `untilMs`.
  private workItems(workers: readonly Worker[], sinceMs: number, limit: number, untilMs?: number): WorkItem[] {
    const roster = this.deps.workers.roster();
    const ratings = this.ratingsByEntry();
    const runs = new Map(this.deps.runs.listRuns().map((r) => [r.id, r]));
    const items: WorkItem[] = [];
    for (const w of workers) {
      for (const e of this.deps.workers.journalFor(w.id)) {
        if (e.kind !== 'completed' || e.at < sinceMs || (untilMs != null && e.at >= untilMs)) continue;
        const run = e.runId ? runs.get(e.runId) : undefined;
        const rating = ratings.get(e.id);
        const manager = managerFor(roster, w.id);
        items.push({
          entryId: e.id,
          workerId: w.id,
          workerName: w.name,
          ...(manager ? { forManager: manager.name } : {}),
          title: e.title || run?.digest?.headline || (run ? flowRunTitle(run) : 'Finished work'),
          ...(run?.digest?.headline && run.digest.headline !== e.title ? { summary: run.digest.headline } : e.note ? { summary: e.note } : {}),
          at: e.at,
          ...(e.costUSD != null ? { costUSD: e.costUSD } : e.runId && this.deps.runCost?.(e.runId) != null ? { costUSD: this.deps.runCost(e.runId) } : {}),
          ...(e.runId ? { runId: e.runId } : {}),
          ...(rating ? { rating: { useful: rating.useful, by: rating.by, ...(rating.note ? { note: rating.note } : {}) } } : {}),
        });
      }
    }
    // A run that ended well but logged only a failed attempt (one it retried
    // past) has no 'completed' entry: list it from the run itself.
    const covered = new Set(items.map((x) => x.runId).filter(Boolean));
    const byWorker = new Map(workers.map((w) => [w.id, w]));
    for (const r of runs.values()) {
      const w = r.workerId ? byWorker.get(r.workerId) : undefined;
      if (!w || covered.has(r.id) || r.state.kind !== 'done' || !r.state.success) continue;
      const at = OrgService.runEndedAt(r);
      if (at < sinceMs || (untilMs != null && at >= untilMs)) continue;
      const entryId = `run:${r.id}`;
      const rating = ratings.get(entryId);
      const manager = managerFor(roster, w.id);
      const answer = OrgService.newestArtifact(r);
      const cost = r.costUSD ?? this.deps.runCost?.(r.id);
      items.push({
        entryId,
        workerId: w.id,
        workerName: w.name,
        ...(manager ? { forManager: manager.name } : {}),
        title: r.digest?.headline || flowRunTitle(r),
        at,
        ...(cost != null ? { costUSD: cost } : {}),
        runId: r.id,
        ...(rating ? { rating: { useful: rating.useful, by: rating.by, ...(rating.note ? { note: rating.note } : {}) } } : {}),
        ...(answer ? { body: answer.body.slice(0, 6000) } : {}),
      });
    }
    return items.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /// Finished work from the workers the caller can see — or, with `mine`,
  /// only the ones they manage.
  work(caller: OrgCaller, opts: { mine?: boolean; days?: number; limit?: number } = {}): WorkItem[] {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const workers = roster.filter((w) =>
      opts.mine ? canManage(policy, roster, w.id, caller) && !(caller.admin && !managesDirectly(roster, w.id, caller)) : canSee(policy, roster, w.id, caller),
    );
    const days = Math.min(90, Math.max(1, opts.days ?? 14));
    return this.workItems(workers, this.now() - days * 86_400_000, Math.min(200, opts.limit ?? 60));
  }

  /// Useful or not, on one piece of finished work. It lands in the worker's
  /// journal as a note, so the next run it plans leans toward what was useful.
  rate(caller: OrgCaller, args: { entryId: string; useful: boolean; note?: string }): Result {
    if (args.entryId.startsWith('file:')) {
      // A team file kept in the Library: whoever can see the team may rate it.
      const kept = this.keptFiles().find((k) => `file:${k.id}` === args.entryId);
      if (!kept || !this.teams(caller, { disbanded: true }).some((t) => t.id === kept.teamId)) return { ok: false, error: 'No finished work with that id that you can see.' };
      const note = args.note?.trim().slice(0, 500);
      const rest = (this.deps.ratings?.list() ?? []).filter((r) => r.entryId !== args.entryId);
      this.deps.ratings?.save([
        ...rest,
        {
          entryId: args.entryId,
          workerId: kept.writer?.workerId ?? `team:${kept.teamId}`,
          useful: args.useful,
          ...(note ? { note } : {}),
          by: caller.name,
          ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
          at: this.now(),
        },
      ]);
      return { ok: true };
    }
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    if (args.entryId.startsWith('run:')) {
      // Finished work listed from the run itself (no 'completed' entry).
      const run = this.deps.runs.getRun(args.entryId.slice(4));
      if (!run?.workerId || !canSee(policy, roster, run.workerId, caller)) return { ok: false, error: 'No finished work with that id that you can see.' };
      if (run.state.kind !== 'done' || !run.state.success) return { ok: false, error: 'Only finished work can be rated.' };
      const note = args.note?.trim().slice(0, 500);
      const rest = (this.deps.ratings?.list() ?? []).filter((r) => r.entryId !== args.entryId);
      this.deps.ratings?.save([
        ...rest,
        {
          entryId: args.entryId,
          workerId: run.workerId,
          useful: args.useful,
          ...(note ? { note } : {}),
          by: caller.name,
          ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
          at: this.now(),
        },
      ]);
      return { ok: true };
    }
    for (const w of roster) {
      if (!canSee(policy, roster, w.id, caller)) continue;
      const entry = this.deps.workers.journalFor(w.id).find((e) => e.id === args.entryId);
      if (!entry) continue;
      if (entry.kind !== 'completed') return { ok: false, error: 'Only finished work can be rated.' };
      const note = args.note?.trim().slice(0, 500);
      const rating: Rating = {
        entryId: entry.id,
        workerId: w.id,
        useful: args.useful,
        ...(note ? { note } : {}),
        by: caller.name,
        ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
        at: this.now(),
      };
      const rest = (this.deps.ratings?.list() ?? []).filter((r) => r.entryId !== entry.id);
      this.deps.ratings?.save([...rest, rating]);
      if (entry.orchestrationId && this.deps.note) {
        const text = `${caller.name} found "${entry.title}" ${args.useful ? 'useful' : 'not useful'}${note ? `: ${note}` : '.'}`;
        this.deps.note(w.id, entry.orchestrationId, text.slice(0, 900));
      }
      return { ok: true };
    }
    return { ok: false, error: 'No finished work with that id that you can see.' };
  }

  // ---- ONE WORKER -------------------------------------------------------

  workerDetail(caller: OrgCaller, idOrName: string): Result<WorkerDetail> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const summary = this.listWorkers(caller).find((s) => s.id === w.id)!;
    const journal = this.deps.workers.journalFor(w.id);
    const now = this.now();
    const month = journal.filter((e) => now - e.at <= 30 * 86_400_000);
    const delivered = this.workItems([w], now - 30 * 86_400_000, 20);
    const rated = delivered.filter((d) => d.rating);
    const questions = this.workerQuestions(w);
    // Counted from the runs themselves, the same list the page draws, so the
    // tally can't say "failed" beside a run it shows as finished. The journal
    // also logs attempts a run retried past.
    const recentRuns = this.runsPast(w.id).filter((r) => now - r.at <= 30 * 86_400_000);
    return {
      ok: true,
      worker: summary,
      jobDescription: w.jobDescription,
      readiness: trustReadiness(w, journal, now),
      stats: {
        runs: recentRuns.length,
        failed: recentRuns.filter((r) => r.outcome === 'failed').length,
        rated: rated.length,
        usefulPct: rated.length ? Math.round((100 * rated.filter((d) => d.rating!.useful).length) / rated.length) : null,
      },
      delivered,
      questions: questions.slice(0, 20),
      learned: journal
        .filter((e) => e.kind === 'note' && e.note)
        .slice(-12)
        .reverse()
        .map((e) => ({ at: e.at, note: e.note! })),
      recent: journal
        .slice(-10)
        .reverse()
        .map((e) => ({ at: e.at, kind: e.kind, title: e.title, ...(e.note ? { note: e.note } : {}) })),
      asks: this.visibleAsks(caller, w.id).slice(-10).reverse(),
      missingTools: this.deps.tools ? this.deps.tools.list([w]).missing.map((m) => m.name) : [],
      triggers: (() => {
        const s = this.triggerSvc();
        return s ? s.list(w.id).map((t) => this.showTrigger(t, s)) : [];
      })(),
      value: this.workerValue(w.id),
      now: this.runsNow(w.id),
      deciding: this.deps.planning?.(w.id) ?? null,
      history: this.runsPast(w.id),
      shifts: this.shiftsOf(w.id).slice(0, 10),
      proposals: this.proposals(caller).filter((b) => b.workerId === w.id),
      waiting: this.listWaiting(caller).filter((x) => x.workerId === w.id),
    };
  }

  /// One run, live: where it is and what it has done so far, step by step,
  /// for whoever can see its worker. `after` returns only what's new.
  runLive(caller: OrgCaller, runId: UUID, after = 0): Result<{
    run: { id: UUID; title: string; workerName?: string; state: string; step: { index: number; total: number; name: string }; startedAt: number; costUSD?: number };
    activity: Array<{ at: number; kind: 'tool' | 'said' | 'error' | 'denied'; text: string }>;
  }> {
    const r = this.deps.runs.getRun(runId);
    const roster = this.deps.workers.roster();
    if (!r?.workerId || !canSee(this.policy(), roster, r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    const steps = r.flowSnapshot.steps;
    const at = r.state.kind === 'running' ? r.state.currentStepId : r.state.kind === 'paused' ? r.state.nextStepId : undefined;
    const i = Math.max(0, steps.findIndex((s) => s.id === at));
    const state = r.state.kind === 'paused' ? `paused: ${r.state.reason}` : r.state.kind === 'done' ? (r.state.success ? 'done' : 'failed') : r.state.kind;
    return {
      ok: true,
      run: { id: r.id, title: flowRunTitle(r), ...(r.workerName ? { workerName: r.workerName } : {}), state, step: { index: i + 1, total: steps.length, name: steps[i]?.id ?? '' }, startedAt: r.createdAt, ...(r.costUSD ? { costUSD: r.costUSD } : {}) },
      activity: this.deps.runActivity?.(runId, after) ?? [],
    };
  }

  /// The files a run wrote besides what its steps said — a report's HTML,
  /// the data behind it — for whoever can see its worker. Its steps' text
  /// is the report you read in the thread; these are what it made.
  runFiles(caller: OrgCaller, runId: UUID): Result<{ files: Array<{ name: string; bytes?: number }> }> {
    const r = this.deps.runs.getRun(runId);
    if (!r?.workerId || !canSee(this.policy(), this.deps.workers.roster(), r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    const files = (this.deps.runDeliverables?.(runId) ?? []).filter((f) => f.sourcePath).map((f) => ({ name: f.name, ...(f.bytes ? { bytes: f.bytes } : {}) }));
    return { ok: true, files };
  }

  /// Everything in a worker's own files, newest first, for whoever can see
  /// the worker: its timeline of what it made.
  workerFileList(caller: OrgCaller, workerId: UUID): Result<{ files: Array<{ name: string; bytes: number; at: number }> }> {
    if (!canSee(this.policy(), this.deps.workers.roster(), workerId, caller)) return { ok: false, error: NOT_FOUND };
    const files = (this.deps.workerFiles?.list(workerId) ?? []).slice(0, 500).map((f) => ({ name: f.name, bytes: f.bytes, at: f.modifiedAt }));
    return { ok: true, files };
  }

  /// One of a worker's files. The name is checked against its folder by the
  /// reader, links resolved, so it can't reach anything outside.
  workerFile(caller: OrgCaller, workerId: UUID, name: string): Result<{ name: string; data: Buffer }> {
    if (!canSee(this.policy(), this.deps.workers.roster(), workerId, caller)) return { ok: false, error: NOT_FOUND };
    const data = this.deps.workerFiles?.read(workerId, name);
    return data ? { ok: true, name, data } : { ok: false, error: 'That file is no longer there.' };
  }

  /// One of those files, found by its name on that list — never a path
  /// taken from the request.
  runFile(caller: OrgCaller, runId: UUID, name: string): Result<{ name: string; data: Buffer }> {
    const r = this.deps.runs.getRun(runId);
    if (!r?.workerId || !canSee(this.policy(), this.deps.workers.roster(), r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    const f = (this.deps.runDeliverables?.(runId) ?? []).find((x) => x.sourcePath && x.name === name);
    const data = f?.sourcePath ? this.deps.readRunFile?.(f.sourcePath) : null;
    return data ? { ok: true, name, data } : { ok: false, error: 'That file is no longer there.' };
  }

  /// Everything moving across the workers and teams the caller can see:
  /// runs under way, workers deciding what to do, runs waiting on someone,
  /// and team tasks being planned or worked. Newest first.
  workingNow(caller: OrgCaller): WorkingItem[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const visible = new Map(roster.filter((w) => canSee(policy, roster, w.id, caller)).map((w) => [w.id, w]));
    const out: WorkingItem[] = [];
    for (const w of visible.values()) {
      const p = this.deps.planning?.(w.id);
      if (p) out.push({ kind: 'deciding', id: `deciding:${w.id}`, at: p.since, title: p.task === 'errand' ? `Working out how to answer` : 'Deciding what to work on', detail: p.manual ? 'Run now' : p.task === 'errand' ? 'a question' : 'scheduled check', workerId: w.id, workerName: w.name });
    }
    for (const r of this.deps.runs.listRuns()) {
      const w = r.workerId ? visible.get(r.workerId) : undefined;
      if (!w) continue;
      const waiting = r.state.kind === 'paused' && (r.state.reason === 'needsInput' || r.state.reason === 'externalAction' || r.state.reason === 'riskyStep');
      if (r.state.kind !== 'running' && !waiting) continue;
      const steps = r.flowSnapshot.steps;
      const at = r.state.kind === 'running' ? r.state.currentStepId : r.state.kind === 'paused' ? r.state.nextStepId : undefined;
      const i = Math.max(0, steps.findIndex((s) => s.id === at));
      const where = `step ${i + 1} of ${steps.length}, ${(steps[i]?.id ?? '').replace(/[-_]+/g, ' ')}`;
      out.push({
        kind: waiting ? 'waiting' : 'run',
        id: `run:${r.id}`,
        at: r.createdAt,
        title: flowRunTitle(r),
        detail: waiting ? (r.state.kind === 'paused' && r.state.reason === 'needsInput' ? `has a question · ${where}` : `wants an OK · ${where}`) : where,
        workerId: w.id,
        workerName: w.name,
        ...(r.team ? { teamId: r.team.teamId, teamName: r.team.teamName } : {}),
        ...(r.costUSD ? { costUSD: r.costUSD } : {}),
      });
    }
    const teams = new Set(this.teams(caller, { disbanded: true }).map((t) => t.id));
    const names = new Map(roster.map((w) => [w.id, w.name]));
    for (const t of this.deps.teams?.list().tasks ?? []) {
      if (!teams.has(t.teamId) || (t.status !== 'running' && t.status !== 'planning')) continue;
      const stage = t.stages[t.stageIndex];
      const who = stage ? (stage.assignments ?? []).filter((a) => a.status === 'running' || a.status === 'paused').map((a) => names.get(a.workerId) ?? a.workerName) : [];
      out.push({
        kind: 'team',
        id: `team:${t.id}`,
        at: t.createdAt,
        title: t.title ?? t.brief.slice(0, 80),
        detail: t.status === 'planning' ? 'the coordinator is planning' : stage ? `stage ${t.stageIndex + 1} of ${t.stages.length}, ${(TEAM_STAGE_LABEL[stage.kind as TeamStageKind] ?? stage.kind).toLowerCase()}${who.length ? ` · ${who.join(', ')}` : ''}` : 'finishing',
        teamId: t.teamId,
        teamName: t.teamName,
        ...(t.spentUSD ? { costUSD: t.spentUSD } : {}),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /// Carry on a run a restart cut short. Its manager or an admin.
  resumeInterrupted(caller: OrgCaller, runId: UUID): Result {
    const run = this.deps.runs.getRun(runId);
    if (!run?.workerId || run.state.kind !== 'paused' || run.state.reason !== 'interrupted') return { ok: false, error: 'No interrupted run with that id.' };
    if (!canManage(this.policy(), this.deps.workers.roster(), run.workerId, caller)) return { ok: false, error: 'Only its manager or an admin can do that.' };
    const res = this.deps.runs.resumeRun({ runId });
    if (res.ok) this.record(caller, `Carried on ${run.workerName ?? 'a worker'}'s interrupted run "${flowRunTitle(run)}".`);
    return res;
  }

  /// What its runs asked along the way, newest first.
  private workerQuestions(w: Worker): WorkerDetail['questions'] {
    const questions: WorkerDetail['questions'] = [];
    for (const run of this.deps.runs.listRuns()) {
      if (run.workerId !== w.id) continue;
      for (const x of run.workerExchanges ?? []) {
        questions.push({
          question: x.question,
          ...(x.answer ? { answer: x.answer } : {}),
          answeredBy: x.answeredBy?.workerName ?? (x.status === 'answered' ? w.name : undefined),
          at: x.askedAt,
          waiting: x.status === 'escalated' && run.state.kind === 'paused' && run.state.reason === 'needsInput',
        });
      }
    }
    return questions.sort((a, b) => b.at - a.at);
  }

  /// What people asked this worker that the caller may see, in stored order.
  private visibleAsks(caller: OrgCaller, workerId: UUID): AskRecord[] {
    return this.allAsks().filter((a) => a.workerId === workerId && this.maySeeAsk(caller, a));
  }

  /// Runs of this worker that have ended, newest first.
  private runsPast(workerId: UUID): RunPast[] {
    return this.endedRuns(workerId)
      .slice(0, 25)
      .map((r) => this.runPast(r));
  }

  /// Every run of this worker that has ended, newest first, unmapped.
  private endedRuns(workerId: UUID): FlowRun[] {
    return this.deps.runs
      .listRuns()
      .filter((r) => r.workerId === workerId && (r.state.kind === 'done' || r.state.kind === 'aborted'))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private static runEndedAt(r: FlowRun): number {
    return Math.max(r.createdAt, ...(r.attempts ?? []).map((a) => a.endedAt ?? a.startedAt));
  }

  private static newestArtifact(r: FlowRun): { name: string; body: string } | undefined {
    return Object.values(r.artifacts ?? {}).sort((a, b) => b.producedAt - a.producedAt)[0];
  }

  private static runOutcome(r: FlowRun): RunPast['outcome'] {
    return r.state.kind === 'done' && r.state.success ? 'done' : r.state.kind === 'aborted' ? 'stopped' : 'failed';
  }

  private runPast(r: FlowRun): RunPast {
    const ended = OrgService.runEndedAt(r);
    const failedAt = r.attempts.filter((a) => a.outcome === 'error' || a.outcome === 'reboundExhausted').pop();
    const answer = OrgService.newestArtifact(r);
    const outcome = OrgService.runOutcome(r);
    return {
      runId: r.id,
      title: flowRunTitle(r),
      at: r.createdAt,
      minutes: Math.max(0, Math.round((ended - r.createdAt) / 60_000)),
      outcome,
      steps: r.flowSnapshot.steps.length,
      ...(r.costUSD ? { costUSD: r.costUSD } : {}),
      ...(answer ? { result: { name: answer.name, body: answer.body.slice(0, 6000) } } : {}),
      ...(outcome === 'failed' && failedAt?.errorMessage ? { error: failedAt.errorMessage.slice(0, 400) } : {}),
    };
  }

  /// One worker's ended runs, a page at a time, newest first. `nextBefore`
  /// is what to pass as `before` for the next page; null when there is none.
  workerRuns(
    caller: OrgCaller,
    idOrName: string,
    opts: { before?: number; limit?: number; outcome?: string } = {},
  ): Result<{ runs: RunPast[]; nextBefore: number | null; total: number }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const outcome = opts.outcome || undefined;
    if (outcome && outcome !== 'done' && outcome !== 'failed' && outcome !== 'stopped') return { ok: false, error: 'Pick done, failed or stopped.' };
    const limit = Number.isFinite(opts.limit) ? Math.min(100, Math.max(1, Math.floor(opts.limit!))) : 50;
    const matching = this.endedRuns(w.id).filter((r) => !outcome || OrgService.runOutcome(r) === outcome);
    const before = opts.before;
    const page = before != null && Number.isFinite(before) ? matching.filter((r) => r.createdAt < before) : matching;
    const runs = page.slice(0, limit).map((r) => this.runPast(r));
    return {
      ok: true,
      runs,
      nextBefore: page.length > limit ? runs[runs.length - 1].at : null,
      total: matching.length,
    };
  }

  /// A worker's shifts — scheduled, and Run now — newest first: what it
  /// decided each time and why, and the runs it started. The ones that
  /// started nothing are shifts too: without them Run now looked like it did
  /// nothing at all.
  private shiftsOf(workerId: UUID): ShiftPast[] {
    return this.deps.workers
      .journalFor(workerId)
      .filter((e) => e.kind === 'shift')
      .sort((a, b) => b.at - a.at)
      .map((e) => {
        const batch = e.orchestrationId ? this.deps.orchestration?.(e.orchestrationId) : null;
        const items = batch?.items ?? [];
        const reply = (batch?.producer?.reply ?? '').replace(/<candidates>[\s\S]*?<\/candidates>/g, '').replace(/<\/?subject>/g, '').trim();
        const started = items.filter((i) => i.status !== 'proposed' && i.status !== 'cancelled').length;
        const waiting = items.filter((i) => i.status === 'proposed').length;
        return {
          at: e.at,
          title: e.title,
          decision: !items.length ? 'nothing' : started ? 'started' : waiting ? 'proposed' : 'declined',
          started,
          proposed: items.length,
          waiting,
          runIds: items.flatMap((i) => (i.runId ? [i.runId] : [])),
          ...(e.orchestrationId ? { batchId: e.orchestrationId } : {}),
          ...(e.note ? { note: e.note } : {}),
          ...(reply ? { reasoning: reply.slice(0, 4000) } : {}),
        };
      });
  }

  /// One worker's shifts, a page at a time, newest first — the Runs tab's
  /// other half. `decision` filters: nothing, proposed, started, declined.
  workerShifts(
    caller: OrgCaller,
    idOrName: string,
    opts: { before?: number; limit?: number; decision?: string } = {},
  ): Result<{ shifts: ShiftPast[]; nextBefore: number | null; total: number }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const decision = opts.decision || undefined;
    if (decision && !['nothing', 'proposed', 'started', 'declined'].includes(decision)) return { ok: false, error: 'Pick nothing, proposed, started or declined.' };
    const limit = Number.isFinite(opts.limit) ? Math.min(100, Math.max(1, Math.floor(opts.limit!))) : 50;
    const matching = this.shiftsOf(w.id).filter((s) => !decision || s.decision === decision);
    const page = opts.before != null && Number.isFinite(opts.before) ? matching.filter((s) => s.at < opts.before!) : matching;
    const shifts = page.slice(0, limit);
    return { ok: true, shifts, nextBefore: page.length > limit ? shifts[shifts.length - 1].at : null, total: matching.length };
  }

  /// Everything on one worker's page, for a window of days ending at
  /// `before`: [from, to). `older` says whether anything came before it.
  workerFeed(
    caller: OrgCaller,
    idOrName: string,
    opts: { before?: number; days?: number } = {},
  ): Result<{
    from: number;
    to: number;
    asks: AskRecord[];
    delivered: WorkItem[];
    questions: WorkerDetail['questions'];
    history: RunPast[];
    shifts: ShiftPast[];
    older: boolean;
  }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const CAP = 200;
    const to = opts.before != null && Number.isFinite(opts.before) ? opts.before : this.now();
    const days = opts.days != null && Number.isFinite(opts.days) ? Math.min(60, Math.max(1, Math.floor(opts.days))) : 14;
    const from = to - days * 86_400_000;
    const inWindow = (at: number) => at >= from && at < to;

    const allAsks = this.visibleAsks(caller, w.id);
    const asks = allAsks
      .filter((a) => inWindow(a.at))
      .sort((a, b) => b.at - a.at)
      .slice(0, CAP);
    const delivered = this.workItems([w], from, CAP, to);
    const allQuestions = this.workerQuestions(w);
    const questions = allQuestions.filter((q) => inWindow(q.at)).slice(0, CAP);
    const ended = this.endedRuns(w.id);
    const history = ended
      .filter((r) => inWindow(r.createdAt))
      .slice(0, CAP)
      .map((r) => this.runPast(r));
    const allShifts = this.shiftsOf(w.id);
    const shifts = allShifts.filter((s) => inWindow(s.at)).slice(0, CAP);
    const older =
      allShifts.some((s) => s.at < from) ||
      allAsks.some((a) => a.at < from) ||
      this.deps.workers.journalFor(w.id).some((e) => e.kind === 'completed' && e.at < from) ||
      allQuestions.some((q) => q.at < from) ||
      ended.some((r) => r.createdAt < from);
    return { ok: true, from, to, asks, delivered, questions, history, shifts, older };
  }

  /// One worker's work as threads, newest first: each question, Run now,
  /// scheduled check or trigger joined to what it decided, what it put to its
  /// manager, the runs that came of it and what they found. `now` says what
  /// it's doing this moment, in one sentence; `waiting` carries the questions
  /// and approvals its runs have for the caller, by run.
  workerThreads(
    caller: OrgCaller,
    idOrName: string,
    opts: { before?: number; limit?: number } = {},
  ): Result<{ threads: WorkThread[]; nextBefore: number | null; total: number; now: ReturnType<typeof nowLine>; waiting: WaitingItem[]; youManage: boolean }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const filed = new Map<string, { entryId: string; title: string; rating?: WorkItem['rating'] }>();
    for (const it of this.workItems([w], 0, 1000)) {
      if (it.runId && !filed.has(it.runId)) filed.set(it.runId, { entryId: it.entryId, title: it.title, ...(it.rating ? { rating: it.rating } : {}) });
    }
    const all = buildThreads({
      workerName: w.name,
      asks: this.visibleAsks(caller, w.id),
      journal: this.deps.workers.journalFor(w.id),
      batches: (this.deps.batches?.list() ?? []).filter((b) => b.origin?.kind === 'worker' && b.origin.workerId === w.id),
      runs: this.deps.runs.listRuns().filter((r) => r.workerId === w.id),
      filed,
      planning: this.deps.planning?.(w.id) ?? null,
      runNow: (this.deps.audit?.recent(5000) ?? []).filter((e) => e.what === `Started a run of ${w.name} now.`).map((e) => ({ at: e.at, by: e.by })),
      now: this.now(),
    });
    const limit = Number.isFinite(opts.limit) ? Math.min(100, Math.max(1, Math.floor(opts.limit!))) : 20;
    const page = opts.before != null && Number.isFinite(opts.before) ? all.filter((t) => t.lastAt < opts.before!) : all;
    const threads = page.slice(0, limit);
    return {
      ok: true,
      threads,
      nextBefore: page.length > limit ? threads[threads.length - 1].lastAt : null,
      total: all.length,
      now: nowLine(all, w.name, this.now()),
      waiting: this.listWaiting(caller).filter((x) => x.workerId === w.id),
      youManage: canManage(this.policy(), this.deps.workers.roster(), w.id, caller),
    };
  }

  /// Runs of this worker still under way, newest first.
  private runsNow(workerId: UUID): RunNow[] {
    return this.deps.runs
      .listRuns()
      .filter((r) => r.workerId === workerId && (r.state.kind === 'running' || r.state.kind === 'paused'))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((r) => {
        const steps = r.flowSnapshot.steps;
        const currentId = r.state.kind === 'running' ? r.state.currentStepId : r.state.kind === 'paused' ? r.state.nextStepId : undefined;
        const index = Math.max(0, steps.findIndex((s) => s.id === currentId));
        const reason = r.state.kind === 'paused' ? r.state.reason : undefined;
        return {
          runId: r.id,
          title: flowRunTitle(r),
          startedAt: r.createdAt,
          step: { index: index + 1, total: steps.length, name: steps[index]?.id ?? '' },
          finished: steps.slice(0, index).map((s) => s.id),
          state:
            r.state.kind === 'running'
              ? 'working'
              : reason === 'needsInput'
                ? 'question'
                : reason === 'externalAction' || reason === 'riskyStep'
                  ? 'approval'
                  : reason === 'interrupted'
                    ? 'interrupted'
                    : 'paused',
          ...(r.costUSD ? { costUSD: r.costUSD } : {}),
        };
      });
  }

  /// Raise or lower a worker's trust. Its manager may move it between
  /// probation and trusted; autonomy is an admin's call.
  setTrust(caller: OrgCaller, idOrName: string, trust: WorkerTrustLevel): Result<{ name: string; trust: WorkerTrustLevel }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.setTrust) return { ok: false, error: 'Trust cannot be changed from here.' };
    if (trust === 'autonomous' && !isAdmin(this.policy(), caller)) {
      return { ok: false, error: 'Only an admin can make a worker autonomous.' };
    }
    const res = this.deps.setTrust(found.worker.id, trust);
    if (!res.ok) return res;
    // "On its own" means it acts outside the server without asking, and
    // that is the grant that says so. It used to change only the label: an
    // autonomous member still stopped for every Jira write in a team task.
    // Moving it down takes the grant back.
    const after = this.deps.workers.get(found.worker.id);
    const grant = trust === 'autonomous';
    if (after && !!after.caps.allowExternalActions !== grant) {
      const next = structuredClone(after);
      if (grant) next.caps.allowExternalActions = true;
      else delete next.caps.allowExternalActions;
      this.deps.workers.save(next);
    }
    this.record(caller, `Set ${found.worker.name} to ${trust}.`);
    return { ok: true, name: found.worker.name, trust };
  }

  // ---- TODAY ------------------------------------------------------------

  today(caller: OrgCaller): TodayView {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const runs = this.deps.runs.listRuns();
    const mine = roster.filter((w) => managesDirectly(roster, w.id, caller) || (!caller.admin && canManage(policy, roster, w.id, caller)));
    const crewSource = mine.length ? mine : caller.admin ? roster : [];
    const snapshots = new Map((this.deps.snapshots?.() ?? []).map((s) => [s.worker.id, s.nextShiftAt]));
    const spent = this.deps.workers.spentThisMonth();
    const spentUSD = crewSource.reduce((sum, w) => sum + (spent.get(w.id) ?? 0), 0);
    const approver = isAdmin(policy, caller) || (!!caller.slackUserId && approversFor(policy).includes(caller.slackUserId));
    return {
      org: policy.name ?? 'Your org',
      waiting: this.listWaiting(caller),
      hireApprovals: approver
        ? this.deps.hires
            .list()
            .filter((h) => h.status === 'awaitingApproval' && h.requestedBy.slackUserId !== caller.slackUserId)
            .map((h) => this.summarize(h))
        : [],
      teamTasks: this.teamTasks(caller).filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
      proposals: this.proposals(caller),
      delivered: this.workItems(crewSource, this.now() - 36 * 3_600_000, 12),
      crew: crewSource
        .map((w) => ({ id: w.id, name: w.name, state: workerState(w, runs), nextShiftAt: snapshots.get(w.id) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      spend: {
        spentUSD,
        projectedUSD: projectMonthEnd(spentUSD, new Date(this.now())),
        ...(caller.slackUserId
          ? { allowanceUSD: allowanceFor(policy, caller.slackUserId), committedUSD: committedBudget(roster, caller.slackUserId) }
          : {}),
      },
    };
  }

  // ---- ROLES ------------------------------------------------------------

  roles(caller: OrgCaller): RoleOffer[] {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    return policy.roles.map((role) => {
      const hiredCount = roster.filter((w) => w.tagline === role.name || w.jobDescription.startsWith(role.job.slice(0, 60))).length;
      const decision = caller.slackUserId || caller.admin
        ? hireDecision(policy, roster, caller, { budgetUSDPerMonth: role.budgetUSDPerMonth, mcpServers: role.tools, role })
        : { kind: 'refused' as const, reason: 'Sign in as a person to hire.' };
      return {
        ...role,
        hiredCount,
        fit: decision.kind === 'allowed' ? 'fits' : decision.kind === 'needsApproval' ? 'needsApproval' : 'notAllowed',
        ...(decision.kind === 'needsApproval' ? { why: decision.reasons.join(' ') } : decision.kind === 'refused' ? { why: decision.reason } : {}),
      };
    });
  }

  /// Draft a hire from a catalog role: the role's job, straight to an offer.
  async hireRole(caller: OrgCaller, roleName: string, extra?: string): Promise<Result<{ hire: HireSummary }>> {
    const role = this.policy().roles.find((r) => r.name.toLowerCase() === roleName.trim().toLowerCase());
    if (!role) return { ok: false, error: `No role called "${roleName}" in the catalog.` };
    const job = extra?.trim() ? `${role.job}\n\nFor this hire: ${extra.trim()}` : role.job;
    const res = await this.draftHire(caller, { jobDescription: job, skipQuestions: true, options: { budgetUSDPerMonth: role.budgetUSDPerMonth } });
    if (!res.ok) return res;
    const hire = this.hire(res.hire.hireId);
    if (hire) {
      hire.role = role;
      this.putHire(hire);
    }
    return res;
  }

  /// How the work an errand started is going: each item, and once every one
  /// has ended, what they produced and the links in it (a PR, a doc). The
  /// asker's way of hearing back about work that outlasts the ask itself.
  errandProgress(orchestrationId: UUID): ErrandProgress | null {
    const batch = this.deps.orchestration?.(orchestrationId);
    if (!batch) return null;
    const items = batch.items
      .filter((i) => i.status !== 'cancelled' || !i.settledByRestart)
      .map((i) => ({
        title: i.candidate.title,
        status: i.status,
        ...(i.runId ? { runId: i.runId } : {}),
        ...(i.branchName ? { branch: i.branchName } : {}),
        ...(i.note ? { note: i.note } : {}),
        ...(i.status === 'running' && i.runId ? this.runPlace(i.runId) : {}),
      }));
    const ended = items.every((i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled');
    if (!ended) return { done: false, items, files: [], links: [] };
    const files = items.flatMap((i) => (i.status === 'done' && i.runId ? (this.deps.runDeliverables?.(i.runId) ?? []) : []));
    const links = [...new Set(files.flatMap((f) => (f.body ?? '').match(/https?:\/\/[^\s)\]>"'`]+/g) ?? []))].filter((u) => /\/pull\/\d+|\/compare\/|\/pull-requests\/new|\/pull-requests\?create|docs\.google|notion\.so|\/wiki\//.test(u)).slice(0, 10);
    return { done: true, items, files, links };
  }

  /// Where a running run is: its step, since when, and the last thing it said.
  private runPlace(runId: UUID): { step?: { index: number; total: number; name: string }; startedAt?: number; said?: string } {
    const r = this.deps.runs.getRun(runId);
    if (!r) return {};
    const steps = r.flowSnapshot.steps;
    const at = r.state.kind === 'running' ? r.state.currentStepId : r.state.kind === 'paused' ? r.state.nextStepId : undefined;
    const index = steps.findIndex((s) => s.id === at);
    const said = (this.deps.runActivity?.(runId, 0) ?? []).filter((a) => a.kind === 'said').at(-1)?.text;
    return {
      ...(index >= 0 ? { step: { index: index + 1, total: steps.length, name: steps[index].id.replace(/[-_]+/g, ' ') } } : {}),
      startedAt: r.createdAt,
      ...(said ? { said: said.replace(/\s+/g, ' ').trim().slice(0, 240) } : {}),
    };
  }

  // ---- REPOS ------------------------------------------------------------

  /// Connected repos, and who works in each.
  repoList(caller: OrgCaller): Result<{ repos: Array<ConnectedRepo & { workers: string[]; canPush: boolean; tokenEnv?: string }>; workspaces: Array<OrgWorkspace & { workers: string[] }> }> {
    if (!this.deps.repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!canHire(this.policy(), caller)) return { ok: false, error: 'Only people who may hire workers can see the repos.' };
    const roster = this.deps.workers.roster();
    const repos = this.deps.repos;
    return {
      ok: true,
      repos: repos.list().map((r) => {
        const tokenEnv = repos.tokenFor(r);
        return { ...r, canPush: repos.canPush(r), ...(tokenEnv ? { tokenEnv } : {}), workers: roster.filter((w) => w.projectPath === r.path).map((w) => w.name) };
      }),
      workspaces: repos.workspaces().map((ws) => ({ ...ws, workers: roster.filter((w) => w.projectPath === ws.rootPath).map((w) => w.name) })),
    };
  }

  async connectRepo(caller: OrgCaller, input: { url: string; name?: string; testCommand?: string }): Promise<Result<{ repo: ConnectedRepo }>> {
    if (!this.deps.repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can connect repos.' };
    const res = await this.deps.repos.connect(input, caller.name);
    if (!res.ok) return res;
    this.deps.repos.changed();
    this.record(caller, `Connected the repo ${res.repo.name} (${res.repo.url})${res.repo.testCommand ? `, tests: ${res.repo.testCommand}` : ''}.`);
    return res;
  }

  disconnectRepo(caller: OrgCaller, name: string): Result {
    if (!this.deps.repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can disconnect repos.' };
    const res = this.deps.repos.disconnect(name);
    if (!res.ok) return res;
    this.deps.repos.changed();
    this.record(caller, `Disconnected the repo ${name}.`);
    return res;
  }

  /// Let a worker change a repo, or a workspace of repos: it works there
  /// from now on, with a flow that ends in pushed branches and the links to
  /// open pull requests. Its manager or an admin decides.
  letWorkOnRepo(caller: OrgCaller, idOrName: string, repoOrWorkspace: string): Result<{ worker: string; flow: string }> {
    const repos = this.deps.repos;
    if (!repos || !this.deps.saveFlow) return { ok: false, error: 'Repos are not available on this server.' };
    const repo = repos.list().find((r) => r.name === repoOrWorkspace);
    const key = repoOrWorkspace.trim().toLowerCase();
    const ws = repo ? undefined : repos.workspaces().find((x) => x.id === repoOrWorkspace || x.name.toLowerCase() === key);
    if (!repo && !ws) return { ok: false, error: 'No connected repo or workspace by that name.' };
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    if (!canManage(this.policy(), this.deps.workers.roster(), w.id, caller)) return { ok: false, error: `Only ${w.name}'s manager or an admin can do that.` };
    const flowId = repo ? prFlowIdFor(repo) : workspaceFlowId(ws!);
    const flow = this.deps.saveFlow(flowId, repo ? prFlowFor(repo) : workspaceFlowYaml(ws!, repos.list()));
    if (!flow.ok) return flow;
    const place = repo ? repo.path : ws!.rootPath;
    // A worker works in one place: the flows for any other repo or workspace
    // go, so its planning can't launch work against somewhere it isn't.
    const others = (id: string) => id.startsWith('org-pr-') && id !== flowId;
    const saved = this.deps.workers.save({ ...w, projectPath: place, flowIds: [...new Set([...w.flowIds.filter((id) => !others(id)), flowId])] });
    if (!saved.ok) return saved;
    this.record(caller, `Let ${w.name} change ${repo ? repo.name : `the ${ws!.name} workspace (${ws!.repos.join(', ')})`}; its changes arrive as branches to open pull requests from.`);
    return { ok: true, worker: w.name, flow: flowId };
  }

  createWorkspace(caller: OrgCaller, input: { name: string; repos: string[]; instructions?: string }): Result<{ workspace: OrgWorkspace }> {
    if (!this.deps.repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can make workspaces.' };
    const res = this.deps.repos.createWorkspace(input, caller.name);
    if (!res.ok) return res;
    this.deps.repos.changed();
    this.record(caller, `Made the ${res.workspace.name} workspace: ${res.workspace.repos.join(', ')}.`);
    return res;
  }

  updateWorkspace(caller: OrgCaller, id: string, patch: { repos?: string[]; instructions?: string }): Result<{ workspace: OrgWorkspace }> {
    const repos = this.deps.repos;
    if (!repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change workspaces.' };
    const res = repos.updateWorkspace(id, patch);
    if (!res.ok) return res;
    repos.changed();
    // Workers already in it get the flow for what it is now.
    this.deps.saveFlow?.(workspaceFlowId(res.workspace), workspaceFlowYaml(res.workspace, repos.list()));
    this.record(caller, `Changed the ${res.workspace.name} workspace: ${res.workspace.repos.join(', ')}${patch.instructions !== undefined ? ', and its instructions' : ''}.`);
    return res;
  }

  removeWorkspace(caller: OrgCaller, id: string): Result {
    const repos = this.deps.repos;
    if (!repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can remove workspaces.' };
    const ws = repos.workspaces().find((w) => w.id === id || w.name.toLowerCase() === id.trim().toLowerCase());
    if (!ws) return { ok: false, error: 'No workspace by that name.' };
    const inUse = this.deps.workers.roster().filter((w) => w.projectPath === ws.rootPath).map((w) => w.name);
    if (inUse.length) return { ok: false, error: `${inUse.join(', ')} ${inUse.length === 1 ? 'works' : 'work'} there. Point ${inUse.length === 1 ? 'it' : 'them'} at a repo first.` };
    const res = repos.removeWorkspace(ws.id);
    if (!res.ok) return res;
    repos.changed();
    this.record(caller, `Removed the ${ws.name} workspace.`);
    return res;
  }

  // ---- SECRETS ----------------------------------------------------------

  /// Every secret the server uses: which are set and where, never a value.
  secretList(caller: OrgCaller): Result<{ store: { kind: string; where: string; readOnly: boolean; warning?: string }; secrets: SecretStatus[]; error: string | null; model?: ModelProvider }> {
    if (!this.deps.secrets) return { ok: false, error: 'This server keeps its secrets in its environment only.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can see the secrets.' };
    const repos = this.deps.repos;
    const neededBy = (name: string) => (repos ? repos.list().filter((r) => repos.tokenFor(r) === name).map((r) => `pushing to ${r.name}`) : []);
    return { ok: true, store: this.deps.secrets.store, ...this.deps.secrets.status(neededBy) };
  }

  async setSecret(caller: OrgCaller, name: string, value: string): Promise<Result> {
    if (!this.deps.secrets) return { ok: false, error: 'This server keeps its secrets in its environment only.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change secrets.' };
    const res = await this.deps.secrets.set(name.trim(), value, caller.name);
    if (res.ok) this.record(caller, `Set the secret ${name.trim()}.`);
    return res;
  }

  async removeSecret(caller: OrgCaller, name: string): Promise<Result> {
    if (!this.deps.secrets) return { ok: false, error: 'This server keeps its secrets in its environment only.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change secrets.' };
    const res = await this.deps.secrets.remove(name.trim());
    if (res.ok) this.record(caller, `Removed the secret ${name.trim()}.`);
    return res;
  }

  // ---- PUBLISH A LOCAL WORKER -------------------------------------------

  /// Take a worker someone built on their own install (its share file) onto
  /// the org's roster, under the same rules as a hire: the publisher becomes
  /// its manager, and anything over their allowance waits for an approver.
  publishWorker(caller: OrgCaller, yaml: string, options: HireOptions = {}, tools: ToolTemplate[] = [], localId?: string): Result<{ hired?: WorkerSummary; hire: HireSummary }> {
    if (!this.deps.importWorker) return { ok: false, error: 'This server cannot take published workers.' };
    // What its tools looked like where it was built: the Tools page offers
    // them pre-filled. Only names, commands and setting names — no secrets.
    if (tools.length && canHire(this.policy(), caller)) this.deps.tools?.remember?.(tools);
    if (!canHire(this.policy(), caller)) {
      return { ok: false, error: 'You are not on the list of people who may hire workers. Ask an admin to add you to the org policy.' };
    }
    if (yaml.length > 2_000_000) return { ok: false, error: 'That worker file is too large.' };
    const parsed = parseWorkerYaml(yaml);
    if (!parsed.ok) return { ok: false, error: `That is not a worker file overcli can read: ${parsed.error}` };
    const w = parsed.bundle.worker;
    const hire: PendingHire = {
      id: randomUUID(),
      status: 'drafted',
      createdAt: this.now(),
      requestedBy: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) },
      jobDescription: w.jobDescription,
      conversation: [],
      options,
      imported: {
        yaml,
        name: w.name,
        ...(w.description ? { tagline: w.description } : {}),
        jobDescription: w.jobDescription,
        budgetUSDPerMonth: w.budgetUSDPerMonth,
        mcpServers: w.mcpServers ?? [],
        flows: parsed.bundle.flows.map((f) => f.name),
        cadence: w.cadence,
        ...(localId && LOCAL_ID.test(localId) ? { localId } : {}),
      },
    };
    this.putHire(hire);
    return this.confirmHire(caller, hire.id);
  }

  // ---- PUBLISH A TEAM ---------------------------------------------------

  private memoryPublished: PublishedState = { workers: {}, teams: {}, waiting: [] };

  private publishedState(): PublishedState {
    return this.deps.published?.load() ?? this.memoryPublished;
  }

  private savePublished(state: PublishedState): void {
    if (this.deps.published) this.deps.published.save(state);
    else this.memoryPublished = state;
  }

  /// The server's copy of something published from an install, if it is
  /// still here.
  private publishedWorker(localId: string): UUID | null {
    const id = this.publishedState().workers[localId];
    return id && this.deps.workers.get(id) ? id : null;
  }

  /// A team someone built on their own install, onto the org: members the org
  /// doesn't have yet are published first (each a hire under the usual
  /// rules), members it has are reused, then the team. Published again, the
  /// team is updated in place. A member waiting on an approver holds the team
  /// back until the approval lands.
  publishTeam(caller: OrgCaller, input: TeamPublishInput): Result<{ team?: { id: UUID; name: string }; updated: boolean; added: string[]; reused: string[]; waitingOn: string[] }> {
    if (!this.deps.teams?.save) return { ok: false, error: 'Teams are not running on this server.' };
    if (!canHire(this.policy(), caller)) {
      return { ok: false, error: 'You are not on the list of people who may hire workers. Ask an admin to add you to the org policy.' };
    }
    const bad = checkTeamPublish(input);
    if (bad) return { ok: false, error: bad };
    const priorId = this.publishedState().teams[input.localId];
    const prior = priorId ? this.deps.teams.list().teams.find((t) => t.id === priorId) : undefined;
    if (prior && !this.canChangeTeam(caller, prior)) return { ok: false, error: `${prior.name} is already on the org, and only people who manage someone on it can change it.` };

    const roster = this.deps.workers.roster();
    const added: string[] = [];
    const reused: string[] = [];
    const waiting: Record<string, string> = {};
    const waitingOn: string[] = [];
    for (const m of input.members) {
      const existing = this.publishedWorker(m.localId);
      if (existing && canSee(this.policy(), roster, existing, caller)) {
        reused.push(this.deps.workers.get(existing)!.name);
        continue;
      }
      const res = this.publishWorker(caller, m.yaml, {}, m.tools ?? [], m.localId);
      if (!res.ok) return { ok: false, error: `Could not publish a member: ${res.error}` };
      if (res.hired) added.push(res.hired.name);
      else {
        waiting[m.localId] = res.hire.hireId;
        waitingOn.push(res.hire.contract?.name ?? 'a member');
      }
    }
    const shape: TeamPublishShape = {
      name: input.name.trim(),
      ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
      budgetUSDPerTask: input.budgetUSDPerTask,
      ...(input.checkpoints ? { checkpoints: input.checkpoints } : {}),
      ...(input.piecesAskFirst === false ? { piecesAskFirst: false } : {}),
      members: input.members.map((m) => ({ localId: m.localId, role: m.role.trim() })),
    };
    const by = { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) };
    const state = this.publishedState();
    state.waiting = state.waiting.filter((w) => w.localTeamId !== input.localId);
    if (waitingOn.length) {
      state.waiting.push({ localTeamId: input.localId, team: shape, by, waiting, at: this.now() });
      this.savePublished(state);
      this.record(caller, `Published the team ${shape.name}; it waits for ${waitingOn.join(', ')} to be approved.`);
      return { ok: true, updated: !!prior, added, reused, waitingOn };
    }
    this.savePublished(state);
    const saved = this.landTeam(input.localId, shape);
    if (!saved.ok) return saved;
    this.record(caller, `${prior ? 'Updated' : 'Published'} the team ${saved.team.name}.`);
    return { ok: true, team: { id: saved.team.id, name: saved.team.name }, updated: !!prior, added, reused, waitingOn };
  }

  /// A team from workers already on the org, made in the console. Whoever
  /// makes it must manage every member, or be an admin.
  makeTeam(
    caller: OrgCaller,
    input: { name: string; purpose?: string; budgetUSDPerTask: number; members: Array<{ workerId: UUID; role: string }>; workIn?: string; checkpoints?: TeamCheckpoints },
  ): Result<{ team: { id: UUID; name: string } }> {
    if (!this.deps.teams?.save) return { ok: false, error: 'Teams are not running on this server.' };
    const refused = this.teamMembersRefused(caller, input.members);
    if (refused) return { ok: false, error: refused };
    // Where its tasks run: a connected repo or workspace, so code changes get
    // a branch in each repo. Absent: each member works where it usually does.
    let projectPath: string | undefined;
    if (input.workIn?.trim()) {
      const key = input.workIn.trim().toLowerCase();
      const repo = this.deps.repos?.list().find((r) => r.name === input.workIn);
      const ws = this.deps.repos?.workspaces().find((w) => w.id === input.workIn || w.name.toLowerCase() === key);
      projectPath = repo?.path ?? ws?.rootPath;
      if (!projectPath) return { ok: false, error: 'No connected repo or workspace by that name.' };
    }
    const saved = this.deps.teams.save({
      ...(projectPath ? { projectPath } : {}),
      name: input.name,
      ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
      members: input.members.map((m) => ({ workerId: m.workerId, role: m.role.trim().slice(0, 200) })),
      budgetUSDPerTask: input.budgetUSDPerTask,
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(input.checkpoints ?? {}) },
    });
    if (!saved.ok) return saved;
    this.record(caller, `Made the team ${saved.team.name}.`);
    return { ok: true, team: { id: saved.team.id, name: saved.team.name } };
  }

  private teamMembersRefused(caller: OrgCaller, members: Array<{ workerId: UUID; role: string }>): string | null {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const notMine = members.find((m) => !isAdmin(policy, caller) && !canManage(policy, roster, m.workerId, caller));
    if (notMine) return `You don't manage ${this.deps.workers.get(notMine.workerId)?.name ?? 'one of those workers'}. Ask its manager, or an admin, to make the team.`;
    if (members.some((m) => !m.role.trim())) return 'Say what each member does on the team.';
    return null;
  }

  // ---- MAKING A TEAM WITH NEW HIRES ------------------------------------------
  //
  // Hiring the members a suggestion said nobody covers takes a model turn
  // each, so making such a team is a run the server keeps: the console asks
  // how it stands, every hire's own state included, and it carries on when
  // the page is closed. In memory: a restart drops a run in progress.

  private teamRuns = new Map<string, TeamRun>();

  private teamRunView(run: TeamRun): TeamRunView {
    const { id, name, status, startedAt, members, hires, team, error } = run;
    return { id, name, status, startedAt, members, hires: hires.map((h) => ({ ...h })), ...(team ? { team } : {}), ...(error ? { error } : {}) };
  }

  private ownRun(caller: OrgCaller, id: string): TeamRun | null {
    const run = this.teamRuns.get(id);
    return run && (run.by === personKey(caller) || isAdmin(this.policy(), caller)) ? run : null;
  }

  /// Start making a team. With no hires it is made at once; with hires, each
  /// is drafted without an interview and confirmed as the person would:
  /// hired now when it fits their allowance, else sent to an approver, and it
  /// joins the team once approved. A hire that fails waits for Retry or Skip,
  /// unless `skipFailed` (Slack, which has no buttons for it).
  startTeamRun(
    caller: OrgCaller,
    input: Parameters<OrgService['makeTeam']>[1] & { hires?: Array<{ key?: string; job: string; role: string }>; hireVisibility?: WorkerVisibility },
    opts: { skipFailed?: boolean } = {},
  ): Result<{ run: TeamRunView }> {
    if (!this.deps.teams?.save) return { ok: false, error: 'Teams are not running on this server.' };
    const hires = (input.hires ?? []).filter((x) => x.job.trim()).slice(0, 3);
    if (hires.length && !canHire(this.policy(), caller)) return { ok: false, error: 'You can’t hire, so the suggested new member can’t be added. Skip it, or ask an admin to let you hire.' };
    const refused = this.teamMembersRefused(caller, input.members);
    if (refused) return { ok: false, error: refused };
    if (!input.name.trim()) return { ok: false, error: 'Give the team a name.' };
    const now = this.now();
    for (const [id, r] of this.teamRuns) if (r.finishedAt && now - r.finishedAt > 60 * 60 * 1000) this.teamRuns.delete(id);
    const names = new Map(this.deps.workers.roster().map((w) => [w.id, w.name]));
    const run: TeamRun = {
      id: randomUUID(),
      by: personKey(caller),
      caller,
      name: input.name.trim(),
      status: hires.length ? 'hiring' : 'making',
      startedAt: now,
      members: input.members.map((m) => ({ workerId: m.workerId, name: names.get(m.workerId) ?? 'A worker', role: m.role })),
      hires: hires.map((g, i) => ({ key: g.key || String(i), role: g.role.trim() || 'New member', job: g.job.trim(), state: 'drafting' as const })),
      input,
      hireIds: {},
      workerIds: {},
      skipFailed: !!opts.skipFailed,
      ...(input.hireVisibility ? { hireVisibility: input.hireVisibility } : {}),
    };
    this.teamRuns.set(run.id, run);
    // No hires: made before this returns.
    if (!run.hires.length) this.settleRun(run);
    run.settled = Promise.all(run.hires.map((h) => this.hireForRun(run, h))).then(() => this.settleRun(run));
    return { ok: true, run: this.teamRunView(run) };
  }

  private async hireForRun(run: TeamRun, h: TeamRunHire): Promise<void> {
    const context = `${run.name} team${run.input.purpose?.trim() ? ` (${run.input.purpose.trim()})` : ''}`;
    try {
      const drafted = await this.draftHire(run.caller, { jobDescription: `${h.job}\n\nOn the ${context}: ${h.role}.`, skipQuestions: true });
      if (h.state !== 'drafting') return;
      if (!drafted.ok) return void Object.assign(h, { state: 'failed', error: drafted.error });
      const confirmed = this.confirmHire(run.caller, drafted.hire.hireId, run.hireVisibility ? { visibility: run.hireVisibility } : undefined);
      if (!confirmed.ok) {
        this.cancelHire(run.caller, drafted.hire.hireId);
        return void Object.assign(h, { state: 'failed', error: confirmed.error });
      }
      run.hireIds[h.key] = drafted.hire.hireId;
      if (confirmed.hired) {
        run.workerIds[h.key] = confirmed.hired.id;
        Object.assign(h, { state: 'hired', name: confirmed.hired.name });
      } else {
        Object.assign(h, { state: 'waiting', name: drafted.hire.contract?.name ?? 'The new worker' });
      }
      delete h.error;
    } catch (err) {
      Object.assign(h, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /// Once no hire is still drafting: wait on the person for a failed one,
  /// else make the team from who is here now.
  private settleRun(run: TeamRun): void {
    if (run.status === 'making' && run.team) return;
    if (run.status === 'done' || run.status === 'failed') return;
    if (run.hires.some((h) => h.state === 'drafting')) return;
    if (run.skipFailed) {
      run.failedErrors = run.hires.filter((h) => h.state === 'failed').map((h) => ({ role: h.role, error: h.error ?? 'It didn’t go through.' }));
      for (const h of run.hires) if (h.state === 'failed') h.state = 'skipped';
    }
    if (run.hires.some((h) => h.state === 'failed')) {
      run.status = 'needsYou';
      return;
    }
    run.status = 'making';
    const hired = run.hires.filter((h) => h.state === 'hired');
    const members = [...run.input.members, ...hired.map((h) => ({ workerId: run.workerIds[h.key], role: h.role }))];
    const end = (status: 'done' | 'failed', error?: string) => Object.assign(run, { status, finishedAt: this.now(), ...(error ? { error } : {}) });
    if (members.length < 2) {
      const waiting = run.hires.filter((h) => h.state === 'waiting');
      const why = waiting.length ? `${waiting.map((h) => h.name).join(' and ')} ${waiting.length === 1 ? 'is' : 'are'} waiting on an approver` : 'nobody else is on it';
      return void end('failed', `A team needs two members to start, and ${why}. Add another of your workers, or make the team once the hire is approved.`);
    }
    const made = this.makeTeam(run.caller, { ...run.input, members });
    if (!made.ok) return void end('failed', made.error);
    run.team = made.team;
    for (const h of run.hires.filter((x) => x.state === 'waiting')) {
      const hire = this.hire(run.hireIds[h.key]);
      if (hire) this.putHire({ ...hire, joinTeam: { teamId: made.team.id, role: h.role } });
    }
    end('done');
  }

  teamRun(caller: OrgCaller, id: string): Result<{ run: TeamRunView }> {
    const run = this.ownRun(caller, id);
    return run ? { ok: true, run: this.teamRunView(run) } : { ok: false, error: 'That team is no longer being made.' };
  }

  /// Teams this person is making now, for the Teams page.
  teamRunsFor(caller: OrgCaller): TeamRunView[] {
    return [...this.teamRuns.values()].filter((r) => r.by === personKey(caller) && !r.finishedAt).map((r) => this.teamRunView(r));
  }

  retryTeamRunHire(caller: OrgCaller, id: string, key: string): Result<{ run: TeamRunView }> {
    const run = this.ownRun(caller, id);
    const h = run?.hires.find((x) => x.key === key);
    if (!run || !h || h.state !== 'failed') return { ok: false, error: 'There’s nothing to retry there.' };
    Object.assign(h, { state: 'drafting' });
    delete h.error;
    run.status = 'hiring';
    run.settled = this.hireForRun(run, h).then(() => this.settleRun(run));
    return { ok: true, run: this.teamRunView(run) };
  }

  skipTeamRunHire(caller: OrgCaller, id: string, key: string): Result<{ run: TeamRunView }> {
    const run = this.ownRun(caller, id);
    const h = run?.hires.find((x) => x.key === key);
    if (!run || !h || (h.state !== 'failed' && h.state !== 'drafting')) return { ok: false, error: 'That hire is already settled.' };
    h.state = 'skipped';
    delete h.error;
    if (run.status === 'needsYou') run.status = 'hiring';
    this.settleRun(run);
    return { ok: true, run: this.teamRunView(run) };
  }

  /// Make a team with its hires and wait for the outcome: for Slack, where
  /// a failed hire is left out rather than waited on.
  async makeTeamWithHires(
    caller: OrgCaller,
    input: Parameters<OrgService['makeTeam']>[1] & { hires?: Array<{ job: string; role: string }>; hireVisibility?: WorkerVisibility },
  ): Promise<Result<{ team: { id: UUID; name: string }; hired: Array<{ name: string; role: string }>; waiting: Array<{ name: string; role: string }>; failed: Array<{ role: string; error: string }> }>> {
    const started = this.startTeamRun(caller, input, { skipFailed: true });
    if (!started.ok) return started;
    const run = this.teamRuns.get(started.run.id)!;
    await run.settled;
    if (run.status !== 'done' || !run.team) return { ok: false, error: run.error ?? 'The team could not be made.' };
    const pick = (state: TeamRunHire['state']) => run.hires.filter((h) => h.state === state).map((h) => ({ name: h.name ?? 'The new worker', role: h.role }));
    return { ok: true, team: run.team, hired: pick('hired'), waiting: pick('waiting'), failed: run.failedErrors ?? [] };
  }

  /// A crew for a team someone is making: picked from the workers they
  /// manage, each with what it would do. Jobs nobody of theirs covers come
  /// back as gaps, never as hires. Nothing is saved.
  async suggestTeam(
    caller: OrgCaller,
    purpose: string,
    name = '',
  ): Promise<Result<{ name: string; purpose: string; note: string; members: Array<{ workerId: UUID; name: string; role: string }>; gaps: Array<{ job: string; role: string }> }>> {
    if (!this.deps.teams?.draftRoster) return { ok: false, error: 'Suggesting a crew isn’t available on this server.' };
    if (!purpose.trim()) return { ok: false, error: 'Say what the team is for first.' };
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    // The workers makeTeam would let them put on it: their own, or any for an admin.
    const mine = roster.filter((w) => w.enabled && (isAdmin(policy, caller) || canManage(policy, roster, w.id, caller)));
    if (mine.length < 2) return { ok: false, error: 'A team needs at least two workers you manage. Hire another first.' };
    const res = await this.deps.teams.draftRoster({ brief: purpose, ...(name.trim() ? { current: { name: name.trim(), members: [] } } : {}), onlyWorkerIds: mine.map((w) => w.id) });
    if (!res.ok) return res;
    const names = new Map(mine.map((w) => [w.id, w.name]));
    const d = res.draft;
    return {
      ok: true,
      name: d.name,
      purpose: d.purpose,
      note: d.note,
      members: d.members.flatMap((m) => (m.kind === 'worker' && names.has(m.workerId) ? [{ workerId: m.workerId, name: names.get(m.workerId)!, role: m.role }] : [])),
      gaps: d.members.flatMap((m) => (m.kind === 'hire' ? [{ job: m.job, role: m.role }] : [])),
    };
  }

  /// Where a team checks in with you, whether its members' pieces ask
  /// before acting outside their sandbox, and how it should go about its
  /// work. For whoever manages one of its members, or an admin.
  updateTeamSettings(caller: OrgCaller, teamId: UUID, patch: { checkpoints?: Partial<TeamCheckpoints>; piecesAskFirst?: boolean; budgetUSDPerTask?: number; guidance?: string; avatarUrl?: string | null }): Result {
    if (!this.deps.teams?.save) return { ok: false, error: 'Teams are not running on this server.' };
    const team = this.deps.teams.list().teams.find((t) => t.id === teamId);
    if (!team) return { ok: false, error: 'No team by that id.' };
    if (!this.canChangeTeam(caller, team)) return { ok: false, error: `Only people who manage someone on ${team.name} can change it.` };
    if (patch.budgetUSDPerTask !== undefined && (!Number.isFinite(patch.budgetUSDPerTask) || patch.budgetUSDPerTask <= 0)) return { ok: false, error: 'Set a budget per task above $0.' };
    if (patch.guidance !== undefined && patch.guidance.trim().length > TEAM_GUIDANCE_MAX) return { ok: false, error: `Keep the guidance under ${TEAM_GUIDANCE_MAX.toLocaleString()} characters.` };
    if (patch.avatarUrl && !/^https:\/\/\S{1,500}$/.test(patch.avatarUrl.trim())) return { ok: false, error: 'The picture must be an https:// image link.' };
    const { piecesAskFirst: _was, avatarUrl: _pic, ...rest } = team;
    const saved = this.deps.teams.save({
      ...rest,
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(team.checkpoints ?? {}), ...(patch.checkpoints ?? {}) },
      ...(patch.budgetUSDPerTask !== undefined ? { budgetUSDPerTask: Math.round(patch.budgetUSDPerTask * 100) / 100 } : {}),
      ...((patch.piecesAskFirst ?? team.piecesAskFirst !== false) ? {} : { piecesAskFirst: false }),
      ...(patch.guidance !== undefined ? { guidance: patch.guidance } : {}),
      ...((patch.avatarUrl === undefined ? team.avatarUrl : patch.avatarUrl?.trim()) ? { avatarUrl: (patch.avatarUrl === undefined ? team.avatarUrl : patch.avatarUrl!.trim())! } : {}),
    });
    if (!saved.ok) return saved;
    if (patch.guidance !== undefined && patch.guidance.trim() !== (team.guidance ?? '')) {
      this.record(caller, patch.guidance.trim() ? `Changed how ${team.name} works.` : `Cleared ${team.name}'s guidance.`);
    }
    if (patch.piecesAskFirst !== undefined && patch.piecesAskFirst !== (team.piecesAskFirst !== false)) {
      this.record(caller, patch.piecesAskFirst ? `${team.name}'s members ask again before acting outside their sandbox.` : `${team.name}'s members act outside their sandbox without asking on its tasks.`);
    }
    return { ok: true };
  }

  private canChangeTeam(caller: OrgCaller, team: Team): boolean {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    return isAdmin(policy, caller) || team.members.some((m) => canManage(policy, roster, m.workerId, caller));
  }

  /// Create or update the server's copy, every member now here.
  private landTeam(localTeamId: string, shape: TeamPublishShape): Result<{ team: Team }> {
    const state = this.publishedState();
    const members = shape.members.map((m) => ({ workerId: state.workers[m.localId], role: m.role }));
    if (members.some((m) => !m.workerId || !this.deps.workers.get(m.workerId))) return { ok: false, error: 'A member of this team is no longer on the org.' };
    const priorId = state.teams[localTeamId];
    const prior = priorId ? this.deps.teams?.list().teams.find((t) => t.id === priorId) : undefined;
    const saved = this.deps.teams!.save!({
      ...(prior ? { id: prior.id } : {}),
      name: shape.name,
      ...(shape.purpose ? { purpose: shape.purpose } : {}),
      // The project it worked in is a folder on someone's laptop: here each
      // member works in their own until someone picks one of the server's.
      ...(prior?.projectPath ? { projectPath: prior.projectPath } : {}),
      ...(shape.piecesAskFirst === false ? { piecesAskFirst: false } : {}),
      members,
      budgetUSDPerTask: shape.budgetUSDPerTask,
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(prior?.checkpoints ?? {}), ...(shape.checkpoints ?? {}) },
    });
    if (!saved.ok) return saved;
    const after = this.publishedState();
    after.teams[localTeamId] = saved.team.id;
    this.savePublished(after);
    return saved;
  }

  /// A published worker landed (at once, or when approved): remember it, and
  /// finish any team that was only waiting for it.
  private landedPublished(localId: string, hireId: string, workerId: UUID): void {
    const state = this.publishedState();
    state.workers[localId] = workerId;
    const ready: typeof state.waiting = [];
    for (const w of state.waiting) {
      if (w.waiting[localId] === hireId) delete w.waiting[localId];
      if (Object.keys(w.waiting).length === 0) ready.push(w);
    }
    state.waiting = state.waiting.filter((w) => !ready.includes(w));
    this.savePublished(state);
    for (const w of ready) {
      const saved = this.landTeam(w.localTeamId, w.team);
      const who: OrgCaller = { name: w.by.name, ...(w.by.slackUserId ? { slackUserId: w.by.slackUserId } : {}), admin: false };
      this.record(who, saved.ok ? `The team ${w.team.name} is on the org: its last member was approved.` : `The team ${w.team.name} could not be made: ${saved.error}`);
    }
  }

  /// A member was turned down: the team it was waiting for is not made.
  private dropTeamsWaitingOn(caller: OrgCaller, hireId: string, memberName: string): void {
    const state = this.publishedState();
    const dropped = state.waiting.filter((w) => Object.values(w.waiting).includes(hireId));
    if (!dropped.length) return;
    state.waiting = state.waiting.filter((w) => !dropped.includes(w));
    this.savePublished(state);
    for (const w of dropped) this.record(caller, `The team ${w.team.name} was not made: ${memberName} was turned down.`);
  }

  // ---- TEAMS ------------------------------------------------------------

  /// Whether the caller is who asked for a task. By Slack id when it has
  /// one; a task given from the console with a key that has none was matched
  /// by nobody, so its plan waited forever with no button anywhere. Such a
  /// task matches by name, and an admin can always steer one nobody else can
  /// reach.
  private askedForTask(task: TeamTask, caller: OrgCaller): boolean {
    const by = task.requestedBy;
    if (!by) return isAdmin(this.policy(), caller);
    if (by.slackUserId) return by.slackUserId === caller.slackUserId;
    return by.name === caller.name || isAdmin(this.policy(), caller);
  }

  private summarizeTask(task: TeamTask, caller: OrgCaller, roster: readonly Worker[]): TeamTaskSummary {
    const names = new Map(roster.map((w) => [w.id, w.name]));
    const waitingOnYou =
      this.askedForTask(task, caller) &&
      (task.status === 'questions' || task.status === 'proposed' || (task.status === 'waiting' && task.waiting?.reason !== 'away'));
    const needs: TeamTaskSummary['needs'] =
      TEAM_NEEDS[task.status] ??
      (task.status === 'waiting'
        ? task.waiting?.reason === 'budget'
          ? 'budget'
          : task.waiting?.reason === 'failed'
            ? 'failed'
            : task.waiting?.reason === 'checkpoint'
              ? 'checkpoint'
              : undefined
        : undefined);
    return {
      ...(task.kind ? { kind: task.kind } : {}),
      ...(task.answered ? { answered: true } : {}),
      id: task.id,
      teamId: task.teamId,
      teamName: task.teamName,
      title: task.title ?? task.brief.slice(0, 80),
      status: task.status,
      ...(task.requestedBy ? { requestedBy: task.requestedBy.name } : {}),
      ...(needs ? { needs } : {}),
      waitingOnYou,
      ...(task.status === 'questions' && task.questions ? { questions: task.questions } : {}),
      ...(task.planNote ? { planNote: task.planNote } : {}),
      ...(task.waiting ? { waitingMessage: task.waiting.message } : {}),
      spentUSD: task.spentUSD,
      budgetUSD: task.budgetUSD,
      stages: task.stages.map((stage, i) => ({
        label: TEAM_STAGE_LABEL[stage.kind as TeamStageKind] ?? stage.kind,
        // From the stage itself: a cancelled or failed task has no stage "now".
        state: stage.status === 'done' || stage.status === 'skipped' ? 'done' : task.status === 'failed' && stage.status === 'failed' ? 'failed' : isTaskActive(task.status) && i === task.stageIndex ? 'now' : i < task.stageIndex ? 'done' : 'next',
        who: isMemberStage(stage.kind as TeamStageKind)
          ? (stage.assignments ?? []).map((a) => names.get(a.workerId) ?? 'a member')
          : ['the coordinator'],
      })),
      ...(task.pack?.summary ? { packSummary: task.pack.summary } : {}),
      ...(task.code
        ? {
            code: {
              branch: task.code.branch,
              repos: task.code.repos.map((r) => ({
                name: r.name,
                ...(r.ahead !== undefined ? { ahead: r.ahead } : {}),
                ...(r.pushed ? { pushed: { ...((r.pushed.url ?? this.newPrLink(r.projectPath, task.code!.branch)) ? { url: r.pushed.url ?? this.newPrLink(r.projectPath, task.code!.branch) } : {}) } } : {}),
              })),
            },
          }
        : {}),
      updatedAt: task.updatedAt,
    };
  }

  /// One team's page: who's on it and what each is doing, and its tasks with
  /// every stage, every member's piece (where it is, what it wrote, an
  /// approval it waits on) and the pack. `now` says what the team is doing
  /// this moment, in a sentence.
  teamPage(caller: OrgCaller, teamIdOrName: string): Result<{
    team: { id: UUID; name: string; purpose?: string; guidance?: string; avatarUrl?: string; budgetUSDPerTask: number; canBrief: boolean; canChange: boolean; checkpoints: TeamCheckpoints; piecesAskFirst: boolean; members: TeamMemberRow[]; knowledge?: { status: 'learning' | 'ready' | 'failed'; updatedAt?: number; taskId?: UUID; error?: string; words?: number; refresh: 'weekly' | 'off' } };
    tasks: TeamTaskDetail[];
    now: { sentence: string; taskId: UUID; waitingOnYou: boolean } | null;
  }> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const key = teamIdOrName.trim().toLowerCase();
    const visible = this.teams(caller);
    const seen = visible.find((t) => t.id === teamIdOrName || t.name.toLowerCase() === key);
    if (!seen) return { ok: false, error: 'No team by that name that you can see.' };
    const all = this.deps.teams.list();
    const team = all.teams.find((t) => t.id === seen.id)!;
    const roster = this.deps.workers.roster();
    const runs = this.deps.runs.listRuns();
    const runsById = new Map(runs.map((r) => [r.id, r]));
    const waiting = this.listWaiting(caller);
    const tasks = all.tasks
      .filter((t) => t.teamId === team.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((t) => this.taskDetail(t, caller, roster, runsById, waiting));
    const members = this.teamMembers(team, all.tasks, roster, runs);
    const first = tasks.find((t) => t.waitingOnYou || t.piecesNeedYou > 0) ?? tasks.find((t) => t.status === 'running' || t.status === 'planning');
    return {
      ok: true,
      team: {
        id: team.id,
        name: team.name,
        ...(team.purpose ? { purpose: team.purpose } : {}),
        ...(team.guidance ? { guidance: team.guidance } : {}),
        ...(team.avatarUrl ? { avatarUrl: team.avatarUrl } : {}),
        budgetUSDPerTask: team.budgetUSDPerTask,
        canBrief: seen.canBrief,
        canChange: this.canChangeTeam(caller, team),
        checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(team.checkpoints ?? {}) },
        piecesAskFirst: team.piecesAskFirst !== false,
        members,
        ...(team.knowledge
          ? {
              knowledge: {
                status: team.knowledge.status,
                refresh: team.knowledgeRefresh ?? 'weekly',
                ...(team.knowledge.updatedAt ? { updatedAt: team.knowledge.updatedAt } : {}),
                ...(team.knowledge.taskId ? { taskId: team.knowledge.taskId } : {}),
                ...(team.knowledge.error ? { error: team.knowledge.error } : {}),
                ...(team.knowledge.body ? { words: team.knowledge.body.split(/\s+/).filter(Boolean).length } : {}),
              },
            }
          : {}),
      },
      tasks,
      now: first ? { sentence: first.nowSentence, taskId: first.id, waitingOnYou: first.waitingOnYou || first.piecesNeedYou > 0 } : null,
    };
  }

  /// A team's members and what each is doing for it now: its piece in a
  /// live task's current stage. The team page and a task page share it.
  private teamMembers(team: Team, tasks: readonly TeamTask[], roster: readonly Worker[], runs: FlowRun[]): TeamMemberRow[] {
    const live = tasks.filter((t) => t.teamId === team.id && !['done', 'cancelled', 'failed'].includes(t.status));
    return team.members.map((m) => {
      const w = roster.find((x) => x.id === m.workerId);
      const piece = live
        .flatMap((t) => (t.stages[t.stageIndex]?.assignments ?? []).filter((a) => a.workerId === m.workerId && (a.status === 'running' || a.status === 'paused')).map((a) => ({ t, a })))
        .at(0);
      return {
        workerId: m.workerId,
        name: w?.name ?? 'a former worker',
        role: m.role,
        state: w ? workerState(w, runs) : ('idle' as WorkerState),
        ...(piece ? { doing: `${piece.t.stages[piece.t.stageIndex].title}: ${piece.a.ask.split(/(?<=[.!?])\s/)[0].slice(0, 140)}` } : {}),
      };
    });
  }

  private taskDetail(task: TeamTask, caller: OrgCaller, roster: readonly Worker[], runsById: Map<string, FlowRun>, waiting: WaitingItem[]): TeamTaskDetail {
    const summary = this.summarizeTask(task, caller, roster);
    const stages = task.stages.map((s, i) => ({
      title: s.title,
      label: TEAM_STAGE_LABEL[s.kind as TeamStageKind] ?? s.kind,
      status: s.status,
      ...(s.ask ? { ask: s.ask } : {}),
      ...(s.file ? { file: s.file } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
      ...(s.error ? { error: s.error } : {}),
      current: i === task.stageIndex,
      pieces: (s.assignments ?? []).map((a) => {
        const run = a.runId ? runsById.get(a.runId) : undefined;
        const steps = run?.flowSnapshot.steps ?? [];
        const at = run ? (run.state.kind === 'running' ? run.state.currentStepId : run.state.kind === 'paused' ? run.state.nextStepId : undefined) : undefined;
        const idx = at ? steps.findIndex((x) => x.id === at) : -1;
        const wait = a.runId ? waiting.find((x) => x.runId === a.runId) : undefined;
        return {
          workerId: a.workerId,
          workerName: a.workerName,
          ask: a.ask,
          status: a.status,
          ...(a.runId ? { runId: a.runId } : {}),
          ...(idx >= 0 ? { step: { index: idx + 1, total: steps.length, name: steps[idx].id } } : {}),
          ...(run?.createdAt ? { startedAt: run.createdAt } : {}),
          ...(run?.costUSD ? { costUSD: run.costUSD } : {}),
          ...(a.file ? { file: a.file } : {}),
          ...(a.error ? { error: a.error } : {}),
          ...(wait ? { waiting: wait } : {}),
        };
      }),
    }));
    const cur = stages[task.stageIndex];
    const busy = cur?.pieces.filter((p) => p.status === 'running') ?? [];
    const asking = cur?.pieces.filter((p) => p.waiting) ?? [];
    const names = (xs: Array<{ workerName: string }>) => (xs.length <= 2 ? xs.map((x) => x.workerName).join(' and ') : `${xs.slice(0, -1).map((x) => x.workerName).join(', ')} and ${xs.at(-1)!.workerName}`);
    const nowSentence =
      task.status === 'queued'
        ? `Up next: ${task.teamName} starts this when it finishes the task it's on.`
        : task.status === 'planning'
        ? `${task.teamName}'s coordinator is planning "${summary.title}".`
        : task.status === 'questions'
          ? `${task.teamName}'s coordinator has ${task.questions?.length ?? 0} question${task.questions?.length === 1 ? '' : 's'} for you before it plans.`
          : task.status === 'proposed'
            ? `${task.teamName} is waiting for your OK on the plan for "${summary.title}".`
            : asking.length
              ? `${names(asking)} ${asking.length === 1 ? 'is' : 'are'} waiting for your OK (stage ${task.stageIndex + 1} of ${stages.length}, ${cur.label.toLowerCase()}).`
              : task.status === 'running' && cur
                ? busy.length
                  ? `${names(busy)} ${busy.length === 1 ? 'is' : 'are'} on stage ${task.stageIndex + 1} of ${stages.length}, ${cur.label.toLowerCase()}, of "${summary.title}".`
                  : `The coordinator is on stage ${task.stageIndex + 1} of ${stages.length}, ${cur.label.toLowerCase()}, of "${summary.title}".`
                : task.status === 'waiting'
                  ? task.waiting?.message ?? `${task.teamName} is waiting.`
                  : `"${summary.title}" is ${task.status}.`;
    return {
      ...summary,
      piecesNeedYou: asking.filter((p) => p.waiting && (isAdmin(this.policy(), caller) || managesDirectly(roster, p.workerId, caller))).length,
      brief: task.brief,
      createdAt: task.createdAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.deliverables?.length ? { deliverables: task.deliverables } : {}),
      ...(task.answers?.length ? { answers: task.answers } : {}),
      ...(task.error ? { error: task.error } : {}),
      files: task.files.map((f) => ({ name: f.name, author: f.author, at: f.at })),
      ...(task.pack ? { pack: { summary: task.pack.summary, files: task.pack.files } } : {}),
      stagesDetail: stages,
      nowSentence,
    };
  }

  /// One of a team task's shared files, for whoever can see the team.
  teamTaskFile(caller: OrgCaller, taskId: UUID, name: string): Result<{ name: string; body: string }> {
    const teams = this.deps.teams;
    if (!teams?.readFile) return { ok: false, error: 'Team files are not available here.' };
    const task = teams.list().tasks.find((t) => t.id === taskId);
    if (!task || !this.teams(caller, { disbanded: true }).some((t) => t.id === task.teamId)) return { ok: false, error: 'No team task with that id.' };
    const res = teams.readFile(taskId, name);
    return res.ok ? { ok: true, name, body: res.body.slice(0, 200_000) } : res;
  }

  // ---- TEAM TASK FILES -------------------------------------------------

  private memoryKept: KeptFile[] = [];
  private memorySaved: SavedFile[] = [];
  private toolLists = new Map<string, { at: number; res: Awaited<ReturnType<NonNullable<OrgServiceDeps['serverToolSchemas']>>> }>();

  private keptFiles(): KeptFile[] {
    return this.deps.teamFiles?.kept() ?? this.memoryKept;
  }

  private setKept(all: KeptFile[]): void {
    if (this.deps.teamFiles) this.deps.teamFiles.saveKept(all);
    else this.memoryKept = all;
  }

  private savedFiles(): SavedFile[] {
    return this.deps.teamFiles?.saved() ?? this.memorySaved;
  }

  private setSaved(all: SavedFile[]): void {
    if (this.deps.teamFiles) this.deps.teamFiles.saveSaved(all);
    else this.memorySaved = all;
  }

  /// A team task the caller can see, with its team and the whole list —
  /// the same rule as teamTaskFile and teamPage.
  private visibleTask(caller: OrgCaller, taskId: UUID): { task: TeamTask; team: Team; all: { teams: Team[]; tasks: TeamTask[] } } | null {
    if (!this.deps.teams) return null;
    const all = this.deps.teams.list();
    const task = all.tasks.find((t) => t.id === taskId);
    if (!task || !this.teams(caller, { disbanded: true }).some((t) => t.id === task.teamId)) return null;
    const team = all.teams.find((t) => t.id === task.teamId);
    return team ? { task, team, all } : null;
  }

  /// One team task on its own page: the task exactly as the team page shows
  /// it, and the team it belongs to.
  teamTaskPage(caller: OrgCaller, taskId: UUID): Result<{ team: { id: UUID; name: string; purpose?: string; members: TeamMemberRow[] }; task: TeamTaskDetail }> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const found = this.visibleTask(caller, taskId);
    if (!found) return { ok: false, error: 'No team task with that id.' };
    const { task, team, all } = found;
    const roster = this.deps.workers.roster();
    const runs = this.deps.runs.listRuns();
    const runsById = new Map(runs.map((r) => [r.id, r]));
    return {
      ok: true,
      team: { id: team.id, name: team.name, ...(team.purpose ? { purpose: team.purpose } : {}), members: this.teamMembers(team, all.tasks, roster, runs) },
      task: this.taskDetail(task, caller, roster, runsById, this.listWaiting(caller)),
    };
  }

  /// Who wrote each of a task's files, and in which stage: a member's piece,
  /// a coordinator stage's file, else what the task's file list says.
  private fileOrigins(task: TeamTask): Map<string, Pick<TeamTaskFileRow, 'writtenBy' | 'stage'>> {
    const out = new Map<string, Pick<TeamTaskFileRow, 'writtenBy' | 'stage'>>();
    const members = new Map<string, { workerId: string; name: string }>();
    task.stages.forEach((s, i) => {
      const stage = { index: i + 1, title: s.title };
      for (const a of s.assignments ?? []) {
        members.set(a.workerName.toLowerCase(), { workerId: a.workerId, name: a.workerName });
        if (a.file && !out.has(a.file)) out.set(a.file, { writtenBy: { workerId: a.workerId, name: a.workerName }, stage });
      }
      if (s.file && !out.has(s.file)) out.set(s.file, { writtenBy: null, stage });
    });
    for (const f of task.files) {
      if (out.has(f.name)) continue;
      const st = f.stage !== undefined ? task.stages[f.stage] : undefined;
      out.set(f.name, { writtenBy: members.get(f.author.toLowerCase()) ?? null, stage: st ? { index: f.stage! + 1, title: st.title } : null });
    }
    return out;
  }

  /// Everything in a task's shared folder, newest first — who wrote each,
  /// in which stage, and where it has been kept — and where it can go.
  async teamTaskFiles(caller: OrgCaller, taskId: UUID): Promise<Result<{ files: TeamTaskFileRow[]; destinations: FileDestination[] }>> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const found = this.visibleTask(caller, taskId);
    if (!found) return { ok: false, error: 'No team task with that id.' };
    const { task } = found;
    const origins = this.fileOrigins(task);
    const kept = new Set(this.keptFiles().filter((k) => k.taskId === task.id).map((k) => k.name));
    // A file saved to someone's own Drive is theirs to see listed: the link
    // opens only for them anyway.
    const me = personKey(caller);
    const saved = this.savedFiles().filter((x) => x.taskId === task.id && (!x.person || x.person === me));
    const files = (task.folder ? listFolder(task.folder) : []).map((f) => {
      const o = origins.get(f.name);
      return {
        ...f,
        writtenBy: o?.writtenBy ?? null,
        stage: o?.stage ?? null,
        kept: {
          library: kept.has(f.name),
          saved: saved.filter((x) => x.name === f.name).map((x) => ({ destination: x.destination, label: x.label, at: x.at, ...(x.link ? { link: x.link } : {}) })),
        },
      };
    });
    const destinations = (await this.fileDestinations(caller)).map(({ id, label, kind, ready, why }) => ({ id, label, kind, ready, ...(why ? { why } : {}) }));
    return { ok: true, files, destinations };
  }

  /// A server's tools with their schemas, remembered a few minutes: asking
  /// starts the server.
  private async serverToolList(name: string) {
    const hit = this.toolLists.get(name);
    if (hit && this.now() - hit.at < (hit.res.ok ? 5 * 60_000 : 30_000)) return hit.res;
    const res = await this.deps.serverToolSchemas!(name);
    this.toolLists.set(name, { at: this.now(), res });
    return res;
  }

  /// Where a team file can be kept: the Library always, and a Drive or
  /// SharePoint for each installed tool that looks like one (ready when it
  /// has a call that uploads a file). Drive and SharePoint are listed even
  /// with no tool for them, not ready, so the console can offer to connect.
  private async fileDestinations(caller?: OrgCaller): Promise<Array<FileDestination & { server?: string; tool?: { name: string; inputSchema?: unknown } }>> {
    const out: Array<FileDestination & { server?: string; tool?: { name: string; inputSchema?: unknown } }> = [{ id: 'library', label: 'Library', kind: 'library', ready: true }];
    // The caller's own Drive, through the Google account they connected.
    const own = caller && this.deps.connections ? await this.deps.connections.status(caller).catch(() => null) : null;
    if (own) out.push({ id: GOOGLE_ME, label: YOUR_DRIVE, kind: 'drive', ready: own.connected, ...(own.connected ? {} : { why: own.why ?? 'Connect your Google account first.' }) });
    const installed = this.deps.tools?.list([]).tools.map((t) => t.name) ?? [];
    const seen = { drive: false, sharepoint: false };
    const found = await Promise.all(
      installed.map(async (server) => {
        const kind = classifyServer(server);
        if (!kind) return null;
        seen[kind] = true;
        const who = connectorName(server);
        const label = `${kind === 'drive' ? 'Google Drive' : 'SharePoint'} (${who})`;
        const base = { id: `mcp:${server}`, label, kind, server };
        if (!this.deps.serverToolSchemas || !this.deps.callServerTool) return { ...base, ready: false, why: 'Tools cannot be called from this server.' };
        const listed = await this.serverToolList(server);
        if (!listed.ok) return { ...base, ready: false, why: `${who} did not answer: ${listed.error}` };
        const tool = pickUploadTool(listed.tools);
        if (!tool) return { ...base, ready: false, why: `${who} has no tool that uploads a file.` };
        return { ...base, ready: true, tool: { name: tool.name, ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}) } };
      }),
    );
    for (const d of found) if (d) out.push(d);
    if (!seen.drive && !own) out.push({ id: 'drive', label: 'Google Drive', kind: 'drive', ready: false, why: 'Install a Google Drive tool on Setup → Tools' });
    if (!seen.sharepoint) out.push({ id: 'sharepoint', label: 'SharePoint', kind: 'sharepoint', ready: false, why: 'Install a SharePoint or OneDrive tool on Setup → Tools' });
    return out;
  }

  private wantedNames(names: unknown): string[] {
    return [...new Set((Array.isArray(names) ? names : []).filter((n): n is string => typeof n === 'string').map((n) => n.trim()).filter(Boolean))].slice(0, 200);
  }

  /// Put files of a task into the Library: `added` is how many were new.
  private keepInto(caller: OrgCaller, found: { task: TeamTask; team: Team }, names: string[]): { added: number; missing: string[] } {
    const { task, team } = found;
    const origins = this.fileOrigins(task);
    const all = [...this.keptFiles()];
    const missing: string[] = [];
    let added = 0;
    for (const name of names) {
      const buf = task.folder ? readInFolder(task.folder, name) : null;
      if (!buf) {
        missing.push(name);
        continue;
      }
      if (all.some((k) => k.taskId === task.id && k.name === name)) continue;
      const text = isText(buf) ? buf.toString('utf8') : '';
      const writer = origins.get(name)?.writtenBy;
      all.push({
        id: randomUUID(),
        taskId: task.id,
        teamId: team.id,
        teamName: team.name,
        name,
        title: fileTitle(name, text),
        body: text.slice(0, 6000),
        ...(writer ? { writer } : {}),
        by: caller.name,
        ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
        at: this.now(),
      });
      added++;
    }
    if (added) {
      this.setKept(all);
      this.record(caller, `Kept ${added} file${added === 1 ? '' : 's'} from ${team.name}'s "${task.title ?? task.brief.slice(0, 80)}" in the Library.`);
    }
    return { added, missing };
  }

  /// Keep a task's files in the Library, where they can be found and rated.
  /// Keeping one twice changes nothing.
  keepTeamFiles(caller: OrgCaller, taskId: UUID, names: unknown): Result<{ kept: number }> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const found = this.visibleTask(caller, taskId);
    if (!found) return { ok: false, error: 'No team task with that id.' };
    const wanted = this.wantedNames(names);
    if (!wanted.length) return { ok: false, error: 'Say which files to keep.' };
    const missing = wanted.filter((n) => !found.task.folder || !readInFolder(found.task.folder, n));
    if (missing.length) return { ok: false, error: `No file named ${missing.map((n) => `"${n}"`).join(', ')} in this task.` };
    return { ok: true, kept: this.keepInto(caller, found, wanted).added };
  }

  /// Save a task's files somewhere: the Library, or a Drive or SharePoint
  /// through its installed tool, called directly. A file that fails says why;
  /// the rest still go.
  async saveTeamFiles(caller: OrgCaller, taskId: UUID, names: unknown, destination: string): Promise<Result<{ saved: Array<{ name: string; link?: string }>; failed: Array<{ name: string; error: string }> }>> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const found = this.visibleTask(caller, taskId);
    if (!found) return { ok: false, error: 'No team task with that id.' };
    const wanted = this.wantedNames(names);
    if (!wanted.length) return { ok: false, error: 'Say which files to save.' };
    const { task, team } = found;
    if (destination === 'library') {
      const { missing } = this.keepInto(caller, found, wanted);
      return { ok: true, saved: wanted.filter((n) => !missing.includes(n)).map((name) => ({ name })), failed: missing.map((name) => ({ name, error: 'No such file in this task.' })) };
    }
    if (destination === GOOGLE_ME) return this.saveToOwnDrive(caller, found, wanted);
    let dests: Awaited<ReturnType<OrgService['fileDestinations']>>;
    try {
      dests = await this.fileDestinations();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const dest = dests.find((d) => d.id === destination);
    if (!dest) return { ok: false, error: 'No place to save by that name.' };
    if (!dest.ready || !dest.server || !dest.tool || !this.deps.callServerTool) return { ok: false, error: dest.why ?? `${dest.label} isn't ready.` };
    const saved: Array<{ name: string; link?: string }> = [];
    const failed: Array<{ name: string; error: string }> = [];
    const records: SavedFile[] = [];
    for (const name of wanted) {
      const buf = task.folder ? readInFolder(task.folder, name) : null;
      if (!buf) {
        failed.push({ name, error: 'No such file in this task.' });
        continue;
      }
      if (!isText(buf)) {
        failed.push({ name, error: `Only text files can be saved to ${dest.label} for now.` });
        continue;
      }
      const { args, missing } = uploadArgs(dest.tool.inputSchema, name, buf.toString('utf8'));
      if (missing.length) {
        failed.push({ name, error: `${dest.tool.name} on ${dest.server} also needs ${missing.join(', ')}, which overcli can't fill in.` });
        continue;
      }
      let call: ToolCall;
      try {
        call = await this.deps.callServerTool(dest.server, dest.tool.name, args);
      } catch (err) {
        call = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!call.ok) {
        failed.push({ name, error: call.error || 'The tool reported an error.' });
        continue;
      }
      const link = linkFrom(call);
      saved.push({ name, ...(link ? { link } : {}) });
      records.push({ taskId: task.id, name, destination: dest.id, label: dest.label, at: this.now(), ...(link ? { link } : {}), by: caller.name });
    }
    if (records.length) {
      this.setSaved([...this.savedFiles(), ...records]);
      this.record(caller, `Saved ${records.length} file${records.length === 1 ? '' : 's'} from ${team.name}'s "${task.title ?? task.brief.slice(0, 80)}" to ${dest.label}.`);
    }
    return { ok: true, saved, failed };
  }

  /// Save files into the caller's own Google Drive, as them. Text files
  /// only, as through a tool.
  private async saveToOwnDrive(caller: OrgCaller, found: { task: TeamTask; team: Team }, wanted: string[]): Promise<Result<{ saved: Array<{ name: string; link?: string }>; failed: Array<{ name: string; error: string }> }>> {
    const connections = this.deps.connections;
    if (!connections) return { ok: false, error: 'No place to save by that name.' };
    const own = await connections.status(caller);
    if (!own.connected) return { ok: false, error: own.why ?? 'Connect your Google account first.' };
    const { task, team } = found;
    const saved: Array<{ name: string; link?: string }> = [];
    const failed: Array<{ name: string; error: string }> = [];
    const records: SavedFile[] = [];
    for (const name of wanted) {
      const buf = task.folder ? readInFolder(task.folder, name) : null;
      if (!buf) {
        failed.push({ name, error: 'No such file in this task.' });
        continue;
      }
      if (!isText(buf)) {
        failed.push({ name, error: `Only text files can be saved to ${YOUR_DRIVE} for now.` });
        continue;
      }
      const up = await connections.upload(caller, { name, mimeType: mimeFor(name), data: buf });
      if (!up.ok) {
        failed.push({ name, error: up.error });
        continue;
      }
      saved.push({ name, ...(up.link ? { link: up.link } : {}) });
      records.push({ taskId: task.id, name, destination: GOOGLE_ME, label: YOUR_DRIVE, at: this.now(), ...(up.link ? { link: up.link } : {}), by: caller.name, person: personKey(caller) });
    }
    if (records.length) {
      this.setSaved([...this.savedFiles(), ...records]);
      this.record(caller, `Saved ${records.length} file${records.length === 1 ? '' : 's'} from ${team.name}'s "${task.title ?? task.brief.slice(0, 80)}" to their own Google Drive.`);
    }
    return { ok: true, saved, failed };
  }

  /// A task's whole shared folder as one zip, named after the task.
  teamTaskZip(caller: OrgCaller, taskId: UUID): Result<{ filename: string; data: Buffer }> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const found = this.visibleTask(caller, taskId);
    if (!found) return { ok: false, error: 'No team task with that id.' };
    const { task } = found;
    const entries: ZipEntry[] = [];
    let bytes = 0;
    for (const f of task.folder ? listFolder(task.folder) : []) {
      const data = readInFolder(task.folder, f.name);
      if (!data) continue;
      bytes += data.length;
      if (bytes > 500 * 1024 * 1024) return { ok: false, error: 'This task folder is too big to download as one zip.' };
      entries.push({ name: f.name, data, modifiedAt: f.modifiedAt });
    }
    if (!entries.length) return { ok: false, error: 'This task has no files yet.' };
    return { ok: true, filename: `${slugFor(task.title ?? task.brief.slice(0, 80))}.zip`, data: buildZip(entries) };
  }

  /// Teams the caller can see: any team with a member they can see.
  /// The teams someone can see: those with a member they can see. A
  /// disbanded team only with `disbanded`, for what it delivered (the
  /// Library, its task pages): it takes no work and lists nowhere.
  teams(caller: OrgCaller, opts: { disbanded?: boolean } = {}): Array<{ id: UUID; name: string; purpose?: string; avatarUrl?: string; members: Array<{ name: string; role: string }>; canBrief: boolean }> {
    if (!this.deps.teams) return [];
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const names = new Map(roster.map((w) => [w.id, w.name]));
    return this.deps.teams
      .list()
      .teams.filter((t) => (opts.disbanded || !t.disbanded) && t.members.some((m) => canSee(policy, roster, m.workerId, caller)))
      .map((t) => ({
        id: t.id,
        name: t.name,
        ...(t.purpose ? { purpose: t.purpose } : {}),
        ...(t.avatarUrl ? { avatarUrl: t.avatarUrl } : {}),
        members: t.members.map((m) => ({ name: names.get(m.workerId) ?? 'a former worker', role: m.role })),
        canBrief: isAdmin(policy, caller) || t.members.some((m) => canManage(policy, roster, m.workerId, caller)),
      }));
  }

  teamTasks(caller: OrgCaller): TeamTaskSummary[] {
    if (!this.deps.teams) return [];
    const roster = this.deps.workers.roster();
    const visible = new Set(this.teams(caller).map((t) => t.id));
    return this.deps.teams
      .list()
      .tasks.filter((t) => visible.has(t.teamId))
      .map((t) => this.summarizeTask(t, caller, roster))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40);
  }

  /// Give a team a task. Anyone who manages one of its members may.
  briefTeam(caller: OrgCaller, teamIdOrName: string, text: string): Result<{ task: TeamTaskSummary }> {
    if (!this.deps.teams) return { ok: false, error: 'Teams are not running on this server.' };
    const key = teamIdOrName.trim().toLowerCase();
    const team = this.teams(caller).find((t) => t.id === teamIdOrName || t.name.toLowerCase() === key);
    if (!team) return { ok: false, error: 'No team by that name that you can see.' };
    if (!team.canBrief) return { ok: false, error: `Only people who manage someone on ${team.name} can give it work.` };
    const res = this.deps.teams.brief(team.id, text, [], undefined, {
      requestedBy: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) },
    });
    if (!res.ok) return res;
    this.record(caller, `Gave ${team.name} a task: "${text.trim().slice(0, 120)}".`);
    return { ok: true, task: this.summarizeTask(res.task, caller, this.deps.workers.roster()) };
  }

  /// Have a team learn (or refresh) what it knows: each member, from its own
  /// tools, then the coordinator writes it up. For whoever can give it work.
  learnTeam(caller: OrgCaller, teamId: string): Result<{ task: TeamTaskSummary }> {
    const teams = this.deps.teams;
    if (!teams?.learn) return { ok: false, error: 'Teams can’t learn on this server.' };
    const team = this.teams(caller).find((t) => t.id === teamId);
    if (!team) return { ok: false, error: 'No team by that name that you can see.' };
    if (!team.canBrief) return { ok: false, error: `Only people who manage someone on ${team.name} can have it learn.` };
    const res = teams.learn(team.id, { requestedBy: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) } });
    if (!res.ok) return res;
    this.record(caller, `Had ${team.name} learn what it needs to know.`);
    return { ok: true, task: this.summarizeTask(res.task, caller, this.deps.workers.roster()) };
  }

  /// Whether what a team knows refreshes weekly, for whoever can change the team.
  setTeamKnowledgeRefresh(caller: OrgCaller, teamId: string, mode: string): Result {
    const teams = this.deps.teams;
    if (!teams?.setKnowledgeRefresh) return { ok: false, error: 'Not available on this server.' };
    if (mode !== 'weekly' && mode !== 'off') return { ok: false, error: 'Weekly, or off.' };
    const team = teams.list().teams.find((t) => t.id === teamId);
    if (!team || !this.teams(caller).some((t) => t.id === teamId)) return { ok: false, error: 'No team by that name that you can see.' };
    if (!this.canChangeTeam(caller, team)) return { ok: false, error: `Only people who manage someone on ${team.name} can change that.` };
    const res = teams.setKnowledgeRefresh(team.id, mode);
    if (res.ok) this.record(caller, `Set ${team.name} to refresh what it knows ${mode === 'weekly' ? 'weekly' : 'only when asked'}.`);
    return res;
  }

  /// A worker's or team's picture, by id: what Slack posts it under. Its
  /// initials when nobody picked one.
  pictureOf(id: string): string | undefined {
    const w = this.deps.workers.get(id);
    if (w) return w.avatarUrl ?? initialsPicture(w.id, w.name);
    const t = this.deps.teams?.list().teams.find((x) => x.id === id);
    return t ? (t.avatarUrl ?? initialsPicture(t.id, t.name)) : undefined;
  }

  /// Retire a team: its open work cancelled, and it takes no more, but what
  /// it delivered stays in the Library for the people who could see it. Its
  /// members stay hired. For whoever may change it.
  disbandTeam(caller: OrgCaller, teamId: string): Result<{ cancelled: number }> {
    const teams = this.deps.teams;
    if (!teams?.disband) return { ok: false, error: 'Teams can’t be disbanded on this server.' };
    const team = teams.list().teams.find((t) => t.id === teamId && !t.disbanded);
    if (!team || !this.teams(caller).some((t) => t.id === teamId)) return { ok: false, error: 'No team by that name that you can see.' };
    if (!this.canChangeTeam(caller, team)) return { ok: false, error: `Only people who manage someone on ${team.name} can disband it.` };
    const res = teams.disband(team.id, caller.name);
    if (!res.ok) return res;
    this.record(caller, `Disbanded ${team.name}${res.cancelled ? `, cancelling ${res.cancelled === 1 ? 'its open task' : `${res.cancelled} open tasks`}` : ''}. What it delivered stays in the Library.`);
    return res;
  }

  /// Delete a team for good, with every task it ran and their files. An
  /// admin's call: unlike disbanding, its work leaves the Library too.
  deleteTeam(caller: OrgCaller, teamId: string): Result {
    const teams = this.deps.teams;
    if (!teams?.remove) return { ok: false, error: 'Teams can’t be deleted on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can delete a team and its work. You can disband it instead.' };
    const team = teams.list().teams.find((t) => t.id === teamId);
    if (!team) return { ok: false, error: 'No team by that name.' };
    for (const t of teams.list().tasks) {
      if (t.teamId === teamId && isTaskActive(t.status)) teams.cancel(t.id);
    }
    const res = teams.remove(team.id);
    if (!res.ok) return res;
    this.record(caller, `Deleted ${team.name} and everything it delivered.`);
    return { ok: true };
  }

  /// What a team knows, whole, for whoever can see the team.
  teamKnowledge(caller: OrgCaller, teamId: string): Result<{ body: string; updatedAt?: number }> {
    if (!this.deps.teams || !this.teams(caller).some((t) => t.id === teamId)) return { ok: false, error: 'No team by that name that you can see.' };
    const k = this.deps.teams.list().teams.find((t) => t.id === teamId)?.knowledge;
    if (!k?.body) return { ok: false, error: 'This team hasn’t learned anything yet.' };
    return { ok: true, body: k.body, ...(k.updatedAt ? { updatedAt: k.updatedAt } : {}) };
  }

  /// Answer a team's questions, approve or change its plan, carry on past a
  /// checkpoint, or cancel — for whoever asked for the task, or an admin.
  decideTeamTask(
    caller: OrgCaller,
    taskId: UUID,
    action: { kind: 'answer'; answers: string[] } | { kind: 'approve' } | { kind: 'revise'; feedback: string } | { kind: 'continue' } | { kind: 'cancel' } | { kind: 'retryPiece'; workerId: string } | { kind: 'accept' } | { kind: 'plan' },
  ): Result {
    const teams = this.deps.teams;
    if (!teams) return { ok: false, error: 'Teams are not running on this server.' };
    const task = teams.list().tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: 'No team task with that id.' };
    const own = this.askedForTask(task, caller);
    if (!own && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only the person who asked for this task, or an admin, can steer it.' };
    const res =
      action.kind === 'plan'
        ? teams.planAsTask
          ? teams.planAsTask(taskId)
          : { ok: false as const, error: 'Planning it again isn’t available here.' }
        : action.kind === 'accept'
        ? teams.accept
          ? teams.accept(taskId)
          : { ok: false as const, error: 'Accepting a pack isn’t available here.' }
        : action.kind === 'retryPiece'
        ? teams.retryPiece
          ? teams.retryPiece(taskId, action.workerId)
          : { ok: false as const, error: 'Retrying a piece isn’t available here.' }
        : action.kind === 'answer'
        ? teams.answer(taskId, action.answers)
        : action.kind === 'approve'
          ? teams.approve(taskId)
          : action.kind === 'revise'
            ? teams.revise(taskId, action.feedback)
            : action.kind === 'continue'
              ? teams.continueTask(taskId)
              : teams.cancel(taskId);
    if (res.ok) {
      const verb = { answer: 'Answered', approve: 'Approved the plan for', revise: 'Asked for changes to', continue: 'Continued', cancel: 'Cancelled', retryPiece: 'Retried a piece of', accept: 'Accepted the pack of', plan: 'Asked again as work' }[action.kind];
      this.record(caller, `${verb} ${task.teamName}'s task "${task.title ?? task.brief.slice(0, 60)}".`);
    }
    return res;
  }

  /// The page that opens a pull request from `branch`, for a connected repo.
  private newPrLink(projectPath: string, branch: string): string | undefined {
    const repo = this.deps.repos?.list().find((r) => r.path === projectPath);
    return repo ? newPullRequestLink(repo, branch) ?? undefined : undefined;
  }

  /// Push a finished team task's branch from every repo it changed, and hand
  /// back one link per repo to open its pull request. Whoever asked for the
  /// task, or an admin.
  pushTeamCode(caller: OrgCaller, taskId: UUID): Result<{ pushed: Array<{ repo: string; url?: string }>; failed: Array<{ repo: string; error: string }> }> {
    const teams = this.deps.teams;
    if (!teams?.pushCode) return { ok: false, error: 'Teams can’t push code on this server.' };
    const task = teams.list().tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: 'No team task with that id.' };
    const own = !!caller.slackUserId && task.requestedBy?.slackUserId === caller.slackUserId;
    if (!own && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only the person who asked for this task, or an admin, can push its code.' };
    if (!task.code) return { ok: false, error: 'This task changed no code.' };
    const pushed: Array<{ repo: string; url?: string }> = [];
    const failed: Array<{ repo: string; error: string }> = [];
    for (const r of task.code.repos) {
      if (r.pushed || r.ahead === 0) continue;
      const res = teams.pushCode(taskId, r.projectPath);
      if (!res.ok) failed.push({ repo: r.name, error: res.error });
      else {
        const url = res.url ?? this.newPrLink(r.projectPath, task.code.branch);
        pushed.push({ repo: r.name, ...(url ? { url } : {}) });
      }
    }
    if (!pushed.length && !failed.length) return { ok: false, error: 'Nothing left to push: every repo with changes is already pushed.' };
    if (pushed.length) this.record(caller, `Pushed ${task.teamName}'s branch ${task.code.branch} in ${pushed.map((p) => p.repo).join(', ')}.`);
    return { ok: true, pushed, failed };
  }

  // ---- ADMIN ------------------------------------------------------------

  /// Names for Slack ids, from tokens and managers the plane knows; the id
  /// itself when nobody has given a name for it.
  private namesFor(ids: readonly string[]): string[] {
    const known = new Map<string, string>();
    for (const t of this.deps.people?.() ?? []) if (t.slackUserId) known.set(t.slackUserId, t.name);
    for (const w of this.deps.workers.roster()) if (w.manager?.slackUserId) known.set(w.manager.slackUserId, w.manager.name);
    return ids.map((id) => known.get(id) ?? id);
  }

  people(caller: OrgCaller): Result<{ people: PersonRow[] }> {
    const policy = this.policy();
    if (!isAdmin(policy, caller)) return { ok: false, error: 'Only admins can see everyone.' };
    const roster = this.deps.workers.roster();
    const spent = this.deps.workers.spentThisMonth();
    const approvers = approversFor(policy);
    const rows = new Map<string, PersonRow>();
    const key = (p: { name: string; slackUserId?: string }) => p.slackUserId ?? `name:${p.name}`;
    const roleOf = (id?: string, admin = false): PersonRow['role'] =>
      admin || (id && policy.admins.includes(id))
        ? 'Admin'
        : id && approvers.includes(id)
          ? 'Approver'
          : id && (policy.hirers === '*' || policy.hirers.includes(id))
            ? 'Hirer'
            : 'Member';
    for (const t of this.deps.people?.() ?? []) {
      const prev = rows.get(key(t));
      const device = t.id ? [{ id: t.id, where: t.device ?? 'Token', ...(t.lastUsedAt ? { lastUsedAt: t.lastUsedAt } : {}) }] : [];
      rows.set(key(t), {
        name: prev?.name ?? t.name,
        ...(t.slackUserId ? { slackUserId: t.slackUserId, allowanceUSD: allowanceFor(policy, t.slackUserId) } : {}),
        role: prev?.role === 'Admin' ? 'Admin' : roleOf(t.slackUserId, t.admin),
        workers: 0,
        spentUSD: 0,
        lastSeen: Math.max(prev?.lastSeen ?? 0, t.lastUsedAt ?? 0) || undefined,
        devices: [...(prev?.devices ?? []), ...device],
      });
    }
    for (const id of [...policy.admins, ...policy.approvers, ...(policy.hirers === '*' ? [] : policy.hirers)]) {
      if (!rows.has(id)) rows.set(id, { name: this.namesFor([id])[0], slackUserId: id, allowanceUSD: allowanceFor(policy, id), role: roleOf(id), workers: 0, spentUSD: 0, devices: [] });
    }
    // Whole branches, as spend-by-manager counts them: the person a worker
    // answers to, inherited through its boss when it has no manager of its own.
    for (const w of roster) {
      const m = managerFor(roster, w.id);
      if (!m) continue;
      const row = rows.get(key(m)) ?? {
        name: m.name,
        ...(m.slackUserId ? { slackUserId: m.slackUserId, allowanceUSD: allowanceFor(policy, m.slackUserId) } : {}),
        role: roleOf(m.slackUserId),
        workers: 0,
        spentUSD: 0,
        devices: [],
      };
      row.workers += 1;
      row.spentUSD += spent.get(w.id) ?? 0;
      rows.set(key(m), row);
    }
    return { ok: true, people: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  health(caller: OrgCaller): Result<{
    items: HealthItem[];
    org: { name?: string; slackTeamId?: string; timezone?: string };
    spend: { spentUSD: number; orgBudgetUSD?: number; byManager: Array<{ name: string; spentUSD: number }>; byTeam: Array<{ name: string; spentUSD: number }> };
    rules: { hirers: string; allowanceUSD: number; approvers: string[]; orgVisibilityNeedsAdmin: boolean; clearedTools: string[]; roles: number; openJoin: boolean; publicUrl?: string };
  }> {
    const policy = this.policy();
    if (!isAdmin(policy, caller)) return { ok: false, error: 'Only admins can see system health.' };
    const roster = this.deps.workers.roster();
    const runs = this.deps.runs.listRuns();
    const states = roster.map((w) => workerState(w, runs));
    const items: HealthItem[] = [
      ...(this.deps.health?.() ?? []),
      {
        name: 'Workers',
        ok: !states.includes('stuck'),
        detail: `${states.filter((s) => s === 'working').length} working, ${states.filter((s) => s === 'waiting').length} waiting on people, ${states.filter((s) => s === 'paused').length} paused, ${states.filter((s) => s === 'stuck').length} stuck.`,
      },
    ];
    const spent = this.deps.workers.spentThisMonth();
    const byManager = new Map<string, number>();
    for (const w of roster) {
      const name = managerFor(roster, w.id)?.name ?? 'Nobody';
      byManager.set(name, (byManager.get(name) ?? 0) + (spent.get(w.id) ?? 0));
    }
    return {
      ok: true,
      items,
      org: {
        ...(policy.name ? { name: policy.name } : {}),
        ...(policy.slackTeamId ? { slackTeamId: policy.slackTeamId } : {}),
        ...(policy.timezone ? { timezone: policy.timezone } : {}),
      },
      spend: {
        spentUSD: [...spent.values()].reduce((a, b) => a + b, 0),
        ...(policy.orgBudgetUSD ? { orgBudgetUSD: policy.orgBudgetUSD } : {}),
        byManager: [...byManager.entries()].map(([name, spentUSD]) => ({ name, spentUSD })).sort((a, b) => b.spentUSD - a.spentUSD),
        // A worker counts toward every team its manager is on.
        byTeam: Object.entries(policy.teams)
          .map(([name, members]) => ({
            name,
            spentUSD: roster
              .filter((w) => {
                const m = managerFor(roster, w.id)?.slackUserId;
                return !!m && members.includes(m);
              })
              .reduce((sum, w) => sum + (spent.get(w.id) ?? 0), 0),
          }))
          .sort((a, b) => b.spentUSD - a.spentUSD),
      },
      rules: {
        hirers: policy.hirers === '*' ? 'Everyone' : policy.hirers.length ? `${policy.hirers.length} people` : 'Admins only',
        allowanceUSD: policy.budgetAllowanceUSD,
        approvers: this.namesFor(approversFor(policy)),
        orgVisibilityNeedsAdmin: policy.orgVisibilityNeedsAdmin,
        clearedTools: policy.allowedMcpServers ?? [],
        roles: policy.roles.length,
        openJoin: policy.openJoin,
        ...(policy.publicUrl ? { publicUrl: policy.publicUrl } : {}),
      },
    };
  }

  /// What the caller is allowed, for a console header or a `whoami` tool.
  whoami(caller: OrgCaller): { org: string; name: string; slackUserId?: string; admin: boolean; canHire: boolean; timezone?: string; allowanceUSD?: number; committedUSD?: number } {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    return {
      org: policy.name ?? 'Your org',
      name: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      admin: isAdmin(policy, caller),
      canHire: canHire(policy, caller),
      ...(policy.timezone ? { timezone: policy.timezone } : {}),
      ...(caller.slackUserId
        ? { allowanceUSD: allowanceFor(policy, caller.slackUserId), committedUSD: committedBudget(roster, caller.slackUserId) }
        : {}),
    };
  }
}
