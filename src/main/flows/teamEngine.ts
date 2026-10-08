// The team engine: runs a team task from brief to finished pack.
//
//   brief ─► planning ─► (questions ─► planning) ─► proposed ─► running ─► review ─► done
//                                                    ▲   │ revise        │ ▲
//                                                    └───┘               ▼ │ continue / retry
//                                                                      waiting
//
// Planning, drafting and synthesis are COORDINATOR turns: one-shot, no tools,
// fed the brief and the shared folder. Member stages commission each assigned
// worker through the worker engine, so a piece of team work is an ordinary
// errand of that worker's — its own funding gate, journal, spend and
// questions — tagged with `origin.team`. This engine watches those batches go
// by (observeEvent) and files each finished piece into the task's shared
// folder, which every later stage reads.
//
// Main decides; the renderer only mirrors `teamUpdate` / `teamTaskUpdate`.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { log } from '../diagnostics';
import type { Attachment, Backend, MainToRendererEvent, UUID } from '../../shared/types';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker } from '../../shared/flows/worker';
import {
  DEFAULT_TEAM_CHECKPOINTS,
  TEAM_COORDINATOR_SYSTEM_PROMPT,
  TEAM_MAX_HIRES_PER_PLAN,
  TEAM_MAX_MEMBERS,
  TEAM_PLAN_SYSTEM_PROMPT,
  TEAM_ROSTER_SYSTEM_PROMPT,
  buildTeamRosterMessage,
  parseTeamRosterReply,
  unhired,
  buildCoordinatorStageMessage,
  buildMemberStagePrompt,
  buildTeamPlanMessage,
  isMemberStage,
  isPieceSettled,
  canSkipStage,
  blocksNewTask,
  isTaskActive,
  parsePackReply,
  parsePlanReply,
  safeTeamFileName,
  slugify,
  stageFileName,
  validateTeam,
  type FolderFile,
  type Team,
  type TeamHireRequest,
  type TeamMember,
  type TeamPlanHire,
  type TeamRosterDraft,
  type TeamTaskCode,
  type TeamAssignment,
  type TeamRosterLine,
  type TeamStage,
  type TeamTask,
} from '../../shared/flows/team';
import {
  ROOM_COORDINATOR_SYSTEM,
  buildCoordinatorAnswerMessage,
  buildMemberRoomPrompt,
  buildPackUpdateMessage,
  buildRoomWrapUpMessage,
  buildRouteMessage,
  conversationMarkdown,
  isPass,
  parseMentions,
  parseRouteReply,
  renderConversation,
  type RoomMember,
} from '../../shared/flows/teamRoom';
import type { TeamHandoff, TeamMessage, TeamSpeaker } from '../../shared/flows/team';
import * as teamsStore from './teamsStore';

/// How much of the shared folder a member's prompt carries. Members can open
/// the files themselves for the rest; the coordinator cannot, so it gets more.
const MEMBER_FOLDER_BUDGET = 60_000;
// About 75k tokens: room for several long pieces whole, inside any model the
// coordinator runs on.
const COORDINATOR_FOLDER_BUDGET = 300_000;
/// Cap on what one member's piece files into the folder.
const PIECE_MAX_CHARS = 200_000;
const SUPPORTING_MAX_CHARS = 20_000;
/// How often, and how much of, a streaming coordinator turn the desk sees.
const PROGRESS_EVERY_MS = 400;
const PROGRESS_TAIL_CHARS = 1_500;

const BACKEND_LABEL: Record<Backend, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  ollama: 'Ollama',
  copilot: 'Copilot',
};

export type TeamInput = Omit<Team, 'id' | 'createdAt' | 'updatedAt'> & { id?: UUID };

export interface TeamStoreDeps {
  loadTeams(): Team[];
  saveTeam(team: Team): void;
  deleteTeam(id: UUID): void;
  loadTasks(): TeamTask[];
  saveTask(task: TeamTask): void;
  deleteTask(id: UUID): void;
  taskDir(taskId: UUID): string;
  writeFile(taskId: UUID, name: string, body: string): void;
  readFile(taskId: UUID, name: string): string | null;
  removeTaskDir(taskId: UUID): void;
  copyIn(taskId: UUID, name: string, sourcePath: string): void;
  writeBytes(taskId: UUID, name: string, bytes: Buffer): void;
  readBytes(taskId: UUID, name: string): Buffer | null;
  pathOf(taskId: UUID, name: string): string;
}

