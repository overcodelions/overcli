// Processes on the org's server: defining them, taking items in, and moving
// each item along. See shared/org/process.ts for the model.
//
// A team stage briefs its team as the stage's owner, so the team's own
// questions, plan and pack review reach that owner the way they always do;
// when the team's task is done its pack becomes an artifact and the item
// moves on. A people stage DMs its deciders and waits. Nothing here talks to
// Slack or the teams directly: the host hands both in.

import { randomUUID } from 'node:crypto';
import type { OrgCaller } from '../../shared/org/policy';
import {
  sendBackIndex,
  accessOf,
  type ProcessAudience,
  answersText,
  checkAnswers,
  parseProcessAccess,
  stageBrief,
  validateProcess,
  type ProcessArtifact,
  type ProcessDef,
  type ProcessEventKind,
  type ProcessItem,
  type ProcessPerson,
  type ProcessSchedule,
  type ProcessStage,
  type ProcessState,
} from '../../shared/org/process';
import { nextOccurrenceAfter, type ScheduleTrigger } from '../../shared/flows/schedule';
import { scheduleText } from './orgService';
import { checkShortName, normalizeShortName, resolveShortNames } from '../../shared/shortName';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// A team's task as a process reads it.
export interface ProcessTaskLook {
  status: 'planning' | 'questions' | 'proposed' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled' | 'queued';
  title?: string;
  pack?: { summary: string; files: string[] };
  /// The task's code branch, when it changed code.
  branch?: string;
  error?: string;
  waiting?: string;
}

export interface ProcessDeps {
  store: { load(): ProcessState; save(state: ProcessState): void };
  /// The teams a process may use, with who leads each (its members' manager).
  teams(): Array<{ id: string; name: string; owner?: ProcessPerson }>;
  task(taskId: string): ProcessTaskLook | null;
  /// Give a team the stage's work, asked by the stage's owner.
  brief(teamId: string, text: string, requestedBy: ProcessPerson, code?: { projectPath: string; startFrom?: string }): Result<{ taskId: string }>;
  /// The workers a stage may use, with who manages each. Absent: no worker stages.
  workers?(): Array<{ id: string; name: string; owner?: ProcessPerson }>;
  /// How far someone reaches a worker: they manage it (or are an admin), may
  /// see it, or neither. Absent: everyone sees every worker and manages none.
  workerAccess?(caller: OrgCaller, workerId: string): 'manage' | 'see' | null;
  /// Ask one worker for the stage's work. `trusted`: as from its manager,
  /// who put it in the process; otherwise the worker treats it as a proposal.
  askWorker?(workerId: string, text: string, requestedBy: ProcessPerson, trusted: boolean): Result<{ askId: string }>;
  /// A worker stage's ask, read as a task: done once it answered and any work it started ended.
  workerTask?(askId: string): ProcessTaskLook | null;
  /// A pack file's text, to hand to the next stage. Absent: summaries only.
  readFile?(taskId: string, name: string): string | null;
  cancelTask?(taskId: string): void;
  /// Stop a worker stage's ask and the work it started.
  cancelAsk?(askId: string): void;
  isAdmin(caller: OrgCaller): boolean;
  /// The people in a group of deciders, now. Absent: groups decide nothing.
  groupMembers?(groupId: string): ProcessPerson[];
  /// Whether this person has any of these roles (ProcessAccess.roles).
  hasRole?(person: { name: string; slackUserId?: string }, roles: string[]): boolean;
  /// A message to one person. `decide`: offer Approve / Send back / Stop,
  /// or the stage's form to fill in when it asks for something.
  notify?(to: ProcessPerson, text: string, decide?: { itemId: string; stageId: string }): void;
  /// A decision was made (or a vote cast): the decision messages sent for it
  /// can say so and drop their buttons once `final`.
  decided?(itemId: string, stageId: string, text: string, final: boolean): void;
  log(message: string): void;
  now?(): number;
}

export type ItemAction = 'approve' | 'sendBack' | 'stop' | 'retry' | 'move' | 'note' | 'startNow';

export interface ProcessItemView extends ProcessItem {
  stageName: string;
  /// The caller may approve, send back or stop it here.
  canDecide: boolean;
  /// The caller owns the process (or is an admin): stop, move, retry.
  canSteer: boolean;
  /// It waits on the caller: a decision here, or their team's or worker's
  /// questions, plan, pack or paused run.
  yourTurn: boolean;
  /// Who it waits on, when it waits on someone: "Pat", "Sam or Eng leads".
  waitsOn?: string;
}

const MAX_ITEMS = 2000;
const DAY_MS = 24 * 3_600_000;
const POLL_MS = 20_000;

