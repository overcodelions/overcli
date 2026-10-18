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
import { isSlackUserId, validateOrgFields, workerTagline } from '../../shared/flows/worker';
import { describeTrigger, type ScheduleTrigger } from '../../shared/flows/schedule';
import type { Orchestration } from '../../shared/flows/orchestration';
import { buildOrgTree, managerFor, type OrgNode } from '../../shared/flows/org';
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
import { answerOptions, projectMonthEnd, trustReadiness, workerState, type TrustReadiness, type WorkerState } from '../../shared/org/insights';
import type { Team, TeamStageKind, TeamTask } from '../../shared/flows/team';
import { TEAM_STAGE_LABEL, isMemberStage } from '../../shared/flows/team';
import { parseWorkerYaml } from '../../shared/flows/workerYaml';
import type { UUID } from '../../shared/types';
import type { DraftedHire, HireDraftResult } from './hireDraft';
import type { ToolInput, ToolSummary, ToolTemplate } from './tools';
import type { Deliverable, Destination, TriggerService, WorkerTrigger } from './triggers';
import type { AskRecord, AskStore, AuditEntry, AuditStore, HireStore, Rating, RatingStore } from './orgStores';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

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
  budgetUSDPerMonth: number;
  spentThisMonthUSD: number;
  waiting: number;
  youManage: boolean;
  /// What it is doing now: working, waiting on a person, paused, stuck, idle.
  state: WorkerState;
  /// The tools (MCP servers) it lists, and whether this server has each.
  tools: Array<{ name: string; ok: boolean }>;
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
}

export interface TeamTaskSummary {
  id: UUID;
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
  stages: Array<{ label: string; state: 'done' | 'now' | 'next'; who: string[] }>;
  packSummary?: string;
  updatedAt: number;
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

export interface LibraryItem {
  id: string;
  /// event: delivered on a trigger; work: a finished run.
  kind: 'event' | 'work';
  workerId: string;
  workerName: string;
  at: number;
  title: string;
  status: Deliverable['status'];
  body?: string;
  error?: string;
  links: string[];
  deliveredTo: string[];
  source: Deliverable['source'];
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
  };
  reasons?: string[];
}

