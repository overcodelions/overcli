// A process: one piece of work moving through several teams and people's
// decisions, in order. "Demand → PRFAQ → Prototype → Validate → Develop →
// Test & deploy → Launch → Verify." A flow is one worker's steps and a team
// is several workers on one deliverable; a process sits above teams.
//
// Each stage is either a team, briefed with everything the stages before it
// produced, or people, who decide: approve, send it back, or stop it. People
// can be asked to fill something in as well (a budget, the target segment,
// what they think), or only that; what they put becomes the stage's
// artifact, so every stage after is briefed with it. The
// process has an owner; each stage has an owner (a team's leader, who
// answers its questions and signs off what leaves it); each item has the
// person who started it, told as it moves.

import type { ScheduleTrigger } from '../flows/schedule';

export interface ProcessPerson {
  name: string;
  slackUserId?: string;
}

export type ProcessStageKind = 'team' | 'worker' | 'people';

/// Who may see a process and put work into it, from Slack, the console or
/// the app. Its owner, whoever made it, admins and the people in its stages
/// always see it; only its owner, whoever made it, admins and its audience
/// start items in it.
///   private   no one else
///   team      the members of these teams (the org's people teams), and
///             anyone named beside them
///   people    these people, and the members of any group named
///   everyone  anyone in the org
export type ProcessAudience = 'private' | 'team' | 'people' | 'everyone';

export interface ProcessAccess {
  who: ProcessAudience;
  groups?: Array<{ id: string; name: string }>;
  people?: ProcessPerson[];
  /// Roles, for `people`: admins, hire approvers, people who can hire.
  roles?: Array<'admin' | 'approver' | 'hirer'>;
}

/// A process's access as stored; absent is everyone, as processes made
/// before access existed were.
export function accessOf(def: Pick<ProcessDef, 'access'>): ProcessAccess {
  return def.access ?? { who: 'everyone' };
}

/// An access setting from untrusted input, or a reason it isn't one.
export function parseProcessAccess(raw: unknown): ProcessAccess | string {
  const r = (raw ?? {}) as { who?: unknown; groups?: unknown; people?: unknown; roles?: unknown };
  const who = r.who;
  if (who !== 'private' && who !== 'team' && who !== 'people' && who !== 'everyone') return 'Say who can see and start it: only you, a team, certain people or everyone.';
  if (who === 'private' || who === 'everyone') return { who };
  const groups = (Array.isArray(r.groups) ? r.groups : [])
    .filter((g): g is { id: string; name: string } => !!g && typeof g.id === 'string' && typeof g.name === 'string' && !!g.id.trim())
    .slice(0, 50)
    .map((g) => ({ id: g.id.trim(), name: g.name.trim() }));
  const people = (Array.isArray(r.people) ? r.people : [])
    .filter((p): p is ProcessPerson => !!p && typeof p.name === 'string' && !!p.name.trim())
    .slice(0, 200)
    .map((p) => ({ name: p.name.trim(), ...(typeof p.slackUserId === 'string' && p.slackUserId ? { slackUserId: p.slackUserId } : {}) }));
  const roles = (Array.isArray(r.roles) ? r.roles : []).filter((x): x is 'admin' | 'approver' | 'hirer' => x === 'admin' || x === 'approver' || x === 'hirer');
  if (who === 'team' && !groups.length) return 'Pick the team that can see and start it.';
  if (who === 'people' && !groups.length && !people.length && !roles.length) return 'Pick the people who can see and start it.';
  return { who, ...(groups.length ? { groups } : {}), ...(people.length ? { people } : {}), ...(who === 'people' && roles.length ? { roles: [...new Set(roles)] } : {}) };
}

/// Something people fill in at a people stage.
export type ProcessFieldKind = 'text' | 'longText' | 'choice';

export interface ProcessField {
  id: string;
  label: string;
  kind: ProcessFieldKind;
  /// choice: what they pick from.
  options?: string[];
  required?: boolean;
}

/// What a people stage asks for: a decision (approve, send back or stop),
/// or input, where they fill in its fields and submit.
export type ProcessStageMode = 'decide' | 'input';