/// The same person: by Slack id whenever either side has one, so a display
/// name never stands in for someone Slack knows. Names match only between
/// two people Slack doesn't know (a service token, the desktop's "You").
function samePerson(a: ProcessPerson | undefined, b: { name: string; slackUserId?: string }): boolean {
  if (!a) return false;
  if (a.slackUserId || b.slackUserId) return !!a.slackUserId && a.slackUserId === b.slackUserId;
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/// A process as someone outside it sees it: what it's for and its stages by
/// name, enough to put an idea in. Not who leads, does or decides each
/// stage, anyone's Slack id, where its code lives, how work comes in or its
/// schedules.
function outline(def: ProcessDef): ProcessDef {
  const person = (p: ProcessPerson): ProcessPerson => ({ name: p.name });
  return {
    id: def.id,
    name: def.name,
    ...(def.shortName ? { shortName: def.shortName } : {}),
    ...(def.purpose ? { purpose: def.purpose } : {}),
    owner: person(def.owner),
    stages: def.stages.map((st) => ({
      id: st.id,
      name: st.name,
      kind: st.kind,
      ...(st.kind === 'people' ? { approvers: [] } : {}),
      ...(st.needs !== undefined ? { needs: st.needs } : {}),
      ...(st.mode ? { mode: st.mode } : {}),
      ...(st.why ? { why: st.why } : {}),
      ...(st.delayDays ? { delayDays: st.delayDays } : {}),
      ...(st.repeat ? { repeat: st.repeat } : {}),
    })),
    createdBy: def.createdBy,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
    ...(def.archived ? { archived: def.archived } : {}),
  };
}

export class ProcessService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /// The store as last read or written. The poll, the board and Slack all
  /// read it often, and only this service writes it.
  private cached: ProcessState | null = null;

  constructor(private readonly deps: ProcessDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /// The state to read. Not to be changed: `load` for that.
  private peek(): ProcessState {
    if (!this.cached) {
      const s = this.deps.store.load();
      this.cached = { processes: s.processes ?? [], items: s.items ?? [] };
    }
    return this.cached;
  }

  /// A copy of the state to change and `put` back.
  private load(): ProcessState {
    return structuredClone(this.peek());
  }

  private put(state: ProcessState): void {
    // Finished items beyond the cap go first, oldest first; live ones never.
    if (state.items.length > MAX_ITEMS) {
      const over = state.items.length - MAX_ITEMS;
      const old = new Set(
        state.items
          .filter((i) => i.status !== 'active')
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, over)
          .map((i) => i.id),
      );
      state.items = state.items.filter((i) => !old.has(i.id));
    }
    this.deps.store.save(state);
    this.cached = structuredClone(state);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- WHO ----------------------------------------------------------------

  private steers(caller: OrgCaller, def: ProcessDef): boolean {
    return this.deps.isAdmin(caller) || samePerson(def.owner, caller);
  }

  /// Whether the caller sees everything that goes through a process: they
  /// steer it, own one of its team or worker stages, or decide at one of its
  /// people stages. Anyone else sees only the items they put in.
  private seesAll(caller: OrgCaller, def: ProcessDef): boolean {
    if (this.steers(caller, def)) return true;
    return def.stages.some((st) => (st.kind === 'people' ? this.deciders(st).some((p) => samePerson(p, caller)) : samePerson(this.stageOwner(def, st), caller)));
  }

  /// Whether the caller is in the process's audience (ProcessAccess).
  private inAudience(caller: { name: string; slackUserId?: string }, def: ProcessDef): boolean {
    const access = accessOf(def);
    if (access.who === 'everyone') return true;
    if (access.who === 'private') return false;
    // Groups are read now, so someone who joins or leaves a team gains or
    // loses the process with it.
    return (
      (access.people ?? []).some((p) => samePerson(p, caller)) ||
      (access.groups ?? []).some((g) => (this.deps.groupMembers?.(g.id) ?? []).some((p) => samePerson(p, caller))) ||
      (!!access.roles?.length && !!this.deps.hasRole?.(caller, access.roles))
    );
  }

  /// Whether the caller made the process. One made before creators were kept
  /// matches by name only for callers with no Slack id, as samePerson does.
  private made(caller: { name: string; slackUserId?: string }, def: ProcessDef): boolean {
    return samePerson(def.creator ?? { name: def.createdBy }, caller);
  }

  /// Whether the caller sees the process at all: those in it, whoever made
  /// it, and its audience.
  private seesProcess(caller: OrgCaller, def: ProcessDef): boolean {
    return this.seesAll(caller, def) || this.made(caller, def) || this.inAudience(caller, def);
  }

  /// Whether the caller may put work in: its owner, whoever made it, admins
  /// and its audience.
  private mayStart(caller: OrgCaller, def: ProcessDef): boolean {
    return this.steers(caller, def) || this.made(caller, def) || this.inAudience(caller, def);
  }

  private seesItem(caller: OrgCaller, def: ProcessDef, item: ProcessItem, all = this.seesAll(caller, def)): boolean {
    return all || samePerson(item.initiator, caller);
  }

  /// A process as this caller may see it: whole to its owner and admins;
  /// without the code's path to the others in it; as an outline to everyone
  /// else.
  private shownTo(caller: OrgCaller, def: ProcessDef, all = this.seesAll(caller, def), shortNames = this.shortNames()): ProcessDef {
    const short = shortNames.get(def.id);
    const named = short ? { ...def, shortName: short, ...(def.shortName ? {} : { shortNameAuto: true }) } : def;
    if (!all) return outline(named);
    if (this.steers(caller, def) || !def.codeIn) return named;
    return { ...named, codeIn: { name: def.codeIn.name, path: '' } };
  }

  /// Every live process's short name: its own, or its initials while free.
  private shortNames(): Map<string, string> {
    return resolveShortNames(this.peek().processes.filter((p) => !p.archived).sort((a, b) => a.createdAt - b.createdAt));
  }

  private stageOwner(def: ProcessDef, stage: ProcessStage): ProcessPerson {
    if (stage.owner?.name) return stage.owner;
    if (stage.kind === 'worker') return this.deps.workers?.().find((w) => w.id === stage.workerId)?.owner ?? def.owner;
    const team = stage.teamId ? this.deps.teams().find((t) => t.id === stage.teamId) : undefined;
    return team?.owner ?? def.owner;
  }

  private decides(caller: OrgCaller, def: ProcessDef, item: ProcessItem): boolean {
    if (item.status !== 'active') return false;
    const stage = def.stages[item.stageIndex];
    if (stage?.kind !== 'people') return false;
    return this.steers(caller, def) || this.deciders(stage).some((p) => samePerson(p, caller));
  }

  /// Whether this caller has already approved at the current stage.
  private voted(caller: OrgCaller, item: ProcessItem): boolean {
    return (item.votes ?? []).some((v) =>
      samePerson(
        {
          name: v.by,
          ...(v.slackUserId ? { slackUserId: v.slackUserId } : {}),
        },
        caller,
      ),
    );
  }

  /// Everyone who decides at a people stage: its people, and its groups' members now.
  private deciders(stage: ProcessStage): ProcessPerson[] {
    const out: ProcessPerson[] = [];
    const add = (p: ProcessPerson) => {
      if (!out.some((x) => samePerson(x, p))) out.push(p);
    };
    (stage.approvers ?? []).forEach(add);
    for (const g of stage.approverGroups ?? []) (this.deps.groupMembers?.(g.id) ?? []).forEach(add);
    return out;
  }

  /// How many approvals a people stage needs, with who decides now.
  private needed(stage: ProcessStage): number {
    const n = this.deciders(stage).length || 1;
    if (stage.needs === 'all') return n;
    if (typeof stage.needs === 'number') return Math.max(1, Math.min(stage.needs, n));
    return 1;
  }

  /// "2 of 3 approved", for the board and the messages.
  private tally(stage: ProcessStage, item: ProcessItem): string {
    return `${item.votes?.length ?? 0} of ${this.needed(stage)} ${stage.mode === 'input' ? 'filled in' : 'approved'}`;
  }

  /// Who decides at a stage, as said to people: "Sam or Product leads".
  /// Unnamed to someone who sees the process only as an outline: its
  /// approvers are left out of that, and so out of what it says to them.
  private decidersText(stage: ProcessStage, named = true): string {
    if (!named) return stage.mode === 'input' ? 'the people who fill it in' : 'its approvers';
    return [...(stage.approvers ?? []).map((p) => p.name), ...(stage.approverGroups ?? []).map((g) => g.name)].join(' or ') || 'nobody yet';
  }

  /// Whether the caller owns this process or is an admin.
  canSteer(caller: OrgCaller, id: string): boolean {
    const def = this.peek().processes.find((p) => p.id === id && !p.archived);
    return !!def && this.steers(caller, def);
  }

  // ---- PROCESSES --------------------------------------------------------

  list(caller: OrgCaller): Array<ProcessDef & { active: number; byStage: number[]; canSteer: boolean; canStart: boolean; whoStarts: { who: ProcessAudience; groups: string[] } }> {
    const s = this.peek();
    // Once per listing, not once per row: the map sorts every process.
    const shortNames = this.shortNames();
    return s.processes
      .filter((p) => !p.archived && this.seesProcess(caller, p))
      .map((p) => {
        const live = s.items.filter((i) => i.processId === p.id && i.status === 'active');
        return {
          ...this.shownTo(caller, p, undefined, shortNames),
          active: live.length,
          byStage: p.stages.map((_, n) => live.filter((i) => i.stageIndex === n).length),
          canSteer: this.steers(caller, p),
          canStart: this.mayStart(caller, p),
          // Who may put work in, for its card: the kind and the teams, never
          // the people named, which the outline keeps from most callers.
          whoStarts: { who: accessOf(p).who, groups: (accessOf(p).groups ?? []).map((g) => g.name) },
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(
    caller: OrgCaller,
    id: string,
  ): Result<{
    process: ProcessDef & { canSteer: boolean; canStart: boolean };
    items: ProcessItemView[];
    teams: Array<{ id: string; name: string }>;
    workers: Array<{ id: string; name: string }>;
  }> {
    const s = this.peek();
    const def = s.processes.find((p) => p.id === id && !p.archived);
    // A process the caller can't see is one that isn't there. Someone who put
    // an item in before it was narrowed still reaches it through that item.
    if (!def || (!this.seesProcess(caller, def) && !s.items.some((i) => i.processId === id && samePerson(i.initiator, caller)))) return { ok: false, error: 'No such process.' };
    const all = this.seesAll(caller, def);
    const items = s.items
      .filter((i) => i.processId === id && this.seesItem(caller, def, i, all))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 300)
      .map((i) => this.view(caller, def, i));
    // The workers the caller could pick, and those its stages already use.
    const used = new Set(def.stages.map((st) => st.workerId).filter(Boolean));
    return {
      ok: true,
      process: { ...this.shownTo(caller, def, all), canSteer: this.steers(caller, def), canStart: this.mayStart(caller, def) },
      items,
      teams: all ? this.deps.teams().map((t) => ({ id: t.id, name: t.name })) : [],
      workers: (all ? (this.deps.workers?.() ?? []) : [])
        .filter((w) => used.has(w.id) || (this.deps.workerAccess?.(caller, w.id) ?? 'see'))
        .map((w) => ({
          id: w.id,
          name: w.name,
        })),
    };
  }

  private view(caller: OrgCaller, def: ProcessDef, item: ProcessItem): ProcessItemView {
    const canDecide = this.decides(caller, def, item) && !this.voted(caller, item);
    const owner = this.turnOwner(def, item);
    const stage = def.stages[item.stageIndex];
    const waitsOn = owner?.name ?? (item.status === 'active' && stage?.kind === 'people' ? this.decidersText(stage, this.seesAll(caller, def)) : undefined);
    return {
      ...item,
      stageName: item.status === 'done' ? 'Done' : item.status === 'stopped' ? 'Stopped' : (def.stages[item.stageIndex]?.name ?? ''),
      canDecide,
      canSteer: this.steers(caller, def),
      yourTurn: canDecide || (!!owner && samePerson(owner, caller)),
      ...(waitsOn ? { waitsOn } : {}),
    };
  }

  /// Whose turn it is at the item's stage: the owner of a team or worker
  /// stage that stopped for them. People stages go by their deciders.
  private turnOwner(def: ProcessDef, item: ProcessItem): ProcessPerson | undefined {
    const stage = def.stages[item.stageIndex];
    if (item.status !== 'active' || !item.ownerTurn || !stage || stage.kind === 'people') return undefined;
    return this.stageOwner(def, stage);
  }

  /// A new process, or changes to one. Only its owner or an admin changes it.
  save(
    caller: OrgCaller,
    input: {
      id?: string;
      localId?: string;
      name: string;
      /// Absent: kept as it was; empty: cleared.
      shortName?: string;
      purpose?: string;
      about?: string;
      templateId?: string;
      codeIn?: { name: string; path: string } | null;
      owner?: ProcessPerson;
      stages: ProcessStage[];
      /// Absent: kept as it was; a new process is its owner's alone.
      access?: unknown;
    },
  ): Result<{ process: ProcessDef; updated: boolean }> {
    const s = this.load();
    const existing = input.id ? s.processes.find((p) => p.id === input.id && !p.archived) : input.localId ? s.processes.find((p) => p.localId === input.localId && !p.archived) : undefined;
    if (input.id && !existing) return { ok: false, error: 'No such process.' };
    if (existing && !this.steers(caller, existing))
      return {
        ok: false,
        error: `Only ${existing.owner.name}, who owns it, or an admin can change ${existing.name}.`,
      };
    const owner = input.owner?.name?.trim()
      ? input.owner
      : (existing?.owner ?? {
          name: caller.name,
          ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
        });
    // A process speaks for its owner (it tells them things, and its items
    // are theirs to steer), so only an admin gives one to someone else.
    if (!this.deps.isAdmin(caller) && !samePerson(owner, caller) && !(existing && samePerson(existing.owner, owner))) {
      return { ok: false, error: existing ? 'Only an admin can hand a process to someone else.' : 'A process you make is yours. An admin can hand it to someone else.' };
    }
    const stages: ProcessStage[] = (input.stages ?? []).map(({ trusted: _never, ...st }) => ({
      ...st,
      id: st.id?.trim() || randomUUID().slice(0, 8),
      name: (st.name ?? '').trim(),
      ...(st.ask ? { ask: st.ask.trim() } : {}),
    }));
    const refused = this.checkStages(caller, existing, owner, stages);
    if (refused) return { ok: false, error: refused };
    const access = input.access === undefined ? (existing ? existing.access : { who: 'private' as const }) : parseProcessAccess(input.access);
    if (typeof access === 'string') return { ok: false, error: access };
    const shortName = input.shortName === undefined ? existing?.shortName : normalizeShortName(input.shortName);
    if (shortName) {
      const bad = checkShortName(shortName);
      if (bad) return { ok: false, error: bad };
      // What each live process goes by today, its own or its initials: a
      // new name never takes over one people already type (`/idea dtpd …`).
      const resolved = this.shortNames();
      const taken = s.processes.find((p) => !p.archived && p.id !== existing?.id && (p.shortName === shortName || resolved.get(p.id) === shortName || p.name.trim().toLowerCase() === shortName));
      if (taken) return { ok: false, error: `${taken.name} already goes by "${shortName}". Pick another short name.` };
    }
    const def: ProcessDef = {
      id: existing?.id ?? randomUUID().slice(0, 12),
      name: input.name?.trim() ?? '',
      ...(shortName ? { shortName } : {}),
      ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
      ...(input.about?.trim() ? { about: input.about.trim() } : {}),
      ...(input.codeIn === undefined ? (existing?.codeIn ? { codeIn: existing.codeIn } : {}) : input.codeIn ? { codeIn: input.codeIn } : {}),
      ...((input.templateId ?? existing?.templateId) ? { templateId: input.templateId ?? existing?.templateId } : {}),
      owner,
      stages,
      createdBy: existing?.createdBy ?? caller.name,
      ...(existing ? (existing.creator ? { creator: existing.creator } : {}) : { creator: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) } }),
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
      ...(existing?.schedules?.length ? { schedules: existing.schedules } : {}),
      ...((input.localId ?? existing?.localId) ? { localId: input.localId ?? existing?.localId } : {}),
      ...(access ? { access } : {}),
    };
    const invalid = validateProcess(def, new Set(this.deps.teams().map((t) => t.id)), this.deps.workers ? new Set(this.deps.workers().map((w) => w.id)) : undefined);
    if (invalid) return { ok: false, error: invalid };
    // Items sitting on a stage that was removed go back to the stage now at
    // that place (or the last), so nothing is stranded.
    if (existing) {
      for (const item of s.items.filter((i) => i.processId === def.id && i.status === 'active')) {
        const old = existing.stages[item.stageIndex];
        const now = def.stages.findIndex((st) => st.id === old?.id);
        if (now >= 0) item.stageIndex = now;
        else {
          this.leave(old, item, 'Its stage was removed from the process.');
          item.stageIndex = Math.min(item.stageIndex, def.stages.length - 1);
          this.event(item, 'moved', {
            by: caller.name,
            note: 'Its stage was removed from the process.',
          });
          this.enter(def, item, item.stageIndex);
        }
      }
    }
    s.processes = [...s.processes.filter((p) => p.id !== def.id), def];
    this.put(s);
    return { ok: true, process: def, updated: !!existing };
  }

  /// What a caller may put in a process's stages, or why not. Stages kept
  /// as they were pass; a new or changed one is checked against the caller:
  ///   - a worker stage needs a worker they can see, and runs as from its
  ///     manager only when they are that manager (or an admin) — otherwise
  ///     the worker takes each item as a proposal;
  ///   - a stage's lead gets its team's questions and signs off its pack, so
  ///     only an admin, or the team's or worker's own manager, names someone
  ///     else to it.
  private checkStages(caller: OrgCaller, existing: ProcessDef | undefined, owner: ProcessPerson, stages: ProcessStage[]): string | null {
    const admin = this.deps.isAdmin(caller);
    for (const st of stages) {
      const was = existing?.stages.find((x) => x.id === st.id && x.kind === st.kind);
      const sameWorker = st.kind === 'worker' && was?.workerId === st.workerId;
      if (st.kind === 'worker' && st.workerId) {
        const reach = this.deps.workerAccess ? this.deps.workerAccess(caller, st.workerId) : 'see';
        if (!reach && !sameWorker) return `You can't use that worker in ${st.name || 'a stage'}: only people who can see it may.`;
        // Kept while the stage keeps its worker; its manager saving it vouches anew.
        if ((sameWorker && was?.trusted) || reach === 'manage') st.trusted = true;
      }
      if (!st.owner?.name || admin) continue;
      if (was?.owner && samePerson(was.owner, st.owner) && (st.kind !== 'worker' || sameWorker) && (st.kind !== 'team' || was.teamId === st.teamId)) continue;
      const lead = this.stageOwner({ owner } as ProcessDef, { ...st, owner: undefined });
      if (samePerson(lead, st.owner) || samePerson(lead, caller)) continue;
      return `Only an admin or ${lead.name}, who leads it, can make someone else lead ${st.name || 'a stage'}.`;
    }
    return null;
  }

  /// An item leaving a stage before it finished: its work stops, and the
  /// decision messages sent for it say so and drop their buttons.
  private leave(stage: ProcessStage | undefined, item: ProcessItem, why: string): void {
    if (!stage) return;
    if (item.taskId && stage.kind === 'team') this.deps.cancelTask?.(item.taskId);
    if (item.taskId && stage.kind === 'worker') this.deps.cancelAsk?.(item.taskId);
    if (stage.kind === 'people') this.deps.decided?.(item.id, stage.id, why, true);
  }

  archive(caller: OrgCaller, id: string): Result {
    const s = this.load();
    const def = s.processes.find((p) => p.id === id && !p.archived);
    if (!def) return { ok: false, error: 'No such process.' };
    if (!this.steers(caller, def))
      return {
        ok: false,
        error: `Only ${def.owner.name} or an admin can retire ${def.name}.`,
      };
    if (s.items.some((i) => i.processId === id && i.status === 'active'))
      return {
        ok: false,
        error: 'Finish or stop the items still in it first.',
      };
    def.archived = true;
    def.updatedAt = this.now();
    this.put(s);
    return { ok: true };
  }

  /// A recurring item for a process: on each occurrence, one goes in.
  addSchedule(caller: OrgCaller, id: string, input: { cadence: ScheduleTrigger; title: string; brief: string }): Result<{ schedule: ProcessSchedule; nextAt: number }> {
    const s = this.load();
    const def = s.processes.find((p) => p.id === id && !p.archived);
    if (!def) return { ok: false, error: 'No such process.' };
    if (!this.steers(caller, def))
      return {
        ok: false,
        error: `Only ${def.owner.name} or an admin can schedule ${def.name}.`,
      };
    const title = input.title?.trim() ?? '';
    if (!title)
      return {
        ok: false,
        error: 'Give each scheduled item a title, e.g. "Quarterly roadmap".',
      };
    if (!input.brief?.trim() || input.brief.trim().length < 3)
      return {
        ok: false,
        error: 'Say what each one is about: it is the first stage’s brief.',
      };
    const nextAt = nextOccurrenceAfter(input.cadence, this.now());
    if (!Number.isFinite(nextAt))
      return {
        ok: false,
        error: 'That schedule never comes round. Pick another.',
      };
    if ((def.schedules ?? []).length >= 10) return { ok: false, error: 'A process has at most 10 schedules.' };
    const schedule: ProcessSchedule = {
      id: randomUUID().slice(0, 8),
      cadence: input.cadence,
      title: clip(title, 100),
      brief: input.brief.trim(),
      enabled: true,
      createdAt: this.now(),
    };
    def.schedules = [...(def.schedules ?? []), schedule];
    def.updatedAt = this.now();
    this.put(s);
    return { ok: true, schedule, nextAt };
  }

  removeSchedule(caller: OrgCaller, id: string, scheduleId: string): Result {
    const s = this.load();
    const def = s.processes.find((p) => p.id === id && !p.archived);
    if (!def) return { ok: false, error: 'No such process.' };
    if (!this.steers(caller, def))
      return {
        ok: false,
        error: `Only ${def.owner.name} or an admin can change ${def.name}'s schedules.`,
      };
    const before = def.schedules?.length ?? 0;
    def.schedules = (def.schedules ?? []).filter((x) => x.id !== scheduleId);
    if (def.schedules.length === before) return { ok: false, error: 'No such schedule.' };
    this.put(s);
    return { ok: true };
  }

  /// When a schedule next puts an item in.
  nextAt(schedule: ProcessSchedule): number {
    return nextOccurrenceAfter(schedule.cadence, schedule.lastAt ?? schedule.createdAt);
  }

  /// Put in the items whose schedules have come round. One per schedule per
  /// pass, so a server that was down for a month doesn't flood the process.
  private runSchedules(): void {
    const now = this.now();
    if (!this.peek().processes.some((p) => !p.archived && (p.schedules ?? []).some((x) => x.enabled && this.nextAt(x) <= now))) return;
    const s = this.load();
    const due: Array<{ def: ProcessDef; sched: ProcessSchedule }> = [];
    for (const def of s.processes) {
      if (def.archived) continue;
      for (const sched of def.schedules ?? []) if (sched.enabled && this.nextAt(sched) <= this.now()) due.push({ def, sched });
    }
    if (!due.length) return;
    for (const { sched } of due) sched.lastAt = this.now();
    this.put(s);
    const day = new Date(this.now()).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    for (const { def, sched } of due) {
      const res = this.submit(def.owner, def.id, {
        title: `${sched.title} · ${day}`,
        brief: sched.brief,
        source: 'schedule',
      });
      if (!res.ok) this.deps.log(`processes: ${def.name}'s schedule "${sched.title}" couldn't start an item: ${res.error}`);
    }
  }

  /// The process a name or id means, for Slack and triggers.
  find(nameOrId: string): ProcessDef | undefined {
    const key = nameOrId.trim().toLowerCase();
    const live = this.peek().processes.filter((p) => !p.archived);
    const short = this.shortNames();
    return live.find((p) => p.id === nameOrId) ?? live.find((p) => p.name.toLowerCase() === key) ?? live.find((p) => short.get(p.id) === key);
  }

  // ---- ITEMS ------------------------------------------------------------

  /// Something new comes in: an idea, a request, a problem Verify found.
  submit(
    from: ProcessPerson,
    processId: string,
    input: {
      title?: string;
      brief: string;
      source: ProcessItem['source'];
      sourceUrl?: string;
      fromItemId?: string;
      /// The person putting it in is an admin.
      byAdmin?: boolean;
    },
  ): Result<{ item: ProcessItem; process: ProcessDef }> {
    const s = this.load();
    const def = s.processes.find((p) => p.id === processId && !p.archived);
    if (!def) return { ok: false, error: 'No such process.' };
    // People are held to its audience. A trigger or a schedule was set up by
    // someone who could already steer it, so it goes in as they would.
    const fromPerson = input.source !== 'trigger' && input.source !== 'schedule';
    if (fromPerson && !this.mayStart({ ...from, admin: !!input.byAdmin }, def)) {
      return this.seesProcess({ ...from, admin: false }, def)
        ? { ok: false, error: `Only some people can start ${def.name}. Ask ${def.owner.name}, who owns it.` }
        : { ok: false, error: 'No such process.' };
    }
    const brief = input.brief?.trim() ?? '';
    if (brief.length < 3) return { ok: false, error: 'Say what the idea or request is.' };
    const title = clip(input.title?.trim() || brief.split('\n')[0], 100);
    const item: ProcessItem = {
      id: randomUUID().slice(0, 12),
      processId,
      title,
      brief,
      initiator: from,
      ...(input.byAdmin ? { byAdmin: true } : {}),
      source: input.source,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.fromItemId ? { fromItemId: input.fromItemId } : {}),
      stageIndex: 0,
      status: 'active',
      artifacts: [],
      history: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.event(item, 'submitted', { by: from.name });
    s.items.push(item);
    this.enter(def, item, 0);
    this.put(s);
    this.tell(def.owner, `*${from.name}* put _${title}_ into *${def.name}*. It starts at ${def.stages[0].name}.`, from);
    return { ok: true, item, process: def };
  }

  item(id: string): ProcessItem | undefined {
    return this.peek().items.find((i) => i.id === id);
  }

  /// The people stage an item is at, when it is still at `stageId`: what a
  /// decision message's form asks for.
  stageOf(itemId: string, stageId: string): ProcessStage | undefined {
    const item = this.item(itemId);
    const stage = item && item.status === 'active' ? this.peek().processes.find((p) => p.id === item.processId)?.stages[item.stageIndex] : undefined;
    return stage?.kind === 'people' && stage.id === stageId ? stage : undefined;
  }

  /// One file a stage handed on, for anyone who can see the item: its
  /// people needn't be able to see the team that made it.
  artifactFile(caller: OrgCaller, itemId: string, taskId: string, name: string): Result<{ name: string; body: string }> {
    const item = this.item(itemId);
    const def = item && this.peek().processes.find((p) => p.id === item.processId);
    if (!item || !def || !this.seesItem(caller, def, item) || !item.artifacts.some((a) => a.taskId === taskId && a.files.includes(name))) return { ok: false, error: 'No such file on that item.' };
    const body = this.deps.readFile?.(taskId, name);
    return body == null ? { ok: false, error: 'That file isn’t available any more.' } : { ok: true, name, body: body.slice(0, 200_000) };
  }

  /// What's in flight across the processes this person can see: each live
  /// item, where it is, and whether it waits on them. For the Inbox.
  inFlight(caller: OrgCaller): Array<{
    processId: string;
    process: string;
    item: ProcessItemView;
    stages: number;
    stageKind: string;
    decide: boolean;
  }> {
    const s = this.peek();
    const out: Array<{
      processId: string;
      process: string;
      item: ProcessItemView;
      stages: number;
      stageKind: string;
      decide: boolean;
    }> = [];
    for (const def of s.processes) {
      if (def.archived) continue;
      const all = this.seesAll(caller, def);
      for (const item of s.items) {
        if (item.processId !== def.id || item.status !== 'active' || !this.seesItem(caller, def, item, all)) continue;
        const view = this.view(caller, def, item);
        out.push({
          processId: def.id,
          process: def.name,
          item: view,
          stages: def.stages.length,
          stageKind: def.stages[item.stageIndex]?.kind ?? 'team',
          decide: view.yourTurn,
        });
      }
    }
    return out.sort((a, b) => b.item.updatedAt - a.item.updatedAt).slice(0, 50);
  }

  /// Items waiting on this person's decision, for "how are we doing?"
  waitingOn(person: ProcessPerson): Array<{ title: string; process: string; stage: string }> {
    const s = this.peek();
    const out: Array<{ title: string; process: string; stage: string }> = [];
    for (const item of s.items) {
      if (item.status !== 'active') continue;
      const def = s.processes.find((p) => p.id === item.processId);
      const stage = def?.stages[item.stageIndex];
      const already = (item.votes ?? []).some((v) =>
        samePerson(
          {
            name: v.by,
            ...(v.slackUserId ? { slackUserId: v.slackUserId } : {}),
          },
          person,
        ),
      );
      if (def && stage?.kind === 'people' && !already && this.deciders(stage).some((a) => samePerson(a, person))) out.push({ title: item.title, process: def.name, stage: stage.name });
      else if (def && stage && samePerson(this.turnOwner(def, item), person)) out.push({ title: item.title, process: def.name, stage: stage.name });
    }
    return out;
  }

  /// The items someone started, newest first: "where's my idea?"
  mine(person: ProcessPerson): Array<{ item: ProcessItem; process: string; stage: string }> {
    const s = this.peek();
    const defs = new Map(s.processes.map((p) => [p.id, p]));
    return s.items
      .filter((i) => samePerson(i.initiator, person))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10)
      .map((i) => {
        const def = defs.get(i.processId);
        return {
          item: i,
          process: def?.name ?? 'a process',
          stage: i.status === 'done' ? 'done' : i.status === 'stopped' ? 'stopped' : (def?.stages[i.stageIndex]?.name ?? ''),
        };
      });
  }

  /// A decision at a people stage, or the owner steering an item.
  /// `stageId`: the stage a decision was asked at (a Slack button's). A
  /// decision for a stage the item has since left is refused.
  /// `answers`: what an approve fills in, by field id, when the stage asks for something.
  act(caller: OrgCaller, itemId: string, action: ItemAction, opts: { note?: string; stageIndex?: number; stageId?: string; answers?: unknown } = {}): Result<{ item: ProcessItem }> {
    const s = this.load();
    const item = s.items.find((i) => i.id === itemId);
    if (!item) return { ok: false, error: 'No such item.' };
    const def = s.processes.find((p) => p.id === item.processId);
    if (!def || !this.seesItem(caller, def, item)) return { ok: false, error: def ? 'No such item.' : 'Its process is gone.' };
    const note = opts.note?.trim();
    const stage = def.stages[item.stageIndex];
    if (opts.stageId !== undefined && (item.status !== 'active' || stage?.id !== opts.stageId)) {
      return { ok: false, error: item.status === 'active' ? `It has moved on since: it's at ${stage?.name ?? 'another stage'} now.` : `It's already ${item.status === 'done' ? 'done' : 'stopped'}.` };
    }
    if (action === 'note') {
      if (!note) return { ok: false, error: 'Write the note.' };
      this.event(item, 'note', { by: caller.name, note });
      this.put(s);
      return { ok: true, item };
    }
    if (item.status !== 'active')
      return {
        ok: false,
        error: `It's already ${item.status === 'done' ? 'done' : 'stopped'}.`,
      };
    const owner = stage ? this.stageOwner(def, stage) : def.owner;
    const steer = this.steers(caller, def);
    switch (action) {
      case 'approve': {
        if (!this.decides(caller, def, item))
          return {
            ok: false,
            error: stage?.kind === 'people' ? `Only ${this.decidersText(stage, this.seesAll(caller, def))} or ${def.owner.name} decide here.` : 'This stage moves on by itself when its work is done.',
          };
        const checked = checkAnswers(stage?.kind === 'people' ? stage.fields : undefined, opts.answers);
        if (typeof checked === 'string') return { ok: false, error: checked };
        const answers = Object.keys(checked).length ? checked : undefined;
        const need = this.needed(stage!);
        if (need > 1) {
          const votes = item.votes ?? [];
          if (
            votes.some((v) =>
              samePerson(
                {
                  name: v.by,
                  ...(v.slackUserId ? { slackUserId: v.slackUserId } : {}),
                },
                caller,
              ),
            )
          )
            return { ok: false, error: 'You already approved this.' };
          item.votes = [
            ...votes,
            {
              by: caller.name,
              ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
              at: this.now(),
              ...(note ? { note } : {}),
              ...(answers ? { answers } : {}),
            },
          ];
          this.event(item, 'approved', {
            by: caller.name,
            note: [`${item.votes.length} of ${need}`, note].filter(Boolean).join(': '),
          });
          if (item.votes.length < need) {
            item.stageNote = `${this.tally(stage!, item)}, waiting on ${need - item.votes.length} more`;
            this.deps.decided?.(item.id, stage!.id, `${caller.name} ${stage!.mode === 'input' ? 'filled it in' : 'approved'} (${this.tally(stage!, item)}).`, false);
            break;
          }
          this.deps.decided?.(item.id, stage!.id, `${this.doneWord(stage!)} by ${item.votes.map((v) => v.by).join(', ')}.`, true);
          this.handOn(stage!, item, item.votes);
        } else {
          this.event(item, 'approved', {
            by: caller.name,
            ...(note ? { note } : {}),
          });
          this.deps.decided?.(item.id, stage!.id, `${this.doneWord(stage!)} by ${caller.name}.`, true);
          this.handOn(stage!, item, [{ by: caller.name, ...(note ? { note } : {}), ...(answers ? { answers } : {}) }]);
        }
        this.advance(def, item);
        break;
      }
      case 'sendBack': {
        if (!this.decides(caller, def, item) && !steer)
          return {
            ok: false,
            error: `Only the people deciding here or ${def.owner.name} can send it back.`,
          };
        if (!note)
          return {
            ok: false,
            error: 'Say what needs to change, so the stage it goes back to knows.',
          };
        // Any earlier stage the person picked, else the stage's usual one.
        const picked = opts.stageIndex;
        const to = typeof picked === 'number' && Number.isInteger(picked) && picked >= 0 && picked < item.stageIndex ? picked : sendBackIndex(def, item.stageIndex);
        this.leave(stage, item, `Sent back by ${caller.name}: ${note}`);
        this.event(item, 'sentBack', {
          by: caller.name,
          note,
          stageId: def.stages[to].id,
        });
        item.feedback = { by: caller.name, note };
        this.enter(def, item, to);
        break;
      }
      case 'stop': {
        if (!steer && !this.decides(caller, def, item) && !samePerson(owner, caller))
          return {
            ok: false,
            error: `Only ${def.owner.name}, this stage’s owner or the people deciding here can stop it.`,
          };
        this.leave(stage, item, `Stopped by ${caller.name}.`);
        this.event(item, 'stopped', {
          by: caller.name,
          ...(note ? { note } : {}),
        });
        item.status = 'stopped';
        item.finishedAt = this.now();
        delete item.taskId;
        delete item.ownerTurn;
        delete item.stageNote;
        delete item.blocked;
        this.tell(item.initiator, `_${item.title}_ was stopped at ${stage?.name ?? 'its stage'} by ${caller.name}${note ? `: ${note}` : '.'}`, caller);
        break;
      }
      case 'retry': {
        if (!steer && !samePerson(owner, caller))
          return {
            ok: false,
            error: `Only ${def.owner.name} or this stage’s owner can start it again.`,
          };
        if (stage?.kind !== 'team' && stage?.kind !== 'worker')
          return {
            ok: false,
            error: 'Only a team or worker stage can be started again.',
          };
        this.leave(stage, item, 'Started again.');
        this.event(item, 'retried', {
          by: caller.name,
          ...(note ? { note } : {}),
        });
        if (note) item.feedback = { by: caller.name, note };
        this.enter(def, item, item.stageIndex);
        break;
      }
      case 'startNow': {
        if (!steer && !samePerson(owner, caller))
          return {
            ok: false,
            error: `Only ${def.owner.name} or this stage’s owner can start it early.`,
          };
        if (!item.startsAt) return { ok: false, error: 'It isn’t waiting.' };
        this.event(item, 'note', { by: caller.name, note: 'Started early.' });
        this.begin(def, item);
        break;
      }
      case 'move': {
        if (!steer)
          return {
            ok: false,
            error: `Only ${def.owner.name} or an admin can move it.`,
          };
        const to = opts.stageIndex ?? -1;
        if (!Number.isInteger(to) || to < 0 || to >= def.stages.length) return { ok: false, error: 'Pick a stage.' };
        this.leave(stage, item, `Moved to ${def.stages[to].name} by ${caller.name}.`);
        this.event(item, 'moved', {
          by: caller.name,
          stageId: def.stages[to].id,
          ...(note ? { note } : {}),
        });
        if (note) item.feedback = { by: caller.name, note };
        this.enter(def, item, to);
        break;
      }
    }
    this.put(s);
    return { ok: true, item };
  }

  // ---- MOVING -----------------------------------------------------------

  private doneWord(stage: ProcessStage): string {
    return stage.mode === 'input' ? 'Filled in' : 'Approved';
  }

  /// What people said as they approved or filled it in becomes the stage's
  /// artifact, so the stages after are briefed with it. Nothing said, nothing kept.
  private handOn(stage: ProcessStage, item: ProcessItem, entries: ReadonlyArray<{ by: string; note?: string; answers?: Record<string, string> }>): void {
    const summary = answersText(stage.fields, entries);
    item.artifacts = item.artifacts.filter((a) => a.stageId !== stage.id);
    if (!summary) return;
    item.artifacts.push({ stageId: stage.id, stageName: stage.name, at: this.now(), title: stage.mode === 'input' ? 'What people added' : 'What the deciders said', summary, files: [] });
  }

  private event(item: ProcessItem, kind: ProcessEventKind, extra: { by?: string; note?: string; stageId?: string } = {}): void {
    item.history.push({ at: this.now(), kind, ...extra });
    if (item.history.length > 200) item.history = item.history.slice(-200);
    item.updatedAt = this.now();
  }

  private tell(to: ProcessPerson | undefined, text: string, except?: { name: string; slackUserId?: string }): void {
    if (!to || (except && samePerson(to, except))) return;
    this.deps.notify?.(to, text);
  }

  /// Start a stage: brief its team, or ask its people.
  private enter(def: ProcessDef, item: ProcessItem, index: number, opts: { now?: boolean } = {}): void {
    const stage = def.stages[index];
    const again = item.stageIndex === index && item.status === 'active' && (item.runs ?? 0) > 0;
    item.stageIndex = index;
    delete item.taskId;
    delete item.ownerTurn;
    delete item.blocked;
    delete item.votes;
    delete item.startsAt;
    if (!again) delete item.runs;
    this.event(item, 'entered', { stageId: stage.id });
    // A stage that waits starts later, from the poll.
    if (!opts.now && stage.kind !== 'people' && stage.delayDays) {
      this.waitUntil(def, item, this.now() + stage.delayDays * DAY_MS, `Starts ${this.day(this.now() + stage.delayDays * DAY_MS)}`);
      return;
    }
    this.begin(def, item);
  }

  private day(at: number): string {
    return new Date(at).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  private waitUntil(def: ProcessDef, item: ProcessItem, at: number, note: string): void {
    item.startsAt = at;
    item.stageNote = note;
    const stage = def.stages[item.stageIndex];
    this.tell(item.initiator, `_${item.title}_ is at *${stage.name}* in ${def.name}. It ${note.charAt(0).toLowerCase()}${note.slice(1)}.`);
  }

  /// Start the current stage's work: brief its team, ask its worker, or ask its people.
  private begin(def: ProcessDef, item: ProcessItem): void {
    const stage = def.stages[item.stageIndex];
    const index = item.stageIndex;
    delete item.startsAt;
    if (stage.kind === 'worker') {
      const owner = this.stageOwner(def, stage);
      // As from its manager only when its manager put the stage in the
      // process and the item comes from them (or an admin). Anyone else's
      // item reaches the worker as a proposal from them.
      const trusted = stage.trusted === true && this.mayDirect(item, stage.workerId!);
      const res = this.deps.askWorker
        ? this.deps.askWorker(stage.workerId!, stageBrief(def, item, index, this.artifactFiles(item)), trusted ? owner : item.initiator, trusted)
        : { ok: false as const, error: 'Worker stages are not running here.' };
      if (!res.ok) {
        item.stageNote = 'Not started';
        this.block(def, item, `The worker couldn’t take it: ${res.error}`);
        return;
      }
      item.taskId = res.askId;
      item.stageNote = 'Working';
      delete item.feedback;
      const worker = this.deps.workers?.().find((w) => w.id === stage.workerId)?.name ?? 'A worker';
      this.tell(item.initiator, `_${item.title}_ is now at *${stage.name}* in ${def.name}. ${worker} is on it.`, owner);
      return;
    }
    if (stage.kind === 'team') {
      const owner = this.stageOwner(def, stage);
      const code = def.codeIn
        ? {
            projectPath: def.codeIn.path,
            ...(item.branch ? { startFrom: item.branch } : {}),
          }
        : undefined;
      const res = this.deps.brief(stage.teamId!, stageBrief(def, item, index, this.artifactFiles(item)), owner, code);
      if (!res.ok) {
        item.stageNote = 'Not started';
        this.block(def, item, `The team couldn’t take it: ${res.error}`);
        return;
      }
      item.taskId = res.taskId;
      item.stageNote = 'Planning';
      delete item.feedback;
      this.tell(item.initiator, `_${item.title}_ is now at *${stage.name}* in ${def.name}. ${owner.name} leads this stage.`, owner);
    } else {
      const who = this.deciders(stage);
      const need = this.needed(stage);
      const input = stage.mode === 'input';
      // Kept on the item, which everyone in it sees: who decides is said
      // per viewer, in `waitsOn`.
      item.stageNote = need > 1 ? `0 of ${need} ${input ? 'filled in' : 'approved'}` : input ? 'Waiting to be filled in' : 'Waiting for a decision';
      const earlier = item.artifacts.at(-1);
      const asks = (stage.fields ?? []).map((f) => `• ${f.label}${f.required ? '' : ' (optional)'}`).join('\n');
      const text = [
        `*${def.name}* · *${stage.name}*: ${input ? 'fill in' : 'decide on'} _${item.title}_ (from ${item.initiator.name}).${need > 1 ? ` It needs ${need} ${input ? 'of you to fill it in' : 'approvals'}; a send back or a stop from anyone acts at once.` : ''}`,
        stage.ask ? `> ${stage.ask}` : '',
        asks ? `${input ? 'It asks for' : 'With your decision, it asks for'}:\n${asks}` : '',
        earlier ? `*${earlier.stageName}* produced: ${clip(earlier.summary, 600)}` : `The request: ${clip(item.brief, 600)}`,
        item.feedback ? `Last time it was sent back: ${item.feedback.note}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      for (const p of who) this.deps.notify?.(p, text, { itemId: item.id, stageId: stage.id });
      const named = this.seesAll({ ...item.initiator, admin: false }, def);
      this.tell(item.initiator, `_${item.title}_ is now at *${stage.name}* in ${def.name}, waiting on ${this.decidersText(stage, named)} to decide.`);
    }
  }

  /// Whether whoever put an item in may direct this worker: its manager, or
  /// an admin.
  private mayDirect(item: ProcessItem, workerId: string): boolean {
    if (item.byAdmin) return true;
    const asker: OrgCaller = { name: item.initiator.name, ...(item.initiator.slackUserId ? { slackUserId: item.initiator.slackUserId } : {}), admin: false };
    return this.deps.workerAccess?.(asker, workerId) === 'manage';
  }

  /// Earlier stages' pack files, by `taskId/name`, for the next brief.
  private artifactFiles(item: ProcessItem): Record<string, string> {
    const files: Record<string, string> = {};
    if (!this.deps.readFile) return files;
    for (const a of item.artifacts) for (const f of a.files) if (a.taskId) files[`${a.taskId}/${f}`] = this.deps.readFile(a.taskId, f) ?? '';
    return files;
  }

  private advance(def: ProcessDef, item: ProcessItem): void {
    const next = item.stageIndex + 1;
    if (next >= def.stages.length) {
      item.status = 'done';
      item.finishedAt = this.now();
      delete item.taskId;
      delete item.ownerTurn;
      delete item.stageNote;
      this.event(item, 'done');
      this.tell(item.initiator, `_${item.title}_ made it through *${def.name}*.`);
      this.tell(def.owner, `_${item.title}_ finished *${def.name}*.`, item.initiator);
      return;
    }
    this.enter(def, item, next);
  }

  private block(def: ProcessDef, item: ProcessItem, why: string): void {
    if (item.blocked === why) return;
    item.blocked = why;
    this.event(item, 'blocked', {
      note: why,
      stageId: def.stages[item.stageIndex]?.id,
    });
    const stage = def.stages[item.stageIndex];
    const owner = stage ? this.stageOwner(def, stage) : def.owner;
    const text = `_${item.title}_ is stuck at *${stage?.name ?? 'its stage'}* in ${def.name}: ${why} Start the stage again, move it, or stop it on the process page.`;
    this.deps.notify?.(owner, text);
    if (!samePerson(def.owner, owner)) this.deps.notify?.(def.owner, text);
  }

  /// Follow each team stage's task: a signed-off pack moves the item on.
  poll(): void {
    this.runSchedules();
    // Most polls find nothing in flight: look before copying the state.
    if (!this.peek().items.some((i) => i.status === 'active' && (i.taskId || i.startsAt))) return;
    const s = this.load();
    let changed = false;
    for (const item of s.items) {
      if (item.status === 'active' && item.startsAt && item.startsAt <= this.now()) {
        const def = s.processes.find((p) => p.id === item.processId);
        if (def) {
          this.begin(def, item);
          changed = true;
        }
        continue;
      }
      if (item.status !== 'active' || !item.taskId) continue;
      const def = s.processes.find((p) => p.id === item.processId);
      const stage = def?.stages[item.stageIndex];
      if (!def || (stage?.kind !== 'team' && stage?.kind !== 'worker')) continue;
      const byWorker = stage.kind === 'worker';
      const task = byWorker ? (this.deps.workerTask?.(item.taskId) ?? null) : this.deps.task(item.taskId);
      if (!task) {
        this.block(def, item, byWorker ? 'Its ask to the worker is gone.' : 'Its team task is gone.');
        changed = true;
        continue;
      }
      const owner = this.stageOwner(def, stage).name;
      const note =
        task.status === 'planning'
          ? 'Planning'
          : task.status === 'queued'
            ? 'Next in line for the team'
            : task.status === 'questions'
              ? `Questions for ${owner}`
              : task.status === 'proposed'
                ? `Plan waiting on ${owner}`
                : task.status === 'running'
                  ? 'Working'
                  : task.status === 'waiting'
                    ? `Paused${task.waiting ? `: ${clip(task.waiting, 80)}` : ''}`
                    : task.status === 'review'
                      ? `Pack waiting on ${owner}’s sign-off`
                      : undefined;
      const turn: ProcessItem['ownerTurn'] = task.status === 'questions' ? 'questions' : task.status === 'proposed' ? 'plan' : task.status === 'review' ? 'pack' : task.status === 'waiting' ? 'paused' : undefined;
      if (task.status === 'done') {
        const artifact: ProcessArtifact = {
          stageId: stage.id,
          stageName: stage.name,
          at: this.now(),
          taskId: item.taskId,
          title: task.title ?? stage.name,
          summary: task.pack?.summary ?? 'The team finished without a pack.',
          files: byWorker ? [] : (task.pack?.files ?? []),
          ...(task.branch ? { branch: task.branch } : {}),
        };
        if (task.branch && def.codeIn) item.branch = task.branch;
        const runs = (item.runs ?? 0) + 1;
        if (stage.repeat) {
          // Each run is kept, so the next one and the stage after see them all.
          artifact.title = `${artifact.title} · run ${runs} of ${stage.repeat.times}`;
          item.artifacts = [...item.artifacts, artifact];
        } else item.artifacts = [...item.artifacts.filter((a) => a.stageId !== stage.id), artifact];
        this.event(item, 'finished', {
          stageId: stage.id,
          note: clip(artifact.summary, 300),
        });
        if (stage.repeat && runs < stage.repeat.times) {
          item.runs = runs;
          delete item.taskId;
          delete item.ownerTurn;
          const at = this.now() + stage.repeat.everyDays * DAY_MS;
          this.waitUntil(def, item, at, `Run ${runs + 1} of ${stage.repeat.times} starts ${this.day(at)}`);
        } else {
          delete item.runs;
          this.advance(def, item);
        }
        changed = true;
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        const whose = byWorker ? 'The worker’s' : 'The team’s';
        const why = task.status === 'failed' ? `${whose} work failed${task.error ? `: ${clip(task.error, 160)}` : '.'}` : `${whose} work was cancelled.`;
        if (item.blocked !== why) {
          this.block(def, item, why);
          item.stageNote = task.status === 'failed' ? 'Failed' : 'Cancelled';
          changed = true;
        }
      } else if (note && (note !== item.stageNote || turn !== item.ownerTurn)) {
        item.stageNote = note;
        if (turn) item.ownerTurn = turn;
        else delete item.ownerTurn;
        item.updatedAt = this.now();
        changed = true;
      }
    }
    if (changed) this.put(s);
  }
}

/// A process schedule in words: the monthly and quarterly crons said plainly.
export function processScheduleText(cadence: ScheduleTrigger): string {
  if (cadence.kind === 'cron') {
    const m = /^(\d{1,2}) (\d{1,2}) 1 (\*|1,4,7,10) \*$/.exec(cadence.expr.trim());
    if (m) {
      const at = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
      return m[3] === '*' ? `On the 1st of each month at ${at}` : `On the first day of each quarter at ${at}`;
    }
  }
  return scheduleText(cadence);
}