export interface OrgServiceDeps {
  workers: {
    roster(): Worker[];
    get(id: UUID): Worker | null;
    save(input: Worker): { ok: true; worker: Worker } | { ok: false; error: string };
    setEnabled(id: UUID, enabled: boolean): { ok: true } | { ok: false; error: string };
    remove(id: UUID): { ok: true } | { ok: false; error: string };
    runErrand(id: UUID, instruction: string): Promise<{ ok: true; result: WorkerErrandResult } | { ok: false; error: string }>;
    journalFor(id: UUID): WorkerJournalEntry[];
    spentThisMonth(): Map<UUID, number>;
    workerNames(): string[];
  };
  runs: {
    listRuns(): FlowRun[];
    getRun(id: UUID): FlowRun | null;
    steerRun(args: { runId: UUID; text: string }): { ok: true } | { ok: false; error: string };
    resumeRun(args: { runId: UUID }): { ok: true } | { ok: false; error: string };
  };
  rejectRun(runId: UUID): { ok: true } | { ok: false; error: string };
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
  /// The rest are optional so a host can bring the plane up a piece at a time.
  snapshots?(): Array<{ worker: Worker; nextShiftAt: number | null }>;
  setTrust?(id: UUID, trust: WorkerTrustLevel): { ok: true } | { ok: false; error: string };
  /// A note into the worker's journal against one of its turns — memory its
  /// next planning reads.
  note?(id: UUID, orchestrationId: string, text: string): { ok: true } | { ok: false; error: string };
  runCost?(runId: UUID): number | undefined;
  teams?: {
    list(): { teams: Team[]; tasks: TeamTask[] };
    brief(teamId: UUID, text: string, attachments: [], projectPath: undefined, opts: { requestedBy?: TeamTask['requestedBy'] }): Result<{ task: TeamTask }>;
    answer(taskId: UUID, answers: string[]): Result;
    approve(taskId: UUID): Result;
    revise(taskId: UUID, feedback: string): Result;
    continueTask(taskId: UUID): Result;
    cancel(taskId: UUID): Result;
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
    remember?(templates: ToolTemplate[]): void;
    install(input: ToolInput): { ok: true } | { ok: false; error: string };
    uninstall(name: string): { ok: true } | { ok: false; error: string };
    /// Start the model CLI once and read what each server reports.
    check(): Promise<Record<string, string> | null>;
  };
  /// Workers acting on business events. Absent: no triggers on this host.
  triggers?: () => TriggerService | null;
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
function approvalDetail(run: FlowRun, stepId: string): Pick<WaitingItem, 'instructions' | 'inputs'> {
  const step = run.flowSnapshot.steps.find((s) => s.id === stepId);
  if (!step) return {};
  const inputs = (step.inputs ?? [])
    .map((name) => run.artifacts?.[name])
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ name: a.name, preview: a.body.length > 1500 ? `${a.body.slice(0, 1500)}…` : a.body }));
  return {
    ...(step.systemPromptOverride ? { instructions: step.systemPromptOverride.slice(0, 2000) } : {}),
    ...(inputs.length ? { inputs } : {}),
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
        const tools = (w.mcpServers ?? []).map((name) => ({ name, ok: !installed || installed.has(name) }));
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
          budgetUSDPerMonth: w.budgetUSDPerMonth,
          spentThisMonthUSD: spent.get(w.id) ?? 0,
          waiting: waiting.get(w.id) ?? 0,
          youManage: canManage(policy, roster, w.id, caller),
          schedule: scheduleText(w.cadence),
          cadence: w.cadence,
          nextRunAt: w.enabled ? next.get(w.id) ?? null : null,
          state: workerState(w, runs),
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

  decideRun(caller: OrgCaller, runId: UUID, approve: boolean): Result {
    const found = this.pausedFor(caller, runId, 'approval');
    if (!found.ok) return found;
    // Read before acting: approving moves the run on, and the log should
    // name the step that was approved, not the one after it.
    const step = found.run.state.kind === 'paused' ? found.run.state.nextStepId : 'a step';
    const what = `${found.run.workerName ?? 'a worker'} running "${step}" on "${flowRunTitle(found.run)}"`;
    const res = approve ? this.deps.runs.resumeRun({ runId }) : this.deps.rejectRun(runId);
    if (res.ok) this.record(caller, `${approve ? 'Approved' : 'Rejected'} ${what}.`);
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
  ): Result<{ askId: string; done: Promise<Result<{ reply: string; launched: number; askId: string }>> }> {
    const w = this.resolve(caller, idOrName);
    if (!w) return { ok: false, error: NOT_FOUND };
    if (!w.enabled) return { ok: false, error: `${w.name} is paused.` };
    if (!text.trim()) return { ok: false, error: `What should ${w.name} do?` };
    const from = canManage(this.policy(), this.deps.workers.roster(), w.id, caller) ? '' : `(Asked by ${caller.name}, who is not your manager.)\n`;
    const record: AskRecord = {
      id: randomUUID(),
      workerId: w.id,
      workerName: w.name,
      by: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      text: text.trim().slice(0, 4000),
      at: this.now(),
      status: 'working',
      via,
    };
    this.putAsk(record);
    const done = this.deps.workers.runErrand(w.id, from + text).then(
      (res): Result<{ reply: string; launched: number; askId: string }> => {
        const finished: AskRecord = res.ok
          ? { ...record, status: 'answered', reply: res.result.reply, launched: res.result.queued, doneAt: this.now() }
          : { ...record, status: 'failed', error: res.error, doneAt: this.now() };
        this.putAsk(finished);
        this.deps.onAskDone?.(finished);
        return res.ok ? { ok: true, reply: res.result.reply, launched: res.result.queued, askId: record.id } : res;
      },
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        const failed: AskRecord = { ...record, status: 'failed', error, doneAt: this.now() };
        this.putAsk(failed);
        this.deps.onAskDone?.(failed);
        return { ok: false as const, error };
      },
    );
    return { ok: true, askId: record.id, done };
  }

  private memoryAsks: AskRecord[] = [];
  private asksRestored = false;

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
  tools(caller: OrgCaller): Result<{ tools: ToolSummary[]; missing: Array<{ name: string; workers: string[]; template?: ToolTemplate }>; checkedAt?: number; canEdit: boolean }> {
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const roster = this.deps.workers.roster();
    const admin = isAdmin(this.policy(), caller);
    const mine = admin ? roster : roster.filter((w) => canManage(this.policy(), roster, w.id, caller));
    const listed = this.deps.tools.list(mine, this.toolStatuses?.statuses);
    return {
      ok: true,
      tools: admin ? listed.tools : listed.tools.filter((t) => t.usedBy.length),
      missing: listed.missing,
      ...(this.toolStatuses ? { checkedAt: this.toolStatuses.at } : {}),
      canEdit: admin,
    };
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
    if (res.ok) this.record(caller, `Removed the ${name} tool.`);
    return res;
  }

  async checkTools(caller: OrgCaller): Promise<Result<{ statuses: Record<string, string> }>> {
    if (!isAdmin(this.policy(), caller)) return { ok: false, error: 'Only an admin can check the server\'s tools.' };
    if (!this.deps.tools) return { ok: false, error: 'Tools cannot be managed on this server.' };
    const statuses = await this.deps.tools.check();
    if (!statuses) return { ok: false, error: 'Claude did not start on the server, so the tools could not be checked. See Admin → health.' };
    this.toolStatuses = { at: this.now(), statuses };
    return { ok: true, statuses };
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

  /// Everything workers made that the caller can see, newest first: what
  /// they delivered on events, and their finished work.
  library(caller: OrgCaller, opts: { workerId?: string; query?: string; limit?: number } = {}): LibraryItem[] {
    const roster = this.deps.workers.roster();
    const policy = this.policy();
    const visible = new Set(roster.filter((w) => canSee(policy, roster, w.id, caller)).map((w) => w.id));
    const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const fromEvents: LibraryItem[] = this.deliverableList()
      .filter((d) => d.status !== 'skipped' && visible.has(d.workerId))
      .map((d) => ({
        id: d.id,
        kind: 'event',
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
    const fromWork: LibraryItem[] = this.workItems(roster.filter((w) => visible.has(w.id)), 0, 300).map((x) => ({
      id: x.entryId,
      kind: 'work',
      workerId: x.workerId,
      workerName: x.workerName,
      at: x.at,
      title: x.title,
      status: 'delivered',
      ...(x.summary ? { body: x.summary } : {}),
      links: [...new Set((x.summary ?? '').match(/https?:\/\/[^\s<>)"'\]]+/g) ?? [])].slice(0, 10),
      deliveredTo: [],
      source: { kind: 'ask' as const },
      ...(x.rating ? { rating: { useful: x.rating.useful, by: x.rating.by } } : {}),
    }));
    return [...fromEvents, ...fromWork]
      .filter((x) => !opts.workerId || x.workerId === opts.workerId)
      .filter((x) => words.every((w) => `${x.title} ${x.workerName} ${x.body ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.min(500, opts.limit ?? 200));
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
            },
          }
        : {}),
      ...(hire.reasons ? { reasons: hire.reasons } : {}),
    };
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
    const res = await this.deps.draft({
      crew: this.deps.workers.workerNames(),
      jobDescription: hire.jobDescription,
      conversation: hire.conversation,
      interview: !args.skipQuestions,
    });
    if (!res.ok) return res;
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
    const summary = this.listWorkers({ name: 'admin', admin: true }).find((s) => s.id === saved.worker.id)!;
    return { ok: true, worker: saved.worker, summary };
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
    return { ok: true, hired: made.summary };
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

  private workItems(workers: readonly Worker[], sinceMs: number, limit: number): WorkItem[] {
    const roster = this.deps.workers.roster();
    const ratings = this.ratingsByEntry();
    const runs = new Map(this.deps.runs.listRuns().map((r) => [r.id, r]));
    const items: WorkItem[] = [];
    for (const w of workers) {
      for (const e of this.deps.workers.journalFor(w.id)) {
        if (e.kind !== 'completed' || e.at < sinceMs) continue;
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
    const roster = this.deps.workers.roster();
    const policy = this.policy();
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
    questions.sort((a, b) => b.at - a.at);
    return {
      ok: true,
      worker: summary,
      jobDescription: w.jobDescription,
      readiness: trustReadiness(w, journal, now),
      stats: {
        runs: month.filter((e) => e.kind === 'completed' || e.kind === 'failed').length,
        failed: month.filter((e) => e.kind === 'failed').length,
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
      asks: this.allAsks()
        .filter((a) => a.workerId === w.id && this.maySeeAsk(caller, a))
        .slice(-10)
        .reverse(),
      missingTools: this.deps.tools ? this.deps.tools.list([w]).missing.map((m) => m.name) : [],
      triggers: (() => {
        const s = this.triggerSvc();
        return s ? s.list(w.id).map((t) => this.showTrigger(t, s)) : [];
      })(),
      value: this.workerValue(w.id),
    };
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

  // ---- PUBLISH A LOCAL WORKER -------------------------------------------

  /// Take a worker someone built on their own install (its share file) onto
  /// the org's roster, under the same rules as a hire: the publisher becomes
  /// its manager, and anything over their allowance waits for an approver.
  publishWorker(caller: OrgCaller, yaml: string, options: HireOptions = {}, tools: ToolTemplate[] = []): Result<{ hired?: WorkerSummary; hire: HireSummary }> {
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
      },
    };
    this.putHire(hire);
    return this.confirmHire(caller, hire.id);
  }

  // ---- TEAMS ------------------------------------------------------------

  private summarizeTask(task: TeamTask, caller: OrgCaller, roster: readonly Worker[]): TeamTaskSummary {
    const names = new Map(roster.map((w) => [w.id, w.name]));
    const waitingOnYou =
      !!task.requestedBy?.slackUserId && task.requestedBy.slackUserId === caller.slackUserId &&
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
        state: i < task.stageIndex ? 'done' : i === task.stageIndex ? 'now' : 'next',
        who: isMemberStage(stage.kind as TeamStageKind)
          ? (stage.assignments ?? []).map((a) => names.get(a.workerId) ?? 'a member')
          : ['the coordinator'],
      })),
      ...(task.pack?.summary ? { packSummary: task.pack.summary } : {}),
      updatedAt: task.updatedAt,
    };
  }

  /// Teams the caller can see: any team with a member they can see.
  teams(caller: OrgCaller): Array<{ id: UUID; name: string; purpose?: string; members: Array<{ name: string; role: string }>; canBrief: boolean }> {
    if (!this.deps.teams) return [];
    const policy = this.policy();
    const roster = this.deps.workers.roster();
    const names = new Map(roster.map((w) => [w.id, w.name]));
    return this.deps.teams
      .list()
      .teams.filter((t) => t.members.some((m) => canSee(policy, roster, m.workerId, caller)))
      .map((t) => ({
        id: t.id,
        name: t.name,
        ...(t.purpose ? { purpose: t.purpose } : {}),
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

  /// Answer a team's questions, approve or change its plan, carry on past a
  /// checkpoint, or cancel — for whoever asked for the task, or an admin.
  decideTeamTask(
    caller: OrgCaller,
    taskId: UUID,
    action: { kind: 'answer'; answers: string[] } | { kind: 'approve' } | { kind: 'revise'; feedback: string } | { kind: 'continue' } | { kind: 'cancel' },
  ): Result {
    const teams = this.deps.teams;
    if (!teams) return { ok: false, error: 'Teams are not running on this server.' };
    const task = teams.list().tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: 'No team task with that id.' };
    const own = !!caller.slackUserId && task.requestedBy?.slackUserId === caller.slackUserId;
    if (!own && !isAdmin(this.policy(), caller)) return { ok: false, error: 'Only the person who asked for this task, or an admin, can steer it.' };
    const res =
      action.kind === 'answer'
        ? teams.answer(taskId, action.answers)
        : action.kind === 'approve'
          ? teams.approve(taskId)
          : action.kind === 'revise'
            ? teams.revise(taskId, action.feedback)
            : action.kind === 'continue'
              ? teams.continueTask(taskId)
              : teams.cancel(taskId);
    if (res.ok) {
      const verb = { answer: 'Answered', approve: 'Approved the plan for', revise: 'Asked for changes to', continue: 'Continued', cancel: 'Cancelled' }[action.kind];
      this.record(caller, `${verb} ${task.teamName}'s task "${task.title ?? task.brief.slice(0, 60)}".`);
    }
    return res;
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