export interface ProcessStage {
  id: string;
  name: string;
  kind: ProcessStageKind;
  /// team: the team that does this stage's work.
  teamId?: string;
  /// worker: the one worker that does it, for a step that needs no team.
  workerId?: string;
  /// worker: set by the server, never by a form, when whoever put the
  /// worker in the stage manages it (or is an admin). The worker then takes
  /// the stage's work as from its manager; otherwise as a proposal.
  trusted?: boolean;
  /// Who owns the stage. A team stage's owner gets its questions, approves
  /// its plan and signs off its pack before it moves on. Absent: the team's
  /// manager, else the process owner.
  owner?: ProcessPerson;
  /// people: who decides. Any one of them may.
  approvers?: ProcessPerson[];
  /// people: groups whose members decide too, by id (`team:Product leads`,
  /// `admins`, `approvers`). Who is in them is read when the decision is asked.
  approverGroups?: Array<{ id: string; name: string }>;
  /// people: how many must approve before it moves on: any one (the
  /// default), all of them, or at least this many. A send back or a stop
  /// from any one of them acts at once.
  needs?: 'any' | 'all' | number;
  /// people: decide (the default) or input. Input needs fields.
  mode?: ProcessStageMode;
  /// people: what they fill in. Their answers are handed on.
  fields?: ProcessField[];
  /// What this stage is for, in the process owner's words: added to a
  /// team's brief, shown to people deciding.
  ask?: string;
  /// Where "send it back" goes, by stage id. Absent: the team stage before.
  sendBackTo?: string;
  /// Why the stage is there, as the process library puts it. Shown, not briefed.
  why?: string;
  /// team or worker: wait this many days after the stage before ends, so
  /// "check adoption" starts when there is adoption to check.
  delayDays?: number;
  /// team or worker: run it several times, this many days apart, each run
  /// building on the last, before the item moves on: "weekly for 4 weeks".
  repeat?: { everyDays: number; times: number };
}

export interface ProcessDef {
  id: string;
  name: string;
  /// What `/idea` takes in place of its name: "lrb". Lowercase, unique
  /// among processes.
  shortName?: string;
  /// Shown, never stored: `shortName` is its initials, not one someone set.
  shortNameAuto?: boolean;
  purpose?: string;
  /// When to use it and the practice behind it.
  about?: string;
  /// The library process it started from.
  templateId?: string;
  owner: ProcessPerson;
  stages: ProcessStage[];
  createdBy: string;
  /// Who made it: they always see it and can start it, whoever owns it now.
  creator?: ProcessPerson;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  /// Its id on the install it was published from, so publishing again updates it.
  localId?: string;
  /// Where its code lives: every team stage works there, and each starts
  /// from the branch the stage before it left, so a build, its tests and
  /// its release are the same change. Absent: each stage in its own place.
  codeIn?: { name: string; path: string };
  /// Items it starts by itself on a schedule: "every quarter, plan the roadmap".
  schedules?: ProcessSchedule[];
  /// Who may see it and start items in it. Absent: everyone.
  access?: ProcessAccess;
}

/// A recurring item: on each occurrence of `cadence`, an item with this
/// title and brief goes in, from the process owner.
export interface ProcessSchedule {
  id: string;
  cadence: ScheduleTrigger;
  title: string;
  brief: string;
  enabled: boolean;
  createdAt: number;
  lastAt?: number;
}

export type ProcessItemStatus = 'active' | 'done' | 'stopped';

export type ProcessEventKind = 'submitted' | 'entered' | 'finished' | 'approved' | 'sentBack' | 'stopped' | 'moved' | 'blocked' | 'retried' | 'note' | 'done';

export interface ProcessEvent {
  at: number;
  kind: ProcessEventKind;
  stageId?: string;
  by?: string;
  note?: string;
}

/// What a team stage handed on: its pack's summary and files.
export interface ProcessArtifact {
  stageId: string;
  stageName: string;
  at: number;
  taskId?: string;
  title: string;
  summary: string;
  files: string[];
  /// The branch the stage's code is on, when it changed code.
  branch?: string;
}