export interface TeamEngineDeps {
  emit: (event: MainToRendererEvent) => void;
  notify: (args: { title: string; body: string }) => void;
  workers: () => Worker[];
  /// Run one member's piece as that worker's errand (WorkerEngine.commission).
  commission: (
    workerId: UUID,
    args: {
      title: string;
      prompt: string;
      team: { teamId: UUID; teamName: string; taskId: UUID; stage: number };
      /// Where the piece runs, when the task works in a project of its own.
      projectPath?: string;
      /// The grant for external actions on this piece's run, over the
      /// member's own setting (see `Team.piecesAskFirst`).
      allowExternalActions?: boolean;
      /// Fork the piece off the task branch rather than the project as it is.
      baseBranch?: string;
      mode?: 'piece' | 'full';
      check?: boolean;
    },
  ) => Promise<{ ok: true; orchestrationId: UUID } | { ok: false; error: string }>;
  batch: (id: UUID) => Orchestration | null;
  /// One coordinator turn: no tools, text in, text out.
  coordinatorTurn: (args: {
    system: string;
    message: string;
    cancelKey: string;
    /// The text so far, each time the turn streams more.
    onProgress?: (text: string) => void;
    /// Files you attached, handed to the model as attachments (an image or
    /// a PDF is read as one, not as a file name).
    attachments?: Attachment[];
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  cancelTurn?: (cancelKey: string) => void;
  /// Stop a commissioned batch (work you stopped from the room).
  cancelBatch?: (orchestrationId: UUID) => void;
  /// One member's turn in the room, on that worker's own backend and model.
  /// No tools: it answers from the prompt.
  memberTurn: (args: {
    worker: Worker;
    prompt: string;
    cancelKey: string;
    onProgress?: (text: string) => void;
    attachments?: Attachment[];
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  deliverablesFor: (runId: UUID) => Array<{ name: string; body?: string; sourcePath?: string }>;
  /// Member spend so far, summed over these runs.
  spendForRuns: (runIds: UUID[]) => number;
  /// Hire a new worker for a team: drafted from the job, saved on the crew
  /// with no shifts. Absent, teams cannot hire and plans never propose it.
  hire?: (req: TeamHireRequest) => Promise<{ ok: true; worker: Worker } | { ok: false; error: string }>;
  /// Your projects and workspaces, by name: what a team can work in.
  projects?: () => Array<{ name: string; path: string }>;
  /// The task's shared branch (main/flows/teamBranch.ts). Absent: every
  /// piece forks off the project as it is, as before.
  code?: TeamCodeDeps;
  now?: () => number;
  newId?: () => string;
  store?: TeamStoreDeps;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface TeamCodeDeps {
  /// Cut the task branch in every git repo of `projectPath`. Null: no repo.
  open(args: { taskId: UUID; title: string; projectPath: string }): Result<{ code: TeamTaskCode | null }>;
  /// Where a piece's run did its work: a worktree and branch per repo.
  pieceRepos(runId: UUID): Array<{ projectPath: string; worktreePath: string; branchName: string }>;
  absorb(args: {
    code: TeamTaskCode;
    piece: Array<{ projectPath: string; worktreePath: string; branchName: string }>;
    message: string;
  }): Result<{ merged: string[] }>;
  land(code: TeamTaskCode, repo: TeamTaskCode['repos'][number], subject: string): Result<{ message: string }>;
  close(code: TeamTaskCode): void;
}

const realStore: TeamStoreDeps = {
  loadTeams: teamsStore.loadAllTeams,
  saveTeam: teamsStore.saveTeam,
  deleteTeam: teamsStore.deleteTeam,
  loadTasks: teamsStore.loadAllTeamTasks,
  saveTask: teamsStore.saveTeamTask,
  deleteTask: teamsStore.deleteTeamTask,
  taskDir: teamsStore.teamTaskDir,
  writeFile: teamsStore.writeTeamTaskFile,
  readFile: teamsStore.readTeamTaskFile,
  copyIn: teamsStore.copyIntoTeamTask,
  writeBytes: teamsStore.writeTeamTaskBytes,
  readBytes: teamsStore.readTeamTaskBytes,
  pathOf: teamsStore.teamTaskFilePath,
  removeTaskDir: (taskId) => {
    try {
      fs.rmSync(teamsStore.teamTaskDir(taskId), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },
};

export class TeamEngine {
  private readonly teams = new Map<UUID, Team>();
  private readonly tasks = new Map<UUID, TeamTask>();
  /// Coordinator turns in flight, keyed `<taskId>:<plan|stageIndex>`, so a
  /// re-entrant advance can't start the same turn twice.
  private readonly turning = new Set<string>();
  /// Tasks whose member stage is mid-launch.
  private readonly launching = new Set<UUID>();
  /// Room exchanges you stopped, and the turn each room is waiting on.
  private readonly roomStopped = new Set<UUID>();
  private readonly roomTurnKey = new Map<UUID, string>();
  private readonly store: TeamStoreDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: TeamEngineDeps) {
    this.store = deps.store ?? realStore;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /// Load from disk and pick up whatever a restart interrupted.
  start(): void {
    for (const team of this.store.loadTeams()) this.teams.set(team.id, team);
    for (const task of this.store.loadTasks()) this.tasks.set(task.id, task);
    for (const task of this.tasks.values()) {
      try {
        this.recover(task);
      } catch (err) {
        log('warn', 'teams', `Could not resume task ${task.id}`, err);
      }
    }
  }

  private recover(task: TeamTask): void {
    this.catchUpRunFiles(task);
    this.catchUpPackVersions(task);
    if (task.room?.busy) {
      // The turn died with the app. Say so in the room rather than leave a
      // speaker "answering" forever.
      task.room.busy = null;
      this.pushMessage(task, { kind: 'coordinator' }, 'Interrupted when Overcli closed — ask again.', {
        failed: true,
      });
      this.persist(task);
    }
    if (task.status === 'planning') {
      void this.plan(task.id);
      return;
    }
    if (task.status !== 'running') return;
    if (unhired(task).length > 0) {
      // A hire that died with the app never reached the crew: start it again.
      for (const h of task.hires ?? []) if (h.status === 'hiring') h.status = 'proposed';
      this.persist(task);
      void this.hireForPlan(task.id);
      return;
    }
    const stage = task.stages[task.stageIndex];
    if (!stage) {
      this.finish(task);
      return;
    }
    if (stage.status !== 'running') {
      this.advance(task.id);
      return;
    }
    if (!isMemberStage(stage.kind)) {
      // The turn died with the app; run it again.
      stage.status = 'pending';
      this.advance(task.id);
      return;
    }
    for (const a of stage.assignments) {
      if (isPieceSettled(a.status)) continue;
      const batch = a.orchestrationId ? this.deps.batch(a.orchestrationId) : null;
      if (batch) this.applyBatch(task, batch);
      else if (a.orchestrationId) {
        a.status = 'failed';
        a.error = 'The run was lost when Overcli closed.';
      }
    }
    if (stage.assignments.some((a) => a.status === 'pending')) {
      void this.launchMemberStage(task.id, task.stageIndex);
      return;
    }
    this.persist(task);
    this.checkStage(task);
  }

  list(): { teams: Team[]; tasks: TeamTask[] } {
    return {
      teams: [...this.teams.values()].sort((a, b) => a.createdAt - b.createdAt),
      tasks: [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------

  save(input: TeamInput): Result<{ team: Team }> {
    const workers = this.deps.workers();
    const members = (input.members ?? []).map((m) => ({ workerId: m.workerId, role: (m.role ?? '').trim() }));
    const draft: Partial<Team> = {
      ...input,
      name: input.name?.trim(),
      purpose: input.purpose?.trim() || undefined,
      members,
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(input.checkpoints ?? {}) },
    };
    const error = validateTeam(draft, workers);
    if (error) return { ok: false, error };
    const prior = input.id ? this.teams.get(input.id) : undefined;
    if (input.id && !prior) return { ok: false, error: 'That team no longer exists.' };
    const now = this.now();
    const projectPath = input.projectPath?.trim() || undefined;
    if (projectPath && this.deps.projects && !this.deps.projects().some((p) => p.path === projectPath)) {
      return { ok: false, error: 'That project is no longer in Overcli. Pick another, or let members work in their own.' };
    }
    const team: Team = {
      id: prior?.id ?? this.newId(),
      name: draft.name!,
      purpose: draft.purpose,
      ...(projectPath ? { projectPath } : {}),
      ...(projectPath && input.ownProjectOnly ? { ownProjectOnly: true } : {}),
      ...(input.piecesAskFirst ? { piecesAskFirst: true } : {}),
      members,
      budgetUSDPerTask: Math.round(input.budgetUSDPerTask * 100) / 100,
      checkpoints: draft.checkpoints!,
      createdAt: prior?.createdAt ?? now,
      ...(prior ? { updatedAt: now } : {}),
    };
    this.teams.set(team.id, team);
    this.store.saveTeam(team);
    this.deps.emit({ type: 'teamUpdate', team });
    // Raising the team's budget raises it for the task in flight too: you
    // changed the number because you want this work to go further.
    for (const task of this.tasks.values()) {
      if (task.teamId === team.id && isTaskActive(task.status) && this.liftBudget(task, team)) this.persist(task);
    }
    return { ok: true, team };
  }

  remove(id: UUID): Result {
    const team = this.teams.get(id);
    if (!team) return { ok: false, error: 'That team no longer exists.' };
    const busy = [...this.tasks.values()].find((t) => t.teamId === id && (t.status === 'running' || t.status === 'planning'));
    if (busy) return { ok: false, error: 'This team is working on a task. Cancel it first.' };
    for (const task of [...this.tasks.values()]) {
      if (task.teamId === id) this.dropTask(task.id);
    }
    this.teams.delete(id);
    this.store.deleteTeam(id);
    this.deps.emit({ type: 'teamDeleted', id });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Tasks: brief → plan
  // -------------------------------------------------------------------------

  brief(
    teamId: UUID,
    text: string,
    attachments: Attachment[] = [],
    /// Where this task works, over the team's own project. `null`: each
    /// member in their own, whatever the team says.
    projectPath?: string | null,
  ): Result<{ task: TeamTask }> {
    const team = this.teams.get(teamId);
    if (!team) return { ok: false, error: 'That team no longer exists.' };
    const brief = text.trim();
    if (!brief) return { ok: false, error: 'Say what you want the team to produce.' };
    const active = [...this.tasks.values()].find((t) => t.teamId === teamId && blocksNewTask(t));
    if (active) {
      return { ok: false, error: `This team is still on "${active.title ?? firstWords(active.brief, 60)}". Finish or cancel it first.` };
    }
    const workers = this.deps.workers();
    const invalid = validateTeam(team, workers);
    if (invalid) return { ok: false, error: invalid };
    const paused = team.members
      .map((m) => workers.find((w) => w.id === m.workerId))
      .filter((w): w is Worker => !!w && !w.enabled);
    if (paused.length > 0) {
      return { ok: false, error: `${paused.map((w) => w.name).join(', ')} ${paused.length === 1 ? 'is' : 'are'} paused. Resume them or take them off the team.` };
    }

    const workIn = projectPath === undefined ? team.projectPath : projectPath || undefined;
    if (workIn && this.deps.projects && !this.deps.projects().some((p) => p.path === workIn)) {
      return { ok: false, error: 'That project is no longer in Overcli. Pick another for this task.' };
    }
    const now = this.now();
    const id = this.newId();
    const task: TeamTask = {
      id,
      teamId,
      teamName: team.name,
      brief,
      ...(workIn ? { projectPath: workIn } : {}),
      status: 'planning',
      createdAt: now,
      updatedAt: now,
      stages: [],
      stageIndex: 0,
      spentUSD: 0,
      budgetUSD: team.budgetUSDPerTask,
      folder: this.store.taskDir(id),
      files: [],
    };
    this.tasks.set(id, task);
    const saved = this.saveAttachments(task, attachments);
    if (saved.length > 0) task.attachments = saved;
    this.writeBrief(task);
    this.persist(task);
    void this.plan(id);
    return { ok: true, task };
  }

  answer(taskId: UUID, answers: string[]): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status !== 'questions') return { ok: false, error: 'There are no questions waiting.' };
    task.answers = (task.questions ?? []).map((_, i) => (answers[i] ?? '').trim());
    task.status = 'planning';
    this.writeBrief(task);
    this.persist(task);
    void this.plan(taskId);
    return { ok: true };
  }

  revise(taskId: UUID, feedback: string): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status !== 'proposed') return { ok: false, error: 'There is no plan waiting to change.' };
    const note = feedback.trim();
    if (!note) return { ok: false, error: 'Say what to change.' };
    task.revisions = [...(task.revisions ?? []), note];
    task.status = 'planning';
    this.persist(task);
    void this.plan(taskId);
    return { ok: true };
  }

  private async plan(taskId: UUID): Promise<void> {
    const key = `${taskId}:plan`;
    if (this.turning.has(key)) return;
    this.turning.add(key);
    try {
      let repair: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const task = this.tasks.get(taskId);
        const team = task ? this.teams.get(task.teamId) : undefined;
        if (!task || task.status !== 'planning') return;
        if (!team) {
          this.fail(task, 'The team was deleted.');
          return;
        }
        const roster = this.roster(team);
        const allowQuestions = team.checkpoints.askFirst && !task.answers && !(task.revisions?.length);
        const maxHires = this.deps.hire ? Math.max(0, Math.min(TEAM_MAX_HIRES_PER_PLAN, TEAM_MAX_MEMBERS - roster.length)) : 0;
        const message = buildTeamPlanMessage({
          teamName: team.name,
          purpose: team.purpose,
          roster,
          brief: task.brief,
          allowQuestions,
          questions: task.questions,
          answers: task.answers,
          revisions: task.revisions,
          previousPlan: task.stages.length > 0 ? task : undefined,
          budgetUSD: task.budgetUSD,
          maxHires,
          project: task.projectPath ? this.projectName(task.projectPath) : undefined,
          repair,
        });
        const res = await this.deps.coordinatorTurn({
          system: TEAM_PLAN_SYSTEM_PROMPT,
          message,
          cancelKey: `team:${taskId}:plan`,
          onProgress: this.progressFor(taskId, null),
          attachments: this.loadAttachments(task, task.attachments),
        });
        const fresh = this.tasks.get(taskId);
        if (!fresh || fresh.status !== 'planning') return;
        if (!res.ok) {
          this.fail(fresh, `The coordinator could not plan: ${res.error}`);
          return;
        }
        const reply = parsePlanReply(res.text, roster, { allowQuestions, maxHires });
        if (reply.kind === 'error') {
          repair = reply.error;
          log('warn', 'teams', `Plan for ${taskId} unusable (attempt ${attempt + 1}): ${reply.error}`);
          continue;
        }
        if (reply.kind === 'questions') {
          fresh.status = 'questions';
          fresh.questions = reply.questions;
          fresh.planNote = reply.note || undefined;
          this.persist(fresh);
          this.deps.notify({ title: `${fresh.teamName} has questions`, body: reply.questions[0] });
          return;
        }
        fresh.status = 'proposed';
        fresh.title = reply.title;
        fresh.planNote = reply.note || undefined;
        fresh.deliverables = reply.deliverables;
        fresh.stages = reply.stages;
        fresh.hires = reply.hires.length > 0 ? reply.hires : undefined;
        fresh.stageIndex = 0;
        fresh.error = undefined;
        this.persist(fresh);
        this.deps.notify({
          title: `${fresh.teamName} has a plan`,
          body: `${reply.title} · ${reply.stages.length} stages${reply.hires.length > 0 ? ` · hires ${joinNames(reply.hires.map((h) => h.name))}` : ''}`,
        });
        return;
      }
      const task = this.tasks.get(taskId);
      if (task && task.status === 'planning') this.fail(task, `The coordinator's plan could not be used: ${repair}`);
    } catch (err) {
      const task = this.tasks.get(taskId);
      if (task && task.status === 'planning') this.fail(task, `Planning failed: ${String(err)}`);
    } finally {
      this.turning.delete(key);
    }
  }

  private roster(team: Team): TeamRosterLine[] {
    const workers = this.deps.workers();
    return team.members.flatMap((m) => {
      const w = workers.find((x) => x.id === m.workerId);
      if (!w) return [];
      return [{
        workerId: w.id,
        name: w.name,
        role: m.role,
        jobDescription: w.jobDescription,
        backend: w.heartbeatBackend ? BACKEND_LABEL[w.heartbeatBackend] : undefined,
      }];
    });
  }

  // -------------------------------------------------------------------------
  // Tasks: run
  // -------------------------------------------------------------------------

  approve(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status !== 'proposed') return { ok: false, error: 'There is no plan waiting for approval.' };
    task.status = 'running';
    task.stageIndex = 0;
    this.openCode(task);
    this.persist(task);
    // Approving a plan that hires approves the hires: they join the crew,
    // then the first stage runs.
    if (unhired(task).length > 0) void this.hireForPlan(taskId);
    else this.advance(taskId);
    return { ok: true };
  }

  /// Hire the members the approved plan needs, then start it. A hire that
  /// fails holds the task until you retry it or carry on without them.
  private async hireForPlan(taskId: UUID): Promise<void> {
    const key = `${taskId}:hire`;
    if (this.turning.has(key)) return;
    this.turning.add(key);
    try {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'running') return;
      const team = this.teams.get(task.teamId);
      if (!team) {
        this.fail(task, 'The team was deleted.');
        return;
      }
      const hire = this.deps.hire;
      const todo = unhired(task);
      if (!hire) {
        this.wait(task, 'failed', `Could not hire ${joinNames(todo.map((h) => h.name))}: hiring is not available.`);
        return;
      }
      for (const h of todo) {
        h.status = 'hiring';
        h.error = undefined;
      }
      this.persist(task);
      await Promise.all(
        todo.map(async (h) => {
          let res: Awaited<ReturnType<typeof hire>>;
          try {
            const projectPath = task.projectPath ?? team.projectPath;
            res = await hire({
              job: h.job,
              role: h.role,
              teamName: team.name,
              teamId: team.id,
              purpose: team.purpose,
              ...(projectPath ? { projectPath, projectName: this.projectName(projectPath) } : {}),
            });
          } catch (err) {
            res = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          const fresh = this.tasks.get(taskId);
          const entry = fresh?.hires?.find((x) => x.key === h.key);
          if (!fresh || !entry) return;
          if (!res.ok) {
            entry.status = 'failed';
            entry.error = res.error;
          } else {
            entry.status = 'hired';
            entry.workerId = res.worker.id;
            this.placeHire(fresh, entry, res.worker);
          }
          this.persist(fresh);
        }),
      );
      const fresh = this.tasks.get(taskId);
      if (!fresh || fresh.status !== 'running') return;
      const failed = (fresh.hires ?? []).filter((h) => h.status === 'failed');
      if (failed.length > 0) {
        this.wait(fresh, 'failed', `Could not hire ${joinNames(failed.map((h) => h.name))}: ${failed[0].error ?? 'unknown error'}`);
        return;
      }
      this.advance(taskId);
    } finally {
      this.turning.delete(key);
    }
  }

  /// A plan hire is on the crew now: put them on the team, and give their
  /// assignments their real id and name.
  private placeHire(task: TeamTask, hire: TeamPlanHire, worker: Worker): void {
    for (const stage of task.stages) {
      for (const a of stage.assignments) {
        if (a.workerId !== hire.key) continue;
        a.workerId = worker.id;
        a.workerName = worker.name;
      }
    }
    const team = this.teams.get(task.teamId);
    if (!team || team.members.some((m) => m.workerId === worker.id) || team.members.length >= TEAM_MAX_MEMBERS) return;
    const next: Team = { ...team, members: [...team.members, { workerId: worker.id, role: hire.role }], updatedAt: this.now() };
    this.teams.set(next.id, next);
    this.store.saveTeam(next);
    this.deps.emit({ type: 'teamUpdate', team: next });
  }

  /// Carry on from a `waiting` task: past a checkpoint, past the budget with
  /// more money, or past a stage that failed (keeping what did finish).
  continueTask(taskId: UUID, opts: { extraBudgetUSD?: number } = {}): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status !== 'waiting' || !task.waiting) return { ok: false, error: 'This task is not waiting on you.' };
    const stage = task.stages[task.stageIndex];
    switch (task.waiting.reason) {
      case 'checkpoint':
        task.checkpointCleared = task.stageIndex;
        break;
      case 'budget': {
        const extra = opts.extraBudgetUSD ?? 0;
        if (!(extra > 0)) return { ok: false, error: 'Add to the budget to continue.' };
        task.budgetUSD = Math.round((task.budgetUSD + extra) * 100) / 100;
        break;
      }
      case 'failed':
        if (stage?.assignments.some((a) => a.mergeConflict)) {
          // Carry on without the changes that would not merge: the pieces'
          // write-ups stay in the shared folder; their code stays on their
          // own branches.
          for (const a of stage.assignments) a.mergeConflict = undefined;
          stage.status = 'done';
          stage.finishedAt = this.now();
          task.stageIndex += 1;
          break;
        }
        if (unhired(task).length > 0) {
          const dropped = this.dropHires(task);
          if (dropped) return { ok: false, error: dropped };
          break;
        }
        if (!stage) break;
        if (stage.kind === 'synthesize') return { ok: false, error: 'The final pack has to be written — retry it instead.' };
        // Keep whatever finished and move on without the rest.
        stage.status = stage.assignments.some((a) => a.status === 'done') || stage.file ? 'done' : 'failed';
        stage.finishedAt = this.now();
        task.stageIndex += 1;
        break;
    }
    task.waiting = undefined;
    task.status = 'running';
    this.persist(task);
    this.advance(taskId);
    return { ok: true };
  }

  /// Run a failed stage's failed pieces again, or a failed plan again.
  retry(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status === 'failed' && task.stages.length === 0) {
      task.status = 'planning';
      task.error = undefined;
      this.persist(task);
      void this.plan(taskId);
      return { ok: true };
    }
    if (task.status !== 'waiting' || task.waiting?.reason !== 'failed') {
      return { ok: false, error: 'Nothing here has failed.' };
    }
    const clashing = task.stages[task.stageIndex]?.assignments.filter((a) => a.mergeConflict) ?? [];
    if (clashing.length > 0) {
      // You resolved it by hand (or want another go): merge again. A merge
      // you finished yourself leaves nothing new to merge, which clears it.
      const stage = task.stages[task.stageIndex];
      for (const a of clashing) {
        a.mergeConflict = undefined;
        this.absorbPiece(task, stage, a);
      }
      task.waiting = undefined;
      task.status = 'running';
      this.persist(task);
      this.checkStage(task);
      return { ok: true };
    }
    if (unhired(task).length > 0) {
      for (const h of task.hires ?? []) if (h.status === 'failed') h.status = 'proposed';
      task.waiting = undefined;
      task.status = 'running';
      this.persist(task);
      void this.hireForPlan(taskId);
      return { ok: true };
    }
    const stage = task.stages[task.stageIndex];
    if (!stage) return { ok: false, error: 'Nothing here has failed.' };
    stage.error = undefined;
    for (const a of stage.assignments) {
      if (a.status !== 'failed') continue;
      a.status = 'pending';
      a.error = undefined;
      a.orchestrationId = undefined;
      a.runId = undefined;
    }
    stage.status = 'pending';
    task.waiting = undefined;
    task.status = 'running';
    this.persist(task);
    this.advance(taskId);
    return { ok: true };
  }

  /// Drop one member's piece of a stage that has not finished — before it
  /// starts, or by stopping its run — and carry on without it. For when a
  /// piece turns out to repeat work the team already has.
  skipPiece(taskId: UUID, stageIndex: number, workerId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (!canSkipStage(task, stageIndex)) return { ok: false, error: 'That stage can no longer be skipped.' };
    const stage = task.stages[stageIndex];
    const a = stage.assignments.find((x) => x.workerId === workerId);
    if (!a) return { ok: false, error: 'That member has no piece in this stage.' };
    if (isPieceSettled(a.status)) return { ok: false, error: `${a.workerName}'s piece has already ended.` };
    this.dropPiece(a);
    if (stageIndex === task.stageIndex && stage.status === 'running') {
      this.persist(task);
      this.checkStage(task);
      return { ok: true };
    }
    // A stage that has not started: with nobody left on it, it will not.
    if (stage.assignments.every((x) => x.status === 'skipped')) return this.skipStage(taskId, stageIndex);
    this.persist(task);
    return { ok: true };
  }

  /// Drop a whole stage that has not finished. Pieces already in are kept;
  /// anything still running is stopped. The final pack cannot be skipped.
  skipStage(taskId: UUID, stageIndex: number): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (!canSkipStage(task, stageIndex)) return { ok: false, error: 'That stage can no longer be skipped.' };
    const stage = task.stages[stageIndex];
    if (!isMemberStage(stage.kind)) this.deps.cancelTurn?.(`team:${taskId}:${stageIndex}`);
    for (const a of stage.assignments) {
      if (!isPieceSettled(a.status)) this.dropPiece(a);
    }
    stage.status = stage.assignments.some((a) => a.status === 'done') ? 'done' : 'skipped';
    stage.finishedAt = this.now();
    if (stageIndex === task.stageIndex) {
      // Waiting at this stage's checkpoint or budget gate is waiting on a
      // stage that is no longer happening; the next one gates itself.
      task.waiting = undefined;
      task.status = 'running';
      task.stageIndex += 1;
      this.persist(task);
      this.advance(taskId);
      return { ok: true };
    }
    this.persist(task);
    return { ok: true };
  }

