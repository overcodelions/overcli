// The org control plane: every action a person can take on the workers from
// outside the desktop app — over MCP, from a Slack command, from the web
// console — goes through here, so every one of them asks the same question
// first: may THIS caller do THAT (`shared/org/policy.ts`)?
//
// It holds no state of its own beyond hires in progress. Workers live in the
// worker engine, runs in the runtime; this is a policy gate in front of both,
// returning plain data each surface renders in its own way.

import { KITS, type KitDef, type KitId, type Toolchain, type ToolchainService } from './toolchains';
import { scrubOutbound } from '../secretScrub';
import type { LoginResult } from './toolLogin';
import { generalize, readShape, readToolCall, setupPrompt } from './watchSetup';
import { randomUUID } from 'node:crypto';
import type { Flow, FlowRun, FlowRunState } from '../../shared/flows/schema';
import { applyFlowModelUpgrade, planFlowModelUpgrade, shortModelChangeLabel } from '../../shared/flows/modelUpgrade';
import { rebindMissingBackends } from '../../shared/flows/templateResolver';
import { pickDrafterBackend } from '../../shared/flows/drafterBackend';
import { friendlyModelLabel, newestInFamily, type FlowModelDefaults } from '../../shared/modelCatalog';
import type { RunChanges } from './runChanges';
import { ticketFlowId, ticketFlowYaml, trackerOf } from './ticketFollowUp';
import { flowRunTitle } from '../../shared/flows/schema';
import type { HireMessage, Worker, WorkerErrandResult, WorkerJournalEntry, WorkerTrustLevel, WorkerVisibility } from '../../shared/flows/worker';
import { ANSWERS_AT_ONCE, ANSWERS_AT_ONCE_MAX, WORKER_NOTE_MAX, isCodingWorker, isSlackUserId, validateOrgFields, workerTagline } from '../../shared/flows/worker';
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
  sharesTeam,
  committedBudget,
  hireDecision,
  isAdmin,
  type OrgCaller,
  type OrgPolicy,
  type OrgRole, inAudience, type Audience } from '../../shared/org/policy';
import { buildThreads, nowLine, summarize, type WorkThread } from './workThreads';
import { LANDED_ARTIFACT, pullRequestsIn, type LandedPullRequest } from './landBranches';
import { isReadOnlyMcpTool, parseMcpToolName } from '../../shared/flows/mcpTools';
import { stepsARunGrantCovers } from '../flows/stepEffect';
import { parseFlowYaml, serializeFlow } from '../../shared/flows/yaml';
import { copyFlowId, describeFlowEdit, holdFlowEdit, stepsOf, type FlowStepView } from './flowEdit';
import { initialsPicture } from '../../shared/flows/avatars';
import { describeScope, mcpServerKey, parseToolScope, withinScope, type ToolScope, type ToolScopes } from '../../shared/flows/toolScope';
import { answerOptions, projectMonthEnd, trustReadiness, workerState, type TrustReadiness, type WorkerState } from '../../shared/org/insights';
import type { Team, TeamCheckpoints, TeamComment, TeamHandoff, TeamRosterDraft, TeamStageKind, TeamTask } from '../../shared/flows/team';
import { resolveShortNames } from '../../shared/shortName';
import { DEFAULT_TEAM_CHECKPOINTS, TEAM_GUIDANCE_MAX, TEAM_MAX_MEMBERS, TEAM_STAGE_LABEL, handoffSteps, isMemberStage, isTaskActive } from '../../shared/flows/team';
import { CARRIED_LIMITS, parseWorkerYaml, type PortableTrigger, type WorkerCarried } from '../../shared/flows/workerYaml';
import type { Attachment, Backend, UUID } from '../../shared/types';
import type { DraftedHire, HireDraftResult } from './hireDraft';
import type { ToolInput, ToolSummary, ToolTemplate } from './tools';
import { TOOL_NAME, parseTemplates } from './tools';
import { OverdbOrg, type OverdbDeps } from './overdb';
import { catalogFor, connectorTitle, connectorTool, TOOL_CATALOG, type CatalogTool } from './toolCatalog';
import type { Discovery, SignInSummary } from './toolSignIn';
import type { Deliverable, Destination, TriggerService, WorkerTrigger } from './triggers';
import { argsFor } from './triggers';
import { newPullRequestLink, prFlowId as prFlowIdFor, prFlowYaml as prFlowFor, workspaceFlowId, workspaceFlowYaml, type ConnectedRepo, type OrgWorkspace } from './repos';
import type { ModelProvider, SecretStatus } from './secrets/service';
import type { ToolTrouble } from './toolHealth';
import { HANDBOOK_MAX, WORKER_VERSIONS_KEPT } from './orgStores';
import type { AskRecord, AskStore, AuditEntry, AuditStore, HireStore, KeptFile, PublishedState, PublishedStore, Rating, RatingStore, SavedFile, TeamFileStore, TeamPublishShape, ToolRequest, ToolRequestStore, WorkerConfig, WorkerVersion, WorkerVersionStore } from './orgStores';
import type { ToolCall } from './mcpDirect';
import { classifyServer, fileTitle, isText, listFolder, linkFrom, mimeFor, pickUploadTool, readInFolder, slugFor, uploadArgs, type DestinationKind } from './teamFiles';
import { buildZip, type ZipEntry } from './zip';
import { personKey } from './connections';
import type { ServerVersion } from './updateCheck';
import { SLACK_BUDGET } from '../slack/deliver';
import { TRIGGER_STARTS } from './askPreface';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// A bare Slack member id, as a name stands in for it before it's known.
const SLACK_ID = /^[UW][A-Z0-9]{6,}$/;

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
  /// When the hirer asked the admins to set up the tools it wants.
  toolsAskedAt?: number;
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
  /// This month so far: runs started, runs that failed, pull requests opened.
  month: { runs: number; failed: number; pullRequests: number };
  waiting: number;
  youManage: boolean;
  /// What it is doing now: working, waiting on a person, paused, stuck, idle.
  state: WorkerState;
  /// The tools (MCP servers) it lists, whether this server has each, and how
  /// much of it the worker may use (absent: the whole tool).
  tools: Array<{ name: string; ok: boolean; scope?: ToolScope; scopeFrom?: 'default' | 'own' }>;
  /// How many Slack conversations it answers at once.
  answersAtOnce: number;
  /// Runs through its flows' own checkpoints without stopping.
  skipCheckpoints?: boolean;
  /// Steps it always runs without asking, `flowId/stepId`.
  alwaysAllow?: string[];
  /// Set by hand: whether it changes code. Absent: from its flows (`coding`).
  writesCode?: boolean;
  /// Who can ask it, picked; absent: `visibility` says.
  audience?: Audience;
  /// Slack channel IDs where it answers without being named.
  slackHomeChannels?: string[];
  /// When it runs, in words ("Weekdays at 09:00"), and the next time.
  schedule: string;
  cadence: ScheduleTrigger | null;
  nextRunAt?: number | null;
  /// Where it works: a connected repo, a workspace of repos, or a folder.
  /// Absent: nowhere in particular, so it can't change code.
  place?: { kind: 'repo' | 'workspace' | 'folder'; name: string; repos?: string[] };
  /// Pointed at a repo or workspace: its work lands as branches to review.
  coding?: boolean;
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
  /// What the person who asked said about the work, and what came of each.
  comments?: TeamComment[];
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
  /// `changed`: files the latest version changed (absent on older packs: all of them).
  pack?: { summary: string; files: string[]; version?: number; updatedAt?: number; changed?: string[] };
  /// The team talking about its pack: who said what, the coordinator's
  /// wrap-ups, and how much of it the pack has taken in.
  room?: {
    messages: Array<{
      id: string;
      speaker: { kind: 'you' | 'coordinator' | 'member'; name?: string; workerId?: UUID };
      text: string;
      at: number;
      exchange: number;
      wrapUp?: boolean;
      failed?: boolean;
      /// A turn that died with the app: what to run again.
      retry?: 'pack' | 'ask';
      /// A member's report on work handed off from the room: the stage it ran as.
      workReport?: { stage: number; title: string };
      /// Work the coordinator handed off, and to whom. `steps` when it runs in
      /// order: who goes first, who builds on them.
      handoff?: { title: string; status: string; who: string[]; steps?: string[][] };
    }>;
    busy?: { speaker: string; since: number; doing?: 'pack' };
    foldedThrough?: number;
    queued?: number;
  };
  /// The caller asked for it (or is an admin): may answer, approve, talk to the team and update the pack.
  canSteer: boolean;
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
    /// Work handed off from the room, run as one more stage.
    fromRoom?: boolean;
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
  /// Managers asking for tools for their workers: an admin's to decide.
  toolRequests: ToolRequest[];
  /// Tools failing right now: an admin's to fix.
  toolTrouble: ToolTrouble[];
  teamTasks: TeamTaskSummary[];
  proposals: ProposalBatch[];
  delivered: WorkItem[];
  crew: Array<{ id: UUID; name: string; state: WorkerState; nextShiftAt?: number | null; spentUSD?: number; budgetUSDPerMonth?: number }>;
  spend: { spentUSD: number; projectedUSD: number; allowanceUSD?: number; committedUSD?: number };
}

/// One of a worker's flows as its Job tab shows it (`workerFlows`).
export interface WorkerFlowView {
  id: string;
  name: string;
  description?: string;
  /// The one its work goes through unless someone names another.
  usual: boolean;
  /// Run after a team's work, not for its own.
  wrapUp: boolean;
  steps: FlowStepView[];
  /// Other workers that run it: a change can be made for them too.
  sharedWith: string[];
  /// Of those, the ones this caller doesn't manage.
  othersNotYours: string[];
}

/// What moving a worker onto newer models would change (`modelUpgrades`).
export interface ModelUpgradePlan {
  /// The model CLIs signed in on this server.
  healthy: Backend[];
  planning?: { model: string; to?: string; change?: string; runsHere?: string };
  flows: Array<{
    id: string;
    name: string;
    changes: Array<{ backend: Backend; from: string; to: string; where: string[]; change: string }>;
    /// Other workers that run it: an upgrade moves them too.
    sharedWith: string[];
    /// Models that run on another backend here, theirs not signed in.
    runsHere: string[];
    /// The backends it was written for that aren't signed in here.
    missing: Backend[];
  }>;
}

export type TriggerView = Omit<WorkerTrigger, 'webhook' | 'seen' | 'followers'> & {
  webhook?: { idPath?: string };
  seenCount: number;
  handledToday: number;
  handledTotal: number;
  /// Who follows each tracked item: how many, and who to someone who manages the worker.
  following?: Record<string, { count: number; names?: string[] }>;
};

/// One tracked ticket, as the Watching report lists it.
export interface WatchRow {
  item: string;
  /// Its field's value when last checked.
  status?: string;
  triggerId: string;
  trigger: string;
  workerId: string;
  worker: string;
  everyMinutes: number;
  lastPolledAt?: number;
  followers: number;
  /// Who, to an admin or someone who manages the worker.
  followerNames?: string[];
  youFollow: boolean;
}

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
  /// What its work could change; empty when it only reads, and then anyone
  /// who can ask it gets answers without its manager's OK. Absent: unknown here.
  changes?: string[];
  /// Its tools whose keys the server found don't sign in.
  toolProblems?: string[];
  jobDescription: string;
  readiness: TrustReadiness;
  stats: { runs: number; failed: number; rated: number; usefulPct: number | null };
  delivered: WorkItem[];
  questions: Array<{ question: string; answer?: string; answeredBy?: string; at: number; waiting: boolean }>;
  learned: Array<{ at: number; note: string }>;
  /// What it found out going through its tools (its onboarding).
  knowledge?: Worker['knowledge'];
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

/// A tool a hire wants that this server has no install of.
export interface WantedTool {
  name: string;
  why?: string;
  /// In the tool catalog, so an admin adds it in a click.
  inCatalog: boolean;
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
    /// Tools the job needs that this server doesn't have yet.
    wantedTools?: WantedTool[];
    /// The hirer already asked an admin for them.
    toolsAsked?: boolean;
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
  /// Pull requests its runs opened in the window.
  pullRequests: number;
};

export type OrgReport = Omit<WorkerReport, 'byWorker' | 'totals'> & {
  /// The window asked for: 7, 30, or 0 for all time.
  days: number;
  byWorker: OrgReportRow[];
  totals: WorkerReport['totals'] & { pullRequests: number };
};

/// The report's estimate of a person's time saved, and how it was reached.
export interface ReportSaved {
  ms: number;
  /// Runs counted at the pull-request rate.
  prRuns: number;
  prMultiplier: number;
  prMinHours: number;
}

const REPORT_WINDOWS = new Set([7, 30, 0]);

/// Who sees a worker's output, by its visibility, as the Library says it.
const VISIBLE_TO: Record<WorkerVisibility, string> = { private: 'Only its manager', team: 'Its manager’s team', org: 'Everyone' };