export interface ProcessItem {
  id: string;
  processId: string;
  title: string;
  brief: string;
  initiator: ProcessPerson;
  /// The person who put it in was an admin then (a token's own admin right,
  /// which a stored person can't carry).
  byAdmin?: boolean;
  source: 'console' | 'slack' | 'trigger' | 'api' | 'desktop' | 'schedule';
  sourceUrl?: string;
  /// Reopened from a finished item: "Verify found a problem with this".
  fromItemId?: string;
  stageIndex: number;
  status: ProcessItemStatus;
  /// The team task working the current stage.
  taskId?: string;
  /// Where the current stage is, in words, for the board.
  stageNote?: string;
  /// The current team or worker stage stopped for its owner: questions to
  /// answer, a plan to approve, a pack to sign off, or a paused run.
  ownerTurn?: 'questions' | 'plan' | 'pack' | 'paused';
  /// Why it can't move on its own. Its owners were told once.
  blocked?: string;
  /// The branch the latest code-changing stage left, where the next one starts.
  branch?: string;
  /// When the current stage starts: set while it waits (a delay, or the gap
  /// before its next run).
  startsAt?: number;
  /// Runs of the current stage done so far, when it repeats.
  runs?: number;
  /// Approvals so far at the current people stage, when it needs more than one.
  votes?: Array<{ by: string; slackUserId?: string; at: number; note?: string; answers?: Record<string, string> }>;
  /// Said when it was sent back; goes into the next brief, then clears.
  feedback?: { by: string; note: string };
  artifacts: ProcessArtifact[];
  history: ProcessEvent[];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface ProcessState {
  processes: ProcessDef[];
  items: ProcessItem[];
}

/// Checked shape of a process. Returns the problem, or null.
export function validateProcess(def: Pick<ProcessDef, 'name' | 'stages' | 'owner'>, teamIds: ReadonlySet<string>, workerIds?: ReadonlySet<string>): string | null {
  if (!def.name?.trim()) return 'Give the process a name, e.g. "Idea to launch".';
  if (!def.owner?.name?.trim()) return 'Say who owns the process.';
  if (!def.stages?.length) return 'Add at least one stage.';
  if (def.stages.length > 20) return 'A process has at most 20 stages.';
  const ids = new Set<string>();
  for (const [i, s] of def.stages.entries()) {
    const label = s.name?.trim() || `Stage ${i + 1}`;
    if (!s.name?.trim()) return `Name stage ${i + 1}.`;
    if (ids.has(s.id)) return `Two stages share the id ${s.id}.`;
    ids.add(s.id);
    if (s.delayDays !== undefined && (s.kind === 'people' || !Number.isInteger(s.delayDays) || s.delayDays < 0 || s.delayDays > 365)) return `${label} can wait 0 to 365 days, and only a team or worker stage waits.`;
    if (s.repeat && (s.kind === 'people' || !Number.isInteger(s.repeat.times) || s.repeat.times < 2 || s.repeat.times > 52 || !Number.isInteger(s.repeat.everyDays) || s.repeat.everyDays < 1 || s.repeat.everyDays > 90)) {
      return `${label} can repeat 2 to 52 times, 1 to 90 days apart, and only a team or worker stage repeats.`;
    }
    if (s.kind === 'team') {
      if (!s.teamId) return `Pick the team for ${label}.`;
      if (!teamIds.has(s.teamId)) return `The team for ${label} is gone. Pick another.`;
    } else if (s.kind === 'worker') {
      if (!s.workerId) return `Pick the worker for ${label}.`;
      if (workerIds && !workerIds.has(s.workerId)) return `The worker for ${label} is gone. Pick another.`;
    } else if (s.kind === 'people') {
      if (!s.approvers?.length && !s.approverGroups?.length) return s.mode === 'input' ? `Say who fills in ${label}.` : `Say who decides at ${label}.`;
      const bad = fieldsProblem(s.fields, label);
      if (bad) return bad;
      if (s.mode === 'input' && !s.fields?.length) return `Add something to fill in at ${label}, or make it a decision.`;
      if (typeof s.needs === 'number') {
        if (!Number.isInteger(s.needs) || s.needs < 1 || s.needs > 50) return `Say how many must approve at ${label}: a whole number from 1.`;
        if (!s.approverGroups?.length && s.needs > (s.approvers?.length ?? 0)) return `${label} needs ${s.needs} approvals but only ${s.approvers?.length ?? 0} people decide there.`;
      }
    } else {
      return `Say whether a team or people do ${label}.`;
    }
  }
  for (const s of def.stages) {
    if (s.sendBackTo && !ids.has(s.sendBackTo)) return `${s.name} sends back to a stage that isn't in the process.`;
  }
  return null;
}

function fieldsProblem(fields: ProcessField[] | undefined, label: string): string | null {
  if (!fields?.length) return null;
  if (fields.length > 12) return `${label} asks for at most 12 things.`;
  const ids = new Set<string>();
  for (const f of fields) {
    if (!f.label?.trim()) return `Name each thing ${label} asks for.`;
    if (!f.id || ids.has(f.id)) return `Two things ${label} asks for share the id ${f.id}.`;
    ids.add(f.id);
    if (f.kind === 'choice' && (f.options?.filter((o) => o.trim()).length ?? 0) < 2) return `Give “${f.label}” in ${label} at least two choices.`;
  }
  return null;
}

/// Answers from untrusted input, checked against a stage's fields: only its
/// fields, choices from its options, and every required one there. Returns
/// the answers, or the problem.
export function checkAnswers(fields: readonly ProcessField[] | undefined, raw: unknown): Record<string, string> | string {
  const given = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of fields ?? []) {
    const v = typeof given[f.id] === 'string' ? (given[f.id] as string).trim().slice(0, f.kind === 'longText' ? 4000 : 400) : '';
    if (!v) {
      if (f.required) return `Fill in “${f.label}”.`;
      continue;
    }
    if (f.kind === 'choice' && !(f.options ?? []).includes(v)) return `Pick one of the choices for “${f.label}”.`;
    out[f.id] = v;
  }
  return out;
}