  private dropPiece(a: TeamAssignment): void {
    if (a.orchestrationId) this.deps.cancelBatch?.(a.orchestrationId);
    a.status = 'skipped';
    a.error = undefined;
  }

  cancel(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (!isTaskActive(task.status)) return { ok: false, error: 'This task has already ended.' };
    this.deps.cancelTurn?.(`team:${taskId}:plan`);
    this.deps.cancelTurn?.(`team:${taskId}:${task.stageIndex}`);
    const stage = task.stages[task.stageIndex];
    if (stage?.fromRoom && task.pack) {
      // Stopping work handed off from the room stops that work, not the
      // task: the pack and the room are still there.
      for (const a of stage.assignments) {
        if (isPieceSettled(a.status)) continue;
        a.status = 'failed';
        a.error = 'You stopped it.';
        if (a.orchestrationId) this.deps.cancelBatch?.(a.orchestrationId);
      }
      stage.status = stage.assignments.some((a) => a.status === 'done') ? 'done' : 'failed';
      stage.finishedAt = this.now();
      this.reportRoomWork(task, stage);
      task.stageIndex += 1;
      task.waiting = undefined;
      task.status = 'review';
      this.persist(task);
      return { ok: true };
    }
    task.status = 'cancelled';
    task.waiting = undefined;
    task.finishedAt = this.now();
    this.persist(task);
    return { ok: true };
  }