/// `OverdbDeps`: databases published from overdb — see overdb.ts.
export interface OrgServiceDeps extends OverdbDeps {
  workers: {
    roster(): Worker[];
    get(id: UUID): Worker | null;
    save(input: Worker): { ok: true; worker: Worker } | { ok: false; error: string };
    setEnabled(id: UUID, enabled: boolean): { ok: true } | { ok: false; error: string };
    remove(id: UUID): { ok: true } | { ok: false; error: string };
    /// `conversation`: a conversation of its own (a Slack thread), not today's desk.
    /// `mayLaunch`: asked by someone else, of a worker that only reads.
    runErrand(id: UUID, instruction: string, attachments?: Attachment[], conversation?: string, untrusted?: boolean, mayLaunch?: boolean): Promise<{ ok: true; result: WorkerErrandResult } | { ok: false; error: string }>;
    /// What its work could change; empty when it only reads. Absent: every
    /// worker counts as one that could change something.
    changesOf?(id: UUID): string[];
    /// Its flows by name, its usual one first.
    flowsOf?(id: UUID): Array<{ id: string; name: string }>;
    /// One look-up run with the worker's tools, nothing to approve
    /// (`WorkerEngine.lookup`). Absent: watches are only set up by hand.
    lookup?(id: UUID, args: { title: string; prompt: string }): Promise<{ ok: true; orchestrationId: UUID } | { ok: false; error: string }>;
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
    /// A message to a finished run's last step, answered in its conversation
    /// (`FlowRuntimeImpl.chatWithRun`). Absent: follow-ups go to the worker.
    chatWithRun?(args: { runId: UUID; text: string; attachments?: Attachment[] }): Promise<{ ok: true; reply: string } | { ok: false; error: string }>;
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
    approve(id: UUID, candidateIds: string[] | 'all', by?: string): Promise<{ ok: true; queued: number } | { ok: false; error: string }>;
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
    /// A comment on the work, and a piece done again with a note (TeamEngine).
    comment?(taskId: UUID, input: { text: string; file?: string; quote?: string; about?: 'questions' | 'plan' | 'coordinator'; workerId?: UUID }): Result<{ comment: TeamComment }>;
    redoPiece?(taskId: UUID, workerId: UUID, note?: string): Result;
    /// The pack held for review is good: the task is done.
    accept?(taskId: UUID): Result;
    /// The room: ask the team, another round on the last question, and the
    /// pack rewritten with what was said (or only the picked `changes`).
    roomAsk?(taskId: UUID, text: string): Result<{ queued?: boolean }>;
    roomContinue?(taskId: UUID): Result;
    updatePack?(taskId: UUID, opts: { changes?: string[] }): Result;
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
  /// Stop a batch: what's queued or proposed never starts, what runs stops.
  stopBatch?(id: UUID): { ok: true } | { ok: false; error: string };
  /// JDKs downloaded onto the server for workers and repo tests (Setup →
  /// Toolchains). Absent: not offered here.
  toolchains?: Pick<ToolchainService, 'state' | 'install' | 'remove' | 'setDefault' | 'setRepoPick' | 'askedByRepos'>;
  /// Repos workers may change, landing work as pull requests. Absent: none.
  repos?: {
    list(): ConnectedRepo[];
    connect(input: { url: string; name?: string; testCommand?: string }, by: string): Promise<Result<{ repo: ConnectedRepo }>>;
    disconnect(name: string): Result;
    /// Whether the server can push to this repo (an ssh key, or the host's token).
    canPush(repo: ConnectedRepo): boolean;
    /// The secret it needs to push over https, or null.
    tokenFor(repo: ConnectedRepo): string | null;
    /// Why this server won't run repo tests, or undefined when it will.
    testsOff?(): string | undefined;
    /// Whether the server opens pull requests: link only, a draft, or open.
    prMode?(): 'link' | 'draft' | 'open';
    setPrMode?(mode: string): Result;
    /// The status a ticket moves to once its pull request is pushed.
    ticketStatus?(): string | undefined;
    setTicketStatus?(status: string): Result;
    /// Fixes a red CI build gets from its worker before its manager hears.
    ciRounds?(): number;
    setCiRounds?(n: number): Result;
    /// What every branch a worker pushes starts with (`agent/`).
    branchPrefix?(): string;
    setBranchPrefix?(prefix: string): void;
    /// Bring each repo's default branch up to origin's. Problems, in words.
    freshen?(paths: string[]): Promise<string[]>;
    /// When they last caught up with origin.
    lastRefreshed?(): number | undefined;
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
  /// What a run has changed in its worktrees so far (runChanges.ts).
  runChanges?(run: FlowRun, opts: { diff?: boolean }): Promise<RunChanges>;
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
  /// One of its workers as a share file, with an export's extras. Absent:
  /// workers can't be exported from here.
  shareWorker?(worker: Worker, carried: WorkerCarried): { yaml: string; filename: string; missingFlowIds: string[] };
  /// Its flows as saved, a way to save one back, and the model CLIs signed
  /// in here: for moving a worker onto newer models. Absent: not offered.
  models?: {
    flows(ids: string[]): Flow[];
    save(flow: Flow): Result;
    healthy(): Promise<Backend[]>;
    /// What a run here falls back on: the preferred backend and model
    /// defaults, so the card names what the run would actually use.
    fallback?(): { preferredBackend?: Backend; modelDefaults?: FlowModelDefaults };
  };
  audit?: AuditStore;
  ratings?: RatingStore;
  /// The MCP servers installed on this server. Absent: the Tools page is off.
  tools?: {
    list(roster: Worker[], statuses?: Record<string, string>): { tools: ToolSummary[]; missing: Array<{ name: string; workers: string[]; template?: ToolTemplate }> };
    /// How a published worker's tools were set up where it came from.
    remember?(templates: ToolTemplate[], onlyNew?: boolean): void;
    /// How an installed tool is set up, minus every value (`templateFrom`).
    template?(name: string): ToolTemplate | null;
    install(input: ToolInput): { ok: true; fixed?: string[] } | { ok: false; error: string };
    /// Change some of a tool's settings in place (`updateToolSettings`).
    update?(name: string, values: Record<string, string>): { ok: true; changed: string[]; fixed?: string[] } | { ok: false; error: string };
    /// Whether its stored keys sign in (`toolLogin.ts`). Null: can't tell.
    login?(name: string): Promise<LoginResult | null>;
    uninstall(name: string): { ok: true } | { ok: false; error: string };
    /// Start the model CLI once and read what each server reports.
    check(): Promise<Record<string, string> | null>;
  };
  /// The last sign-in check of each tool, kept across restarts. Absent: in memory.
  toolLogins?: { load(): Record<string, LoginResult>; save(all: Record<string, LoginResult>): void };
  /// Workers acting on business events. Absent: no triggers on this host.
  triggers?: () => TriggerService | null;
  /// Team task files kept in the Library or saved elsewhere. Absent: kept
  /// in memory only.
  teamFiles?: TeamFileStore;
  /// Whether a worker the person can see already does a job they're about to
  /// hire for (hireOverlap.ts). Absent: no such check.
  overlap?(job: string, workers: Array<{ id: string; name: string; tagline?: string; job?: string }>): Promise<{ workerId: string; why: string } | null>;
  /// Its job rewritten with a change someone described (jobRewrite.ts).
  /// Null: the model gave nothing usable. Absent: no such help on this host.
  rewriteJob?(args: { name: string; job: string; ask: string }): Promise<string | null>;
  /// One of its flows revised with a change someone described
  /// (reviseFlowFromPrompt). Held to what the flow allowed after
  /// (flowEdit.ts). Absent: no such help on this host.
  reviseFlow?(args: { flow: Flow; ask: string }): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }>;
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
  /// The server's version and any newer release, for the console's footer.
  version?(): ServerVersion;
  /// Everyone holding access, from the token list.
  people?(): Array<{ id?: string; name: string; slackUserId?: string; admin: boolean; device?: string; lastUsedAt?: number }>;
  /// Tell the approvers a hire is waiting on them (a Slack DM, usually).
  onHireAwaitingApproval?(hire: PendingHire, approvers: string[]): void;
  /// Ask the admins to set up tools a hire wants (a Slack DM, usually).
  onToolsWanted?(hire: PendingHire, tools: WantedTool[], admins: string[]): void;
  /// The org's handbook every worker reads. Absent: none on this host.
  handbook?: { read(): string; write(text: string): void };
  /// Disk use on the server, for Setup → Readiness. Absent: not shown.
  storage?: {
    report(): Promise<StorageReport>;
    discard(runId: string): Promise<{ ok: true; removed: number } | { ok: false; error: string }>;
    clearToolCache(): Promise<void>;
    clearBuildCache?(): Promise<void>;
  };
  /// Each worker's setup over time, to see and restore. Absent: in memory.
  workerVersions?: WorkerVersionStore;
  /// Tools failing now (toolHealth.ts). Absent: nobody is watching.
  toolHealth?: { list(): ToolTrouble[]; clear(tool: string): void };
  /// Requests for a tool for one worker (`requestTool`). Absent: kept in memory.
  toolRequests?: ToolRequestStore;
  /// A manager asked the admins for a tool.
  onToolRequest?(request: ToolRequest, admins: string[]): void;
  /// An admin gave or declined one.
  onToolRequestDecided?(request: ToolRequest): void;
  /// Tell the person who asked how it went.
  onHireDecided?(hire: PendingHire, outcome: { approved: boolean; by: string; worker?: Worker; error?: string }): void;
  now?(): number;
}

function pauseKind(run: FlowRun): 'question' | 'approval' | null {
  if (run.state.kind !== 'paused' || !run.workerId) return null;
  if (run.state.reason === 'needsInput') return 'question';
  // A flow's own "look before this step", and a step whose words look risky,
  // wait on a person just the same: left off this list, a run stopped there
  // showed as waiting with nothing anyone could press.
  if (run.state.reason === 'externalAction' || run.state.reason === 'preStep' || run.state.reason === 'riskyStep') return 'approval';
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
/// How long a page further back in a worker's threads reuses the first page's build.
const THREAD_REUSE_MS = 60_000;
/// How long a first page reuses the last one's build, when nothing went
/// through here since. Over the console's 3 s poll, so one viewer's every
/// other poll reuses it; a run moving on outside this service shows up no
/// more than this late (anything asked or decided here shows at once).
const FIRST_PAGE_REUSE_MS = 5_000;
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
  /// The pull requests its branches went to, from the landing note.
  pullRequests?: LandedPullRequest[];
}

/// How long a look-up to set up a watch may take, and how often it's checked.
const LOOKUP_WAIT_MS = 10 * 60 * 1000;
/// Onboarding reads more than a look-up does.
const LEARN_WAIT_MS = 30 * 60 * 1000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const LOOKUP_POLL_MS = 3000;

export interface ErrandProgress {
  done: boolean;
  /// Each piece; one running says where it is, since when, and the last
  /// thing it said, so whoever asked can see it moving.
  /// `paused` is why a running piece stopped for a person: "waits for an OK
  /// before verify shipped".
  items: Array<{ title: string; status: string; runId?: UUID; branch?: string; note?: string; step?: { index: number; total: number; name: string }; startedAt?: number; said?: string; paused?: string }>;
  files: Array<{ name: string; body?: string; sourcePath?: string }>;
  /// Pull requests (and pages to open one), and documents the work links to.
  links: string[];
}

/// The last thing a run said, as a progress line in Slack: what a step
/// handed on comes wrapped in its `<output>` contract and written as a
/// document, so the tags go and the markdown is read as plain words.
export function plainSaid(said: string): string {
  const body = said.replace(/<\/?output\b[^>]*>/gi, '\n').replace(/<\/?(?:subject|candidates|handoff)\b[^>]*>/gi, '\n');
  return summarize(body, 240);
}

/// Why a run stopped for a person, as the asker hears it.
const PAUSED_WORDS: Record<Extract<FlowRunState, { kind: 'paused' }>['reason'], string> = {
  preStep: 'waits for an OK',
  externalAction: 'waits for an OK to act outside',
  riskyStep: 'waits for an OK on a risky step',
  needsInput: 'needs an answer',
  failure: 'stopped on a failed step',
  interrupted: 'was interrupted',
  held: 'is on hold',
};

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
    return this.summaries(caller);
  }

  /// One worker's summary, as listWorkers shows it, without building the rest.
  private summaryFor(caller: OrgCaller, id: UUID): WorkerSummary | undefined {
    return this.summaries(caller, id)[0];
  }

  private summaries(caller: OrgCaller, onlyId?: UUID): WorkerSummary[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const shown = roster.filter((w) => (!onlyId || w.id === onlyId) && canSee(policy, roster, w.id, caller));
    if (!shown.length) return [];
    const spent = this.deps.workers.spentThisMonth();
    // Runs by worker, read once: one worker's summary keeps only its own.
    const scoped: FlowRun[] = [];
    const runsBy = new Map<UUID, FlowRun[]>();
    for (const r of this.deps.runs.listRuns()) {
      if (!r.workerId || (onlyId && r.workerId !== onlyId)) continue;
      scoped.push(r);
      const list = runsBy.get(r.workerId);
      if (list) list.push(r);
      else runsBy.set(r.workerId, [r]);
    }
    const waiting = this.waitingCounts(scoped, onlyId);
    // The rest is read on first use, so a summary that doesn't need it
    // (a paused worker's next shift, a worker with no tools) skips it.
    let next: Map<UUID, number | null> | undefined;
    const nextShift = (id: UUID) => (next ??= new Map((this.deps.snapshots?.() ?? []).map((x) => [x.worker.id, x.nextShiftAt]))).get(id);
    // What this server has installed, by name. Unknown (no tools hook): say nothing is missing.
    let installed: Set<string> | undefined;
    const isInstalled = (name: string) => !this.deps.tools || (installed ??= new Set(this.deps.tools.list([]).tools.map((t) => t.name))).has(name);
    let places: { repos: ConnectedRepo[]; spaces: OrgWorkspace[] } | undefined;
    // A manager saved before their name was known is stored under their
    // Slack id: show the name anyone else has for them.
    let named: Map<string, string> | undefined;
    const knownNames = () => {
      if (named) return named;
      named = new Map<string, string>();
      for (const t of this.deps.people?.() ?? []) if (t.slackUserId && !SLACK_ID.test(t.name)) named.set(t.slackUserId, t.name);
      for (const x of roster) if (x.manager?.slackUserId && !SLACK_ID.test(x.manager.name)) named.set(x.manager.slackUserId, x.manager.name);
      return named;
    };
    const display = (m: { name: string; slackUserId?: string }) => (SLACK_ID.test(m.name) && m.slackUserId ? knownNames().get(m.slackUserId) ?? m.name : m.name);
    const placeOf = (dir?: string): WorkerSummary['place'] => {
      if (!dir) return undefined;
      places ??= { repos: this.deps.repos?.list() ?? [], spaces: this.deps.repos?.workspaces() ?? [] };
      const repo = places.repos.find((r) => r.path === dir);
      if (repo) return { kind: 'repo', name: repo.name };
      const ws = places.spaces.find((x) => x.rootPath === dir);
      if (ws) return { kind: 'workspace', name: ws.name, repos: ws.repos };
      return { kind: 'folder', name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir };
    };
    return shown
      .map((w) => {
        const manager = managerFor(roster, w.id);
        const shared = (policy.sharedMcpServers ?? []).filter((n) => !(w.mcpServers ?? []).includes(n));
        const tools = [
          ...(w.mcpServers ?? []).map((name) => ({ name, ok: isInstalled(name), ...this.scopeOf(w, name) })),
          // The org's shared tools, which it gets without anyone giving them.
          ...shared.map((name) => ({ name, ok: isInstalled(name), shared: true, ...this.scopeOf(w, name) })),
        ];
        const boss = w.reportsTo ? roster.find((x) => x.id === w.reportsTo) : undefined;
        const state = workerState(w, runsBy.get(w.id) ?? []);
        return {
          id: w.id,
          name: w.name,
          tagline: workerTagline(w),
          enabled: w.enabled,
          trust: w.trust,
          ...(manager ? { manager: display(manager) } : {}),
          ...(manager && !w.manager ? { managerInherited: true } : {}),
          ...(w.manager?.slackUserId ? { managerSlackUserId: w.manager.slackUserId } : {}),
          ...(boss ? { reportsTo: { id: boss.id, name: boss.name } } : {}),
          visibility: w.visibility ?? 'private',
          ...(w.avatarUrl ? { avatarUrl: w.avatarUrl } : {}),
          budgetUSDPerMonth: w.budgetUSDPerMonth,
          spentThisMonthUSD: spent.get(w.id) ?? 0,
          month: this.monthOf(runsBy.get(w.id) ?? []),
          waiting: waiting.get(w.id) ?? 0,
          youManage: canManage(policy, roster, w.id, caller),
          schedule: scheduleText(w.cadence),
          cadence: w.cadence,
          nextRunAt: w.enabled ? nextShift(w.id) ?? null : null,
          state: this.deps.planning?.(w.id) && state === 'idle' ? 'working' : state,
          tools,
          answersAtOnce: w.caps.answersAtOnce ?? ANSWERS_AT_ONCE,
          ...(w.caps.skipCheckpoints ? { skipCheckpoints: true } : {}),
          ...(w.caps.alwaysAllow?.length ? { alwaysAllow: [...w.caps.alwaysAllow] } : {}),
          ...(w.projectPath ? { place: placeOf(w.projectPath) } : {}),
          ...(isCodingWorker(w) ? { coding: true } : {}),
          ...(w.writesCode !== undefined ? { writesCode: w.writesCode } : {}),
          ...(w.audience ? { audience: w.audience } : {}),
          ...(w.slackHomeChannels?.length ? { slackHomeChannels: [...w.slackHomeChannels] } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getWorker(caller: OrgCaller, idOrName: string): Result<{ worker: WorkerSummary; jobDescription: string; recent: Array<{ at: number; kind: string; title: string; note?: string }> }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const summary = this.summaryFor(caller, w.id)!;
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
    entries: Array<{ id: string; at: number; kind: string; title: string; note?: string; costUSD?: number; runId?: string; orchestrationId?: string }>;
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
      // The batch id is what ties one piece of work's steps (proposed,
      // approved, started, finished) into one row; an answer is shown in full.
      entries: shown.map((e) => ({ id: e.id, at: e.at, kind: e.kind, title: e.title, ...(e.note ? { note: e.note.slice(0, 4000) } : {}), ...(e.costUSD ? { costUSD: e.costUSD } : {}), ...(e.runId ? { runId: e.runId } : {}), ...(e.orchestrationId ? { orchestrationId: e.orchestrationId } : {}) })),
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
  report(caller: OrgCaller, days: number): Result<{ report: OrgReport; savedMultiplier: number; saved: ReportSaved }> {
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
    const prs = new Map<UUID, number>();
    // Runs that opened a pull request, with their agent time, for time saved.
    const prRuns: Array<{ workerId: UUID; ms: number }> = [];
    for (const r of this.deps.runs.listRuns()) {
      if (!r.workerId || r.createdAt < sinceMs) continue;
      const opened = OrgService.prsOpened(r);
      if (!opened) continue;
      prs.set(r.workerId, (prs.get(r.workerId) ?? 0) + opened);
      prRuns.push({ workerId: r.workerId, ms: OrgService.agentMs(r) });
    }
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
        pullRequests: prs.get(w.id) ?? 0,
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
    // Everything at the usual rate, then each run that opened a pull request
    // topped up to the larger of its multiple and the floor. Visible workers only.
    const shown = new Set(byWorker.map((r) => r.workerId));
    const base = WORKER_HUMAN_TIME_SAVED_MULTIPLIER;
    const floorMs = policy.prSavedMinHours * 3_600_000;
    const counted = prRuns.filter((x) => shown.has(x.workerId));
    const topUp = counted.reduce((n, x) => n + Math.max(0, Math.max(x.ms * policy.prSavedMultiplier, floorMs) - x.ms * base), 0);
    const saved: ReportSaved = { ms: totals.workedMs * base + topUp, prRuns: counted.length, prMultiplier: policy.prSavedMultiplier, prMinHours: policy.prSavedMinHours };
    return {
      ok: true,
      report: { generatedAt: full.generatedAt, sinceMs: full.sinceMs, days: span, byWorker, totals: { ...totals, pullRequests: byWorker.reduce((n, r) => n + r.pullRequests, 0) }, daily },
      savedMultiplier: WORKER_HUMAN_TIME_SAVED_MULTIPLIER,
      saved,
    };
  }

  /// What waits on each worker's manager, from these runs and its proposals:
  /// `onlyId` counts that worker's alone.
  private waitingCounts(runs: readonly FlowRun[], onlyId?: UUID): Map<UUID, number> {
    const out = new Map<UUID, number>();
    for (const run of runs) {
      if (pauseKind(run) && run.workerId && (!onlyId || run.workerId === onlyId)) out.set(run.workerId, (out.get(run.workerId) ?? 0) + 1);
    }
    for (const b of this.proposalBatches(onlyId)) out.set(b.workerId, (out.get(b.workerId) ?? 0) + 1);
    return out;
  }

  // ---- PROPOSALS --------------------------------------------------------

  /// `onlyId`: that worker's proposals alone.
  private proposalBatches(onlyId?: UUID): ProposalBatch[] {
    const out: ProposalBatch[] = [];
    for (const o of this.deps.batches?.list() ?? []) {
      if (o.origin?.kind !== 'worker' || (onlyId && o.origin.workerId !== onlyId)) continue;
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
      const res = await this.deps.batches.approve(batchId, approve.length === batch.items.length ? 'all' : approve, caller.name);
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
  decideRun(caller: OrgCaller, runId: UUID, approve: boolean, forRun = false, always = false): Result {
    const found = this.pausedFor(caller, runId, 'approval');
    if (!found.ok) return found;
    // "Always": from now on this step of this flow runs without asking.
    if (approve && always) {
      const saved = this.alwaysAllowStep(caller, runId);
      if (!saved.ok) return saved;
    }
    // Read before acting: approving moves the run on, and the log should
    // name the step that was approved, not the one after it.
    const step = found.run.state.kind === 'paused' ? found.run.state.nextStepId : 'a step';
    const what = `${found.run.workerName ?? 'a worker'} running "${step}" on "${flowRunTitle(found.run)}"`;
    const res = approve ? this.deps.runs.resumeRun({ runId, ...(forRun ? { forRun: true } : {}) }) : this.deps.rejectRun(runId);
    if (res.ok) this.record(caller, `${approve ? 'Approved' : 'Rejected'} ${what}${approve && forRun ? ', and the rest of the run’s steps that use the same tools' : ''}.`);
    return res;
  }

  /// Keep the step a run is waiting at as one its worker always runs without
  /// asking. Its manager or an admin; read before the run moves on.
  alwaysAllowStep(caller: OrgCaller, runId: UUID): Result<{ step: string }> {
    const run = this.deps.runs.getRun(runId);
    if (!run?.workerId || run.state.kind !== 'paused' || !run.state.nextStepId) return { ok: false, error: 'It isn’t waiting at a step any more.' };
    const w = this.deps.workers.get(run.workerId);
    if (!w) return { ok: false, error: NOT_FOUND };
    const key = `${run.flowId}/${run.state.nextStepId}`;
    if ((w.caps.alwaysAllow ?? []).includes(key)) return { ok: true, step: key };
    const res = this.update(caller, w.id, { alwaysAllow: [...(w.caps.alwaysAllow ?? []), key] });
    return res.ok ? { ok: true, step: key } : res;
  }

  /// An errand: the worker plans from its job and answers, and may launch
  /// work. Anyone who can see a worker may ask it — visibility is exactly
  /// "who may ask it things".
  async ask(caller: OrgCaller, idOrName: string, text: string, via: AskRecord['via'] = 'mcp'): Promise<Result<{ reply: string; launched: number; askId: string }>> {
    const started = this.startAsk(caller, idOrName, text, via);
    if (!started.ok) return started;
    return started.done;
  }

  /// Call off an ask nobody wants any more (a process item stopped, moved or
  /// started again): the work its answer started stops, and an ask still
  /// thinking has what it starts stopped as it lands. For the host, which
  /// checks who may.
  cancelAsk(askId: string): Result {
    const a = this.allAsks().find((x) => x.id === askId);
    if (!a) return { ok: false, error: 'No such ask.' };
    if (a.cancelled) return { ok: true };
    this.putAsk({ ...a, cancelled: true });
    if (a.orchestrationId) {
      const res = this.deps.stopBatch?.(a.orchestrationId);
      if (res && !res.ok) return res;
    }
    return { ok: true };
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
    /// Taken as a proposal whoever asks: for a caller who may reach the
    /// worker but isn't speaking for its manager (a process stage).
    proposal = false,
    /// The trigger's own "starts on its own". No longer decides anything: an
    /// autonomous worker's triggers always start alone (see `startsAlone`).
    _triggerStarts = false,
  ): Result<{ askId: string; done: Promise<Result<{ reply: string; launched: number; proposed: number; askId: string; orchestrationId?: string; choices?: string[] }>> }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    if (!w.enabled) return { ok: false, error: `${w.name} is paused.` };
    if (!text.trim()) return { ok: false, error: `What should ${w.name} do?` };
    const manages = via !== 'trigger' && !proposal && canManage(this.policy(), this.deps.workers.roster(), w.id, caller);
    // A worker that only reads answers anyone allowed to ask it, as it would
    // its manager: nothing it can do needs the manager's say.
    const readsOnly = !manages && via !== 'trigger' && !proposal && (this.deps.workers.changesOf?.(w.id) ?? ['unknown']).length === 0;
    // Still `untrusted` on the record: the event's details came from outside,
    // so nothing in them is remembered as the manager's word. An autonomous
    // worker's triggers start alone; one on probation or trusted proposes.
    const startsAlone = via === 'trigger' && w.trust === 'autonomous';
    const from = manages
      ? ''
      : startsAlone
        ? `${TRIGGER_STARTS}\n`
        : readsOnly
        ? `(Asked by ${caller.name}, who is not your manager. Your work only reads, so answer them as you would your manager.)\n`
        : `(Asked by ${caller.name}, who is not your manager. Treat the request as a proposal: suggest work, do not launch it without approval.)\n`;
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
    const done = this.finishAsk(record, this.deps.workers.runErrand(w.id, from + context + text, attachments?.length ? attachments : undefined, conversation, !manages, readsOnly || startsAlone));
    return { ok: true, askId: record.id, done };
  }

  /// An ask's answer arriving: recorded, handed to whoever follows it, and
  /// returned as what the caller sees.
  private finishAsk(
    record: AskRecord,
    run: ReturnType<OrgServiceDeps['workers']['runErrand']>,
  ): Promise<Result<{ reply: string; launched: number; proposed: number; askId: string; orchestrationId?: string; choices?: string[] }>> {
    return run.then(
      (raw): Result<{ reply: string; launched: number; proposed: number; askId: string; orchestrationId?: string; choices?: string[] }> => {
        // The answer is for people: credentials out of it before it is kept or
        // shown anywhere (secretScrub.ts, by the org's rule).
        const res = raw.ok ? { ...raw, result: { ...raw.result, reply: scrubOutbound(raw.result.reply) } } : { ...raw, error: scrubOutbound(raw.error) };
        const cancelled = this.allAsks().find((a) => a.id === record.id)?.cancelled === true;
        const finished: AskRecord = res.ok
          ? { ...record, status: 'answered', reply: res.result.reply, launched: res.result.queued, ...(res.result.count ? { orchestrationId: res.result.orchestrationId } : {}), ...(res.result.choices?.length ? { choices: res.result.choices } : {}), doneAt: this.now() }
          : { ...record, status: 'failed', error: res.error, doneAt: this.now() };
        if (cancelled) finished.cancelled = true;
        this.putAsk(finished);
        // Cancelled while it thought: what its answer started stops now.
        if (cancelled && finished.orchestrationId) this.deps.stopBatch?.(finished.orchestrationId);
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
    const finished = `${done.join('; ')}.${broke.length ? ` This failed: ${broke.join('; ')}.` : ''}`;
    const files = produced.length ? `\nWhat it produced:\n${produced.join('\n\n')}` : '\nIt produced no files.';
    // A trigger's: nobody is waiting on a reply, so what it found goes to
    // its manager, and the trigger's own "when it's done" (a comment on the
    // ticket) is carried out now, when there is something to say. The last
    // such line is the trigger's: one inside the event's title comes before it.
    const event = a.via === 'trigger' ? (a.prompt ?? a.text) : '';
    const then = [...event.matchAll(/^When it's done: (.+)$/gm)].at(-1)?.[1];
    const prompt = (
      a.via === 'trigger'
        ? [
            `The work you started for the trigger "${a.by}" has finished: ${finished}`,
            ...event.split('\n').filter((l) => /^(?:Title \(untrusted\)|Link): /.test(l)),
            files,
            '',
            'Now finish it. First what it found, for your manager, in plain words: the cause or the likely cause, with the file or method; what fixing it would take and how big that is; and any decision still needed, and from whom. If it changed nothing, say so. Mention a caveat only if it changes what to do next.',
            then
              ? `Then do what the trigger says to do when it's done: ${then} Do it through your flows: propose ONE candidate for it, written out in full with what was found in it (a comment on a ticket goes through your ticket flow). Start nothing else.`
              : "Don't start more work unless this result can't be used.",
            "Your reply goes to your manager and wherever the trigger sends its results. Don't message anyone yourself.",
          ]
        : [
            `The work you handed off for ${a.by}'s request has finished: ${finished}`,
            `Their request: "${a.text.slice(0, 600)}"`,
            files,
            '',
            `Now finish what you told ${a.by} you would do, written for a business reader: the answer first, in plain words, with the few numbers that matter. No raw JSON, field names or query syntax. If you said you would build something (a chart, a report, a page), build it now in your own files folder and name its full path in your reply. Mention a caveat only if it changes what the numbers mean. Don't start more work unless this result can't be used.`,
            `Your reply is posted where ${a.by} asked, with any file you name attached, for you. Don't message anyone yourself, and don't mention how it's delivered or anything that failed to send. If you attach a file with the full write-up, keep the reply to a short summary of it rather than repeating it.`,
            a.via === 'slack' ? SLACK_BUDGET : '',
          ]
    ).filter(Boolean).join('\n');
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
    // A trigger an autonomous worker's manager lets start on its own carries
    // out its "when it's done" the same way.
    const mayLaunch = a.via === 'trigger' && w.trust === 'autonomous';
    return { askId: record.id, done: this.finishAsk(record, this.deps.workers.runErrand(w.id, prompt, undefined, a.conversation, a.untrusted === true, mayLaunch)) };
  }

  /// A follow-up on work an ask handed off, once it has finished: said to
  /// whoever ran the work's last step, in that step's own conversation, so it
  /// answers like the next message of a chat — it has the work in front of it
  /// — instead of the worker planning a new errand from scratch. Null when
  /// that can't be: the work isn't finished, there is no run to continue, or
  /// the caller may not drive the worker's work (it may change things, and
  /// they aren't its manager), and the follow-up goes to the worker instead.
  continueRun(
    caller: OrgCaller,
    orchestrationId: UUID,
    text: string,
    opts: { via?: AskRecord['via']; attachments?: Attachment[]; conversation?: string; said?: string } = {},
  ): { askId: string; runId: UUID; done: ReturnType<OrgService['finishAsk']> } | null {
    const chat = this.deps.runs.chatWithRun;
    if (!chat || !text.trim()) return null;
    const p = this.errandProgress(orchestrationId);
    const runId = p?.done ? [...p.items].reverse().find((i) => i.status === 'done' && i.runId)?.runId : undefined;
    const run = runId ? this.deps.runs.getRun(runId) : null;
    if (!runId || !run?.workerId) return null;
    const w = this.resolve(caller, run.workerId);
    if (!w?.enabled) return null;
    const manages = canManage(this.policy(), this.deps.workers.roster(), w.id, caller);
    const readsOnly = (this.deps.workers.changesOf?.(w.id) ?? ['unknown']).length === 0;
    if (!manages && !readsOnly) return null;
    const record: AskRecord = {
      id: randomUUID(),
      workerId: w.id,
      workerName: w.name,
      by: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      text: (opts.said?.trim() || text.trim()).slice(0, 4000),
      at: this.now(),
      status: 'working',
      ...(opts.via ? { via: opts.via } : {}),
      replyTo: `run:${runId}`,
      prompt: text.slice(0, 16_000),
      ...(opts.conversation ? { conversation: opts.conversation } : {}),
      ...(!manages ? { untrusted: true } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments.length } : {}),
    };
    this.putAsk(record);
    const run$ = chat({ runId, text, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }).then(
      (res): { ok: true; result: WorkerErrandResult } | { ok: false; error: string } =>
        res.ok ? { ok: true, result: { orchestrationId, count: 0, queued: 0, launchedNothing: true, reply: res.reply } } : res,
    );
    return { askId: record.id, runId, done: this.finishAsk(record, run$) };
  }

  /// Asks made in the console or by a trigger whose handed-off work has
  /// finished, handed back (see `handBack`); a trigger's answer then goes
  /// where its first did (`onAskDone`). Slack's front door hands back its
  /// own, to post the answer in its thread. Call every so often.
  handBackDue(): number {
    // Only asks made since this server started: one from earlier in the day
    // was answered the old way and already read.
    let n = 0;
    for (const a of this.allAsks()) {
      if ((a.via !== 'console' && a.via !== 'trigger') || a.handedBack || !a.orchestrationId || a.at < this.bootAt) continue;
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
    this.changes++;
    const all = this.allAsks().filter((a) => a.id !== record.id);
    all.push(record);
    if (this.deps.asks) this.deps.asks.save(all);
    else this.memoryAsks = all.slice(-1000);
  }

  // ---- TOOLS --------------------------------------------------------------

  private toolStatuses: { at: number; statuses: Record<string, string> } | null = null;
  private loginCache: Record<string, LoginResult> | null = null;

  private logins(): Record<string, LoginResult> {
    return (this.loginCache ??= this.deps.toolLogins?.load() ?? {});
  }

  /// Check one tool's stored keys sign in, and keep what it found.
  private async checkLoginOf(name: string): Promise<LoginResult | null> {
    if (!this.deps.tools?.login) return null;
    let res: LoginResult | null = null;
    try {
      res = await this.deps.tools.login(name);
    } catch {
      res = null;
    }
    const all = { ...this.logins() };
    if (res) all[name] = res;
    else delete all[name];
    this.loginCache = all;
    this.deps.toolLogins?.save(all);
    return res;
  }

  /// A worker's tools whose keys the server found don't sign in, said for it.
  /// Pushes a finished run's worktrees again (BranchLander.land): set by the
  /// server once its pusher exists. Null when the run has no checkout left.
  private relander?: (runId: UUID) => Promise<string | null>;
  setRelander(fn: (runId: UUID) => Promise<string | null>): void {
    this.relander = fn;
  }

  /// Push a finished run again: after its push was refused (a token that
  /// couldn't write, say) and that's been put right. Its manager or an admin.
  async pushRunAgain(caller: OrgCaller, runId: UUID): Promise<Result<{ result: string }>> {
    const r = this.deps.runs.getRun(runId);
    if (!r?.workerId || !canSee(this.policy(), this.deps.workers.roster(), r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    if (!canManage(this.policy(), this.deps.workers.roster(), r.workerId, caller)) return { ok: false, error: 'Only its manager or an admin can push it.' };
    if (r.state.kind !== 'done') return { ok: false, error: 'Only a finished run can be pushed.' };
    if (!this.relander) return { ok: false, error: 'Runs can’t be pushed from this server.' };
    const result = await this.relander(runId);
    if (result === null) return { ok: false, error: 'Its checkout is gone, so there is nothing left to push.' };
    this.record(caller, `Pushed "${flowRunTitle(r)}" again.`);
    return { ok: true, result };
  }

  toolProblemsFor(workerId: UUID): string[] {
    const w = this.deps.workers.get(workerId);
    if (!w) return [];
    const names = new Set([...(w.mcpServers ?? []), ...(this.policy().sharedMcpServers ?? [])]);
    return Object.entries(this.logins())
      .filter(([name, l]) => names.has(name) && l.state === 'rejected')
      .map(([name, l]) => `${name}: its sign-in is refused, so what it reads comes back empty or fails. ${l.reason ?? ''}`.trim());
  }

  /// What MCP servers workers here can use, who uses each, and what a worker
  /// names that is not installed. Admins see it all; a manager sees whether
  /// their workers' tools are here.
  tools(caller: OrgCaller): Result<{ tools: Array<ToolSummary & { access: 'picked' | 'managers' | 'everyone'; signIn?: SignInSummary; login?: LoginResult; trouble?: ToolTrouble; serviceAccount?: boolean; actsAs?: string; actsAsGone?: boolean }>; missing: Array<{ name: string; workers: string[]; template?: ToolTemplate; connector?: { title: string; tool: string; installed: boolean } }>; catalog?: CatalogTool[]; checkedAt?: number; canEdit: boolean; signIn: boolean }> {
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
    const logins = this.logins();
    const trouble = new Map((this.deps.toolHealth?.list() ?? []).map((x) => [x.tool, x]));
    // Who the org knows, to tell when a tool still signs in as someone gone.
    const known = new Set([...(this.deps.people?.() ?? []).map((p) => p.name), ...Object.values(policy.people ?? {}).map((p) => (p as { name?: string }).name ?? '')].filter(Boolean).map((n) => n.toLowerCase()));
    const service = new Set(policy.serviceAccounts ?? []);
    const withAccess = listed.tools.map((t) => {
      const person = logins[t.name]?.state === 'ok' && !service.has(t.name) ? personOf(logins[t.name].as) : null;
      return {
        ...t,
        ...(logins[t.name] ? { login: logins[t.name] } : {}),
        access: (shared.has(t.name) ? 'everyone' : allowed.has(t.name) ? 'managers' : 'picked') as 'picked' | 'managers' | 'everyone',
        ...(t.kind === 'http' && signedIn[t.name] ? { signIn: signedIn[t.name] } : {}),
        ...(trouble.has(t.name) ? { trouble: trouble.get(t.name)! } : {}),
        ...(service.has(t.name) ? { serviceAccount: true } : {}),
        // Signs in as a person: everyone who asks its workers acts as them.
        ...(person ? { actsAs: person, ...(known.size && !known.has(person.toLowerCase()) ? { actsAsGone: true } : {}) } : {}),
      };
    });
    return {
      ok: true,
      tools: admin ? withAccess : withAccess.filter((t) => t.usedBy.length || t.access === 'everyone'),
      // A tool nobody published the setup of still fills in when it is a
      // common one.
      // A connector from someone's Claude account is installed here under
      // a tool name of its own.
      missing: listed.missing.map((m) => {
        const title = connectorTitle(m.name);
        const tool = connectorTool(m.name);
        if (title && tool) {
          const known = catalogFor(tool);
          return { ...m, template: known ?? { name: tool, kind: 'http' as const, url: '', envKeys: [], headerKeys: [] }, connector: { title, tool, installed: listed.tools.some((t) => t.name === tool) } };
        }
        if (m.template) return m;
        const known = catalogFor(m.name);
        return known ? { ...m, template: { ...known, name: m.name } } : m;
      }),
      ...(admin ? { catalog: TOOL_CATALOG } : {}),
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

  /// Databases published from overdb (Setup → Databases): overdb.ts.
  private overdbOrg: OverdbOrg | null = null;
  get databases(): OverdbOrg {
    return (this.overdbOrg ??= new OverdbOrg(this.deps, {
      policy: () => this.policy(),
      record: (caller, what) => this.record(caller, what),
      now: () => this.now(),
    }));
  }

  installTool(caller: OrgCaller, input: ToolInput): Result<{ fixed?: string[] }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can install tools on the server.' };
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const res = this.deps.tools.install(input);
    if (res.ok) {
      this.record(caller, `Installed the ${input.name} tool (${input.kind === 'http' ? input.url : input.command}).`);
      this.adoptConnectors(input.name);
      void this.checkLoginOf(input.name.trim());
    }
    return res;
  }

  /// Point workers that list a Claude-account connector at the tool
  /// installed for it, so "claude.ai Atlassian" becomes atlassian.
  useToolForConnectors(caller: OrgCaller, name: string): Result<{ workers: string[] }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can set up the server\'s tools.' };
    const moved = this.adoptConnectors(name);
    if (moved.length) this.record(caller, `Gave ${moved.join(', ')} the ${name} tool in place of their Claude connector.`);
    return { ok: true, workers: moved };
  }

  private adoptConnectors(tool: string): string[] {
    const moved: string[] = [];
    for (const w of this.deps.workers.roster()) {
      const list = w.mcpServers ?? [];
      if (!list.some((n) => connectorTool(n) === tool)) continue;
      const next = [...new Set(list.map((n) => (connectorTool(n) === tool ? tool : n)))];
      const scopes = w.toolScopes ? Object.fromEntries(Object.entries(w.toolScopes).map(([k, v]) => [connectorTool(k) === tool ? tool : k, v])) : undefined;
      if (this.deps.workers.save({ ...structuredClone(w), mcpServers: next, ...(scopes ? { toolScopes: scopes } : {}) }).ok) moved.push(w.name);
    }
    return moved;
  }

  /// New values for some of a tool's settings, keeping the rest and who has
  /// it. Only the names go in the record, never a value.
  /// The new keys are tried at once, so the save says whether they sign in.
  async updateToolSettings(caller: OrgCaller, name: string, values: Record<string, string>): Promise<Result<{ changed: string[]; fixed?: string[]; login?: LoginResult }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can change a tool’s keys.' };
    if (!this.deps.tools?.update) return { ok: false, error: 'Tools cannot be changed on this server.' };
    const res = this.deps.tools.update(name, values);
    if (!res.ok) return res;
    this.record(caller, `Changed ${res.changed.join(', ')} on the ${name} tool.`);
    const login = await this.checkLoginOf(name);
    return { ...res, ...(login ? { login } : {}) };
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
    if (back.ok && back.name) {
      this.record({ name: back.by ?? 'An admin', admin: true }, `Signed the ${back.name} tool in for the org.`);
      this.adoptConnectors(back.name);
    }
    return back;
  }

  async checkTools(caller: OrgCaller): Promise<Result<{ statuses: Record<string, string> }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can check the server\'s tools.' };
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const statuses = await this.deps.tools.check();
    if (!statuses) return { ok: false, error: 'Claude did not start on the server, so the tools could not be checked. See Admin → health.' };
    this.toolStatuses = { at: this.now(), statuses };
    // Starting isn't signing in: a bad token still starts. Each tool's keys
    // are tried too.
    await Promise.all(Object.keys(statuses).map((name) => this.checkLoginOf(name)));
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
  private showTrigger(t: WorkerTrigger, s: TriggerService, seeNames = false): TriggerView {
    const { webhook, seen, states, followers, ...rest } = t;
    const following = Object.fromEntries(
      Object.entries(followers ?? {})
        .filter(([, ids]) => ids.length)
        .map(([item, ids]) => [item, { count: ids.length, ...(seeNames ? { names: this.namesFor(ids) } : {}) }]),
    );
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const mine = s.deliverables().filter((d) => d.source.triggerId === t.id);
    return {
      ...rest,
      ...(webhook ? { webhook: { ...(webhook.idPath ? { idPath: webhook.idPath } : {}) } } : {}),
      ...(Object.keys(following).length ? { following } : {}),
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
    const canEdit = canManage(this.policy(), this.deps.workers.roster(), w.id, caller);
    return { ok: true, triggers: s.list(w.id).map((t) => this.showTrigger(t, s, canEdit || isAdmin(this.policy(), caller))), canEdit };
  }

  createTrigger(
    caller: OrgCaller,
    idOrName: string,
    input: Pick<WorkerTrigger, 'name' | 'kind' | 'instructions' | 'deliver' | 'maxPerDay' | 'watch' | 'slack' | 'notifyOnly' | 'startsOnItsOwn'> & { webhook?: { idPath?: string } },
  ): Result<{ trigger: TriggerView; webhookPath?: string }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Triggers run on the org server.' };
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const deliver = this.ownDms(caller, input.deliver);
    if (!deliver.ok) return deliver;
    const res = s.create({ ...input, deliver: deliver.deliver, workerId: found.worker.id, enabled: true, createdBy: caller.name });
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

  updateTrigger(caller: OrgCaller, id: string, patch: Partial<Pick<WorkerTrigger, 'name' | 'enabled' | 'instructions' | 'deliver' | 'maxPerDay' | 'watch' | 'slack' | 'notifyOnly' | 'startsOnItsOwn'>>): Result<{ trigger: TriggerView }> {
    const found = this.managedTrigger(caller, id);
    if (!found.ok) return found;
    if (patch.deliver) {
      const deliver = this.ownDms(caller, patch.deliver, found.trigger.deliver);
      if (!deliver.ok) return deliver;
      patch = { ...patch, deliver: deliver.deliver };
    }
    const res = found.s.update(id, patch);
    if (!res.ok) return res;
    this.record(caller, `${patch.enabled === false ? 'Paused' : patch.enabled === true ? 'Resumed' : 'Changed'} the trigger ${res.trigger.name}.`);
    return { ok: true, trigger: this.showTrigger(res.trigger, found.s) };
  }

  /// A DM goes to the person setting it up, never someone they name: a DM
  /// already there for someone else stays theirs.
  private ownDms(caller: OrgCaller, deliver: Destination[], before: Destination[] = []): Result<{ deliver: Destination[] }> {
    const kept = new Set(before.filter((d) => d.kind === 'dm').map((d) => (d as { slackUserId: string }).slackUserId));
    const out: Destination[] = [];
    for (const d of deliver) {
      if (d.kind !== 'dm') { out.push(d); continue; }
      if (d.slackUserId && kept.has(d.slackUserId)) { out.push(d); continue; }
      if (!caller.slackUserId) return { ok: false, error: 'A DM needs your Slack account linked: sign in from Slack once, or link it on People.' };
      if (!out.some((x) => x.kind === 'dm' && x.slackUserId === caller.slackUserId)) out.push({ kind: 'dm', slackUserId: caller.slackUserId });
    }
    return { ok: true, deliver: out };
  }

  /// "Track ACME-412": add it to the list a worker's change watch asks about,
  /// or stop. For its manager; the watch must already be set up.
  trackItem(caller: OrgCaller, idOrName: string, itemId: string, on: boolean): Result<{ worker: string; trigger: string; tracked: number }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Triggers run on the org server.' };
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const watch = s.list(found.worker.id).find((t) => t.kind === 'watch' && t.watch?.changes && t.watch.tracked);
    if (!watch) return { ok: false, error: `${found.worker.name} has no list to track yet. Give it a change watch on its Triggers tab, with “Only items I track” on.` };
    const res = s.track(watch.id, itemId, on);
    if (!res.ok) return res;
    this.record(caller, `${on ? 'Tracking' : 'Stopped tracking'} ${itemId} on ${found.worker.name}'s ${watch.name}.`);
    return { ok: true, worker: found.worker.name, trigger: watch.name, tracked: res.tracked.length };
  }

  /// "Let me know when ACME-412 changes": DM the caller when it moves, on a
  /// change watch of a worker they can see. The one already tracking it, or
  /// tracking its project's tickets, before any other.
  followItem(caller: OrgCaller, itemId: string, on: boolean): Result<{ worker: string; trigger: string; everyMinutes: number }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Following a ticket needs the org server.' };
    const user = caller.slackUserId;
    if (!user) return { ok: false, error: 'Link your Slack account first, so there is somewhere to DM you.' };
    const names = new Map(this.listWorkers(caller).map((w) => [w.id, w.name]));
    const watches = s.list().filter((t) => t.enabled && t.kind === 'watch' && t.watch?.changes && t.watch.tracked && names.has(t.workerId));
    const said = (t: WorkerTrigger) => ({ worker: names.get(t.workerId) ?? 'A worker', trigger: t.name, everyMinutes: t.watch!.everyMinutes });
    if (!on) {
      const mine = watches.filter((t) => t.followers?.[itemId]?.includes(user));
      if (!mine.length) return { ok: false, error: `You weren't following ${itemId}.` };
      for (const t of mine) s.follow(t.id, itemId, user, false);
      this.record(caller, `Stopped following ${itemId}.`);
      return { ok: true, ...said(mine[0]) };
    }
    if (!watches.length) return { ok: false, error: `Nobody watches tickets for changes yet, so I can't follow ${itemId}. A manager can give a worker a change watch with “Only items I track” on its Triggers tab.` };
    const project = itemId.includes('-') ? `${itemId.split('-')[0]}-` : null;
    const pick = watches.find((t) => t.watch!.tracked!.includes(itemId)) ?? (project ? watches.find((t) => t.watch!.tracked!.some((x) => x.startsWith(project))) : undefined) ?? watches[0];
    const res = s.follow(pick.id, itemId, user, true);
    if (!res.ok) return res;
    this.record(caller, `Following ${itemId} on ${said(pick).worker}'s ${pick.name}.`);
    return { ok: true, ...said(pick) };
  }

  /// Every ticket tracked by a change watch of a worker the caller can see,
  /// found and paged, and all the ones the caller follows. Who follows is
  /// named to an admin or someone who manages the worker; to anyone else, a count.
  watching(caller: OrgCaller, query: { q?: string; offset?: number; limit?: number } = {}): Result<{ rows: WatchRow[]; total: number; mine: WatchRow[] }> {
    const s = this.triggerSvc();
    if (!s) return { ok: false, error: 'Watches run on the org server.' };
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const admin = isAdmin(policy, caller);
    const names = new Map(this.listWorkers(caller).map((w) => [w.id, w.name]));
    const all: WatchRow[] = [];
    for (const t of s.list()) {
      if (t.kind !== 'watch' || !t.watch?.changes || !t.watch.tracked || !names.has(t.workerId)) continue;
      const seeNames = admin || canManage(policy, roster, t.workerId, caller);
      for (const item of t.watch.tracked) {
        const ids = t.followers?.[item] ?? [];
        const status = t.states?.[item];
        all.push({
          item,
          ...(status !== undefined ? { status } : {}),
          triggerId: t.id,
          trigger: t.name,
          workerId: t.workerId,
          worker: names.get(t.workerId)!,
          everyMinutes: t.watch.everyMinutes,
          ...(t.lastPolledAt ? { lastPolledAt: t.lastPolledAt } : {}),
          followers: ids.length,
          ...(seeNames && ids.length ? { followerNames: this.namesFor(ids) } : {}),
          youFollow: !!caller.slackUserId && ids.includes(caller.slackUserId),
        });
      }
    }
    all.sort((a, b) => a.item.localeCompare(b.item, undefined, { numeric: true }) || a.worker.localeCompare(b.worker));
    const q = query.q?.trim().toLowerCase();
    const found = q ? all.filter((r) => [r.item, r.worker, r.trigger, r.status ?? '', ...(r.followerNames ?? [])].some((x) => x.toLowerCase().includes(q))) : all;
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(0, Math.min(500, Math.floor(query.limit ?? 50)));
    const mine = all.filter((r) => r.youFollow);
    // Being set up right now: shown as followed, so it doesn't look lost.
    const pending = [...this.settingUp.values()]
      .filter((p) => p.user === caller.slackUserId && !mine.some((r) => r.item === p.item))
      .map((p): WatchRow => ({ item: p.item, status: `being set up: waiting on ${p.worker}`, triggerId: '', trigger: 'being set up', workerId: p.workerId, worker: p.worker, everyMinutes: 0, followers: 1, youFollow: true }));
    return { ok: true, rows: found.slice(offset, offset + limit), total: found.length, mine: [...mine, ...pending] };
  }

  /// Follow a ticket, setting up the watch for it first when there's none to
  /// put it on: one already tracking its project's tickets, or one on the
  /// worker preferred (the one the thread is with). Setting one up asks a
  /// worker the caller manages to look the ticket up once (`watchSetup`).
  /// `say`: a word while that runs, which takes a minute.
  async followOrSetUp(caller: OrgCaller, itemId: string, on: boolean, opts: { workerId?: string; say?(text: string): void } = {}): Promise<Result<{ worker: string; trigger: string; everyMinutes: number; status?: string; setUp?: boolean }>> {
    const s = this.triggerSvc();
    if (!on || !s) return this.followItem(caller, itemId, on);
    const names = new Map(this.listWorkers(caller).map((w) => [w.id, w]));
    const watches = s.list().filter((t) => t.enabled && t.kind === 'watch' && t.watch?.changes && t.watch.tracked && names.has(t.workerId));
    const project = itemId.includes('-') ? `${itemId.split('-')[0]}-` : null;
    const fits = watches.find((t) => t.watch!.tracked!.includes(itemId) || (!!project && t.watch!.tracked!.some((x) => x.startsWith(project))));
    if (fits) return this.followItem(caller, itemId, on);
    if (!caller.slackUserId) return { ok: false, error: 'Link your Slack account first, so there is somewhere to DM you.' };
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const mine = [...names.values()].filter((w) => w.enabled && canManage(policy, roster, w.id, caller));
    const w = (opts.workerId ? mine.find((x) => x.id === opts.workerId) : undefined) ?? mine.find((x) => x.tools.some((t) => t.ok));
    if (!w) {
      const other = opts.workerId ? names.get(opts.workerId) : undefined;
      const what = project ? `${project.slice(0, -1)} tickets` : itemId;
      return { ok: false, error: other ? `Nothing watches ${what} yet, and only ${other.manager ?? 'its manager'} can set ${other.name} up to. Ask them, or a manager of a worker that can reach the tracker.` : `Nothing watches ${what} yet, and none of your workers can be set up to. A manager can give a worker a change watch on its Triggers tab.` };
    }
    const fail = (why: string): Result<never> => ({ ok: false, error: `Couldn't set up a watch for ${itemId} with ${w.name}: ${why} A manager can set one up by hand on its Triggers tab.` });
    if (!this.deps.workers.lookup) return fail("this server can't run a look-up for it.");
    // A watch calls the tool itself between runs, so only a tool installed
    // here will do: a connector the worker's own Claude account brings works
    // inside its runs and nowhere else.
    const callable = w.tools.filter((t) => t.ok && s.canCall(t.name)).map((t) => t.name);
    if (!callable.length) {
      return {
        ok: false,
        error: `${w.name} reaches the tracker through a connector that only works inside its own runs, and a watch has to check the tracker on its own between them. Add the tracker's MCP server on Setup → Tools and give ${w.name} access, and following ${itemId} will set itself up.`,
      };
    }
    opts.say?.(`Setting up a watch for *${itemId}* with ${w.name}. It looks the ticket up once to learn how; a few minutes.`);
    // Shown as followed, "being set up", while the look-up runs: a follow
    // that only appears minutes later looked like one that hadn't worked.
    const pendingKey = `${caller.slackUserId}:${itemId}`;
    this.settingUp.set(pendingKey, { item: itemId, user: caller.slackUserId, workerId: w.id, worker: w.name, since: this.now() });
    try {
      return await this.setUpWatch(caller, itemId, w, s, callable, project, fail);
    } finally {
      this.settingUp.delete(pendingKey);
    }
  }

  /// Follows being set up right now, by person and ticket.
  private settingUp = new Map<string, { item: string; user: string; workerId: string; worker: string; since: number }>();

  private async setUpWatch(
    caller: OrgCaller,
    itemId: string,
    w: { id: string; name: string; tools: Array<{ name: string; ok: boolean }> },
    s: TriggerService,
    callable: string[],
    project: string | null,
    fail: (why: string) => Result<never>,
  ): Promise<Result<{ worker: string; trigger: string; everyMinutes: number; status?: string; setUp?: boolean }>> {
    const ran = await this.deps.workers.lookup!(w.id, { title: `How to watch ${itemId}`, prompt: setupPrompt(itemId, callable) });
    if (!ran.ok) return fail(ran.error);
    const answer = await this.lookupAnswer(ran.orchestrationId);
    if (!answer.ok) return fail(answer.error);
    const call = readToolCall(answer.text, w.tools.map((t) => t.name));
    if (!call) return fail("it couldn't find a tool that looks tickets up.");
    const general = generalize(call.args, itemId);
    if (!general.found) return fail(`the call it used doesn't name ${itemId}, so it can't be pointed at other tickets.`);
    const probe = await s.probe(call.server, call.tool, argsFor({ server: call.server, tool: call.tool, args: general.args, everyMinutes: 15, tracked: [itemId] }));
    if (!probe.ok) return fail(probe.error);
    const shape = readShape(probe.json, itemId);
    if (!shape) return fail(`asking ${call.server} that way didn't bring back ${itemId} with a status.`);
    const made = s.create({
      workerId: w.id,
      name: `Ticket changes${project ? ` (${project.slice(0, -1)})` : ''}`,
      kind: 'watch',
      enabled: true,
      instructions: '',
      notifyOnly: true,
      deliver: [],
      maxPerDay: 200,
      watch: { server: call.server, tool: call.tool, args: general.args, everyMinutes: 15, itemsPath: shape.itemsPath, idPath: shape.idPath, changes: shape.statusPath, tracked: [itemId] },
      createdBy: caller.name,
    });
    if (!made.ok) return fail(made.error);
    const followed = s.follow(made.trigger.id, itemId, caller.slackUserId!, true);
    if (!followed.ok) return fail(followed.error);
    this.record(caller, `Set up ${w.name}'s ${made.trigger.name} to follow ${itemId}.`);
    return { ok: true, worker: w.name, trigger: made.trigger.name, everyMinutes: 15, status: shape.status, setUp: true };
  }

  /// What a look-up run answered, once it ends: its output and what it said.
  /// Gives up after `waitMs`, or when it stops for a person.
  private async lookupAnswer(orchestrationId: UUID, waitMs = LOOKUP_WAIT_MS): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const until = this.now() + waitMs;
    for (;;) {
      const p = this.errandProgress(orchestrationId);
      if (p?.done) {
        if (!p.items.some((i) => i.status === 'done')) return { ok: false, error: `its look-up ended without finishing${p.items[0]?.note ? ` (${p.items[0].note})` : ''}.` };
        return { ok: true, text: [...p.files.map((f) => f.body ?? ''), ...p.items.map((i) => i.said ?? '')].join('\n') };
      }
      const paused = p?.items.find((i) => i.paused)?.paused;
      if (paused) return { ok: false, error: `its look-up ${paused}, so it was left for a person.` };
      if (this.now() > until) return { ok: false, error: 'its look-up took too long.' };
      await new Promise((r) => setTimeout(r, LOOKUP_POLL_MS));
    }
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
      /// The line under its name. Empty clears it.
      tagline?: string;
      /// The MCP servers it may use, by name.
      mcpServers?: string[];
      /// How much of each it may use, by tool name: `{ mode: 'read' }`,
      /// `{ mode: 'only', calls }`, or null for the whole tool again.
      toolScopes?: Record<string, unknown>;
      /// Its picture: an https image link, or null for initials again.
      avatarUrl?: string | null;
      /// The flow its work goes through unless the ask names another; null
      /// for its first again.
      preferredFlowId?: string | null;
      /// How many Slack conversations it answers at once.
      answersAtOnce?: number;
      /// Run through its flows' own checkpoints. An admin's call.
      skipCheckpoints?: boolean;
      /// Steps it may always run without asking, `flowId/stepId`.
      alwaysAllow?: string[];
      /// Whether it changes code; null for "from its flows" again.
      writesCode?: boolean | null;
      /// Who can ask it, picked; null to go back to `visibility`.
      audience?: Audience | null;
      /// Slack channel IDs where it answers without being named; null for none.
      slackHomeChannels?: string[] | null;
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
    if (patch.answersAtOnce !== undefined) {
      const n = Number(patch.answersAtOnce);
      if (!Number.isInteger(n) || n < 1 || n > ANSWERS_AT_ONCE_MAX) return { ok: false, error: `Between 1 and ${ANSWERS_AT_ONCE_MAX} at once.` };
      next.caps = { ...next.caps, answersAtOnce: n };
    }
    if (patch.skipCheckpoints !== undefined && patch.skipCheckpoints !== (w.caps.skipCheckpoints === true)) {
      // A checkpoint is where someone meant to look; only an admin says
      // nobody needs to.
      if (!admin) return { ok: false, error: 'Only an admin can let a worker run through its flows’ checkpoints.' };
      const caps = { ...next.caps };
      if (patch.skipCheckpoints) caps.skipCheckpoints = true;
      else delete caps.skipCheckpoints;
      next.caps = caps;
    }
    if (patch.audience !== undefined) {
      if (patch.audience === null) delete next.audience;
      else next.audience = patch.audience;
    }
    if (patch.writesCode !== undefined) {
      if (patch.writesCode === null) delete next.writesCode;
      else next.writesCode = patch.writesCode === true;
    }
    if (patch.alwaysAllow !== undefined) {
      const list = [...new Set((Array.isArray(patch.alwaysAllow) ? patch.alwaysAllow : []).map(String))];
      if (list.length > 50 || list.some((k) => !/^[\w.-]{1,120}\/[\w.-]{1,120}$/.test(k))) return { ok: false, error: 'Always-allowed steps are a flow and a step, like solve-ticket/push.' };
      const caps = { ...next.caps };
      if (list.length) caps.alwaysAllow = list;
      else delete caps.alwaysAllow;
      next.caps = caps;
    }
    if (patch.preferredFlowId !== undefined) {
      if (patch.preferredFlowId === null || patch.preferredFlowId === '') delete next.preferredFlowId;
      else if (!w.flowIds.includes(String(patch.preferredFlowId))) return { ok: false, error: `That isn't one of ${w.name}'s flows.` };
      else next.preferredFlowId = String(patch.preferredFlowId);
    }
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
    if (patch.slackHomeChannels !== undefined) {
      const ids = [...new Set((patch.slackHomeChannels ?? []).map((c) => String(c).trim().toUpperCase()))];
      if (ids.some((c) => !/^[CG][A-Z0-9]{6,}$/.test(c))) return { ok: false, error: 'A home channel is a Slack channel ID (it looks like C012AB3CD; in Slack: channel details → bottom).' };
      if (ids.length > 20) return { ok: false, error: 'At most 20 home channels.' };
      // A home channel's every request goes to this worker, whoever is in
      // it: claiming one is an admin's call. Letting one go is its manager's.
      const claimed = ids.filter((c) => !(w.slackHomeChannels ?? []).includes(c));
      if (claimed.length && !admin) return { ok: false, error: `Making ${claimed.join(', ')} ${w.name}'s home channel needs an admin: every request there goes to it.` };
      if (ids.length) next.slackHomeChannels = ids;
      else delete next.slackHomeChannels;
    }
    if (patch.tagline !== undefined) {
      const line = String(patch.tagline).replace(/\s+/g, ' ').trim();
      if (line.length > 160) return { ok: false, error: 'Keep the tagline to a line (160 characters).' };
      if (line) next.tagline = line;
      else delete next.tagline;
    }
    if (patch.jobDescription !== undefined) {
      const job = String(patch.jobDescription).trim();
      if (job.length < 20) return { ok: false, error: 'Describe the job in a sentence or more.' };
      if (job.length > 20_000) return { ok: false, error: 'That job description is too long.' };
      next.jobDescription = job;
    }
    const invalid = validateOrgFields(next);
    if (invalid) return { ok: false, error: invalid };
    this.withTicketFlow(next);
    const saved = this.deps.workers.save(next);
    if (!saved.ok) return saved;
    this.version(caller, w, next);
    this.record(caller, `Changed ${w.name}: ${Object.keys(patch).join(', ')}.`);
    // Re-read through the caller's eyes: moving a worker to another manager
    // can take it out of the caller's sight.
    const summary = this.summaryFor(caller, w.id);
    if (!summary) return { ok: true, worker: { ...this.summaryFor({ name: 'admin', admin: true }, w.id)!, youManage: false } };
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
              ...this.wantedTools(hire),
            },
          }
        : {}),
      ...(hire.reasons ? { reasons: hire.reasons } : {}),
      ...this.alreadyDoes(hire),
    };
  }

  /// What the draft wants that is still not installed: one an admin has
  /// set up since the draft drops off.
  private wantedTools(hire: PendingHire): { wantedTools?: WantedTool[]; toolsAsked?: boolean } {
    const wanted = hire.drafted?.contract.wantedTools ?? [];
    if (!wanted.length) return {};
    const installed = new Set((this.deps.tools?.list([]).tools ?? []).map((t) => t.name.toLowerCase()));
    const still = wanted.filter((t) => !installed.has(t.name.toLowerCase())).map((t) => ({ ...t, inCatalog: !!catalogFor(t.name) }));
    if (!still.length) return {};
    return { wantedTools: still, ...(hire.toolsAskedAt ? { toolsAsked: true } : {}) };
  }

  /// Ask the admins to set up the tools a hire wants. Only admins install
  /// tools, so a hirer who isn't one has no other way to get them.
  askForTools(caller: OrgCaller, hireId: string): Result<{ hire: HireSummary; asked: string[] }> {
    const hire = this.hire(hireId);
    if (!hire) return { ok: false, error: 'No hire in progress with that id — drafts expire after a day.' };
    if (!this.mayTouchHire(caller, hire)) return { ok: false, error: 'That hire belongs to someone else.' };
    const { wantedTools } = this.wantedTools(hire);
    if (!wantedTools) return { ok: false, error: 'Everything it needs is set up already.' };
    const names = wantedTools.map((t) => t.name).join(', ');
    const policy = this.policy();
    if (isAdmin(policy, caller)) return { ok: false, error: `You’re an admin: add ${names} on Setup → Tools in the console.` };
    if (hire.toolsAskedAt) return { ok: false, error: `You already asked for ${names}.` };
    const admins = policy.admins.filter((a) => a !== caller.slackUserId);
    if (!admins.length) return { ok: false, error: `Nobody is an admin on this org yet, so there is no one to set up ${names}.` };
    hire.toolsAskedAt = this.now();
    this.putHire(hire);
    this.deps.onToolsWanted?.(hire, wantedTools, admins);
    this.record(caller, `Asked the admins to set up ${names} for the hire of ${this.summarize(hire).contract?.name ?? 'a worker'}.`);
    return { ok: true, hire: this.summarize(hire), asked: admins };
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
  confirmHire(caller: OrgCaller, hireId: string, options?: HireOptions): Result<{ hired?: WorkerSummary; hire: HireSummary; brought?: string[] }> {
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
    return { ok: true, hired: made.summary, hire: this.summarize(hire), ...(made.brought?.length ? { brought: made.brought } : {}) };
  }

  private make(hire: PendingHire, mcpServers: string[]): Result<{ worker: Worker; summary: WorkerSummary; brought?: string[] }> {
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
      const parsed = parseWorkerYaml(hire.imported.yaml);
      const brought = parsed.ok && parsed.bundle.carried ? this.landCarried(landed.worker, parsed.bundle.carried, by.name) : [];
      const summary = this.summaryFor({ name: 'admin', admin: true }, landed.worker.id)!;
      return { ok: true, worker: landed.worker, summary, brought };
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
    // And it gets to know its tools before its first real job.
    if ((saved.worker.mcpServers ?? []).length) void this.startLearning(saved.worker.id);
    const summary = this.summaryFor({ name: 'admin', admin: true }, saved.worker.id)!;
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
    this.changes++;
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
    this.changes++;
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
    const summary = this.summaryFor(caller, w.id)!;
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
      ...(this.deps.workers.changesOf ? { changes: this.deps.workers.changesOf(w.id) } : {}),
      ...(this.deps.workers.flowsOf ? { flows: this.deps.workers.flowsOf(w.id) } : {}),
      ...(w.preferredFlowId ? { preferredFlowId: w.preferredFlowId } : {}),
      toolProblems: this.toolProblemsFor(w.id),
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
      ...(w.knowledge ? { knowledge: w.knowledge } : {}),
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
        const names = canManage(this.policy(), this.deps.workers.roster(), w.id, caller) || isAdmin(this.policy(), caller);
        return s ? s.list(w.id).map((t) => this.showTrigger(t, s, names)) : [];
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

  /// What each of a run's steps did: what it wrote, and the activity in the
  /// time it ran, for whoever can see its worker. For a finished run, where
  /// the live view has nothing left to show.
  runSteps(caller: OrgCaller, runId: UUID): Result<{ steps: Array<{ id: string; output?: string; body?: string; startedAt?: number; endedAt?: number; outcome?: string; costUSD?: number; error?: string; activity: Array<{ at: number; kind: string; text: string }> }> }> {
    const r = this.deps.runs.getRun(runId);
    if (!r?.workerId || !canSee(this.policy(), this.deps.workers.roster(), r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    const activity = this.deps.runActivity?.(runId, 0) ?? [];
    const steps = r.flowSnapshot.steps.map((s) => {
      const tries = r.attempts.filter((a) => a.stepId === s.id);
      const last = tries[tries.length - 1];
      const body = (last?.artifact?.body ?? (s.output ? r.artifacts?.[s.output]?.body : undefined))?.slice(0, 20_000);
      const from = tries[0]?.startedAt;
      const to = last?.endedAt ?? this.now();
      return {
        id: s.id,
        ...(s.output ? { output: s.output } : {}),
        ...(body ? { body } : {}),
        ...(from ? { startedAt: from } : {}),
        ...(last?.endedAt ? { endedAt: last.endedAt } : {}),
        ...(last?.outcome ? { outcome: last.outcome } : {}),
        ...(tries.some((a) => a.costUSD) ? { costUSD: tries.reduce((n, a) => n + (a.costUSD ?? 0), 0) } : {}),
        ...(last?.errorMessage ? { error: last.errorMessage.slice(0, 800) } : {}),
        activity: from ? activity.filter((x) => x.at >= from && x.at <= to).slice(-200) : [],
      };
    });
    return { ok: true, steps };
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

  /// One run on a page of its own, for whoever can see its worker: the run,
  /// the thread it belongs to (what set it off, follow-ups after it), what
  /// waits on it, and the worker's last runs beside it, so one that went
  /// wrong stands out. What a link from Slack, a ticket or the Library opens.
  runDetail(caller: OrgCaller, runId: UUID): Result<{
    worker: { id: UUID; name: string; enabled: boolean; manager?: string };
    run: { id: UUID; title: string; state: string; startedAt: number; endedAt?: number; steps: number; costUSD?: number; error?: string };
    thread: WorkThread | null;
    waiting: WaitingItem[];
    youManage: boolean;
    recent: Array<{ runId: UUID; title: string; at: number; minutes: number; outcome: RunPast['outcome'] }>;
  }> {
    const r = this.deps.runs.getRun(runId);
    const roster = this.deps.workers.roster();
    if (!r?.workerId || !canSee(this.policy(), roster, r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    const w = roster.find((x) => x.id === r.workerId);
    if (!w) return { ok: false, error: 'No run with that id that you can see.' };
    const ended = r.state.kind === 'done' || r.state.kind === 'aborted';
    const past = ended ? this.runPast(r) : null;
    const manager = managerFor(roster, w.id);
    return {
      ok: true,
      worker: { id: w.id, name: w.name, enabled: w.enabled, ...(manager ? { manager: manager.name } : {}) },
      run: {
        id: r.id,
        title: flowRunTitle(r),
        state: past ? past.outcome : r.state.kind,
        startedAt: r.createdAt,
        ...(ended ? { endedAt: OrgService.runEndedAt(r) } : {}),
        steps: r.flowSnapshot.steps.length,
        ...(r.costUSD ? { costUSD: r.costUSD } : {}),
        ...(past?.error ? { error: past.error } : {}),
      },
      thread: this.threadsFor(caller, w, false).find((t) => t.runs.some((x) => x.runId === r.id) || (t.followUps ?? []).some((f) => f.runs.some((x) => x.runId === r.id))) ?? null,
      waiting: this.listWaiting(caller).filter((x) => x.runId === r.id),
      youManage: canManage(this.policy(), roster, w.id, caller),
      recent: this.endedRuns(w.id)
        .slice(0, 12)
        .map((x) => ({ runId: x.id, title: flowRunTitle(x), at: x.createdAt, minutes: Math.max(0, Math.round((OrgService.runEndedAt(x) - x.createdAt) / 60_000)), outcome: OrgService.runOutcome(x) })),
    };
  }

  /// What a run has changed so far, repo by repo, for whoever can see its
  /// worker: before it pushes, so a Continue is made with the diff in view.
  async runChanges(caller: OrgCaller, runId: UUID, diff = false): Promise<Result<RunChanges>> {
    const r = this.deps.runs.getRun(runId);
    if (!r?.workerId || !canSee(this.policy(), this.deps.workers.roster(), r.workerId, caller)) return { ok: false, error: 'No run with that id that you can see.' };
    if (!this.deps.runChanges) return { ok: false, error: 'Changes can’t be read on this server.' };
    return { ok: true, ...(await this.deps.runChanges(r, { diff })) };
  }

  /// A worker's newest run that changed code and matches `about` (a ticket
  /// key, or words from its title or ask); the newest such run when `about`
  /// is empty. For "/worker Ada changes ACME-412".
  latestCodeRun(caller: OrgCaller, idOrName: string, about: string): Result<{ runId: UUID; title: string }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const words = about.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = this.deps.runs
      .listRuns()
      .filter((r) => r.workerId === w.id && (r.worktreePath || r.workspaceWorktrees?.length))
      .filter((r) => {
        const text = `${flowRunTitle(r)} ${r.userPrompt ?? ''}`.toLowerCase();
        return words.every((x) => text.includes(x));
      })
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return hit ? { ok: true, runId: hit.id, title: flowRunTitle(hit) } : { ok: false, error: `No run of ${w.name}'s that changed code${about.trim() ? ` matches "${about.trim()}"` : ''}.` };
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
      const waiting = r.state.kind === 'paused' && (r.state.reason === 'needsInput' || r.state.reason === 'externalAction' || r.state.reason === 'riskyStep' || r.state.reason === 'preStep');
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
  /// A run's agent time: its attempts end to end, not the waits between them.
  private static agentMs(r: FlowRun): number {
    return (r.attempts ?? []).reduce((n, a) => n + Math.max(0, (a.endedAt ?? a.startedAt) - a.startedAt), 0);
  }

  /// Pull requests a run opened (not ones it only added to, or found open).
  private static prsOpened(r: FlowRun): number {
    return pullRequestsIn(r.artifacts?.[LANDED_ARTIFACT]?.body ?? '').filter((p) => p.state === 'open' || p.state === 'draft').length;
  }

  /// A worker's month so far, from its runs: started, failed, PRs opened.
  private monthOf(runs: FlowRun[]): WorkerSummary['month'] {
    const start = new Date(this.now());
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const mine = runs.filter((r) => r.createdAt >= start.getTime());
    const ended = mine.filter((r) => r.state.kind === 'done' || r.state.kind === 'aborted');
    return {
      runs: mine.length,
      failed: ended.filter((r) => OrgService.runOutcome(r) === 'failed').length,
      pullRequests: mine.reduce((n, r) => n + OrgService.prsOpened(r), 0),
    };
  }

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
    const prs = pullRequestsIn(r.artifacts?.[LANDED_ARTIFACT]?.body ?? '');
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
      ...(prs.length ? { pullRequests: prs } : {}),
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
    const all = this.threadsFor(caller, w, opts.before != null);
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

  /// Every thread of one worker, as this caller sees them. A page further
  /// back, asked for soon after, reuses the last build instead of walking the
  /// whole history again. So does a first page asked for again within a
  /// moment, unless something changed through here since (an ask, a
  /// decision, a rating), so what someone just did shows at once.
  private threadsFor(caller: OrgCaller, w: Worker, paging: boolean): WorkThread[] {
    const key = `${w.id}|${caller.slackUserId ?? ''}|${caller.name}|${caller.admin ? 1 : 0}`;
    const hit = this.threadBuilds.get(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (hit && (paging ? age < THREAD_REUSE_MS : age < FIRST_PAGE_REUSE_MS && hit.changes === this.changes)) return hit.all;
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
    this.threadBuilds.delete(key);
    this.threadBuilds.set(key, { at: this.now(), all, changes: this.changes });
    if (this.threadBuilds.size > 50) this.threadBuilds.delete(this.threadBuilds.keys().next().value as string);
    return all;
  }

  private threadBuilds = new Map<string, { at: number; all: WorkThread[]; changes: number }>();
  /// Counts what changed through here (asks, the decision log, ratings), so a
  /// reused build is never older than the last of them.
  private changes = 0;

  /// Runs of this worker still under way, newest first.
  /// Every run going now on the workers this person can see, newest first:
  /// for the Inbox's "in flight".
  runningNow(caller: OrgCaller): Array<{ workerId: UUID; workerName: string; run: RunNow }> {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    return roster
      .filter((w) => canSee(policy, roster, w.id, caller))
      .flatMap((w) => this.runsNow(w.id).map((run) => ({ workerId: w.id, workerName: w.name, run })))
      .sort((a, b) => b.run.startedAt - a.run.startedAt)
      .slice(0, 30);
  }

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
                : reason === 'externalAction' || reason === 'riskyStep' || reason === 'preStep'
                  ? 'approval'
                  : reason === 'interrupted'
                    ? 'interrupted'
                    : 'paused',
          ...(r.costUSD ? { costUSD: r.costUSD } : {}),
        };
      });
  }

  /// Its job with a described change worked in, to read before saving:
  /// nothing is saved here. From `job` when given (an edit not yet saved),
  /// else the job it has. Its manager or an admin.
  async suggestJob(caller: OrgCaller, idOrName: string, ask: string, job?: string): Promise<Result<{ name: string; job: string }>> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.rewriteJob) return { ok: false, error: 'Rewriting a job isn’t set up on this server. Change it by hand.' };
    const change = ask.trim();
    if (change.length < 3) return { ok: false, error: 'Say what should change.' };
    const from = (job ?? found.worker.jobDescription).trim();
    const next = await this.deps.rewriteJob({ name: found.worker.name, job: from, ask: change.slice(0, 2000) }).catch(() => null);
    if (!next) return { ok: false, error: 'Couldn’t write a new version just now. Try again, or change it by hand.' };
    return { ok: true, name: found.worker.name, job: next };
  }

  // ---- HOW IT WORKS -----------------------------------------------------

  /// The flows it runs, as plain steps, with who else runs each. Whoever
  /// can see it; `canChange` says whether this caller may change it.
  workerFlows(caller: OrgCaller, idOrName: string): Result<{ flows: WorkerFlowView[]; canChange: boolean }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    if (!this.deps.models) return { ok: true, flows: [], canChange: false };
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const ids = [...new Set([...w.flowIds, ...(w.wrapUpFlowId ? [w.wrapUpFlowId] : [])])];
    const byId = new Map(this.deps.models.flows(ids).map((f) => [f.id, f]));
    const usual = w.preferredFlowId && w.flowIds.includes(w.preferredFlowId) ? w.preferredFlowId : w.flowIds[0];
    const flows = ids.flatMap((id): WorkerFlowView[] => {
      const f = byId.get(id);
      if (!f) return [];
      const others = roster.filter((x) => x.id !== w.id && (x.flowIds.includes(id) || x.wrapUpFlowId === id));
      return [{
        id,
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        usual: id === usual,
        wrapUp: id === w.wrapUpFlowId,
        steps: stepsOf(f),
        sharedWith: others.map((x) => x.name),
        othersNotYours: others.filter((x) => !canManage(policy, roster, x.id, caller)).map((x) => x.name),
      }];
    });
    flows.sort((a, b) => Number(b.usual) - Number(a.usual) || Number(a.wrapUp) - Number(b.wrapUp));
    return { ok: true, flows, canChange: canManage(policy, roster, w.id, caller) && !!this.deps.reviseFlow };
  }

  /// One of its flows with a described change worked in, to read before
  /// saving: nothing is saved here. From `yaml` when given (a change not yet
  /// saved, asked again), else the flow as saved. Its manager or an admin.
  async suggestFlow(caller: OrgCaller, idOrName: string, flowId: string, ask: string, yaml?: string): Promise<Result<{ flowId: string; yaml: string; steps: FlowStepView[]; changes: string[] }>> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.reviseFlow) return { ok: false, error: 'Changing how a worker works isn’t set up on this server.' };
    const flow = this.ownFlow(found.worker, flowId);
    if (!flow.ok) return flow;
    const change = ask.trim();
    if (change.length < 3) return { ok: false, error: 'Say what should change.' };
    const admin = isAdmin(this.policy(), caller);
    let base = flow.flow;
    if (yaml) {
      const held = this.readFlowEdit(flow.flow, yaml, admin, found.worker.mcpServers);
      if (!held.ok) return held;
      base = held.flow;
    }
    const revised = await this.deps.reviseFlow({ flow: base, ask: change.slice(0, 2000) }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (!revised.ok) return { ok: false, error: `Couldn’t write a new version just now: ${revised.error}` };
    const held = holdFlowEdit(flow.flow, revised.flow, { admin, servers: found.worker.mcpServers });
    if (!held.ok) return held;
    const changes = describeFlowEdit(flow.flow, held.flow);
    if (!changes.length) return { ok: false, error: 'That didn’t change any of its steps. Try saying it another way.' };
    return { ok: true, flowId: flow.flow.id, yaml: serializeFlow(held.flow), steps: stepsOf(held.flow), changes };
  }

  /// Save a suggested change. A flow other workers run changes for them
  /// only with `everyone` (and their managers' say, or an admin's);
  /// otherwise this worker gets its own copy. Kept in its history.
  saveFlowEdit(caller: OrgCaller, idOrName: string, flowId: string, yaml: string, everyone: boolean): Result<{ flowId: string; copied: boolean; changes: string[] }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.models) return { ok: false, error: 'Changing how a worker works isn’t set up on this server.' };
    const w = found.worker;
    const flow = this.ownFlow(w, flowId);
    if (!flow.ok) return flow;
    const held = this.readFlowEdit(flow.flow, yaml, isAdmin(this.policy(), caller), w.mcpServers);
    if (!held.ok) return held;
    const changes = describeFlowEdit(flow.flow, held.flow);
    if (!changes.length) return { ok: false, error: 'Nothing changed.' };
    const roster = this.deps.workers.roster();
    const others = roster.filter((x) => x.id !== w.id && (x.flowIds.includes(flowId) || x.wrapUpFlowId === flowId));
    let next = held.flow;
    let after = w;
    if (others.length && everyone) {
      const notYours = others.filter((x) => !canManage(this.policy(), roster, x.id, caller));
      if (notYours.length) return { ok: false, error: `${notYours.map((x) => x.name).join(', ')} run${notYours.length === 1 ? 's' : ''} it too and ${notYours.length === 1 ? 'isn’t' : 'aren’t'} yours. Their manager or an admin can change it for everyone, or save it for ${w.name} alone.` };
    } else if (others.length) {
      const id = copyFlowId(flowId, w.name, (x) => this.deps.models!.flows([x]).length > 0);
      next = { ...held.flow, id, name: `${held.flow.name} (${w.name})`, source: 'user', filePath: '' };
      const swap = (x: string) => (x === flowId ? id : x);
      after = { ...structuredClone(w), flowIds: w.flowIds.map(swap) };
      if (w.preferredFlowId) after.preferredFlowId = swap(w.preferredFlowId);
      if (w.wrapUpFlowId) after.wrapUpFlowId = swap(w.wrapUpFlowId);
    }
    const saved = this.deps.models.save(next);
    if (!saved.ok) return saved;
    if (after !== w) {
      const moved = this.deps.workers.save(after);
      if (!moved.ok) return moved;
    }
    this.flowVersion(caller, w, after, flow.flow, next);
    this.record(caller, `Changed how ${w.name} works (${flow.flow.name}${next.id !== flowId ? `, now its own copy` : others.length ? `, for ${others.map((x) => x.name).join(', ')} too` : ''}): ${changes.join(' ')}`);
    return { ok: true, flowId: next.id, copied: next.id !== flowId, changes };
  }

  /// One of the worker's own flows, as saved.
  private ownFlow(w: Worker, flowId: string): Result<{ flow: Flow }> {
    if (!w.flowIds.includes(flowId) && w.wrapUpFlowId !== flowId) return { ok: false, error: `That isn't one of ${w.name}'s flows.` };
    const flow = this.deps.models?.flows([flowId])[0];
    return flow ? { ok: true, flow } : { ok: false, error: 'Couldn’t find that flow on this server.' };
  }

  /// A flow sent back from the console, held to what `before` allowed.
  private readFlowEdit(before: Flow, yaml: string, admin: boolean, servers?: string[]): Result<{ flow: Flow }> {
    if (yaml.length > 200_000) return { ok: false, error: 'That flow is too long.' };
    const parsed = parseFlowYaml({ yaml, id: before.id, source: before.source, filePath: before.filePath });
    if (!parsed) return { ok: false, error: 'That flow didn’t read. Ask for the change again.' };
    return holdFlowEdit(before, parsed, { admin, servers });
  }

  // ---- ONBOARDING -------------------------------------------------------

  /// Have a worker go through its own tools for its job, read only, and
  /// write down what it found (`Worker.knowledge`). Its manager or an admin.
  /// Newer models for a worker: its planning model and each of its flows,
  /// each moved only within its own line and tier (`newestInFamily`), never
  /// on its own. Also what runs on another backend here because its own
  /// isn't signed in, and who else uses a flow it would change. Manager's.
  async modelUpgrades(caller: OrgCaller, idOrName: string): Promise<Result<ModelUpgradePlan>> {
    if (!this.deps.models) return { ok: false, error: 'Model upgrades aren’t offered on this server.' };
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const w = found.worker;
    const healthy = await this.deps.models.healthy().catch((): Backend[] => []);
    const label = (b: Backend, m: string) => friendlyModelLabel(b, m);
    let planning: ModelUpgradePlan['planning'];
    if (w.heartbeatModel) {
      const b = w.heartbeatBackend;
      const to = b && b !== 'ollama' ? newestInFamily(b, w.heartbeatModel) : w.heartbeatModel;
      const here = b && !healthy.includes(b) ? pickDrafterBackend({ preferred: b, isHealthy: (x) => healthy.includes(x), isEnabled: () => true }) : null;
      planning = {
        model: b ? label(b, w.heartbeatModel) : w.heartbeatModel,
        ...(b && to !== w.heartbeatModel ? { to: label(b, to), change: shortModelChangeLabel({ backend: b, from: w.heartbeatModel, to }) } : {}),
        ...(b && !healthy.includes(b) && healthy.length ? { runsHere: here ? `${b} isn’t signed in here, so it plans on ${here} at the same tier.` : `${b} isn’t signed in here.` } : {}),
      };
    }
    const ids = [...new Set([...w.flowIds, ...(w.wrapUpFlowId ? [w.wrapUpFlowId] : [])])];
    const roster = this.deps.workers.roster();
    const flows = this.deps.models.flows(ids).map((f) => {
      const changes = planFlowModelUpgrade(f).map((c) => ({ ...c, change: shortModelChangeLabel(c) }));
      const moved = healthy.length ? rebindMissingBackends(f, { healthyBackends: healthy, ...this.deps.models!.fallback?.() }).moved : [];
      return {
        id: f.id,
        name: f.name,
        changes,
        sharedWith: roster.filter((x) => x.id !== w.id && (x.flowIds.includes(f.id) || x.wrapUpFlowId === f.id)).map((x) => x.name),
        runsHere: [...new Set(moved.map((m) => `${m.from} runs as ${m.to}`))],
        // Which backends those steps were written for, to name what to sign in.
        missing: [...new Set([...f.participants.map((p) => p.backend), ...f.steps.flatMap((s) => (s.model ? [s.model.backend] : []))].filter((b) => !healthy.includes(b)))],
      };
    });
    return { ok: true, healthy, ...(planning ? { planning } : {}), flows };
  }

  /// Move what was picked onto its newer model. A flow other workers use
  /// moves for them too, so it needs their manager as well (or an admin).
  async upgradeModels(caller: OrgCaller, idOrName: string, pick: { planning?: boolean; flows?: string[] }): Promise<Result<{ changed: string[]; errors: string[] }>> {
    if (!this.deps.models) return { ok: false, error: 'Model upgrades aren’t offered on this server.' };
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const w = found.worker;
    const changed: string[] = [];
    const errors: string[] = [];
    const b = w.heartbeatBackend;
    if (pick.planning && b && b !== 'ollama' && w.heartbeatModel) {
      const to = newestInFamily(b, w.heartbeatModel);
      if (to !== w.heartbeatModel) {
        const saved = this.deps.workers.save({ ...structuredClone(w), heartbeatModel: to });
        if (saved.ok) changed.push(`Planning: ${shortModelChangeLabel({ backend: b, from: w.heartbeatModel, to })}`);
        else errors.push(`Planning: ${saved.error}`);
      }
    }
    const wanted = new Set((pick.flows ?? []).filter((id) => w.flowIds.includes(id) || w.wrapUpFlowId === id));
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    for (const f of this.deps.models.flows([...wanted])) {
      const changes = planFlowModelUpgrade(f);
      if (!changes.length) continue;
      const others = roster.filter((x) => x.id !== w.id && (x.flowIds.includes(f.id) || x.wrapUpFlowId === f.id));
      const notYours = others.filter((x) => !canManage(policy, roster, x.id, caller));
      if (notYours.length) {
        errors.push(`${f.name}: ${notYours.map((x) => x.name).join(', ')} use${notYours.length === 1 ? 's' : ''} it too, and ${notYours.length === 1 ? 'isn’t' : 'aren’t'} yours. Their manager or an admin can.`);
        continue;
      }
      const saved = this.deps.models.save(applyFlowModelUpgrade(f, changes));
      if (saved.ok) changed.push(`${f.name}: ${changes.map((c) => shortModelChangeLabel(c)).join(', ')}`);
      else errors.push(`${f.name}: ${saved.error}`);
    }
    if (changed.length) this.record(caller, `Moved ${w.name} onto newer models: ${changed.join('; ')}.`);
    return { ok: true, changed, errors };
  }

  learnWorker(caller: OrgCaller, idOrName: string): Result<{ name: string }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    if (!this.deps.workers.lookup) return { ok: false, error: 'Workers can’t learn on this server.' };
    if (found.worker.knowledge?.status === 'learning' && this.now() - (found.worker.knowledge.triedAt ?? 0) < LEARN_WAIT_MS) {
      return { ok: false, error: `${found.worker.name} is already learning.` };
    }
    void this.startLearning(found.worker.id);
    this.record(caller, `Had ${found.worker.name} learn its tools.`);
    return { ok: true, name: found.worker.name };
  }

  private saveKnowledge(id: UUID, k: NonNullable<Worker['knowledge']>): void {
    const w = this.deps.workers.get(id);
    if (w) this.deps.workers.save({ ...w, knowledge: k });
  }

  /// The run itself: a look-up with its reading tools, waited on.
  private async startLearning(id: UUID): Promise<void> {
    const w = this.deps.workers.get(id);
    if (!w || !this.deps.workers.lookup) return;
    const prior = w.knowledge;
    const base = { ...(prior?.body ? { body: prior.body, updatedAt: prior.updatedAt } : {}), ...(prior?.refresh ? { refresh: prior.refresh } : {}) };
    this.saveKnowledge(id, { ...base, status: 'learning', triedAt: this.now() });
    const fail = (error: string) => this.saveKnowledge(id, { ...base, status: prior?.body ? 'ready' : 'failed', triedAt: this.now(), error });
    try {
      const ran = await this.deps.workers.lookup(id, { title: 'Getting to know its tools', prompt: learnPrompt(w, prior?.body) });
      if (!ran.ok) return fail(ran.error);
      const answer = await this.lookupAnswer(ran.orchestrationId, LEARN_WAIT_MS);
      if (!answer.ok) return fail(answer.error);
      const body = readKnowledge(answer.text);
      if (!body) return fail('It didn’t write anything down.');
      this.saveKnowledge(id, { status: 'ready', body, updatedAt: this.now(), triedAt: this.now(), ...(prior?.refresh ? { refresh: prior.refresh } : {}) });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  /// Its manager corrects what it knows, or says how often it refreshes.
  setKnowledge(caller: OrgCaller, idOrName: string, patch: { body?: string; refresh?: 'weekly' | 'off' }): Result<{ name: string }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const k = found.worker.knowledge ?? { status: 'ready' as const };
    const next = { ...k };
    if (patch.body !== undefined) {
      const body = patch.body.trim();
      if (body.length > 10_000) return { ok: false, error: 'Keep it under 10,000 characters: it reads all of it every run.' };
      next.body = body;
      next.status = 'ready';
      next.updatedAt = this.now();
      next.editedBy = caller.name;
      delete next.error;
    }
    if (patch.refresh === 'weekly' || patch.refresh === 'off') next.refresh = patch.refresh;
    this.saveKnowledge(found.worker.id, next);
    this.record(caller, `Changed what ${found.worker.name} knows${patch.refresh ? ` (refresh: ${patch.refresh})` : ''}.`);
    return { ok: true, name: found.worker.name };
  }

  /// Workers whose onboarding is a week old learn again, unless told not to.
  /// One at a time a call, so a server back from a long sleep doesn't send
  /// every worker off at once.
  refreshKnowledgeDue(): void {
    const now = this.now();
    const due = this.deps.workers.roster().find((w) => w.enabled && w.knowledge?.status === 'ready' && w.knowledge.refresh !== 'off' && now - (w.knowledge.updatedAt ?? 0) > WEEK_MS && now - (w.knowledge.triedAt ?? 0) > DAY_MS);
    if (due) void this.startLearning(due.id);
  }

  // ---- STORAGE ----------------------------------------------------------

  /// What's using the server's disk. Admins.
  async storage(caller: OrgCaller): Promise<Result<{ report: StorageReport }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can see the server’s storage.' };
    if (!this.deps.storage) return { ok: false, error: 'Storage isn’t reported on this server.' };
    return { ok: true, report: await this.deps.storage.report() };
  }

  /// Throw away a finished run's checkouts, unpushed work and all. Admins.
  async discardCheckouts(caller: OrgCaller, runId: string): Promise<Result<{ removed: number }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can do that.' };
    if (!this.deps.storage) return { ok: false, error: 'Storage isn’t managed on this server.' };
    const res = await this.deps.storage.discard(runId);
    if (res.ok) this.record(caller, `Deleted the checkouts of run ${runId}, with work that was never pushed.`);
    return res;
  }

  /// Empty the tools' package cache; they install again in the background.
  async clearBuildCache(caller: OrgCaller): Promise<Result> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can do that.' };
    if (!this.deps.storage?.clearBuildCache) return { ok: false, error: 'Storage isn’t managed on this server.' };
    await this.deps.storage.clearBuildCache();
    this.record(caller, 'Cleared the build caches.');
    return { ok: true };
  }

  async clearToolCache(caller: OrgCaller): Promise<Result> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can do that.' };
    if (!this.deps.storage) return { ok: false, error: 'Storage isn’t managed on this server.' };
    await this.deps.storage.clearToolCache();
    this.record(caller, 'Cleared the tools’ package cache.');
    return { ok: true };
  }

  // ---- HANDBOOK ---------------------------------------------------------

  /// What every worker reads after its job. Anyone can read it.
  handbook(_caller: OrgCaller): Result<{ text: string; canEdit: boolean }> {
    if (!this.deps.handbook) return { ok: false, error: 'There’s no handbook on this server.' };
    return { ok: true, text: this.deps.handbook.read(), canEdit: isAdmin(this.policy(), _caller) };
  }

  setHandbook(caller: OrgCaller, text: string): Result<{ text: string }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can change the handbook.' };
    if (!this.deps.handbook) return { ok: false, error: 'There’s no handbook on this server.' };
    const t = text.replace(/\r\n/g, '\n').trim();
    if (t.length > HANDBOOK_MAX) return { ok: false, error: `Keep it under ${HANDBOOK_MAX.toLocaleString()} characters: every worker reads all of it on every run.` };
    this.deps.handbook.write(t);
    this.record(caller, 'Changed the handbook.');
    return { ok: true, text: t };
  }

  // ---- DIGEST -----------------------------------------------------------

  /// The week for someone: what their workers did and what waits on them;
  /// for an admin, the org's totals too. Null: nothing to say to them.
  weeklyDigest(caller: OrgCaller): Result<{ digest: WeeklyDigest | null }> {
    const rep = this.report(caller, 7);
    if (!rep.ok) return rep;
    const since = this.now() - 7 * 86_400_000;
    const ratings = (this.deps.ratings?.list() ?? []).filter((r) => r.at >= since);
    const rated = (id: string, useful: boolean) => ratings.filter((r) => r.workerId === id && r.useful === useful).length;
    const rows = rep.report.byWorker;
    const mine = rows.filter((r) => r.youManage).map((r) => ({
      name: r.name, done: r.itemsDone, failed: r.itemsFailed, errands: r.errands, costUSD: r.costUSD,
      useful: rated(r.workerId, true), notUseful: rated(r.workerId, false),
    }));
    const waiting = this.listWaiting(caller);
    const oldest = waiting.reduce<number | undefined>((m, x) => {
      const at = (x as { since?: number }).since;
      return at && (!m || at < m) ? at : m;
    }, undefined);
    const policy = this.policy();
    const admin = isAdmin(policy, caller);
    const done = rows.reduce((n, r) => n + r.itemsDone, 0);
    const cost = rows.reduce((n, r) => n + r.costUSD, 0);
    const org = admin
      ? {
          workers: rows.length, done, failed: rows.reduce((n, r) => n + r.itemsFailed, 0), costUSD: cost,
          costPerDone: done ? cost / done : null,
          useful: ratings.filter((r) => r.useful).length, notUseful: ratings.filter((r) => !r.useful).length,
          troubled: (this.deps.toolHealth?.list() ?? []).map((t) => t.tool),
          toolRequests: this.toolRequestList().filter((r) => r.status === 'open').length,
        }
      : undefined;
    if (!mine.length && !waiting.length && !org) return { ok: true, digest: null };
    return { ok: true, digest: { org: policy.name ?? 'Your org', mine, waiting: waiting.length, ...(oldest ? { oldestWaitingAt: oldest } : {}), ...(org ? { orgTotals: org } : {}) } };
  }

  // ---- VERSIONS ---------------------------------------------------------

  private memVersions: WorkerVersion[] = [];

  private versionList(): WorkerVersion[] {
    return this.deps.workerVersions?.list() ?? this.memVersions;
  }

  private configOf(w: Worker): WorkerConfig {
    return {
      jobDescription: w.jobDescription,
      tagline: w.tagline ?? '',
      mcpServers: [...(w.mcpServers ?? [])],
      ...(w.toolScopes ? { toolScopes: structuredClone(w.toolScopes) as Record<string, unknown> } : {}),
      trust: w.trust,
      ...(w.visibility ? { visibility: w.visibility } : {}),
      budgetUSDPerMonth: w.budgetUSDPerMonth,
      cadence: structuredClone(w.cadence),
      ...(w.preferredFlowId ? { preferredFlowId: w.preferredFlowId } : {}),
      ...(w.caps.answersAtOnce ? { answersAtOnce: w.caps.answersAtOnce } : {}),
      ...(w.caps.skipCheckpoints ? { skipCheckpoints: true } : {}),
      ...(w.caps.alwaysAllow?.length ? { alwaysAllow: [...w.caps.alwaysAllow] } : {}),
    };
  }

  /// Keep a version when what it's set up to do changed: the one before
  /// too, the first time, so there's always something to go back to.
  private version(caller: OrgCaller, before: Worker, after: Worker): void {
    const was = this.configOf(before);
    const now = this.configOf(after);
    const WORDS: Record<keyof WorkerConfig, string> = {
      jobDescription: 'its job', tagline: 'its tagline', mcpServers: 'its tools', toolScopes: 'how much of its tools', trust: 'its trust', visibility: 'who can ask it',
      budgetUSDPerMonth: 'its budget', cadence: 'when it runs', preferredFlowId: 'its usual flow', answersAtOnce: 'answers at once',
      skipCheckpoints: 'checkpoints', alwaysAllow: 'what it may always do',
    };
    const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])] as Array<keyof WorkerConfig>;
    const changed = keys.filter((k) => JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null)).map((k) => WORDS[k]);
    if (!changed.length) return;
    const all = this.versionList();
    const mine = all.filter((v) => v.workerId === after.id);
    const add: WorkerVersion[] = [];
    if (!mine.length) add.push({ id: randomUUID(), workerId: after.id, at: this.now() - 1, by: 'before history was kept', changed: ['as it was'], config: was });
    add.push({ id: randomUUID(), workerId: after.id, at: this.now(), by: caller.name, changed, config: now });
    const kept = [...mine, ...add].slice(-WORKER_VERSIONS_KEPT);
    const next = [...all.filter((v) => v.workerId !== after.id), ...kept];
    if (this.deps.workerVersions) this.deps.workerVersions.save(next);
    else this.memVersions = next;
  }

  /// Keep a version when one of its flows changed: the flow before too,
  /// the first time that flow changes, so there's something to go back to.
  private flowVersion(caller: OrgCaller, before: Worker, after: Worker, was: Flow, now: Flow): void {
    const all = this.versionList();
    const mine = all.filter((v) => v.workerId === after.id);
    const snap = (w: Worker, f: Flow): NonNullable<WorkerVersion['flow']> => ({
      id: f.id,
      name: f.name,
      yaml: serializeFlow(f),
      flowIds: [...w.flowIds],
      ...(w.wrapUpFlowId ? { wrapUpFlowId: w.wrapUpFlowId } : {}),
    });
    const add: WorkerVersion[] = [];
    if (!mine.some((v) => v.flow?.id === was.id)) add.push({ id: randomUUID(), workerId: after.id, at: this.now() - 1, by: 'before it changed', changed: ['how it works, as it was'], config: this.configOf(before), flow: snap(before, was) });
    add.push({ id: randomUUID(), workerId: after.id, at: this.now(), by: caller.name, changed: ['how it works'], config: this.configOf(after), flow: snap(after, now) });
    const kept = [...mine, ...add].slice(-WORKER_VERSIONS_KEPT);
    const next = [...all.filter((v) => v.workerId !== after.id), ...kept];
    if (this.deps.workerVersions) this.deps.workerVersions.save(next);
    else this.memVersions = next;
  }

  /// Back to a version's flow, through the same rules as changing it by hand.
  private restoreFlow(caller: OrgCaller, w: Worker, v: NonNullable<WorkerVersion['flow']>): Result {
    if (!this.deps.models) return { ok: false, error: 'Flows can’t be changed on this server.' };
    const current = this.deps.models.flows([v.id])[0];
    const parsed = parseFlowYaml({ yaml: v.yaml, id: v.id, source: current?.source ?? 'user', filePath: current?.filePath ?? '' });
    if (!parsed) return { ok: false, error: 'That version’s flow didn’t read.' };
    let flow = parsed;
    if (current) {
      const held = holdFlowEdit(current, parsed, { admin: isAdmin(this.policy(), caller), servers: w.mcpServers });
      if (!held.ok) return held;
      flow = held.flow;
      const roster = this.deps.workers.roster();
      const notYours = roster.filter((x) => x.id !== w.id && (x.flowIds.includes(v.id) || x.wrapUpFlowId === v.id) && !canManage(this.policy(), roster, x.id, caller));
      if (notYours.length && describeFlowEdit(current, flow).length) return { ok: false, error: `${notYours.map((x) => x.name).join(', ')} run${notYours.length === 1 ? 's' : ''} ${v.name} too. Their manager or an admin can put it back.` };
    }
    const saved = this.deps.models.save(flow);
    if (!saved.ok) return saved;
    const ids = v.flowIds.filter((id) => id === v.id || this.deps.models!.flows([id]).length);
    if (ids.length && (JSON.stringify(ids) !== JSON.stringify(w.flowIds) || (v.wrapUpFlowId ?? null) !== (w.wrapUpFlowId ?? null))) {
      const next: Worker = { ...structuredClone(w), flowIds: ids };
      if (v.wrapUpFlowId) next.wrapUpFlowId = v.wrapUpFlowId;
      else delete next.wrapUpFlowId;
      if (next.preferredFlowId && !ids.includes(next.preferredFlowId)) delete next.preferredFlowId;
      const moved = this.deps.workers.save(next);
      if (!moved.ok) return moved;
    }
    return { ok: true };
  }

  /// A worker's setup over time, newest first. Whoever can see it.
  workerHistory(caller: OrgCaller, idOrName: string): Result<{ versions: Array<Omit<WorkerVersion, 'config' | 'flow'> & { job: string; tagline?: string; tools: string[]; trust: string; flow?: { name: string; steps: FlowStepView[] } }> }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    const versions = this.versionList().filter((v) => v.workerId === w.id).reverse()
      .map(({ config, flow, ...v }) => {
        const f = flow ? parseFlowYaml({ yaml: flow.yaml, id: flow.id, source: 'user', filePath: '' }) : null;
        return { ...v, job: config.jobDescription, ...(config.tagline !== undefined ? { tagline: config.tagline } : {}), tools: config.mcpServers, trust: config.trust, ...(flow ? { flow: { name: flow.name, steps: f ? stepsOf(f) : [] } } : {}) };
      });
    return { ok: true, versions };
  }

  /// Back to a version: through the same rules as changing it by hand, so
  /// restoring can't give it what you couldn't.
  restoreWorker(caller: OrgCaller, idOrName: string, versionId: string): Result<{ worker: WorkerSummary }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const v = this.versionList().find((x) => x.id === versionId && x.workerId === found.worker.id);
    if (!v) return { ok: false, error: 'No such version.' };
    const c = v.config;
    // Its flow first: the usual flow below may be the one put back.
    if (v.flow) {
      const put = this.restoreFlow(caller, found.worker, v.flow);
      if (!put.ok) return put;
    }
    const res = this.update(caller, found.worker.id, {
      jobDescription: c.jobDescription,
      ...(c.tagline !== undefined ? { tagline: c.tagline } : {}),
      mcpServers: c.mcpServers,
      toolScopes: Object.fromEntries([...new Set([...Object.keys(found.worker.toolScopes ?? {}), ...Object.keys(c.toolScopes ?? {})])].map((k) => [k, (c.toolScopes ?? {})[k] ?? null])),
      visibility: (c.visibility ?? 'private') as WorkerVisibility,
      budgetUSDPerMonth: c.budgetUSDPerMonth,
      cadence: c.cadence as ScheduleTrigger | null,
      preferredFlowId: c.preferredFlowId ?? null,
      answersAtOnce: c.answersAtOnce ?? ANSWERS_AT_ONCE,
      skipCheckpoints: c.skipCheckpoints === true,
      alwaysAllow: c.alwaysAllow ?? [],
    });
    if (!res.ok) return res;
    if (c.trust !== found.worker.trust) {
      const t = this.setTrust(caller, found.worker.id, c.trust as WorkerTrustLevel);
      if (!t.ok) return { ok: false, error: `Restored everything but its trust: ${t.error}` };
    }
    this.record(caller, `Restored ${found.worker.name} to how it was ${new Date(v.at).toISOString().slice(0, 16).replace('T', ' ')}.`);
    const summary = this.summaryFor(caller, found.worker.id);
    return summary ? { ok: true, worker: summary } : res;
  }

  // ---- TOOL REQUESTS ----------------------------------------------------

  private memToolRequests: ToolRequest[] = [];

  private toolRequestList(): ToolRequest[] {
    return this.deps.toolRequests?.list() ?? this.memToolRequests;
  }

  private saveToolRequests(all: ToolRequest[]): void {
    if (this.deps.toolRequests) this.deps.toolRequests.save(all);
    else this.memToolRequests = all;
  }

  /// Give a worker a tool, or ask an admin for it. One the org clears for
  /// any hire (or any tool, for an admin) is given at once; anything else,
  /// or one this server doesn't have yet, becomes a request the admins see.
  /// Its manager or an admin.
  requestTool(caller: OrgCaller, idOrName: string, tool: string, why?: string): Result<{ given: boolean; name: string; tool: string; request?: ToolRequest; asked?: string[] }> {
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const w = found.worker;
    const name = tool.trim().slice(0, 80);
    if (!name) return { ok: false, error: 'Which tool?' };
    const policy = this.policy();
    const admin = isAdmin(policy, caller);
    const installed = this.deps.tools ? this.deps.tools.list([]).tools.map((t) => t.name) : null;
    const match = installed?.find((n) => n.toLowerCase() === name.toLowerCase()) ?? (installed ? undefined : name);
    const shared = policy.sharedMcpServers ?? [];
    if (match && ((w.mcpServers ?? []).includes(match) || shared.includes(match))) return { ok: false, error: `${w.name} already has ${match}.` };
    if (match && (admin || (policy.allowedMcpServers ?? []).includes(match))) {
      const res = this.update(caller, w.id, { mcpServers: [...(w.mcpServers ?? []), match] });
      if (!res.ok) return res;
      return { ok: true, given: true, name: w.name, tool: match };
    }
    if (admin) return { ok: false, error: `${name} isn’t on this server yet. Add it under Setup → Tools, then give it to ${w.name}.` };
    const all = this.toolRequestList();
    const asking = match ?? name;
    const open = all.find((r) => r.status === 'open' && r.workerId === w.id && r.tool.toLowerCase() === asking.toLowerCase());
    if (open) return { ok: false, error: `${open.by.name} already asked for ${open.tool} for ${w.name}. It’s waiting on an admin.` };
    const admins = policy.admins.filter((a) => a !== caller.slackUserId);
    if (!admins.length) return { ok: false, error: 'Nobody is an admin on this org yet, so there is no one to ask.' };
    const request: ToolRequest = {
      id: randomUUID(),
      workerId: w.id,
      workerName: w.name,
      tool: asking,
      ...(why?.trim() ? { why: why.trim().slice(0, 500) } : {}),
      by: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) },
      at: this.now(),
      status: 'open',
    };
    this.saveToolRequests([...all, request]);
    this.deps.onToolRequest?.(request, admins);
    this.record(caller, `Asked the admins for ${asking} for ${w.name}.`);
    return { ok: true, given: false, name: w.name, tool: asking, request, asked: admins };
  }

  /// An admin says a failing tool is dealt with.
  clearToolTrouble(caller: OrgCaller, tool: string): Result {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can do that.' };
    this.deps.toolHealth?.clear(tool);
    this.record(caller, `Marked ${tool} as fixed.`);
    return { ok: true };
  }

  /// Whether a tool by this name is on this server.
  toolInstalled(name: string): boolean {
    return !this.deps.tools || this.deps.tools.list([]).tools.some((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /// The requests an admin decides (all still open), or the ones you made.
  toolRequests(caller: OrgCaller): ToolRequest[] {
    const all = this.toolRequestList();
    if (isAdmin(this.policy(), caller)) return all.filter((r) => r.status === 'open');
    return all.filter((r) => !!caller.slackUserId && r.by.slackUserId === caller.slackUserId).slice(-20);
  }

  /// An admin gives the tool asked for, or declines it. Giving needs it
  /// installed: one that isn't is installed first, under Setup → Tools.
  decideToolRequest(caller: OrgCaller, id: string, give: boolean, note?: string): Result<{ request: ToolRequest }> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can decide a tool request.' };
    const all = this.toolRequestList();
    const r = all.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'No such request.' };
    if (r.status !== 'open') return { ok: false, error: `${r.decidedBy ?? 'Someone'} already ${r.status === 'given' ? 'gave it' : 'declined it'}.` };
    if (give) {
      const w = this.deps.workers.get(r.workerId);
      if (!w) return { ok: false, error: `${r.workerName} isn’t here any more.` };
      const installed = this.deps.tools ? this.deps.tools.list([]).tools.map((t) => t.name) : null;
      const match = installed ? installed.find((n) => n.toLowerCase() === r.tool.toLowerCase()) : r.tool;
      if (!match) return { ok: false, error: `${r.tool} isn’t on this server yet. Add it under Setup → Tools first, then give it.` };
      if (!(w.mcpServers ?? []).includes(match)) {
        const res = this.update(caller, w.id, { mcpServers: [...(w.mcpServers ?? []), match] });
        if (!res.ok) return res;
      }
      r.tool = match;
    }
    r.status = give ? 'given' : 'declined';
    r.decidedBy = caller.name;
    r.decidedAt = this.now();
    if (!give && note?.trim()) r.note = note.trim().slice(0, 300);
    this.saveToolRequests(all);
    this.deps.onToolRequestDecided?.(r);
    this.record(caller, `${give ? 'Gave' : 'Declined'} ${r.tool} for ${r.workerName} (asked by ${r.by.name}).`);
    return { ok: true, request: r };
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
    const now = this.deps.workers.get(found.worker.id);
    if (now) this.version(caller, found.worker, now);
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
      toolRequests: isAdmin(policy, caller) ? this.toolRequestList().filter((r) => r.status === 'open') : [],
      toolTrouble: isAdmin(policy, caller) ? this.deps.toolHealth?.list() ?? [] : [],
      teamTasks: this.teamTasks(caller).filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
      proposals: this.proposals(caller),
      delivered: this.workItems(crewSource, this.now() - 36 * 3_600_000, 12),
      crew: crewSource
        .map((w) => ({
          id: w.id,
          name: w.name,
          state: workerState(w, runs),
          nextShiftAt: snapshots.get(w.id) ?? null,
          spentUSD: spent.get(w.id) ?? 0,
          ...(Number.isFinite(w.budgetUSDPerMonth) && w.budgetUSDPerMonth > 0 ? { budgetUSDPerMonth: w.budgetUSDPerMonth } : {}),
        }))
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
  private runPlace(runId: UUID): { step?: { index: number; total: number; name: string }; startedAt?: number; said?: string; paused?: string } {
    const r = this.deps.runs.getRun(runId);
    if (!r) return {};
    const steps = r.flowSnapshot.steps;
    const at = r.state.kind === 'running' ? r.state.currentStepId : r.state.kind === 'paused' ? r.state.nextStepId : undefined;
    const index = steps.findIndex((s) => s.id === at);
    const said = (this.deps.runActivity?.(runId, 0) ?? []).filter((a) => a.kind === 'said').at(-1)?.text;
    return {
      ...(index >= 0 ? { step: { index: index + 1, total: steps.length, name: steps[index].id.replace(/[-_]+/g, ' ') } } : {}),
      startedAt: r.createdAt,
      ...(said && plainSaid(said) ? { said: plainSaid(said) } : {}),
      ...(r.state.kind === 'paused' ? { paused: `${PAUSED_WORDS[r.state.reason]}${index >= 0 ? ` before ${steps[index].id.replace(/[-_]+/g, ' ')}` : ''}` } : {}),
    };
  }

  // ---- REPOS ------------------------------------------------------------

  /// Connected repos, and who works in each.
  repoList(caller: OrgCaller): Result<{ repos: Array<ConnectedRepo & { workers: string[]; canPush: boolean; tokenEnv?: string }>; workspaces: Array<OrgWorkspace & { workers: string[] }>; testsOff?: string; ciRounds?: number; prMode?: 'link' | 'draft' | 'open'; ticketStatus?: string; branchPrefix?: string; lastRefreshedAt?: number }> {
    if (!this.deps.repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!canHire(this.policy(), caller)) return { ok: false, error: 'Only people who may hire workers can see the repos.' };
    const roster = this.deps.workers.roster();
    const repos = this.deps.repos;
    const testsOff = repos.testsOff?.();
    return {
      ok: true,
      repos: repos.list().map((r) => {
        const tokenEnv = repos.tokenFor(r);
        return { ...r, canPush: repos.canPush(r), ...(tokenEnv ? { tokenEnv } : {}), workers: roster.filter((w) => w.projectPath === r.path).map((w) => w.name) };
      }),
      workspaces: repos.workspaces().map((ws) => ({ ...ws, workers: roster.filter((w) => w.projectPath === ws.rootPath).map((w) => w.name) })),
      ...(testsOff ? { testsOff } : {}),
      ...(repos.ciRounds ? { ciRounds: repos.ciRounds() } : {}),
      ...(repos.prMode ? { prMode: repos.prMode() } : {}),
      ...(repos.setTicketStatus ? { ticketStatus: repos.ticketStatus?.() ?? '' } : {}),
      ...(repos.branchPrefix ? { branchPrefix: repos.branchPrefix() } : {}),
      ...(repos.lastRefreshed?.() ? { lastRefreshedAt: repos.lastRefreshed!() } : {}),
    };
  }

  /// What every branch a worker pushes starts with. A name git takes as a
  /// branch, ending in `/`, `-` or `_` so the run's own name stays apart,
  /// and never one a default branch could be named by.
  /// Bring every connected repo up to date with origin now, as the hourly
  /// refresh does. Admins.
  async refreshRepos(caller: OrgCaller): Promise<Result<{ repos: number; problems: string[] }>> {
    const repos = this.deps.repos;
    if (!repos?.freshen) return { ok: false, error: 'Repos can’t be refreshed on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can refresh the repos.' };
    const list = repos.list();
    const problems = await repos.freshen(list.map((r) => r.path));
    this.record(caller, 'Refreshed the connected repos from origin.');
    return { ok: true, repos: list.length, problems };
  }

  setBranchPrefix(caller: OrgCaller, prefix: string): Result<{ branchPrefix: string }> {
    const repos = this.deps.repos;
    if (!repos?.setBranchPrefix) return { ok: false, error: 'Branches can’t be set up on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change how branches are named.' };
    const p = prefix.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,38}[/_-]$/.test(p) || /\.\.|\/\/|@\{|\.lock\/|\/\./.test(p)) {
      return { ok: false, error: 'Use letters, digits, dots, dashes and slashes, ending in "/", "-" or "_" — for example overgo/.' };
    }
    repos.setBranchPrefix(p);
    this.record(caller, `Set worker branches to start with ${p}.`);
    return { ok: true, branchPrefix: p };
  }

  async connectRepo(caller: OrgCaller, input: { url: string; name?: string; testCommand?: string }): Promise<Result<{ repo: ConnectedRepo; warning?: string }>> {
    if (!this.deps.repos) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can connect repos.' };
    const res = await this.deps.repos.connect(input, caller.name);
    if (!res.ok) return res;
    this.deps.repos.changed();
    this.record(caller, `Connected the repo ${res.repo.name} (${res.repo.url})${res.repo.testCommand ? `, tests: ${res.repo.testCommand}` : ''}.`);
    const testsOff = res.repo.testCommand ? this.deps.repos.testsOff?.() : undefined;
    return testsOff ? { ...res, warning: `Repo tests are turned off on this server, so nothing is pushed from ${res.repo.name} until they're on. ${testsOff}` } : res;
  }

  /// Whether the server opens the pull request for a branch it pushed.
  prMode(): 'link' | 'draft' | 'open' {
    return this.deps.repos?.prMode?.() ?? 'link';
  }

  setPrMode(caller: OrgCaller, mode: string): Result {
    const repos = this.deps.repos;
    if (!repos?.setPrMode) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change how pull requests are opened.' };
    const res = repos.setPrMode(mode);
    if (res.ok) this.record(caller, mode === 'link' ? 'Set pushed branches to come with a link to open a pull request.' : `Set pushed branches to open ${mode === 'draft' ? 'a draft' : 'a'} pull request.`);
    return res;
  }

  /// The status a ticket moves to once its pull request is pushed; absent,
  /// whichever means it is in review.
  ticketStatus(): string | undefined {
    return this.deps.repos?.ticketStatus?.();
  }

  setTicketStatus(caller: OrgCaller, status: string): Result {
    const repos = this.deps.repos;
    if (!repos?.setTicketStatus) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change where tickets move.' };
    const res = repos.setTicketStatus(status);
    const s = status.trim();
    if (res.ok) this.record(caller, s ? `Set tickets to move to "${s}" once their pull request is pushed.` : 'Set tickets to move to whichever status means in review once their pull request is pushed.');
    return res;
  }

  /// How many fixes a red CI build gets from its worker (ciWatch.ts).
  ciRounds(): number {
    return this.deps.repos?.ciRounds?.() ?? 3;
  }

  setCiRounds(caller: OrgCaller, n: number): Result {
    const repos = this.deps.repos;
    if (!repos?.setCiRounds) return { ok: false, error: 'Repos are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change how CI failures are handled.' };
    const res = repos.setCiRounds(n);
    if (res.ok) this.record(caller, n ? `Set CI failures to go back to the worker up to ${n} ${n === 1 ? 'time' : 'times'}.` : 'Set CI failures to go straight to the manager.');
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
    // Its changes land as pushed branches by default: the repo's flow is
    // preferred, unless someone already picked one of its other flows.
    const picked = w.preferredFlowId && !w.preferredFlowId.startsWith('org-pr-') && w.flowIds.includes(w.preferredFlowId);
    const saved = this.deps.workers.save({ ...w, projectPath: place, flowIds: [...new Set([...w.flowIds.filter((id) => !others(id)), flowId])], preferredFlowId: picked ? w.preferredFlowId : flowId });
    if (!saved.ok) return saved;
    this.record(caller, `Let ${w.name} change ${repo ? repo.name : `the ${ws!.name} workspace (${ws!.repos.join(', ')})`}; its changes arrive as branches to open pull requests from.`);
    return { ok: true, worker: w.name, flow: flowId };
  }

  /// Rewrite the repo and workspace flows workers use from what this version
  /// makes, so a fix to them reaches the workers already in place. Runs
  /// under way keep the flow they started with.
  refreshRepoFlows(): void {
    // Every worker with a tracker has its "Ticket actions" flow.
    for (const w of this.deps.workers.roster()) {
      const next = structuredClone(w);
      if (this.withTicketFlow(next)) this.deps.workers.save(next);
    }
    const repos = this.deps.repos;
    const save = this.deps.saveFlow;
    if (!repos || !save) return;
    const used = new Set(this.deps.workers.roster().flatMap((w) => w.flowIds));
    for (const r of repos.list()) if (used.has(prFlowIdFor(r))) save(prFlowIdFor(r), prFlowFor(r));
    for (const ws of repos.workspaces()) if (used.has(workspaceFlowId(ws))) save(workspaceFlowId(ws), workspaceFlowYaml(ws, repos.list()));
  }

  /// Gives a worker with a tracker its "Ticket actions" flow, after its
  /// others; true when that changed it.
  private withTicketFlow(w: Worker): boolean {
    const server = trackerOf(w.mcpServers);
    if (!server || !this.deps.saveFlow) return false;
    const id = ticketFlowId(server);
    if (!this.deps.saveFlow(id, ticketFlowYaml(server)).ok) return false;
    if (w.flowIds.includes(id)) return false;
    w.flowIds = [...w.flowIds, id];
    return true;
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
  /// Setup → Toolchains: the catalog, what's installed, the defaults, and
  /// each repo's picks beside what its own files ask for.
  toolchainList(caller: OrgCaller): Result<{
    kits: readonly KitDef[];
    toolchains: Toolchain[];
    defaults: Partial<Record<KitId, string>>;
    repos: Array<{ name: string; picks: Partial<Record<KitId, string>>; asks: Partial<Record<KitId, string>> }>;
    /// What a custom kit's archive must be built for: `linux/arm64`.
    platform: string;
  }> {
    const tc = this.deps.toolchains;
    if (!tc) return { ok: false, error: 'Toolchains are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can see the toolchains.' };
    const s = tc.state();
    const asked = tc.askedByRepos();
    // The default a run falls back to: the one picked, else the first ready.
    const defaults: Partial<Record<KitId, string>> = {};
    for (const k of KITS) {
      const first = s.toolchains.find((t) => t.kit === k.id && t.status === 'ready')?.version;
      const d = s.defaults[k.id] ?? first;
      if (d) defaults[k.id] = d;
    }
    return {
      ok: true,
      kits: KITS,
      toolchains: s.toolchains,
      defaults,
      repos: (this.deps.repos?.list() ?? []).map((r) => ({ name: r.name, picks: s.repoPicks[r.name] ?? {}, asks: asked[r.name] ?? {} })),
      platform: `${process.platform}/${process.arch}`,
    };
  }

  installToolchain(caller: OrgCaller, input: { kit: string; version: string; url?: string; sha256?: string; bin?: string; env?: Record<string, string> }): Result<{ toolchain: Toolchain }> {
    const tc = this.deps.toolchains;
    if (!tc) return { ok: false, error: 'Toolchains are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can install toolchains.' };
    const res = tc.install(input.kit, input.version, caller.name, input.kit === 'custom' ? { url: input.url, sha256: input.sha256, bin: input.bin, env: input.env } : undefined);
    if (!res.ok) return res;
    const t = res.toolchain;
    this.record(caller, t.custom ? `Started installing the custom toolchain ${t.version} from ${t.custom.url}${t.custom.sha256 ? '' : ' (no sha256 given)'}.` : `Started installing ${t.id} for workers and repo tests.`);
    return { ok: true, toolchain: t };
  }

  removeToolchain(caller: OrgCaller, id: string): Result {
    const tc = this.deps.toolchains;
    if (!tc) return { ok: false, error: 'Toolchains are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can remove toolchains.' };
    const res = tc.remove(id);
    if (res.ok) this.record(caller, `Removed the toolchain ${id}.`);
    return res;
  }

  setToolchainDefault(caller: OrgCaller, kit: string, version: string): Result {
    const tc = this.deps.toolchains;
    if (!tc) return { ok: false, error: 'Toolchains are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can change the default toolchains.' };
    const res = tc.setDefault(kit, version);
    if (res.ok) this.record(caller, `Made ${kit} ${version} the default for workers and repo tests.`);
    return res;
  }

  setRepoToolchain(caller: OrgCaller, repo: string, kit: string, version: string | null): Result {
    const tc = this.deps.toolchains;
    if (!tc) return { ok: false, error: 'Toolchains are not available on this server.' };
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only admins can pick a repo\'s toolchains.' };
    const res = tc.setRepoPick(repo, kit, version);
    if (res.ok) this.record(caller, version ? `Set ${repo} to use ${kit} ${version}.` : `Set ${repo} back to the default ${kit}.`);
    return res;
  }

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
  publishWorker(caller: OrgCaller, yaml: string, options: HireOptions = {}, tools: ToolTemplate[] = [], localId?: string): Result<{ hired?: WorkerSummary; hire: HireSummary; brought?: string[] }> {
    if (!this.deps.importWorker) return { ok: false, error: 'This server cannot take published workers.' };
    if (!canHire(this.policy(), caller)) {
      return { ok: false, error: 'You are not on the list of people who may hire workers. Ask an admin to add you to the org policy.' };
    }
    if (yaml.length > 2_000_000) return { ok: false, error: 'That worker file is too large.' };
    const parsed = parseWorkerYaml(yaml);
    if (!parsed.ok) return { ok: false, error: `That is not a worker file overcli can read: ${parsed.error}` };
    // What its tools looked like where it was built: the Tools page offers
    // them pre-filled. Only names, commands and setting names — no secrets.
    // An exported file carries its own.
    const templates = [...tools, ...parseTemplates(parsed.bundle.carried?.tools)];
    if (templates.length) this.deps.tools?.remember?.(templates);
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

  // ---- EXPORT A WORKER --------------------------------------------------

  /// One of its workers as a file to bring to another server: its job and
  /// flows as any share, plus its triggers, tool scopes and its tools' setup
  /// minus secrets, and, when asked, what it knows, its notes and its
  /// journal. For its manager or an admin. `left`: what stays behind.
  exportWorker(caller: OrgCaller, idOrName: string, opts: { learned?: boolean; journal?: boolean } = {}): Result<{ yaml: string; filename: string; left: string[] }> {
    if (!this.deps.shareWorker) return { ok: false, error: 'Workers can’t be exported from this server.' };
    const found = this.managed(caller, idOrName);
    if (!found.ok) return found;
    const w = found.worker;
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const left = ['Secret values: enter its tools’ keys on the new server.', 'Its trust: it starts on probation there.'];
    const carried: WorkerCarried = {};
    if (w.toolScopes && Object.keys(w.toolScopes).length) carried.toolScopes = structuredClone(w.toolScopes);
    const tools = (w.mcpServers ?? []).flatMap((name) => this.deps.tools?.template?.(name) ?? []);
    if (tools.length) carried.tools = tools.map((t) => ({ ...t }));
    let dms = 0;
    let onOwn = 0;
    const triggers: PortableTrigger[] = (this.triggerSvc()?.list(w.id) ?? []).map((t) => {
      if (t.startsOnItsOwn) onOwn++;
      return {
        name: t.name,
        kind: t.kind,
        enabled: t.enabled,
        instructions: t.instructions,
        deliver: t.deliver.flatMap((d) => (d.kind === 'dm' ? (dms++, []) : [d])),
        maxPerDay: t.maxPerDay,
        ...(t.watch ? { watch: structuredClone(t.watch) } : {}),
        ...(t.slack ? { slack: { ...t.slack } } : {}),
        ...(t.notifyOnly ? { notifyOnly: true } : {}),
        ...(t.webhook?.idPath ? { webhookIdPath: t.webhook.idPath } : {}),
      };
    });
    if (triggers.length) carried.triggers = triggers;
    if (dms) left.push(`${n(dms, 'DM destination', 'DM destinations')} on its triggers: a DM names a person here.`);
    if (onOwn) left.push(`“Starts on its own” on ${n(onOwn, 'trigger', 'triggers')}: its new manager turns that on.`);
    const journal = this.deps.workers.journalFor(w.id);
    if (opts.learned) {
      if (w.knowledge?.body) carried.knowledge = w.knowledge.body;
      const notes = journal.filter((e) => e.kind === 'note' && e.note).sort((a, b) => a.at - b.at).slice(-CARRIED_LIMITS.notes);
      if (notes.length) carried.notes = notes.map((e) => ({ at: e.at, note: e.note! }));
    } else left.push('What it knows and its notes.');
    if (opts.journal) {
      const history = journal.filter((e) => e.kind !== 'note' && e.kind !== 'demoted' && e.kind !== 'compacted').sort((a, b) => a.at - b.at);
      if (history.length > CARRIED_LIMITS.journal) left.push(`Its oldest ${history.length - CARRIED_LIMITS.journal} journal entries: only the newest ${CARRIED_LIMITS.journal} go.`);
      const kept = history.slice(-CARRIED_LIMITS.journal);
      if (kept.length) carried.journal = kept.map((e) => ({ kind: e.kind, at: e.at, title: e.title, ...(e.note ? { note: e.note } : {}) }));
    } else left.push('Its journal: without it, it may pick up work it already did.');
    const file = this.deps.shareWorker(w, carried);
    if (file.missingFlowIds.length) left.push(`Flows it uses that aren’t here: ${file.missingFlowIds.join(', ')}.`);
    this.record(caller, `Exported ${w.name}${opts.learned ? ', with what it has learned' : ''}${opts.journal ? ', with its journal' : ''}.`);
    return { ok: true, yaml: file.yaml, filename: file.filename, left };
  }

  /// An exported worker's setup, onto the worker it landed as: scopes no
  /// wider than this org's defaults, and its triggers. Its notes and journal
  /// landed with it. Says what came, and what couldn't.
  private landCarried(landed: Worker, c: WorkerCarried, by: string): string[] {
    const said: string[] = [];
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const has = new Set(landed.mcpServers ?? []);
    if (c.toolScopes) {
      const defaults = this.policy().toolDefaults ?? {};
      const scopes: ToolScopes = {};
      const wider: string[] = [];
      for (const [name, scope] of Object.entries(c.toolScopes)) {
        if (!has.has(name)) continue;
        // An import never widens a tool: past the default is an admin's call.
        if (!withinScope(scope, defaults[name], name)) wider.push(name);
        else if (scope.mode !== 'full' || defaults[name]) scopes[name] = scope;
      }
      const w = this.deps.workers.get(landed.id);
      if (w && Object.keys(scopes).length && this.deps.workers.save({ ...structuredClone(w), toolScopes: scopes }).ok) {
        said.push(`How much of ${Object.keys(scopes).join(', ')} it may use.`);
      }
      if (wider.length) said.push(`Its scope for ${wider.join(', ')} was wider than this org’s default, so it uses the default. An admin can widen it.`);
    }
    if (c.triggers?.length) {
      const s = this.triggerSvc();
      if (!s) said.push(`Its ${n(c.triggers.length, 'trigger', 'triggers')} stayed behind: triggers run on the org server.`);
      else {
        const made: string[] = [];
        for (const t of c.triggers) {
          const { webhookIdPath, ...rest } = t;
          const res = s.create({ ...rest, workerId: landed.id, createdBy: by, ...(t.kind === 'webhook' ? { webhook: webhookIdPath ? { idPath: webhookIdPath } : {} } : {}) });
          if (!res.ok) { said.push(`The trigger ${t.name} didn’t come: ${res.error}`); continue; }
          made.push(t.name);
          if (res.token) said.push(`${t.name} has a new address: /hooks/${res.trigger.id}/${res.token}. Point the sender at it; it is shown once.`);
          if (t.watch && !has.has(t.watch.server)) said.push(`${t.name} watches ${t.watch.server}, which it doesn’t have here yet.`);
        }
        if (made.length) said.unshift(`${n(made.length, 'trigger', 'triggers')}: ${made.join(', ')}.`);
      }
    }
    if (c.knowledge) said.push('What it knows about its tools.');
    if (c.notes?.length) said.push(`${n(c.notes.length, 'note', 'notes')} it was left.`);
    if (c.journal?.length) said.push(`${n(c.journal.length, 'journal entry', 'journal entries')}, so it skips work it already did. They don’t count toward its trust.`);
    return said;
  }

  // ---- PUBLISH A TEAM ---------------------------------------------------

  private memoryPublished: PublishedState = { workers: {}, teams: {}, waiting: [] };

  /// The org's id for a worker published from someone's install, by its id there.
  publishedWorkerId(localId: string): string | undefined {
    return this.publishedState().workers[localId];
  }

  /// The org's id for a team published from someone's install, by its id there.
  publishedTeamId(localId: string): string | undefined {
    return this.publishedState().teams[localId];
  }

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
  updateTeamSettings(caller: OrgCaller, teamId: UUID, patch: { checkpoints?: Partial<TeamCheckpoints>; piecesAskFirst?: boolean; budgetUSDPerTask?: number; guidance?: string; avatarUrl?: string | null; whoCanBrief?: Team['whoCanBrief']; audience?: Audience | null; shortName?: string }): Result {
    if (!this.deps.teams?.save) return { ok: false, error: 'Teams are not running on this server.' };
    const team = this.deps.teams.list().teams.find((t) => t.id === teamId);
    if (!team) return { ok: false, error: 'No team by that id.' };
    if (!this.canChangeTeam(caller, team)) return { ok: false, error: `Only people who manage someone on ${team.name} can change it.` };
    if (patch.budgetUSDPerTask !== undefined && (!Number.isFinite(patch.budgetUSDPerTask) || patch.budgetUSDPerTask <= 0)) return { ok: false, error: 'Set a budget per task above $0.' };
    if (patch.guidance !== undefined && patch.guidance.trim().length > TEAM_GUIDANCE_MAX) return { ok: false, error: `Keep the guidance under ${TEAM_GUIDANCE_MAX.toLocaleString()} characters.` };
    if (patch.avatarUrl && !/^https:\/\/\S{1,500}$/.test(patch.avatarUrl.trim())) return { ok: false, error: 'The picture must be an https:// image link.' };
    if (patch.whoCanBrief !== undefined && !['managers', 'team', 'org'].includes(patch.whoCanBrief)) return { ok: false, error: 'Who can give it tasks: managers, team or org.' };
    const who = patch.whoCanBrief ?? team.whoCanBrief ?? 'managers';
    const { piecesAskFirst: _was, avatarUrl: _pic, whoCanBrief: _who, audience: _aud, ...rest } = team;
    const audience = patch.audience === undefined ? team.audience : patch.audience ?? undefined;
    const saved = this.deps.teams.save({
      ...rest,
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(team.checkpoints ?? {}), ...(patch.checkpoints ?? {}) },
      ...(patch.budgetUSDPerTask !== undefined ? { budgetUSDPerTask: Math.round(patch.budgetUSDPerTask * 100) / 100 } : {}),
      ...((patch.piecesAskFirst ?? team.piecesAskFirst !== false) ? {} : { piecesAskFirst: false }),
      ...(who !== 'managers' ? { whoCanBrief: who } : {}),
      ...(audience ? { audience } : {}),
      ...(patch.guidance !== undefined ? { guidance: patch.guidance } : {}),
      ...(patch.shortName !== undefined ? { shortName: patch.shortName } : {}),
      ...((patch.avatarUrl === undefined ? team.avatarUrl : patch.avatarUrl?.trim()) ? { avatarUrl: (patch.avatarUrl === undefined ? team.avatarUrl : patch.avatarUrl!.trim())! } : {}),
    });
    if (!saved.ok) return saved;
    if (patch.guidance !== undefined && patch.guidance.trim() !== (team.guidance ?? '')) {
      this.record(caller, patch.guidance.trim() ? `Changed how ${team.name} works.` : `Cleared ${team.name}'s guidance.`);
    }
    if (patch.audience !== undefined) this.record(caller, `Changed who can give ${team.name} tasks.`);
    if (patch.shortName !== undefined && patch.shortName.trim().toLowerCase() !== (team.shortName ?? '')) {
      this.record(caller, patch.shortName.trim() ? `${team.name} now goes by "${patch.shortName.trim().toLowerCase()}".` : `${team.name} no longer has a short name.`);
    }
    if (patch.whoCanBrief !== undefined && who !== (team.whoCanBrief ?? 'managers')) {
      this.record(caller, `${team.name} now takes tasks from ${who === 'org' ? 'everyone' : who === 'team' ? "anyone on a team with its members' managers" : "its members' managers"}.`);
    }
    if (patch.piecesAskFirst !== undefined && patch.piecesAskFirst !== (team.piecesAskFirst !== false)) {
      this.record(caller, patch.piecesAskFirst ? `${team.name}'s members ask again before acting outside their sandbox.` : `${team.name}'s members act outside their sandbox without asking on its tasks.`);
    }
    return { ok: true };
  }

  /// Every team's short name: its own, or its initials while free.
  private teamShortNames(): Map<string, string> {
    return resolveShortNames((this.deps.teams?.list().teams ?? []).filter((t) => !t.disbanded).sort((a, b) => a.createdAt - b.createdAt));
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
      ...(task.comments?.length ? { comments: task.comments } : {}),
      updatedAt: task.updatedAt,
    };
  }

  /// One team's page: who's on it and what each is doing, and its tasks with
  /// every stage, every member's piece (where it is, what it wrote, an
  /// approval it waits on) and the pack. `now` says what the team is doing
  /// this moment, in a sentence.
  teamPage(caller: OrgCaller, teamIdOrName: string): Result<{
    team: { id: UUID; name: string; shortName?: string; shortNameAuto?: boolean; purpose?: string; guidance?: string; avatarUrl?: string; budgetUSDPerTask: number; canBrief: boolean; canChange: boolean; checkpoints: TeamCheckpoints; piecesAskFirst: boolean; whoCanBrief: NonNullable<Team['whoCanBrief']>; audience?: Audience; members: TeamMemberRow[]; knowledge?: { status: 'learning' | 'ready' | 'failed'; updatedAt?: number; taskId?: UUID; error?: string; words?: number; refresh: 'weekly' | 'off' } };
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
    const shortName = this.teamShortNames().get(team.id);
    return {
      ok: true,
      team: {
        id: team.id,
        name: team.name,
        ...(shortName ? { shortName, ...(team.shortName ? {} : { shortNameAuto: true }) } : {}),
        ...(team.purpose ? { purpose: team.purpose } : {}),
        ...(team.guidance ? { guidance: team.guidance } : {}),
        ...(team.avatarUrl ? { avatarUrl: team.avatarUrl } : {}),
        budgetUSDPerTask: team.budgetUSDPerTask,
        canBrief: seen.canBrief,
        canChange: this.canChangeTeam(caller, team),
        checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(team.checkpoints ?? {}) },
        piecesAskFirst: team.piecesAskFirst !== false,
        whoCanBrief: team.whoCanBrief ?? 'managers',
        ...(team.audience ? { audience: team.audience } : {}),
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
      ...(s.fromRoom ? { fromRoom: true } : {}),
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
      ...(task.pack
        ? {
            pack: {
              summary: task.pack.summary,
              files: task.pack.files,
              ...(task.pack.version ? { version: task.pack.version } : {}),
              ...(task.pack.updatedAt ? { updatedAt: task.pack.updatedAt } : {}),
              ...(task.pack.changed ? { changed: task.pack.changed } : {}),
            },
          }
        : {}),
      ...(task.room?.messages.length || task.room?.busy
        ? {
            room: {
              messages: task.room.messages.map((m) => ({
                id: m.id,
                speaker: m.speaker.kind === 'member' ? { kind: 'member' as const, name: m.speaker.name, workerId: m.speaker.workerId } : { kind: m.speaker.kind },
                text: m.text,
                at: m.at,
                exchange: m.exchange,
                ...(m.wrapUp ? { wrapUp: true } : {}),
                ...(m.failed ? { failed: true } : {}),
                ...(m.retry ? { retry: m.retry } : {}),
                ...(m.workReport ? { workReport: { stage: m.workReport.stage, title: task.stages[m.workReport.stage]?.title ?? '' } } : {}),
                ...(m.handoff
                  ? { handoff: roomHandoffView(m.handoff) }
                  : {}),
              })),
              ...(task.room.busy ? { busy: task.room.busy } : {}),
              ...(task.room.foldedThrough ? { foldedThrough: task.room.foldedThrough } : {}),
              ...(task.room.queue?.length ? { queued: task.room.queue.length } : {}),
            },
          }
        : {}),
      canSteer: this.askedForTask(task, caller) || isAdmin(this.policy(), caller),
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
  teams(caller: OrgCaller, opts: { disbanded?: boolean } = {}): Array<{ id: UUID; name: string; shortName?: string; shortNameAuto?: boolean; purpose?: string; avatarUrl?: string; members: Array<{ name: string; role: string }>; canBrief: boolean }> {
    if (!this.deps.teams) return [];
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const names = new Map(roster.map((w) => [w.id, w.name]));
    const short = this.teamShortNames();
    return this.deps.teams
      .list()
      .teams.filter((t) => (opts.disbanded || !t.disbanded) && (t.members.some((m) => canSee(policy, roster, m.workerId, caller)) || this.mayBrief(caller, t)))
      .map((t) => ({
        id: t.id,
        name: t.name,
        ...(short.has(t.id) ? { shortName: short.get(t.id), ...(t.shortName ? {} : { shortNameAuto: true }) } : {}),
        ...(t.purpose ? { purpose: t.purpose } : {}),
        ...(t.avatarUrl ? { avatarUrl: t.avatarUrl } : {}),
        members: t.members.map((m) => ({ name: names.get(m.workerId) ?? 'a former worker', role: m.role })),
        canBrief: this.mayBrief(caller, t),
      }));
  }

  /// Whether someone may give a team tasks: an admin, whoever manages one of
  /// its members, and as far as its `whoCanBrief` opens it.
  private mayBrief(caller: OrgCaller, team: Team): boolean {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    if (isAdmin(policy, caller) || team.members.some((m) => canManage(policy, roster, m.workerId, caller))) return true;
    if (team.audience) return inAudience(policy, caller, team.audience);
    if (team.whoCanBrief === 'org') return true;
    if (team.whoCanBrief === 'team' && caller.slackUserId) {
      return team.members.some((m) => {
        const boss = managerFor(roster, m.workerId)?.slackUserId;
        return !!boss && sharesTeam(policy, boss, caller.slackUserId!);
      });
    }
    return false;
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
    const team = this.teams(caller).find((t) => t.id === teamIdOrName || t.name.toLowerCase() === key) ?? this.teams(caller).find((t) => t.shortName === key);
    if (!team) return { ok: false, error: 'No team by that name that you can see.' };
    if (!team.canBrief) return { ok: false, error: `You can't give ${team.name} tasks. Ask someone who manages one of its members to open it up on the team's page.` };
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

  /// A comment on a team task's work, or a member's piece done again with a
  /// note: for whoever asked for the task, or an admin.
  commentOnTeamTask(caller: OrgCaller, taskId: UUID, input: { text: string; file?: string; quote?: string; about?: 'questions' | 'plan' | 'coordinator'; workerId?: string; redo?: boolean }): Result<{ comment?: TeamComment }> {
    const teams = this.deps.teams;
    if (!teams?.comment || !teams.redoPiece) return { ok: false, error: 'Commenting on team work isn’t available here.' };
    const task = teams.list().tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: 'No team task with that id.' };
    if (!this.askedForTask(task, caller) && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only the person who asked for this task, or an admin, can comment on it.' };
    if (input.redo) {
      if (!input.workerId) return { ok: false, error: 'Say whose piece to do again.' };
      const res = teams.redoPiece(taskId, input.workerId, input.text);
      if (res.ok) this.record(caller, `Asked for a piece of ${task.teamName}'s task "${task.title ?? task.brief.slice(0, 60)}" again.`);
      return res;
    }
    return teams.comment(taskId, {
      text: input.text,
      ...(input.file ? { file: input.file } : {}),
      ...(input.quote ? { quote: input.quote } : {}),
      ...(input.about ? { about: input.about } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
    });
  }

  /// Whether `teamRoom` would let this person talk to the task's team.
  mayTalkToRoom(caller: OrgCaller, taskId: UUID): boolean {
    const task = this.deps.teams?.list().tasks.find((t) => t.id === taskId);
    return !!task && (this.askedForTask(task, caller) || isAdmin(this.policy(), caller));
  }

  /// Talk to a finished task's team, or fold what it said into the pack:
  /// for whoever asked for the task, or an admin.
  teamRoom(caller: OrgCaller, taskId: UUID, action: { kind: 'ask'; text: string } | { kind: 'continue' } | { kind: 'updatePack'; changes?: string[] }): Result<{ queued?: boolean }> {
    const teams = this.deps.teams;
    if (!teams) return { ok: false, error: 'Teams are not running on this server.' };
    const task = teams.list().tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: 'No team task with that id.' };
    if (!this.mayTalkToRoom(caller, taskId)) return { ok: false, error: 'Only the person who asked for this task, or an admin, can talk to its team.' };
    const name = `${task.teamName}'s task "${task.title ?? task.brief.slice(0, 60)}"`;
    if (action.kind === 'ask') {
      if (!teams.roomAsk) return { ok: false, error: 'Talking to the team isn’t available here.' };
      if (!action.text.trim()) return { ok: false, error: 'Ask the team something.' };
      const res = teams.roomAsk(taskId, action.text);
      if (res.ok) this.record(caller, `Asked the team on ${name}.`);
      return res;
    }
    if (action.kind === 'continue') {
      if (!teams.roomContinue) return { ok: false, error: 'Talking to the team isn’t available here.' };
      return teams.roomContinue(taskId);
    }
    if (!teams.updatePack) return { ok: false, error: 'Updating the pack isn’t available here.' };
    const res = teams.updatePack(taskId, action.changes ? { changes: action.changes } : {});
    if (res.ok) this.record(caller, `Asked for the pack of ${name} to be updated${action.changes?.length ? ` with ${action.changes.length} change${action.changes.length === 1 ? '' : 's'}` : ''}.`);
    return res;
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
    if (!this.askedForTask(task, caller) && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only the person who asked for this task, or an admin, can push its code.' };
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

  /// The people and groups the org knows, for picking who decides or leads:
  /// its named groups (org.json `teams`), the admins and hire approvers as
  /// groups, and everyone named anywhere. Names only, nothing private.
  directory(): { people: Array<{ name: string; slackUserId: string }>; groups: Array<{ id: string; name: string; members: Array<{ name: string; slackUserId: string }> }> } {
    const policy = this.policy();
    const ids = new Set<string>([...policy.admins, ...approversFor(policy), ...Object.values(policy.teams).flat()]);
    for (const t of this.deps.people?.() ?? []) if (t.slackUserId) ids.add(t.slackUserId);
    for (const w of this.deps.workers.roster()) if (w.manager?.slackUserId) ids.add(w.manager.slackUserId);
    const all = [...ids];
    const names = this.namesFor(all);
    const person = new Map(all.map((id, i) => [id, { name: names[i], slackUserId: id }]));
    const members = (list: readonly string[]) => list.map((id) => person.get(id) ?? { name: id, slackUserId: id });
    return {
      people: [...person.values()].filter((p) => !SLACK_ID.test(p.name)).sort((a, b) => a.name.localeCompare(b.name)),
      groups: [
        ...Object.entries(policy.teams).map(([name, list]) => ({ id: `team:${name}`, name, members: members(list) })),
        { id: 'admins', name: 'Admins', members: members(policy.admins) },
        { id: 'approvers', name: 'Hire approvers', members: members(approversFor(policy)) },
      ].filter((g) => g.members.length),
    };
  }

  /// A person's name, learned from Slack: workers saved with their bare
  /// Slack id as their manager's name take it.
  learnName(slackUserId: string, name: string): void {
    if (!name || SLACK_ID.test(name)) return;
    for (const w of this.deps.workers.roster()) {
      if (w.manager?.slackUserId === slackUserId && SLACK_ID.test(w.manager.name)) this.deps.workers.save({ ...w, manager: { ...w.manager, name } });
    }
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
  whoami(caller: OrgCaller): { org: string; name: string; slackUserId?: string; admin: boolean; canHire: boolean; timezone?: string; allowanceUSD?: number; committedUSD?: number; version?: string; newer?: { version: string; url: string } } {
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const admin = isAdmin(policy, caller);
    const v = this.deps.version?.();
    return {
      org: policy.name ?? 'Your org',
      name: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      admin,
      canHire: canHire(policy, caller),
      ...(policy.timezone ? { timezone: policy.timezone } : {}),
      ...(v ? { version: v.version } : {}),
      // Upgrading is an operator's job, so only admins hear a release is out.
      ...(v?.newer && admin ? { newer: v.newer } : {}),
      ...(caller.slackUserId
        ? { allowanceUSD: allowanceFor(policy, caller.slackUserId), committedUSD: committedBudget(roster, caller.slackUserId) }
        : {}),
    };
  }
}

/// A room hand-off as the console shows it.
function roomHandoffView(h: TeamHandoff): { title: string; status: string; who: string[]; steps?: string[][] } {
  const steps = handoffSteps(h.assignments).map((step) => step.map((a) => a.workerName));
  return {
    title: h.title,
    status: h.status,
    who: h.assignments.map((a) => a.workerName),
    ...(steps.length > 1 ? { steps } : {}),
  };
}

/// The person a tool's keys sign in as, from "Lionel Farr on Jira": null
/// when it reads as an account rather than someone (a bot, a service user).
export function personOf(as: string | undefined): string | null {
  if (!as) return null;
  const who = as.replace(/\s+(?:on|in|at|@)\s+.*$/i, '').trim();
  if (!who || /@/.test(who) || /\b(bot|service|svc|automation|integration|system|api|admin|robot|app|overgo)\b/i.test(who)) return null;
  return /^\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)+$/u.test(who) ? who : null;
}

/// A week, for one person (`OrgService.weeklyDigest`).
export interface WeeklyDigest {
  org: string;
  mine: Array<{ name: string; done: number; failed: number; errands: number; costUSD: number; useful: number; notUseful: number }>;
  waiting: number;
  oldestWaitingAt?: number;
  orgTotals?: { workers: number; done: number; failed: number; costUSD: number; costPerDone: number | null; useful: number; notUseful: number; troubled: string[]; toolRequests: number };
}

/// When the Monday digest is due: 9am or later on a Monday in the org's
/// time zone, for a week it hasn't gone out for. The week's key, or null.
export function digestDue(now: number, timeZone: string | undefined, lastWeek: string | null): string | null {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  } catch {
    return null;
  }
  if (parts.weekday !== 'Mon' || Number(parts.hour) < 9) return null;
  const week = `${parts.year}-${parts.month}-${parts.day}`;
  return week === lastWeek ? null : week;
}

/// What a worker's onboarding asks: go through its tools for its job, read
/// only, and write down what it will need, as notes it reads every run.
export function learnPrompt(w: Pick<Worker, 'name' | 'mcpServers'>, before?: string): string {
  return [
    `This is your onboarding, ${w.name}. Before your next real job, get to know the tools and places your job uses, so you don't have to look things up mid-task.`,
    'Use your tools to READ ONLY. Change nothing, post nothing, comment on nothing.',
    '',
    'Find out, for your job specifically:',
    '- the projects, boards, spaces or folders you work in: their exact names and keys;',
    '- how work moves there: statuses, transitions, fields and labels people actually use;',
    '- who does what: owners, assignees, teams you see again and again;',
    '- where things live: documents, dashboards, repos, links you will need;',
    '- anything that surprised you or that a newcomer would get wrong.',
    before ? `\nYour notes from last time are below. Check them against what you see now: keep what still holds, fix what changed, drop what's gone.\n\n<previous>\n${before.slice(0, 6000)}\n</previous>` : '',
    '',
    'Then write your notes as markdown, under 1,500 words, with short headed sections and exact names, keys and links. Facts you checked, not guesses: mark anything you could not confirm.',
    'Put the notes between <knowledge> and </knowledge>, and nothing else inside.',
  ].filter((l) => l !== '').join('\n');
}

/// The notes from an onboarding reply: what's inside <knowledge>, or the
/// whole reply when it forgot the tags.
export function readKnowledge(text: string): string | null {
  const m = /<knowledge>([\s\S]*?)<\/knowledge>/i.exec(text);
  const body = (m ? m[1] : text).trim();
  return body.length >= 40 ? body.slice(0, 10_000) : null;
}

/// What's using the server's disk (`OrgService.storage`). Bytes; null when
/// it couldn't be measured.
export interface StorageReport {
  volume: { freeBytes: number; totalBytes: number } | null;
  checkouts: { count: number; bytes: number | null };
  repos: number | null;
  toolCache: number | null;
  /// What builds downloaded (buildCacheDirs): Gradle, Maven, npm, pip, uv, Go.
  buildCache?: number | null;
  kept: Array<{ runId: string; title: string; worker?: string; workerId?: string; since: number }>;
  measuredAt: number;
}