/// What people put at a people stage, as the next stages read it: each
/// person's answers by label, and their note.
export function answersText(fields: readonly ProcessField[] | undefined, entries: ReadonlyArray<{ by: string; note?: string; answers?: Record<string, string> }>): string {
  return entries
    .map((e) => {
      const lines = (fields ?? []).filter((f) => e.answers?.[f.id]).map((f) => (f.kind === 'longText' ? `${f.label}:\n${e.answers![f.id]}` : `${f.label}: ${e.answers![f.id]}`));
      if (e.note) lines.push(`Note: ${e.note}`);
      return lines.length ? `From ${e.by}:\n${lines.join('\n')}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/// Where "send it back" from stage `from` lands: its chosen stage, else the
/// nearest team stage before it, else the start.
export function sendBackIndex(def: Pick<ProcessDef, 'stages'>, from: number): number {
  const chosen = def.stages[from]?.sendBackTo;
  if (chosen) {
    const i = def.stages.findIndex((s) => s.id === chosen);
    if (i >= 0) return i;
  }
  for (let i = from - 1; i >= 0; i--) if (def.stages[i].kind !== 'people') return i;
  return 0;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/// What a team stage is briefed with: the stage's ask, the original
/// request, any send-back note, and what each earlier stage produced.
/// `files` are each artifact's file contents, by `taskId/name`.
export function stageBrief(def: ProcessDef, item: ProcessItem, index: number, files: Record<string, string> = {}): string {
  const stage = def.stages[index];
  const parts = [
    `This is stage ${index + 1} of ${def.stages.length}, "${stage.name}", in the ${def.name} process${def.purpose ? ` (${def.purpose})` : ''}.`,
    `Item: ${item.title}`,
    stage.ask?.trim() ? `\nThis stage's job: ${stage.ask.trim()}` : `\nDo this stage's part: ${stage.name}.`,
    stage.kind === 'worker' ? 'Do this stage yourself. Your answer, with any links, is what the next stage gets.' : '',
    `\nThe original request, from ${item.initiator.name}:\n${item.brief.trim()}`,
  ];
  if (item.feedback) parts.push(`\nIt was sent back to this stage by ${item.feedback.by}, who said:\n${item.feedback.note}`);
  if (item.branch && def.codeIn) parts.push(`\nThe code so far is on the branch \`${item.branch}\` in ${def.codeIn.name}. Work on top of it.`);
  const earlier = item.artifacts.filter((a) => a.stageId !== stage.id);
  const ownRuns = item.artifacts.filter((a) => a.stageId === stage.id);
  if (stage.repeat) {
    parts.push(`\nThis is run ${(item.runs ?? 0) + 1} of ${stage.repeat.times}, ${stage.repeat.everyDays === 7 ? 'a week' : `${stage.repeat.everyDays} days`} after the last.${ownRuns.length ? ' Say what changed since the earlier runs, below.' : ''}`);
  }
  if (earlier.length) {
    parts.push('\nWhat earlier stages produced, oldest first. Build on it rather than starting over:');
    let budget = 24_000;
    for (const a of earlier) {
      parts.push(`\n## ${a.stageName}: ${a.title}\n${clip(a.summary, 2000)}`);
      for (const name of a.files) {
        const body = files[`${a.taskId}/${name}`];
        if (!body || budget <= 0) continue;
        const piece = clip(body, Math.min(8000, budget));
        budget -= piece.length;
        parts.push(`\n--- ${name} ---\n${piece}`);
      }
    }
  }
  if (ownRuns.length) {
    parts.push('\nEarlier runs of this stage, oldest first:');
    for (const a of ownRuns) parts.push(`\n## ${a.title}\n${clip(a.summary, 3000)}`);
  }
  const next = def.stages[index + 1];
  if (next) parts.push(`\nWhen this stage is done it goes to ${next.name}${next.kind === 'people' ? (next.mode === 'input' ? ', where people add what they know' : ', where people decide whether it goes on') : ''}. Write the pack for them.`);
  return parts.join('\n');
}

/// A stage's place and owner, said for the board.
export function stageLabel(stage: ProcessStage, doerName?: string): string {
  if (stage.kind === 'team') return `${stage.name} · ${doerName ?? 'a team'}`;
  if (stage.kind === 'worker') return `${stage.name} · ${doerName ?? 'a worker'}`;
  return `${stage.name} · ${(stage.approvers ?? []).map((p) => p.name).join(', ') || 'people'}`;
}