  /// You read the pack and are happy with it.
  accept(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status !== 'review') return { ok: false, error: 'There is no pack waiting for review.' };
    task.status = 'done';
    task.finishedAt = task.finishedAt ?? this.now();
    this.persist(task);
    return { ok: true };
  }

  deleteTask(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (task.status === 'running' || task.status === 'planning') {
      return { ok: false, error: 'Cancel the task before deleting it.' };
    }
    this.dropTask(taskId);
    return { ok: true };
  }

  /// A task file's absolute path, for the host to open — only for files the
  /// task actually recorded.
  filePath(taskId: UUID, name: string): string | null {
    const task = this.tasks.get(taskId);
    if (!task?.files.some((f) => f.name === name)) return null;
    return this.store.pathOf(taskId, name);
  }

  /// The task's shared folder, for the host to reveal.
  folderOf(taskId: UUID): string | null {
    const task = this.tasks.get(taskId);
    return task ? this.store.taskDir(taskId) : null;
  }

  readFile(taskId: UUID, name: string): Result<{ body: string }> {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'That task no longer exists.' };
    if (!task.files.some((f) => f.name === name)) return { ok: false, error: 'No such file in this task.' };
    const body = this.store.readFile(taskId, name);
    if (body === null) return { ok: false, error: 'The file could not be read.' };
    return { ok: true, body };
  }

  private dropTask(taskId: UUID): void {
    const code = this.tasks.get(taskId)?.code;
    if (code) {
      try {
        this.deps.code?.close(code);
      } catch (err) {
        log('warn', 'teams', `Could not take down task ${taskId}'s worktrees`, err);
      }
    }
    this.tasks.delete(taskId);
    this.store.deleteTask(taskId);
    this.store.removeTaskDir(taskId);
    this.deps.emit({ type: 'teamTaskDeleted', id: taskId });
  }

  /// Move a running task forward as far as it can go without waiting.
  private advance(taskId: UUID): void {
    for (;;) {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'running') return;
      // Nothing runs before the plan's hires are on the crew.
      if (unhired(task).length > 0) return;
      const stage = task.stages[task.stageIndex];
      if (!stage) {
        this.finish(task);
        return;
      }
      if (stage.status === 'done' || stage.status === 'failed' || stage.status === 'skipped') {
        task.stageIndex += 1;
        continue;
      }
      if (stage.status === 'running') return;

      // pending: the gates first.
      const team = this.teams.get(task.teamId);
      if (!team) {
        this.fail(task, 'The team was deleted.');
        return;
      }
      if (
        stage.kind === 'challenge' &&
        team.checkpoints.reviewBeforeChallenge &&
        task.checkpointCleared !== task.stageIndex &&
        task.stageIndex > 0
      ) {
        this.wait(task, 'checkpoint', `Look over the work so far before ${stage.assignments.map((a) => a.workerName).join(' and ')} challenges it.`);
        return;
      }
      this.liftBudget(task, team);
      task.spentUSD = this.spent(task);
      if (task.spentUSD >= task.budgetUSD) {
        this.wait(task, 'budget', `Spent $${task.spentUSD.toFixed(2)} of the $${task.budgetUSD.toFixed(2)} budget. Add more to continue.`);
        return;
      }

      if (isMemberStage(stage.kind)) void this.launchMemberStage(taskId, task.stageIndex);
      else void this.runCoordinatorStage(taskId, task.stageIndex);
      return;
    }
  }

  private async launchMemberStage(taskId: UUID, index: number): Promise<void> {
    const task = this.tasks.get(taskId);
    const team = task ? this.teams.get(task.teamId) : undefined;
    const stage = task?.stages[index];
    if (!task || !team || !stage || this.launching.has(taskId)) return;
    this.launching.add(taskId);
    try {
      stage.status = 'running';
      stage.startedAt = stage.startedAt ?? this.now();
      this.persist(task);
      // Work handed off from the room reads the pack too: it is what the
      // conversation was about.
      const files = stage.fromRoom ? [...this.packFiles(task), ...this.folderFiles(task)] : this.folderFiles(task);
      const followUp = stage.fromRoom
        ? {
            conversation: renderConversation(task.room?.messages ?? [], 20_000),
            madeFiles: task.files.filter((f) => f.name.startsWith('files/')).map((f) => f.name),
          }
        : undefined;
      const workers = this.deps.workers();
      const project = task.projectPath ? { name: this.projectName(task.projectPath), path: task.projectPath } : undefined;
      for (const a of stage.assignments) {
        if (a.status !== 'pending') continue;
        const member = team.members.find((m) => m.workerId === a.workerId);
        const prompt = buildMemberStagePrompt({
          ...(followUp ? { followUp: { ...followUp, ownFilesDir: `files/${slugify(a.workerName, 20)}/` } } : {}),
          teamName: team.name,
          task,
          stageNumber: index + 1,
          stageCount: task.stages.length,
          stage,
          role: member?.role ?? '',
          ask: a.ask,
          teammates: this.roster(team)
            .filter((m) => m.workerId !== a.workerId)
            .map((m) => ({ name: m.name, role: m.role })),
          folder: task.folder,
          files,
          budget: MEMBER_FOLDER_BUDGET,
          ...(project && project.path !== workers.find((w) => w.id === a.workerId)?.projectPath
            ? {
                project: {
                  ...project,
                  usual: this.projectName(workers.find((w) => w.id === a.workerId)?.projectPath ?? '') || undefined,
                },
              }
            : {}),
        });
        // Marked running before the call: the batch's first update can
        // arrive while it is still in flight.
        a.status = 'running';
        const res = await this.deps.commission(a.workerId, {
          title: stage.title,
          prompt,
          team: { teamId: team.id, teamName: team.name, taskId, stage: index },
          ...(task.projectPath ? { projectPath: task.projectPath } : {}),
          ...(team.piecesAskFirst ? {} : { allowExternalActions: true }),
          // Code that merges into the task branch is checked first, by the
          // member's own check step, when its flow has one.
          ...(task.code ? { baseBranch: task.code.branch, check: true } : {}),
          ...(a.full ? { mode: 'full' as const } : {}),
        });
        // Skipped while the commission was in flight: the batch exists now,
        // so stop it rather than let a run nobody wants spend.
        if ((a.status as TeamAssignment['status']) === 'skipped') {
          if (res.ok) this.deps.cancelBatch?.(res.orchestrationId);
          continue;
        }
        if (res.ok) {
          a.orchestrationId = a.orchestrationId ?? res.orchestrationId;
          const batch = this.deps.batch(res.orchestrationId);
          if (batch) this.applyBatch(task, batch, { check: false });
        } else {
          a.status = 'failed';
          a.error = res.error;
        }
        this.persist(task);
      }
    } finally {
      this.launching.delete(taskId);
    }
    // Skipping the whole stage mid-launch already moved the task on, but
    // `advance` could not start the next stage while this one held the slot.
    if (task.stageIndex !== index) this.advance(taskId);
    else this.checkStage(task);
  }

  /// Fold a commissioned batch's state into its assignment.
  private applyBatch(task: TeamTask, o: Orchestration, opts: { check?: boolean } = {}): void {
    const origin = o.origin?.kind === 'worker' ? o.origin : undefined;
    if (!origin?.team) return;
    const stage = task.stages[origin.team.stage];
    const a = stage?.assignments.find((x) => x.workerId === origin.workerId);
    if (!stage || !a) return;
    // A retried piece gets a new batch; updates from the old one are history.
    if (a.orchestrationId && a.orchestrationId !== o.id) return;
    if (isPieceSettled(a.status)) return;
    a.orchestrationId = o.id;
    const item = o.items[0];
    if (!item) return;
    if (item.runId) a.runId = item.runId;
    switch (item.status) {
      case 'proposed':
      case 'queued':
      case 'running':
        a.status = 'running';
        break;
      case 'paused':
        a.status = 'paused';
        break;
      case 'done':
        this.collectPiece(task, origin.team.stage, a);
        this.absorbPiece(task, stage, a);
        a.status = 'done';
        break;
      case 'failed':
        a.status = 'failed';
        a.error = item.note || 'The run failed.';
        break;
      case 'cancelled':
        a.status = 'failed';
        a.error = 'The run was cancelled.';
        break;
    }
    this.persist(task);
    if (opts.check !== false && origin.team.stage === task.stageIndex) this.checkStage(task);
  }

  observeEvent(event: MainToRendererEvent): void {
    if (event.type === 'orchestrationUpdate') {
      const o = event.orchestration;
      const team = o.origin?.kind === 'worker' ? o.origin.team : undefined;
      if (!team) return;
      const task = this.tasks.get(team.taskId);
      if (task) this.applyBatch(task, o);
      return;
    }
    if (event.type === 'orchestrationDeleted') {
      for (const task of this.tasks.values()) {
        const stage = task.stages[task.stageIndex];
        const a = stage?.assignments.find((x) => x.orchestrationId === event.id);
        if (!a || isPieceSettled(a.status)) continue;
        a.status = 'failed';
        a.error = 'The run was deleted.';
        this.persist(task);
        this.checkStage(task);
      }
    }
  }

  /// A member stage is over once every piece has landed or failed.
  private checkStage(task: TeamTask): void {
    if (task.status !== 'running' || this.launching.has(task.id)) return;
    const stage = task.stages[task.stageIndex];
    if (!stage || !isMemberStage(stage.kind) || stage.status !== 'running') return;
    if (stage.assignments.some((a) => !isPieceSettled(a.status))) return;
    const failed = stage.assignments.filter((a) => a.status === 'failed');
    if (stage.fromRoom) {
      // Work from the room has no later stage to protect: report what came
      // of it where it was asked for, and go back to the room.
      stage.status = failed.length === stage.assignments.length ? 'failed' : 'done';
      if (failed.length > 0) stage.error = failed.map((a) => `${a.workerName}: ${a.error ?? 'failed'}`).join('\n');
      stage.finishedAt = this.now();
      this.reportRoomWork(task, stage);
      task.stageIndex += 1;
      this.persist(task);
      this.advance(task.id);
      return;
    }
    if (failed.length === stage.assignments.length) {
      stage.status = 'failed';
      stage.error = failed.map((a) => `${a.workerName}: ${a.error ?? 'failed'}`).join('\n');
      this.wait(task, 'failed', `Nobody in "${stage.title}" finished. Retry, skip it, or cancel.`);
      return;
    }
    if (failed.length > 0) {
      // Some pieces are in. Stop and ask rather than quietly carrying on
      // with a hole the coordinator would have to paper over.
      stage.error = failed.map((a) => `${a.workerName}: ${a.error ?? 'failed'}`).join('\n');
      this.wait(task, 'failed', `${failed.map((a) => a.workerName).join(' and ')} did not finish "${stage.title}". Retry, continue without, or cancel.`);
      return;
    }
    const clashed = stage.assignments.filter((a) => a.mergeConflict);
    if (clashed.length > 0) {
      // The work is done; it just will not merge. Stop before the next stage
      // builds on a task branch that is missing it.
      stage.error = clashed.map((a) => `${a.workerName}: ${a.mergeConflict}`).join('\n');
      this.wait(
        task,
        'failed',
        `${clashed.map((a) => a.workerName).join(' and ')}'s changes did not make it into the task branch. ${clashed[0].mergeConflict}`,
      );
      return;
    }
    // Every piece skipped is a stage that did not happen, not one that did.
    stage.status = stage.assignments.some((a) => a.status === 'done') ? 'done' : 'skipped';
    stage.finishedAt = this.now();
    task.stageIndex += 1;
    this.persist(task);
    this.advance(task.id);
  }

  private async runCoordinatorStage(taskId: UUID, index: number): Promise<void> {
    const key = `${taskId}:${index}`;
    const task = this.tasks.get(taskId);
    const stage = task?.stages[index];
    if (!task || !stage || this.turning.has(key)) return;
    this.turning.add(key);
    try {
      stage.status = 'running';
      stage.startedAt = this.now();
      this.persist(task);
      const message = buildCoordinatorStageMessage({
        teamName: task.teamName,
        task,
        stage,
        stageNumber: index + 1,
        stageCount: task.stages.length,
        folder: task.folder,
        files: this.folderFiles(task),
        budget: COORDINATOR_FOLDER_BUDGET,
      });
      const res = await this.deps.coordinatorTurn({
        system: TEAM_COORDINATOR_SYSTEM_PROMPT,
        message,
        cancelKey: `team:${taskId}:${index}`,
        onProgress: this.progressFor(taskId, index),
      });
      if (this.tasks.get(taskId) !== task || task.status !== 'running' || task.stageIndex !== index) return;
      if (!res.ok) {
        stage.status = 'failed';
        stage.error = res.error;
        this.wait(task, 'failed', `The coordinator could not finish "${stage.title}": ${res.error}`);
        return;
      }
      const at = this.now();
      if (stage.kind === 'synthesize') {
        const pack = parsePackReply(res.text);
        const names: string[] = [];
        for (const f of pack.files) {
          const name = `pack/${safeTeamFileName(f.name)}`;
          this.store.writeFile(taskId, name, f.body);
          this.recordFile(task, { name, author: 'Coordinator', stage: index, at });
          names.push(name);
        }
        task.pack = { summary: pack.summary, files: names };
        stage.file = names[0];
      } else {
        const name = stageFileName(index, stage.title, 'coordinator');
        this.store.writeFile(taskId, name, `${res.text.trim()}\n`);
        this.recordFile(task, { name, author: 'Coordinator', stage: index, at });
        stage.file = name;
      }
      stage.status = 'done';
      stage.finishedAt = at;
      task.stageIndex += 1;
      this.persist(task);
      this.advance(taskId);
    } catch (err) {
      if (stage.status === 'running') {
        stage.status = 'failed';
        stage.error = String(err);
        this.wait(task, 'failed', `"${stage.title}" failed: ${String(err)}`);
      }
    } finally {
      this.turning.delete(key);
    }
  }

  private finish(task: TeamTask): void {
    const team = this.teams.get(task.teamId);
    task.spentUSD = this.spent(task);
    task.waiting = undefined;
    const review = team?.checkpoints.finalReview ?? true;
    task.status = review ? 'review' : 'done';
    task.finishedAt = this.now();
    this.persist(task);
    const last = task.stages.at(-1);
    if (last?.fromRoom) {
      const who = last.assignments.filter((a) => a.status === 'done').map((a) => a.workerName);
      this.deps.notify({
        title: who.length ? `${task.teamName}: ${joinNames(who)} finished` : `${task.teamName}: work did not finish`,
        body: last.title,
      });
      return;
    }
    this.deps.notify({
      title: review ? `${task.teamName}: pack ready to review` : `${task.teamName} finished`,
      body: task.pack?.summary?.slice(0, 180) || task.title || task.brief.slice(0, 120),
    });
  }

  /// Carry on without the hires that could not be made: their pieces come
  /// out of the plan. Returns why that is not possible, if it is not.
  private dropHires(task: TeamTask): string | null {
    const gone = new Set(unhired(task).map((h) => h.key));
    const stages = task.stages.map((s) => ({ ...s, assignments: s.assignments.filter((a) => !gone.has(a.workerId)) }));
    const left = stages.filter((s) => !isMemberStage(s.kind) || s.assignments.length > 0);
    if (!left.some((s) => isMemberStage(s.kind))) {
      return `Without ${joinNames(unhired(task).map((h) => h.name))} this plan has no member work left. Retry the hire, or cancel and brief the team again.`;
    }
    task.stages = left;
    task.hires = (task.hires ?? []).filter((h) => h.status === 'hired');
    if (task.hires.length === 0) task.hires = undefined;
    return null;
  }

  // -------------------------------------------------------------------------
  // Putting a team together
  // -------------------------------------------------------------------------

  /// Suggest a team for what you describe: crew workers who fit, and jobs to
  /// hire for where nobody does. Nothing is saved or hired — you review it.
  async draftRoster(args: {
    brief: string;
    current?: { name?: string; purpose?: string; members: TeamMember[]; projectPath?: string; ownProjectOnly?: boolean };
  }): Promise<Result<{ draft: TeamRosterDraft }>> {
    const brief = args.brief.trim();
    if (!brief) return { ok: false, error: 'Say what the team is for.' };
    const workers = this.deps.workers();
    const onlyIn = args.current?.ownProjectOnly ? args.current.projectPath : undefined;
    const crew = workers
      .filter((w) => w.enabled && (!onlyIn || w.projectPath === onlyIn))
      .map((w) => ({
        workerId: w.id,
        name: w.name,
        summary: w.tagline?.trim() || w.jobDescription,
        project: this.projectName(w.projectPath) || undefined,
      }));
    const projects = this.deps.projects?.() ?? [];
    const chosen = args.current?.projectPath;
    const current = args.current && {
      name: args.current.name,
      purpose: args.current.purpose,
      members: args.current.members.flatMap((m) => {
        const w = workers.find((x) => x.id === m.workerId);
        return w ? [{ name: w.name, role: m.role }] : [];
      }),
    };
    const cancelKey = `team-roster:${this.newId()}`;
    let repair: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.deps.coordinatorTurn({
        system: TEAM_ROSTER_SYSTEM_PROMPT,
        message: buildTeamRosterMessage({
          brief,
          crew,
          current,
          repair,
          ...(chosen ? { project: this.projectName(chosen) } : { projects: projects.map((p) => p.name) }),
          ...(onlyIn ? { ownProjectOnly: true } : {}),
        }),
        cancelKey,
      });
      if (!res.ok) return res;
      const parsed = parseTeamRosterReply(res.text, crew, chosen ? [] : projects);
      if (parsed.ok) return { ok: true, draft: parsed.draft };
      repair = parsed.error;
      log('warn', 'teams', `Roster draft unusable (attempt ${attempt + 1}): ${parsed.error}`);
    }
    return { ok: false, error: `The suggestion could not be used: ${repair}` };
  }

  /// Hire one worker for a team you are putting together. They join the
  /// crew with no shifts; putting them on the team is the editor's save.
  async hireMember(req: TeamHireRequest): Promise<Result<{ worker: Worker }>> {
    if (!req.job.trim()) return { ok: false, error: 'Say what they should do.' };
    if (!this.deps.hire) return { ok: false, error: 'Hiring is not available.' };
    try {
      return await this.deps.hire(
        req.projectPath && !req.projectName ? { ...req, projectName: this.projectName(req.projectPath) } : req,
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /// Give the task its shared branch, once, when its plan is approved — only
  /// for a task that works in a project, since that is the code the pieces
  /// change. A branch that cannot be cut is said, not fatal: the pieces then
  /// fork off the project as it is, each on its own.
  private openCode(task: TeamTask): void {
    if (task.code || !task.projectPath || !this.deps.code) return;
    try {
      const res = this.deps.code.open({ taskId: task.id, title: task.title ?? task.brief, projectPath: task.projectPath });
      if (!res.ok) task.codeError = res.error;
      else if (res.code) task.code = res.code;
    } catch (err) {
      task.codeError = err instanceof Error ? err.message : String(err);
    }
  }

  /// Merge a finished piece into the task branch. A conflict is held on the
  /// piece, and the stage stops on it (see checkStage).
  private absorbPiece(task: TeamTask, stage: TeamStage, a: TeamAssignment): void {
    if (!task.code || !a.runId || !this.deps.code) return;
    try {
      const piece = this.deps.code.pieceRepos(a.runId);
      if (piece.length === 0) return;
      const res = this.deps.code.absorb({ code: task.code, piece, message: `${a.workerName}: ${stage.title}` });
      if (!res.ok) a.mergeConflict = res.error;
    } catch (err) {
      a.mergeConflict = err instanceof Error ? err.message : String(err);
    }
  }

  /// Merge the task branch into one repo's base, in your checkout.
  landCode(taskId: UUID, projectPath: string): Result<{ message: string }> {
    const task = this.tasks.get(taskId);
    if (!task?.code) return { ok: false, error: 'This task has no branch to merge.' };
    const repo = task.code.repos.find((r) => r.projectPath === projectPath);
    if (!repo) return { ok: false, error: 'That repo is not part of this task.' };
    if (!this.deps.code) return { ok: false, error: 'Merging is not available.' };
    const res = this.deps.code.land(task.code, repo, task.title ?? firstWords(task.brief, 60));
    if (!res.ok) return res;
    repo.landed = true;
    this.persist(task);
    return res;
  }

  /// A project's name as you know it, else its folder's.
  private projectName(path: string): string {
    if (!path) return '';
    return this.deps.projects?.().find((p) => p.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  private wait(task: TeamTask, reason: 'checkpoint' | 'budget' | 'failed', message: string): void {
    task.status = 'waiting';
    task.waiting = { reason, message };
    this.persist(task);
    this.deps.notify({ title: `${task.teamName} needs you`, body: message });
  }

  private fail(task: TeamTask, error: string): void {
    task.status = 'failed';
    task.error = error;
    task.finishedAt = this.now();
    this.persist(task);
    this.deps.notify({ title: `${task.teamName}: task failed`, body: error });
  }

  // -------------------------------------------------------------------------
  // The shared folder
  // -------------------------------------------------------------------------

  /// File one member's finished piece. Idempotent: the fold sees `done` on
  /// every later update of the batch too.
  private collectPiece(task: TeamTask, stageIndex: number, a: TeamAssignment): void {
    if (a.file) return;
    const stage: TeamStage | undefined = task.stages[stageIndex];
    if (!stage) return;
    const artifacts = a.runId ? this.deps.deliverablesFor(a.runId) : [];
    const copied = this.copyRunFiles(task, stageIndex, a, artifacts);
    a.filesCopied = true;
    const body = pieceText(artifacts, copied);
    const name = stageFileName(stageIndex, stage.title, a.workerName);
    const header = `# ${stage.title} — ${a.workerName}\n\n`;
    try {
      this.store.writeFile(task.id, name, `${header}${body || '_Finished, but left no written output._'}\n`);
      this.recordFile(task, { name, author: a.workerName, stage: stageIndex, at: this.now() });
      a.file = name;
    } catch (err) {
      log('warn', 'teams', `Could not file ${a.workerName}'s piece for ${task.id}`, err);
    }
  }

  /// Copy what a run WROTE (designs, pages, data) into the shared folder
  /// under `files/<member>/`, keeping its subfolders so pages that link to
  /// each other still do. A run's working folder dies with the run; the
  /// shared folder is what the team, the pack and you keep.
  private copyRunFiles(
    task: TeamTask,
    stageIndex: number,
    a: TeamAssignment,
    artifacts: Array<{ name: string; sourcePath?: string }>,
  ): CopiedFile[] {
    const out: CopiedFile[] = [];
    const at = this.now();
    for (const art of artifacts) {
      if (!art.sourcePath) continue;
      const rel = art.name
        .split(/[\\/]/)
        .filter((seg) => seg && seg !== '.' && seg !== '..')
        .join('/');
      if (!rel) continue;
      const shared = `files/${slugify(a.workerName, 20)}/${rel}`;
      try {
        this.store.copyIn(task.id, shared, art.sourcePath);
        this.recordFile(task, { name: shared, author: a.workerName, stage: stageIndex, at });
        out.push({ rel, shared, sourcePath: art.sourcePath });
      } catch (err) {
        log('warn', 'teams', `Could not copy ${rel} from ${a.workerName}'s run`, err);
      }
    }
    return out;
  }

  /// Tasks that finished before run files were copied: copy them now, while
  /// the runs are still around, and add the list to each piece.
  private catchUpRunFiles(task: TeamTask): void {
    let changed = false;
    task.stages.forEach((stage, i) => {
      for (const a of stage.assignments) {
        if (a.status !== 'done' || !a.runId || a.filesCopied) continue;
        const copied = this.copyRunFiles(task, i, a, this.deps.deliverablesFor(a.runId));
        a.filesCopied = true;
        changed = true;
        if (copied.length === 0 || !a.file) continue;
        const piece = this.store.readFile(task.id, a.file);
        if (piece !== null) this.store.writeFile(task.id, a.file, `${piece.trimEnd()}\n\n${filesSection(copied)}\n`);
      }
    });
    if (changed) this.persist(task);
  }

  /// Packs updated before earlier versions were listed: the old copies are
  /// on disk under `pack-vN/`, so list the ones that are there.
  private catchUpPackVersions(task: TeamTask): void {
    const version = task.pack?.version ?? 1;
    let changed = false;
    for (let v = 1; v < version; v++) {
      for (const name of task.pack?.files ?? []) {
        const kept = name.replace(/^pack\//, `pack-v${v}/`);
        if (task.files.some((f) => f.name === kept) || this.store.readFile(task.id, kept) === null) continue;
        this.recordFile(task, { name: kept, author: 'Coordinator', at: task.finishedAt ?? task.createdAt });
        changed = true;
      }
    }
    if (changed) this.persist(task);
  }

  private folderFiles(task: TeamTask): FolderFile[] {
    // Pieces and drafts only: the pack is not written yet, and the files runs
    // made are named in each piece rather than pasted in whole.
    return task.files
      .filter((f) => !f.name.startsWith('pack/') && !f.name.startsWith('files/') && !f.name.startsWith('pack-v'))
      .map((f) => ({
        name: f.name,
        author: f.author,
        // An image or a PDF you attached is named, not pasted as bytes.
        body:
          f.name.startsWith('attachments/') && !TEXT_ATTACHMENT.test(f.name)
            ? `(a ${mimeFor(f.name)} file you attached — open it from the shared folder)`
            : (this.store.readFile(task.id, f.name) ?? ''),
      }));
  }

  private recordFile(task: TeamTask, file: TeamTask['files'][number]): void {
    task.files = [...task.files.filter((f) => f.name !== file.name), file];
  }

  private writeBrief(task: TeamTask): void {
    const lines = ['# Brief', '', task.brief];
    if (task.attachments?.length) {
      lines.push('', '## Attached', '', ...task.attachments.map((a) => `- \`${a}\``));
    }
    const qa = (task.questions ?? []).map((q, i) => ({ q, a: task.answers?.[i] ?? '' }));
    if (qa.length > 0 && task.answers) {
      lines.push('', '## Questions and answers', '');
      for (const { q, a } of qa) lines.push(`**${q}**`, '', a || '_No answer._', '');
    }
    try {
      this.store.writeFile(task.id, 'brief.md', `${lines.join('\n').trim()}\n`);
      this.recordFile(task, { name: 'brief.md', author: 'You', at: this.now() });
    } catch (err) {
      log('warn', 'teams', `Could not write the brief for ${task.id}`, err);
    }
  }

  /// A task's budget never sits below its team's. It can sit above it — you
  /// added to it to get past the cap — and lowering the team's budget does
  /// not cut a plan you already approved.
  private liftBudget(task: TeamTask, team: Team): boolean {
    if (team.budgetUSDPerTask <= task.budgetUSD) return false;
    task.budgetUSD = team.budgetUSDPerTask;
    return true;
  }

  /// A throttled reporter for one coordinator turn. A long draft streams
  /// thousands of chunks; the desk needs a few updates a second, not each one.
  private progressFor(taskId: UUID, stage: number | null | 'room'): (text: string) => void {
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let latest = '';
    const send = () => {
      pending = null;
      last = this.now();
      this.deps.emit({
        type: 'teamTaskProgress',
        taskId,
        stage,
        tail: latest.slice(-PROGRESS_TAIL_CHARS),
        chars: latest.length,
      });
    };
    return (text: string) => {
      latest = text;
      if (pending) return;
      const wait = PROGRESS_EVERY_MS - (this.now() - last);
      if (wait <= 0) send();
      else pending = setTimeout(send, wait);
    };
  }

  // -------------------------------------------------------------------------
  // The room: talking with the team once the pack is written
  // -------------------------------------------------------------------------

  /// Ask the team something. `@Name` picks who answers; otherwise the
  /// coordinator routes the question.
  roomAsk(taskId: UUID, text: string, attachments: Attachment[] = []): Result {
    const task = this.tasks.get(taskId);
    const ready = this.roomReady(task);
    if (ready) return { ok: false, error: ready };
    const question = text.trim();
    if (!question) return { ok: false, error: 'Ask the team something.' };
    const members = this.roomMembers(task!);
    const mentions = parseMentions(question, members);
    const exchange = (task!.room?.messages.at(-1)?.exchange ?? -1) + 1;
    const saved = this.saveAttachments(task!, attachments);
    this.pushMessage(task!, { kind: 'you' }, question, { exchange, attachments: saved });
    this.persist(task!);
    void this.runExchange(taskId, {
      question,
      exchange,
      attachments: saved,
      responders: mentions.everyone ? members.map((m) => m.workerId) : mentions.workerIds.length ? mentions.workerIds : null,
      rounds: ['answer', 'respond'],
      // Even a question to someone by name is routed: "@Lena redo the
      // designs" is work to hand off, not something to answer.
      route: true,
    });
    return { ok: true };
  }

  /// Start work the coordinator proposed in the room: it runs as one more
  /// stage of the task, so its runs, spend and files are the task's, and its
  /// output lands in the shared folder.
  roomStartWork(taskId: UUID, messageId: string): Result {
    const task = this.tasks.get(taskId);
    const ready = this.roomReady(task);
    if (ready) return { ok: false, error: ready };
    const message = task!.room?.messages.find((m) => m.id === messageId);
    const handoff = message?.handoff;
    if (!message || !handoff) return { ok: false, error: 'That proposal is gone.' };
    if (handoff.status !== 'proposed') return { ok: false, error: 'That work was already started or set aside.' };
    const workers = this.deps.workers();
    const assignments = handoff.assignments.filter((a) => workers.some((w) => w.id === a.workerId));
    if (assignments.length === 0) return { ok: false, error: 'Nobody on that proposal is still on the team.' };
    const index = task!.stages.length;
    task!.stages.push({
      kind: 'contribute',
      title: handoff.title,
      assignments: assignments.map((a) => ({ workerId: a.workerId, workerName: a.workerName, ask: a.ask, status: 'pending' })),
      status: 'pending',
      fromRoom: { messageId, exchange: message.exchange },
    });
    handoff.status = 'started';
    handoff.stage = index;
    task!.stageIndex = index;
    task!.status = 'running';
    task!.waiting = undefined;
    this.persist(task!);
    this.advance(taskId);
    return { ok: true };
  }

  roomDismissWork(taskId: UUID, messageId: string): Result {
    const task = this.tasks.get(taskId);
    const handoff = task?.room?.messages.find((m) => m.id === messageId)?.handoff;
    if (!task || !handoff) return { ok: false, error: 'That proposal is gone.' };
    if (handoff.status !== 'proposed') return { ok: false, error: 'That work was already started or set aside.' };
    handoff.status = 'dismissed';
    this.persist(task);
    return { ok: true };
  }

  /// Turn what a member said in the room into work for them: for when the
  /// coordinator took a request to do something as a question.
  roomHandOff(taskId: UUID, messageId: string): Result {
    const task = this.tasks.get(taskId);
    const ready = this.roomReady(task);
    if (ready) return { ok: false, error: ready };
    const messages = task!.room!.messages;
    const at = messages.findIndex((m) => m.id === messageId);
    const said = messages[at];
    if (!said || said.speaker.kind !== 'member' || said.failed) return { ok: false, error: 'Pick something a member said.' };
    if (messages.some((m) => m.handoff?.status === 'proposed')) {
      return { ok: false, error: 'There is already work waiting to start. Start it or set it aside first.' };
    }
    const question = messages.slice(0, at).reverse().find((m) => m.speaker.kind === 'you');
    const title = question ? firstWords(question.text, 60) : 'Follow-up work';
    this.pushMessage(
      task!,
      { kind: 'coordinator' },
      `${said.speaker.name} can do this as a real run, with their tools and the shared folder.`,
      {
        exchange: said.exchange,
        handoff: {
          title,
          status: 'proposed',
          assignments: [
            {
              workerId: said.speaker.workerId,
              workerName: said.speaker.name,
              ask: [
                question ? `The user asked: ${question.text.trim()}` : '',
                `You answered, in the conversation:\n${said.text.trim()}`,
                'Now do it: carry out what you described.',
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
        },
      },
    );
    this.fileConversation(task!);
    this.persist(task!);
    return { ok: true };
  }

  /// Another round on the last question: every member may weigh in on what
  /// was said, or pass.
  roomContinue(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    const ready = this.roomReady(task);
    if (ready) return { ok: false, error: ready };
    const messages = task!.room?.messages ?? [];
    const lastQuestion = [...messages].reverse().find((m) => m.speaker.kind === 'you');
    if (!lastQuestion) return { ok: false, error: 'Ask the team something first.' };
    void this.runExchange(taskId, {
      question: lastQuestion.text,
      exchange: lastQuestion.exchange,
      attachments: lastQuestion.attachments,
      responders: this.roomMembers(task!).map((m) => m.workerId),
      rounds: ['respond'],
      route: false,
    });
    return { ok: true };
  }

  roomStop(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    if (!task?.room?.busy) return { ok: false, error: 'Nobody is speaking.' };
    this.roomStopped.add(taskId);
    const key = this.roomTurnKey.get(taskId);
    if (key) this.deps.cancelTurn?.(key);
    return { ok: true };
  }

  /// Fold what the room settled back into the pack, keeping the old version.
  updatePack(taskId: UUID): Result {
    const task = this.tasks.get(taskId);
    const ready = this.roomReady(task);
    if (ready) return { ok: false, error: ready };
    const room = task!.room;
    const fresh = (room?.messages ?? []).slice(room?.foldedThrough ?? 0).filter((m) => !m.failed);
    if (!fresh.some((m) => m.speaker.kind !== 'you')) {
      return { ok: false, error: 'Nothing new has been said since the pack was written.' };
    }
    void this.rewritePack(taskId, fresh);
    return { ok: true };
  }

  /// Why the room can't take a turn now, or null if it can.
  private roomReady(task: TeamTask | undefined): string | null {
    if (!task) return 'That task no longer exists.';
    if (task.status !== 'review' && task.status !== 'done') return 'The team is still working on this task.';
    if (!task.pack) return 'There is no pack to talk about yet.';
    if (task.room?.busy || this.turning.has(`room:${task.id}`)) return 'The team is still answering.';
    if (!this.teams.get(task.teamId)) return 'The team was deleted.';
    return null;
  }

  private roomMembers(task: TeamTask): RoomMember[] {
    const team = this.teams.get(task.teamId);
    if (!team) return [];
    return this.roster(team).map((m) => ({
      workerId: m.workerId,
      name: m.name,
      role: m.role,
      jobDescription: m.jobDescription,
      backend: m.backend,
    }));
  }

  private async runExchange(
    taskId: UUID,
    args: {
      question: string;
      exchange: number;
      responders: string[] | null;
      rounds: Array<'answer' | 'respond'>;
      attachments?: string[];
      route: boolean;
    },
  ): Promise<void> {
    const key = `room:${taskId}`;
    const task = this.tasks.get(taskId);
    if (!task || this.turning.has(key)) return;
    this.turning.add(key);
    this.roomStopped.delete(taskId);
    const members = this.roomMembers(task);
    const byId = new Map(members.map((m) => [m.workerId, m]));
    const spoke = new Set<string>();
    const files = this.loadAttachments(task, args.attachments);
    try {
      let responders = args.responders;
      if (args.route) {
        const routed = await this.coordinatorSays(task, 'Coordinator', {
          system: ROOM_COORDINATOR_SYSTEM,
          message: buildRouteMessage({
            teamName: task.teamName,
            members: members.map((m) => ({ ...m, pieces: this.ownPieces(task, m.name).map((f) => f.name) })),
            // The question is the last message; it is shown on its own.
            conversation: (task.room?.messages ?? []).slice(0, -1),
            question: args.question,
            addressed: responders?.map((id) => byId.get(id)?.name).filter((n): n is string => !!n),
          }),
        });
        if (this.stopped(taskId)) return;
        const reply = routed.ok ? parseRouteReply(routed.text, members) : { kind: 'route' as const, workerIds: [] };
        if (reply.kind === 'work') {
          this.proposeWork(task, args.exchange, reply.work);
          return;
        }
        responders = responders ?? reply.workerIds;
        if (responders.length === 0) {
          if (this.stopped(taskId)) return;
          const answer = await this.coordinatorSays(task, 'Coordinator', {
            attachments: files,
            system: ROOM_COORDINATOR_SYSTEM,
            message: buildCoordinatorAnswerMessage({
              teamName: task.teamName,
              taskTitle: task.title ?? task.brief,
              pack: this.packFiles(task),
              conversation: task.room?.messages ?? [],
              question: args.question,
            }),
          });
          this.pushMessage(task, { kind: 'coordinator' }, answer.ok ? answer.text.trim() : answer.error, {
            exchange: args.exchange,
            failed: !answer.ok,
          });
          return;
        }
      }

      const pool = (responders ?? []).map((id) => byId.get(id)).filter((m): m is RoomMember => !!m);
      for (const round of args.rounds) {
        // A respond round only means something once two voices are in it.
        if (round === 'respond' && args.rounds.includes('answer') && spoke.size < 2) break;
        const speakers = round === 'respond' && args.rounds.includes('answer') ? pool.filter((m) => spoke.has(m.workerId)) : pool;
        for (const m of speakers) {
          if (this.stopped(taskId)) return;
          const worker = this.deps.workers().find((w) => w.id === m.workerId);
          if (!worker) continue;
          const res = await this.memberSays(task, worker, buildMemberRoomPrompt({
            teamName: task.teamName,
            taskTitle: task.title ?? task.brief,
            brief: task.brief,
            member: m,
            teammates: members.filter((x) => x.workerId !== m.workerId),
            ownPieces: this.ownPieces(task, m.name),
            pack: this.packFiles(task),
            conversation: task.room?.messages ?? [],
            question: args.question,
            round,
          }), files);
          if (this.stopped(taskId)) return;
          if (res.ok && round === 'respond' && isPass(res.text)) continue;
          this.pushMessage(task, { kind: 'member', workerId: m.workerId, name: m.name }, res.ok ? res.text.trim() : res.error, {
            exchange: args.exchange,
            failed: !res.ok,
          });
          if (res.ok) spoke.add(m.workerId);
          this.persist(task);
        }
      }

      if (spoke.size >= 2 && !this.stopped(taskId)) {
        const exchange = (task.room?.messages ?? []).filter((m) => m.exchange === args.exchange);
        const wrap = await this.coordinatorSays(task, 'Coordinator', {
          system: ROOM_COORDINATOR_SYSTEM,
          message: buildRoomWrapUpMessage({ exchange }),
        });
        if (wrap.ok && !this.stopped(taskId)) {
          this.pushMessage(task, { kind: 'coordinator' }, wrap.text.trim(), { exchange: args.exchange, wrapUp: true });
        }
      }
    } catch (err) {
      this.pushMessage(task, { kind: 'coordinator' }, `The room hit an error: ${String(err)}`, {
        exchange: args.exchange,
        failed: true,
      });
    } finally {
      this.turning.delete(key);
      this.roomTurnKey.delete(taskId);
      this.roomStopped.delete(taskId);
      if (task.room) task.room.busy = null;
      this.fileConversation(task);
      this.persist(task);
    }
  }

  private proposeWork(task: TeamTask, exchange: number, work: { title: string; assign: Array<{ workerId: string; name: string; ask: string }> }): void {
    // A newer proposal replaces one you never acted on.
    for (const m of task.room?.messages ?? []) {
      if (m.handoff?.status === 'proposed') m.handoff.status = 'dismissed';
    }
    const who = work.assign.map((a) => a.name);
    const handoff: TeamHandoff = {
      title: work.title,
      status: 'proposed',
      assignments: work.assign.map((a) => ({ workerId: a.workerId, workerName: a.name, ask: a.ask })),
    };
    this.pushMessage(
      task,
      { kind: 'coordinator' },
      `That's work, not a question. ${joinNames(who)} can do it as a real run, with their tools and the shared folder; what they make lands back in the folder and they'll report here.`,
      { exchange, handoff },
    );
  }

  /// A member's report on work handed off from the room, posted where it
  /// was asked for.
  private reportRoomWork(task: TeamTask, stage: TeamStage): void {
    if (!stage.fromRoom) return;
    const index = task.stages.indexOf(stage);
    for (const a of stage.assignments) {
      const speaker: TeamSpeaker = { kind: 'member', workerId: a.workerId, name: a.workerName };
      if (a.status !== 'done') {
        this.pushMessage(task, speaker, `Couldn't finish "${stage.title}": ${a.error ?? 'the run failed.'}`, {
          exchange: stage.fromRoom.exchange,
          failed: true,
        });
        continue;
      }
      const piece = a.file ? (this.store.readFile(task.id, a.file) ?? '') : '';
      const report = piece
        .replace(/^# .*\n+/, '')
        .split(/\n---\n|\n## Files it made\n/)[0]
        .trim();
      const dir = `files/${slugify(a.workerName, 20)}/`;
      const since = stage.startedAt ?? 0;
      const made = task.files.filter((f) => f.name.startsWith(dir) && f.at >= since).map((f) => f.name);
      const parts = [clip(report || `Finished "${stage.title}".`, 2_500)];
      if (made.length > 0) parts.push('', '**Files I made or changed:**', ...made.map((n) => `- \`${n}\``));
      if (a.file) parts.push('', `Full report: \`${a.file}\``);
      task.room = task.room ?? { messages: [] };
      task.room.messages.push({
        id: this.newId(),
        speaker,
        text: parts.join('\n'),
        at: this.now(),
        exchange: stage.fromRoom.exchange,
        workReport: { stage: index },
      });
    }
    this.fileConversation(task);
  }

  private async rewritePack(taskId: UUID, fresh: TeamMessage[]): Promise<void> {
    const key = `room:${taskId}`;
    const task = this.tasks.get(taskId);
    if (!task?.pack || this.turning.has(key)) return;
    this.turning.add(key);
    try {
      const res = await this.coordinatorSays(task, 'Coordinator', {
        system: TEAM_COORDINATOR_SYSTEM_PROMPT,
        message: buildPackUpdateMessage({
          teamName: task.teamName,
          taskTitle: task.title ?? task.brief,
          brief: task.brief,
          pack: this.packFiles(task),
          conversation: fresh,
          newWork: this.roomWorkSincePack(task),
          version: (task.pack.version ?? 1) + 1,
        }),
      });
      if (this.stopped(taskId)) return;
      const exchange = task.room?.messages.at(-1)?.exchange ?? 0;
      if (!res.ok) {
        this.pushMessage(task, { kind: 'coordinator' }, `Could not update the pack: ${res.error}`, { exchange, failed: true });
        return;
      }
      const pack = parsePackReply(res.text);
      const version = (task.pack.version ?? 1) + 1;
      // Keep the version being replaced, beside the pack, so nothing the
      // conversation changed is lost.
      for (const name of task.pack.files) {
        const body = this.store.readFile(taskId, name);
        if (body === null) continue;
        const kept = name.replace(/^pack\//, `pack-v${version - 1}/`);
        this.store.writeFile(taskId, kept, body);
        const was = task.files.find((f) => f.name === name);
        this.recordFile(task, { name: kept, author: 'Coordinator', at: was?.at ?? task.pack.updatedAt ?? this.now() });
      }
      const at = this.now();
      const names: string[] = [];
      for (const f of pack.files) {
        const name = `pack/${safeTeamFileName(f.name)}`;
        this.store.writeFile(taskId, name, f.body);
        this.recordFile(task, { name, author: 'Coordinator', at });
        names.push(name);
      }
      task.pack = { summary: pack.summary, files: names, version, updatedAt: at };
      if (task.room) task.room.foldedThrough = task.room.messages.length + 1;
      this.pushMessage(task, { kind: 'coordinator' }, `Updated the pack (version ${version}). ${pack.summary}`, { exchange });
      // A changed pack is a pack to read again.
      if (task.status === 'done') task.status = 'review';
    } catch (err) {
      this.pushMessage(task, { kind: 'coordinator' }, `Could not update the pack: ${String(err)}`, {
        exchange: task.room?.messages.at(-1)?.exchange ?? 0,
        failed: true,
      });
    } finally {
      this.turning.delete(key);
      this.roomTurnKey.delete(taskId);
      this.roomStopped.delete(taskId);
      if (task.room) task.room.busy = null;
      this.fileConversation(task);
      this.persist(task);
    }
  }

  private async coordinatorSays(
    task: TeamTask,
    label: string,
    args: { system: string; message: string; attachments?: Attachment[] },
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const cancelKey = `team:${task.id}:room:${this.newId()}`;
    this.setSpeaking(task, label, cancelKey);
    return this.deps.coordinatorTurn({ ...args, cancelKey, onProgress: this.progressFor(task.id, 'room') });
  }

  private async memberSays(
    task: TeamTask,
    worker: Worker,
    prompt: string,
    attachments: Attachment[] = [],
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const cancelKey = `team:${task.id}:room:${this.newId()}`;
    this.setSpeaking(task, worker.name, cancelKey);
    return this.deps.memberTurn({
      worker,
      prompt,
      cancelKey,
      onProgress: this.progressFor(task.id, 'room'),
      ...(attachments.length ? { attachments } : {}),
    });
  }

  private setSpeaking(task: TeamTask, speaker: string, cancelKey: string): void {
    task.room = task.room ?? { messages: [] };
    task.room.busy = { speaker, since: this.now() };
    this.roomTurnKey.set(task.id, cancelKey);
    this.deps.emit({ type: 'teamTaskProgress', taskId: task.id, stage: 'room', tail: '', chars: 0 });
    this.persist(task);
  }

  private stopped(taskId: UUID): boolean {
    return this.roomStopped.has(taskId) || !this.tasks.has(taskId);
  }

  private pushMessage(
    task: TeamTask,
    speaker: TeamSpeaker,
    text: string,
    opts: { exchange?: number; wrapUp?: boolean; failed?: boolean; attachments?: string[]; handoff?: TeamHandoff } = {},
  ): void {
    task.room = task.room ?? { messages: [] };
    task.room.messages.push({
      id: this.newId(),
      speaker,
      text,
      at: this.now(),
      exchange: opts.exchange ?? task.room.messages.at(-1)?.exchange ?? 0,
      ...(opts.wrapUp ? { wrapUp: true } : {}),
      ...(opts.failed ? { failed: true } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts.handoff ? { handoff: opts.handoff } : {}),
    });
  }

  /// Save what you attached into the shared folder, under `attachments/`, so
  /// it outlives the message and later stages can read it. Returns the
  /// task-folder names.
  private saveAttachments(task: TeamTask, attachments: Attachment[]): string[] {
    const names: string[] = [];
    const at = this.now();
    for (const a of attachments) {
      const base = safeTeamFileName(a.label?.trim() || `attachment${extensionFor(a.mimeType)}`);
      let name = `attachments/${base}`;
      for (let n = 2; task.files.some((f) => f.name === name) || names.includes(name); n++) {
        name = `attachments/${base.replace(/(\.[^.]+)?$/, (ext) => `-${n}${ext}`)}`;
      }
      try {
        this.store.writeBytes(task.id, name, Buffer.from(a.dataBase64, 'base64'));
        this.recordFile(task, { name, author: 'You', at });
        names.push(name);
      } catch (err) {
        log('warn', 'teams', `Could not save attachment ${base} for ${task.id}`, err);
      }
    }
    return names;
  }

  /// Rebuild attachments from the shared folder — after a restart, a re-plan
  /// or "keep debating", the files are what remains of them.
  private loadAttachments(task: TeamTask, names: string[] | undefined): Attachment[] {
    const out: Attachment[] = [];
    for (const name of names ?? []) {
      const bytes = this.store.readBytes(task.id, name);
      if (!bytes) continue;
      const label = name.split('/').pop() ?? name;
      out.push({ id: name, label, mimeType: mimeFor(label), dataBase64: bytes.toString('base64'), size: bytes.length });
    }
    return out;
  }

  private ownPieces(task: TeamTask, name: string): FolderFile[] {
    return task.files
      .filter((f) => f.author === name && !f.name.startsWith('pack') && !f.name.startsWith('files/'))
      .map((f) => ({ name: f.name, author: f.author, body: this.store.readFile(task.id, f.name) ?? '' }));
  }

  /// Reports from work handed off since the pack was last written.
  private roomWorkSincePack(task: TeamTask): FolderFile[] {
    const since = task.pack?.updatedAt ?? 0;
    return task.stages
      .filter((s) => s.fromRoom && (s.finishedAt ?? 0) > since)
      .flatMap((s) => s.assignments)
      .filter((a): a is TeamAssignment & { file: string } => a.status === 'done' && !!a.file)
      .map((a) => ({ name: a.file, author: a.workerName, body: this.store.readFile(task.id, a.file) ?? '' }));
  }

  private packFiles(task: TeamTask): FolderFile[] {
    return (task.pack?.files ?? []).map((name) => ({
      name,
      author: 'Coordinator',
      body: this.store.readFile(task.id, name) ?? '',
    }));
  }

  private fileConversation(task: TeamTask): void {
    if (!task.room?.messages.length) return;
    try {
      this.store.writeFile(task.id, 'conversation.md', conversationMarkdown(task.title ?? task.brief, task.room.messages));
      this.recordFile(task, { name: 'conversation.md', author: 'You and the team', at: this.now() });
    } catch (err) {
      log('warn', 'teams', `Could not file the conversation for ${task.id}`, err);
    }
  }

  private spent(task: TeamTask): number {
    const runIds = task.stages.flatMap((s) => s.assignments.map((a) => a.runId)).filter((id): id is UUID => !!id);
    return Math.round(this.deps.spendForRuns(runIds) * 100) / 100;
  }

  private persist(task: TeamTask): void {
    task.updatedAt = this.now();
    this.store.saveTask(task);
    this.deps.emit({ type: 'teamTaskUpdate', task: structuredClone(task) });
  }
}

/// Attachments readable as text; anything else is named, not pasted.
const TEXT_ATTACHMENT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|html?|xml)$/i;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
};

function mimeFor(name: string): string {
  return MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function extensionFor(mimeType: string): string {
  const hit = Object.entries(MIME_BY_EXT).find(([, m]) => m === mimeType);
  return hit ? `.${hit[0]}` : '';
}

interface CopiedFile {
  /// Where it sat in the run's folder (`designs/00-index.html`).
  rel: string;
  /// Where it now sits in the task folder (`files/lena/designs/00-index.html`).
  shared: string;
  sourcePath: string;
}

/// Kinds of file read into a piece as text; anything else is linked.
const INLINE_FILE = /\.(md|markdown|txt)$/i;

/// A finished run's deliverables as one document: the answer (the run's last
/// STEP output) first, then earlier steps, then the notes it wrote, then the
/// files it made — linked, not pasted, so a page of HTML is a page you open.
function pieceText(
  artifacts: Array<{ name: string; body?: string; sourcePath?: string }>,
  copied: CopiedFile[],
): string {
  const steps = artifacts.filter((a) => !a.sourcePath && a.body?.trim());
  const notes = artifacts
    .filter((a) => a.sourcePath && INLINE_FILE.test(a.name))
    .map((a) => ({ name: a.name, text: readText(a.sourcePath) }))
    .filter((n) => n.text?.trim());
  const parts: string[] = [];
  if (steps.length > 0) {
    parts.push(clip(steps[steps.length - 1].body!, PIECE_MAX_CHARS));
    const earlier = steps.slice(0, -1);
    if (earlier.length > 0) {
      parts.push('', '---', '', '## Supporting material');
      for (const s of earlier) parts.push('', `### ${s.name}`, '', clip(s.body!, SUPPORTING_MAX_CHARS));
    }
  }
  if (notes.length > 0) {
    parts.push('', '## Notes it wrote');
    for (const n of notes) parts.push('', `### ${n.name}`, '', clip(n.text!, SUPPORTING_MAX_CHARS));
  }
  if (copied.length > 0) parts.push('', filesSection(copied));
  return parts.join('\n').trim();
}

function filesSection(copied: CopiedFile[]): string {
  return ['## Files it made', '', 'In the shared folder:', '', ...copied.map((c) => `- \`${c.shared}\``)].join('\n');
}

function readText(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) return undefined;
  try {
    const buf = fs.readFileSync(sourcePath);
    if (buf.subarray(0, 8192).includes(0)) return undefined;
    return buf.toString('utf-8');
  } catch {
    return undefined;
  }
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function firstWords(text: string, max: number): string {
  const line = text.trim().split('\n')[0].replace(/@\S+\s*/g, '').trim();
  const t = line.charAt(0).toUpperCase() + line.slice(1);
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')}…` : t || 'Follow-up work';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[… cut; ${text.length - max} more characters]` : text;
}
