// What the Processes screens show, worked out apart from the components so
// it can be tested: the process library, the editor's stage edits,
// the board's columns and the history in words.

import { sendBackIndex, type ProcessEvent, type ProcessPerson, type ProcessStage } from "@shared/org/process";
import type { ScheduleTrigger } from "@shared/flows/schedule";
import { PROCESS_LIBRARY, libraryProcess, stagesFromLibrary, suggestTeamFor, type LibraryProcess, type LibraryStage, type ProcessCategory } from "@shared/org/processLibrary";
import type { ProcessItemView } from "@shared/types";

/// On the desktop it's one person's app, so whoever decides is you.
export const DESKTOP_PERSON: ProcessPerson = { name: "You" };

let seq = 0;
/// A stage id that survives reordering. Unique within one editor session,
/// which is all `validateProcess` asks for.
export function newStageId(): string {
  seq += 1;
  return `s${Date.now().toString(36)}${seq.toString(36)}`;
}

export function newStage(kind: ProcessStage["kind"], name = ""): ProcessStage {
  return kind === "people" ? { id: newStageId(), name, kind, approvers: [DESKTOP_PERSON] } : { id: newStageId(), name, kind };
}

const CATEGORY_ORDER: ProcessCategory[] = ["Product", "Engineering", "Customers", "Go to market", "Security and operations"];

/// The library by category, in a fixed order, each keeping the library's
/// own order. Categories with nothing in them are left out.
export function libraryByCategory(list: readonly LibraryProcess[] = PROCESS_LIBRARY): Array<{ category: ProcessCategory; processes: LibraryProcess[] }> {
  const known = new Set<string>(CATEGORY_ORDER);
  const extra = [...new Set(list.map((p) => p.category))].filter((c) => !known.has(c));
  return [...CATEGORY_ORDER, ...extra]
    .map((category) => ({ category, processes: list.filter((p) => p.category === category) }))
    .filter((g) => g.processes.length > 0);
}

/// A team the editor can match a library stage against.
export type LocalTeam = { id: string; name: string; purpose?: string; members?: Array<{ role?: string }> };

/// A worker a stage can use: its id, name and the one line the rail shows.
export type LocalWorker = { id: string; name: string; tagline?: string; enabled?: boolean };

/// The editor's starting point for a library process: its words, and its
/// stages with the teams that fit filled in. On the desktop, you decide.
export function libraryDraft(
  p: LibraryProcess,
  teams: readonly LocalTeam[],
): { name: string; purpose: string; about: string; templateId: string; stages: ProcessStage[] } {
  const stages = stagesFromLibrary(p, (s) => suggestTeamFor(s, teams)?.team.id).map((s) =>
    s.kind === "people" ? { ...s, approvers: [DESKTOP_PERSON] } : s,
  );
  return { name: p.name, purpose: p.summary, about: p.about, templateId: p.id, stages };
}

/// What `processes:draftFromImage` hands back: stages, some with the role
/// the picture gives when none of yours clearly fit.
export type PictureDraft = { name: string; about?: string; stages: Array<ProcessStage & { suggestedRole?: string }> };

/// The editor's starting point for a draft read from a picture: its line
/// about what goes in and out as the purpose, the stages without their role
/// hints (kept apart, by stage id, for the doer picker), and on the desktop,
/// you decide where the picture names nobody.
export function pictureEditorDraft(draft: PictureDraft): { name: string; purpose: string; stages: ProcessStage[]; roles: Record<string, string> } {
  const roles: Record<string, string> = {};
  const stages = draft.stages.map(({ suggestedRole, ...s }) => {
    if (suggestedRole) roles[s.id] = suggestedRole;
    return s.kind === "people" && !s.approvers?.length && !s.approverGroups?.length ? { ...s, approvers: [DESKTOP_PERSON] } : s;
  });
  return { name: draft.name, purpose: draft.about ?? "", stages, roles };
}

/// The library stage an editor stage came from: library stage keys are the
/// stage ids `stagesFromLibrary` gives.
export function libraryStageFor(templateId: string | undefined, stageId: string): LibraryStage | undefined {
  return templateId ? libraryProcess(templateId)?.stages.find((s) => s.key === stageId) : undefined;
}

/// What the team editor's describe card is prefilled with, to make a team
/// for a library stage nobody fits.
export function teamBriefFor(stage: LibraryStage, processName: string): string {
  const lines = [`A team for the "${stage.name}" stage of ${processName}, led by the ${stage.who.toLowerCase()}.`, stage.ask];
  if (stage.crew?.length) lines.push(`It needs: ${stage.crew.join(", ")}.`);
  return lines.join(" ");
}

/// The stages with one moved up (-1) or down (+1). Out of range: unchanged.
export function moveStage(stages: ProcessStage[], index: number, by: -1 | 1): ProcessStage[] {
  const to = index + by;
  if (index < 0 || index >= stages.length || to < 0 || to >= stages.length) return stages;
  const next = stages.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/// A stage removed, and any "send back to" that pointed at it cleared, so
/// the process still saves.
export function removeStage(stages: ProcessStage[], index: number): ProcessStage[] {
  const gone = stages[index]?.id;
  return stages
    .filter((_, i) => i !== index)
    .map((s) => {
      if (!gone || s.sendBackTo !== gone) return s;
      const { sendBackTo: _drop, ...rest } = s;
      return rest;
    });
}

/// One column per stage, holding the items live there, newest move first.
export function boardColumns(stages: ProcessStage[], items: ProcessItemView[]): Array<{ stage: ProcessStage; index: number; items: ProcessItemView[] }> {
  return stages.map((stage, index) => ({
    stage,
    index,
    items: items.filter((i) => i.status === "active" && i.stageIndex === index).sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

/// What the item detail may offer, from where it is and who's looking.
export function itemActions(item: ProcessItemView, stage: ProcessStage | undefined): {
  approve: boolean;
  sendBack: boolean;
  retry: boolean;
  move: boolean;
  stop: boolean;
  startNow: boolean;
} {
  const live = item.status === "active";
  const people = stage?.kind === "people";
  return {
    approve: live && people && item.canDecide,
    sendBack: live && people && (item.canDecide || item.canSteer),
    retry: live && (stage?.kind === "team" || stage?.kind === "worker") && item.canSteer,
    move: live && item.canSteer,
    stop: live && (item.canSteer || item.canDecide),
    startNow: live && item.canSteer && !!item.startsAt,
  };
}

const EVENT_WORDS: Record<ProcessEvent["kind"], string> = {
  submitted: "Put in",
  entered: "Started",
  finished: "Finished",
  approved: "Approved",
  sentBack: "Sent back to",
  stopped: "Stopped",
  moved: "Moved to",
  blocked: "Stuck",
  retried: "Started again",
  note: "Note",
  done: "Made it through",
};

/// One history line: "Sent back to Prototype by You: needs pricing."
export function historyLine(ev: ProcessEvent, stages: ProcessStage[]): string {
  const stage = ev.stageId ? stages.find((s) => s.id === ev.stageId)?.name : undefined;
  const parts = [EVENT_WORDS[ev.kind] ?? ev.kind];
  if (stage && ev.kind !== "done") parts.push(ev.kind === "sentBack" || ev.kind === "moved" ? stage : `· ${stage}`);
  if (ev.by) parts.push(`by ${ev.by}`);
  return parts.join(" ") + (ev.note ? `: ${ev.note}` : "");
}

/// Whether a stage can run: a team stage has its team, a worker stage a
/// worker still in the crew, a decision someone to decide.
export function stageReady(stage: ProcessStage, teamIds: ReadonlySet<string>, workerIds: ReadonlySet<string> = new Set()): boolean {
  if (stage.kind === "team") return !!stage.teamId && teamIds.has(stage.teamId);
  if (stage.kind === "worker") return !!stage.workerId && workerIds.has(stage.workerId);
  return (stage.approvers ?? []).length + (stage.approverGroups ?? []).length > 0;
}

/// What a stage that can't run yet still needs, for the readiness list.
export function stageMissing(stage: ProcessStage): string {
  return stage.kind === "team" ? "pick a team" : stage.kind === "worker" ? "pick a worker" : "say who decides";
}

/// What the map and the board call a stage's kind.
export const STAGE_KIND_LABEL: Record<ProcessStage["kind"], string> = { team: "Team", worker: "Worker", people: "Decision" };

/// Where "send back" from stage `index` lands, by name, as the map says it.
export function sendBackName(stages: ProcessStage[], index: number): string {
  const chosen = stages[index]?.sendBackTo;
  const hit = chosen ? stages.find((s) => s.id === chosen) : undefined;
  if (hit) return hit.name || "an unnamed stage";
  for (let i = index - 1; i >= 0; i--) if (stages[i].kind !== "people") return stages[i].name || "the stage before";
  return "the start";
}

// ---- WHO FITS A STAGE ----------------------------------------------------

/// Filler that says nothing about what a stage or a doer is about, and the
/// job-title words every crew line has.
const MATCH_NOISE = new Set([
  "with", "that", "this", "from", "what", "when", "them", "they", "each", "into", "your", "their", "have", "will", "more",
  "says", "writer", "analyst", "reviewer", "manager", "lead", "specialist", "engineer", "builder", "turns", "makes",
  "write", "writes", "stage", "team", "work", "needs", "needed", "about", "should",
]);

/// Words that say what something is about, for matching a stage to who
/// could do it: lower case, four letters or more, minus the filler, keyed by
/// a rough stem ("designs" and "designer" both key "design") to the word as
/// first written.
export function matchWords(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of String(text ?? "").toLowerCase().split(/[^a-z0-9/]+/)) {
    if (w.length < 4 || MATCH_NOISE.has(w)) continue;
    const stem = w.replace(/(ing|ers|er|es|s)$/, "").replace(/e$/, "");
    if (!out.has(stem)) out.set(stem, w);
  }
  return out;
}

/// One team or worker in the picker: `about` is the line shown under its
/// name, `text` everything it's matched on.
export type DoerOption = { id: string; name: string; about: string; text: string; paused?: boolean };

/// An option with the stage's words it shares, as the stage says them.
export type RankedDoer = { option: DoerOption; hits: string[] };

/// What a stage is about, for ranking who fits it: its name and job, and
/// what the library says a stage like it needs.
export function stageMatchText(stage: Pick<ProcessStage, "name" | "ask">, lib?: Pick<LibraryStage, "words" | "crew">): string {
  return [stage.name, stage.ask ?? "", ...(lib?.words ?? []), ...(lib?.crew ?? [])].join(" ");
}

/// Teams as picker options: said by purpose (else their roles), matched on
/// name, purpose and every member's role.
export function teamOptions(teams: readonly LocalTeam[]): DoerOption[] {
  return teams.map((t) => {
    const roles = (t.members ?? []).map((m) => m.role?.trim()).filter((r): r is string => !!r);
    return { id: t.id, name: t.name, about: t.purpose?.trim() || roles.join(", "), text: [t.name, t.purpose ?? "", ...roles].join(" ") };
  });
}

/// Workers as picker options: said and matched by the line the rail shows.
export function workerOptions(workers: readonly LocalWorker[]): DoerOption[] {
  return workers.map((w) => ({
    id: w.id,
    name: w.name,
    about: w.tagline ?? "",
    text: `${w.name} ${w.tagline ?? ""}`,
    ...(w.enabled === false ? { paused: true } : {}),
  }));
}

/// Each option with the stage's words it shares.
export function rankDoers(options: readonly DoerOption[], stageText: string): RankedDoer[] {
  const want = matchWords(stageText);
  return options.map((option) => {
    const have = matchWords(option.text);
    const hits = [...want.keys()].filter((k) => have.has(k)).map((k) => want.get(k)!);
    return { option, hits };
  });
}

/// The good matches: two shared words or more, most first, at most three.
export function goodMatches(ranked: readonly RankedDoer[], max = 3): RankedDoer[] {
  return ranked
    .filter((r) => r.hits.length >= 2)
    .slice()
    .sort((a, b) => b.hits.length - a.hits.length || a.option.name.localeCompare(b.option.name))
    .slice(0, max);
}

/// The picker's list: with no search, the good matches then everyone else
/// alphabetically; with one, everything it finds by name or what it does.
export function pickerSections(ranked: readonly RankedDoer[], query: string): Array<{ label: string; rows: RankedDoer[]; why: boolean }> {
  const term = query.trim().toLowerCase();
  const top = term ? [] : goodMatches(ranked);
  const has = (r: RankedDoer) => !term || `${r.option.name} ${r.option.text}`.toLowerCase().includes(term);
  const rest = ranked.filter((r) => has(r) && !top.includes(r)).sort((a, b) => a.option.name.localeCompare(b.option.name));
  const out: Array<{ label: string; rows: RankedDoer[]; why: boolean }> = [];
  if (top.length) out.push({ label: "Good matches for this stage", rows: top, why: true });
  if (rest.length) out.push({ label: top.length ? "Everyone else" : "All", rows: rest, why: !!term });
  return out;
}

// ---- TIMING --------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/// A span of days, in weeks when it divides: "2 weeks", "3 days".
function daySpan(d: number): string {
  return d % 7 === 0 ? plural(d / 7, "week", "weeks") : plural(d, "day", "days");
}

/// A stage's timing in words: "2 weeks after the stage before · weekly, 4
/// times". Empty when it starts right away and runs once.
export function timingText(stage: Pick<ProcessStage, "delayDays" | "repeat">): string {
  const parts: string[] = [];
  if (stage.delayDays) parts.push(`${daySpan(stage.delayDays)} after the stage before`);
  if (stage.repeat) parts.push(`${stage.repeat.everyDays === 7 ? "weekly" : `every ${daySpan(stage.repeat.everyDays)}`}, ${stage.repeat.times} times`);
  return parts.join(" · ");
}

/// "When it starts": days after the stage before. A value the list doesn't
/// have (from the library or another install) is offered too.
export function delayOptions(current?: number): Array<{ value: number; label: string }> {
  const out = [
    { value: 0, label: "Right away" },
    { value: 1, label: "1 day after the stage before" },
    { value: 3, label: "3 days after" },
    { value: 7, label: "1 week after" },
    { value: 14, label: "2 weeks after" },
    { value: 30, label: "30 days after" },
    { value: 60, label: "60 days after" },
    { value: 90, label: "90 days after" },
  ];
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: `${current} days after` });
  return out;
}

/// A repeat as the "Runs" select keys it: "7x4", or "" for once.
export function repeatKey(repeat?: ProcessStage["repeat"]): string {
  return repeat ? `${repeat.everyDays}x${repeat.times}` : "";
}

/// The repeat a "Runs" key stands for; undefined for once.
export function repeatFromKey(key: string): ProcessStage["repeat"] | undefined {
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m ? { everyDays: Number(m[1]), times: Number(m[2]) } : undefined;
}

/// "Runs": once, or several times a set number of days apart.
export function repeatOptions(current?: ProcessStage["repeat"]): Array<{ value: string; label: string }> {
  const out = [
    { value: "", label: "Once" },
    ...[2, 3, 4, 6, 8].map((n) => ({ value: `7x${n}`, label: `Weekly, ${n} times` })),
    ...[3, 6].map((n) => ({ value: `14x${n}`, label: `Every 2 weeks, ${n} times` })),
    ...[3, 6].map((n) => ({ value: `30x${n}`, label: `Monthly, ${n} times` })),
  ];
  const key = repeatKey(current);
  if (current && !out.some((o) => o.value === key)) out.push({ value: key, label: `Every ${current.everyDays} days, ${current.times} times` });
  return out;
}

export type SchedulePreset = "weekly" | "weekdays" | "monthly" | "quarterly";

export const SCHEDULE_PRESETS: Array<{ value: SchedulePreset; label: string }> = [
  { value: "weekly", label: "Every week" },
  { value: "weekdays", label: "Every weekday" },
  { value: "monthly", label: "On the 1st of each month" },
  { value: "quarterly", label: "On the first day of each quarter" },
];

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// The cadence a schedule preset means, at `time` ("HH:MM"): weekly on
/// `day` (0 = Sunday) and weekdays as daily-on-these-days, the 1st of a
/// month or a quarter as cron.
export function scheduleCadence(preset: SchedulePreset, time: string, day = 1): ScheduleTrigger {
  const at = /^\d{1,2}:\d{2}$/.test(time) ? time : "09:00";
  if (preset === "weekly") return { kind: "daily", time: at, days: [day] };
  if (preset === "weekdays") return { kind: "daily", time: at, days: [1, 2, 3, 4, 5] };
  const [h, m] = at.split(":").map(Number);
  return { kind: "cron", expr: `${m} ${h} 1 ${preset === "quarterly" ? "1,4,7,10" : "*"} *` };
}

/// The arguments a watch is asked with, from its JSON box: blank is none,
/// and anything but a JSON object is null.
export function parseWatchArgs(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- THE BOARD -----------------------------------------------------------

const DAY_MS = 86_400_000;

/// A length of time, short: "40 min", "5 hours", "2.5 days".
export function durationWords(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = ms / 3_600_000;
  if (hours < 24) return plural(Math.round(hours), "hour", "hours");
  const days = Math.round((ms / DAY_MS) * 2) / 2;
  return days === 1 ? "1 day" : `${days} days`;
}

/// The board's four tiles: what's in flight, waiting on you, stuck, and
/// what got through in the last 30 days with its typical (median) time
/// end to end.
export function boardStats(
  items: readonly ProcessItemView[],
  now = Date.now(),
): { inFlight: number; stages: number; waiting: number; stuck: number; done30: number; typicalMs: number | null } {
  const live = items.filter((i) => i.status === "active");
  const done = items.filter((i) => i.status === "done" && i.finishedAt && now - i.finishedAt <= 30 * DAY_MS);
  const spans = done.map((i) => i.finishedAt! - i.createdAt).sort((a, b) => a - b);
  const mid = spans.length ? (spans.length % 2 ? spans[(spans.length - 1) / 2] : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2) : null;
  return {
    inFlight: live.length,
    stages: new Set(live.map((i) => i.stageIndex)).size,
    waiting: live.filter((i) => i.yourTurn).length,
    stuck: live.filter((i) => !!i.blocked).length,
    done30: done.length,
    typicalMs: mid,
  };
}

/// The board's filters: everything, what waits on you, what's stuck, and
/// what you put in yourself.
export type BoardFilter = "all" | "you" | "stuck" | "mine";

function boardFilterHit(i: ProcessItemView, filter: BoardFilter): boolean {
  if (filter === "you") return i.yourTurn;
  if (filter === "stuck") return !!i.blocked;
  if (filter === "mine") return i.initiator.name.trim().toLowerCase() === DESKTOP_PERSON.name.toLowerCase();
  return true;
}

/// The live items the board shows: by filter, and by stage (-1: every
/// stage), latest move first.
export function filterItems(items: readonly ProcessItemView[], filter: BoardFilter, stageIndex = -1): ProcessItemView[] {
  return items
    .filter((i) => i.status === "active")
    .filter((i) => boardFilterHit(i, filter))
    .filter((i) => stageIndex < 0 || i.stageIndex === stageIndex)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export type TrackStep = "done" | "now" | "stuck" | "ahead";

/// One segment per stage for an item's mini track.
export function itemTrack(item: Pick<ProcessItemView, "status" | "stageIndex" | "blocked">, stageCount: number): TrackStep[] {
  return Array.from({ length: stageCount }, (_, i) => {
    if (item.status === "done" || i < item.stageIndex) return "done";
    if (i === item.stageIndex && item.status === "active") return item.blocked ? "stuck" : "now";
    return "ahead";
  });
}

const SOURCE_WORDS: Partial<Record<ProcessItemView["source"], string>> = {
  slack: "via Slack",
  trigger: "came in by itself",
  api: "via the API",
  console: "via the console",
};

/// Where an item came from, in a line: "From You · via Slack".
export function itemSource(item: Pick<ProcessItemView, "initiator" | "source">): string {
  const via = SOURCE_WORDS[item.source];
  return `From ${item.initiator.name}${via ? ` · ${via}` : ""}`;
}

/// The ways in, in one line: "Comes in from this page · /idea in Slack ·
/// a watch on Tracker · 2 schedules".
export function waysInSummary(intake: { schedules?: unknown[]; watches?: Array<{ server: string }> } | null, slackOn: boolean): string {
  const parts = ["this page"];
  if (slackOn) parts.push("/idea in Slack");
  for (const server of [...new Set((intake?.watches ?? []).map((w) => w.server))]) parts.push(`a watch on ${server}`);
  const n = intake?.schedules?.length ?? 0;
  if (n) parts.push(n === 1 ? "a schedule" : `${n} schedules`);
  return `Comes in from ${parts.join(" · ")}`;
}

/// A team or worker stage stopped for its owner, in words: what they do,
/// as a title ("Sign off the pack") and inside a line ("sign off the pack").
export const OWNER_TURN: Record<NonNullable<ProcessItemView["ownerTurn"]>, { title: string; doing: string }> = {
  questions: { title: "Answer the team's questions", doing: "answer the team's questions" },
  plan: { title: "Approve the plan", doing: "approve the plan" },
  pack: { title: "Sign off the pack", doing: "sign off the pack" },
  paused: { title: "Unblock the run", doing: "unblock the paused run" },
};

/// What an item is doing now, in one line that never contradicts itself:
/// "Waiting on you: sign off the pack", "Waiting on Pat: approve the plan",
/// "Waiting on Eng leads", else where the stage is.
export function nowLine(item: ProcessItemView, stage: ProcessStage | undefined): string {
  if (item.status === "done") return "Made it through";
  if (item.status === "stopped") return `Stopped at ${stage?.name ?? "a stage"}`;
  if (item.blocked) return item.blocked;
  if (item.startsAt) return item.stageNote ?? "Waiting for its start date";
  const turn = item.ownerTurn && stage?.kind !== "people" ? OWNER_TURN[item.ownerTurn] : undefined;
  if (turn) return item.yourTurn ? `Waiting on you: ${turn.doing}` : `Waiting on ${item.waitsOn ?? "its stage owner"}: ${turn.doing}`;
  if (stage?.kind === "people") {
    if (item.yourTurn || item.canDecide) return "Waiting on you";
    if (item.waitsOn) return `Waiting on ${item.waitsOn}`;
  }
  return item.stageNote ?? stage?.name ?? "";
}

/// The current stage's live line for "Where it stands": "Reproduce and
/// fix · Acme web builders: Working", or what it waits on.
export function liveLine(item: ProcessItemView, stage: ProcessStage | undefined, doerName: (s: ProcessStage) => string): string {
  if (!stage || item.status !== "active") return nowLine(item, stage);
  const plain = !item.blocked && !item.startsAt && !item.ownerTurn && stage.kind !== "people";
  return `${stage.name} · ${plain ? `${doerName(stage)}: ${item.stageNote ?? "Working"}` : nowLine(item, stage)}`;
}

/// What the item panel's Now card says and offers.
export type NowCard = {
  mode: "decide" | "work" | "waiting" | "stuck" | "done" | "stopped";
  headline: string;
  detail: string;
};

export function nowCard(item: ProcessItemView, stage: ProcessStage | undefined, doer: string): NowCard {
  if (item.status === "done") return { mode: "done", headline: "Made it through", detail: "Every stage is done." };
  if (item.status === "stopped") return { mode: "stopped", headline: `Stopped at ${stage?.name ?? "a stage"}`, detail: "What it produced stays below." };
  const name = stage?.name ?? "this stage";
  if (item.blocked) return { mode: "stuck", headline: `Stuck at ${name}`, detail: item.blocked };
  if (item.startsAt) return { mode: "waiting", headline: `${name} hasn't started yet`, detail: item.stageNote ?? "It's waiting for its start date." };
  if (stage?.kind === "people") {
    return item.canDecide
      ? { mode: "decide", headline: `Your call: ${name}?`, detail: stage.ask?.trim() || "Approve to move it on, or send it back with what needs to change." }
      : { mode: "decide", headline: `Waiting on ${item.waitsOn ?? doer}`, detail: item.stageNote ?? "Someone who decides here has to approve it." };
  }
  if (item.ownerTurn) {
    const turn = OWNER_TURN[item.ownerTurn];
    return item.yourTurn
      ? { mode: "decide", headline: `Your turn: ${turn.doing}`, detail: item.stageNote ?? "" }
      : { mode: "waiting", headline: `Waiting on ${item.waitsOn ?? "its stage owner"}: ${turn.doing}`, detail: item.stageNote ?? "" };
  }
  return { mode: "work", headline: `${doer} is on it`, detail: item.stageNote ?? stage?.ask ?? "" };
}

/// Every stage an item goes through, for its journey: done ones with what
/// they produced (the latest pack), the current one, the ones ahead. A
/// stage ahead keeps its old pack when the item was sent back past it.
export function itemJourney(
  item: ProcessItemView,
  stages: readonly ProcessStage[],
): Array<{ stage: ProcessStage; index: number; state: TrackStep; artifact?: ProcessItemView["artifacts"][number] }> {
  const track = itemTrack(item, stages.length);
  return stages.map((stage, index) => {
    const made = item.artifacts.filter((a) => a.stageId === stage.id);
    const artifact = made.length ? made[made.length - 1] : undefined;
    return { stage, index, state: track[index], ...(artifact ? { artifact } : {}) };
  });
}

/// The editor's "More" rows (send back target, timing) fold away while
/// they're at their defaults.
export function stageMoreAtDefaults(stage: Pick<ProcessStage, "sendBackTo" | "delayDays" | "repeat">): boolean {
  return !stage.sendBackTo && !stage.delayDays && !stage.repeat;
}

// ---- THE ITEM PAGE -------------------------------------------------------
// One item opened up, full width: the stage track, your call, where it
// stands, its journey, what was handed on, and who did what in how long.

const HOUR_MS = 3_600_000;

/// A length of time, as short as it goes: "40 min", "16 h", "2.5 d".
export function shortSpan(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 48) return `${hours} h`;
  const days = Math.round((ms / DAY_MS) * 2) / 2;
  return `${days} d`;
}

/// The first line of something, for a header or a list: markdown marks
/// dropped, at most `max` characters.
export function firstLine(text: string | undefined, max = 200): string {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s*/, "").replace(/[*_`]/g, "").trim())
    .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/// The first sentence of a summary: "Handed on so far" gives one per stage.
export function firstSentence(text: string | undefined, max = 160): string {
  const line = firstLine(text, 1000);
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  const s = m ? m[1] : line;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function redoWords(n: number): string {
  return n === 1 ? "1 redo" : `${n} redos`;
}

/// How long each stage has taken, from the history: from each time it was
/// entered to the next stage entered (or the item finishing), and the open
/// one up to `now`. A redo is a send back to the stage or a start again there.
export type StageTime = { ms: number; visits: number; redos: number; running: boolean };

export function stageTimes(item: Pick<ProcessItemView, "history" | "status">, stages: readonly ProcessStage[], now = Date.now()): StageTime[] {
  const out: StageTime[] = stages.map(() => ({ ms: 0, visits: 0, redos: 0, running: false }));
  const at = (id?: string) => (id ? stages.findIndex((s) => s.id === id) : -1);
  let open: { index: number; since: number } | null = null;
  const close = (t: number) => {
    if (open && open.index >= 0) out[open.index].ms += Math.max(0, t - open.since);
    open = null;
  };
  for (const ev of [...item.history].sort((a, b) => a.at - b.at)) {
    if (ev.kind === "entered") {
      close(ev.at);
      const i = at(ev.stageId);
      if (i >= 0) out[i].visits += 1;
      open = { index: i, since: ev.at };
    } else if (ev.kind === "done" || ev.kind === "stopped") {
      close(ev.at);
    } else if (ev.kind === "sentBack") {
      const i = at(ev.stageId);
      if (i >= 0) out[i].redos += 1;
    } else if (ev.kind === "retried") {
      const cur = open as { index: number; since: number } | null;
      if (cur && cur.index >= 0) out[cur.index].redos += 1;
    }
  }
  const last = open as { index: number; since: number } | null;
  if (last && last.index >= 0 && item.status === "active") {
    out[last.index].ms += Math.max(0, now - last.since);
    out[last.index].running = true;
  }
  return out;
}

/// When the current stage was last entered, for "waiting 2 h".
export function stageSince(item: Pick<ProcessItemView, "history">, stageId: string | undefined): number | undefined {
  if (!stageId) return undefined;
  for (let i = item.history.length - 1; i >= 0; i--) {
    const ev = item.history[i];
    if (ev.kind === "entered" && ev.stageId === stageId) return ev.at;
  }
  return undefined;
}

/// How many approvals a people stage needs, and from how many (null when a
/// group is in it, since who's in a group is only read when it's asked).
export function voteNeed(stage: Pick<ProcessStage, "needs" | "approvers" | "approverGroups">): { need: number; of: number | null } {
  const people = (stage.approvers ?? []).length;
  const of = (stage.approverGroups ?? []).length ? null : people;
  const need = stage.needs === "all" ? Math.max(1, people) : typeof stage.needs === "number" ? stage.needs : 1;
  return { need, of };
}

/// The vote rule in a few words: "2 of 3", "all 3", "any one", or "" when
/// one person decides.
export function voteRuleText(stage: Pick<ProcessStage, "needs" | "approvers" | "approverGroups">): string {
  const { need, of } = voteNeed(stage);
  const seats = (stage.approvers ?? []).length + (stage.approverGroups ?? []).length;
  if (stage.needs === "all") return of !== null ? (of === 1 ? "" : `all ${of}`) : "all of them";
  if (typeof stage.needs === "number" && need > 1) return of !== null ? `${need} of ${of}` : `${need} needed`;
  return seats > 1 || (stage.approverGroups ?? []).length ? "any one" : "";
}

/// Who decides at a people stage: groups first, then people, two names and a count.
export function decidersText(stage: Pick<ProcessStage, "approvers" | "approverGroups">): string {
  const names = [...(stage.approverGroups ?? []).map((g) => g.name), ...(stage.approvers ?? []).map((p) => p.name)];
  if (!names.length) return "people";
  return names.length > 3 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

/// Who does a stage, for its card: "Triage · worker", "Web app · team",
/// "Eng leads · 2 of 3".
export function stageWho(stage: ProcessStage, doerName: string): string {
  if (stage.kind === "team") return `${doerName} · team`;
  if (stage.kind === "worker") return `${doerName} · worker`;
  const rule = voteRuleText(stage);
  return rule ? `${decidersText(stage)} · ${rule}` : decidersText(stage);
}

/// A day ahead, said plainly: "today", "tomorrow", "Monday", "Oct 24".
export function dayWords(at: number, now = Date.now()): string {
  const start = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((start(at) - start(now)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return DAY_NAMES[new Date(at).getDay()];
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/// When it started: "today 4:12 PM", "yesterday 4:12 PM", "Oct 12, 4:12 PM".
export function startedWords(at: number, now = Date.now()): string {
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const start = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((start(now) - start(at)) / DAY_MS);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/// Where an item came from, for the header: "from a watch on tracker.acme.dev".
export function itemOrigin(item: Pick<ProcessItemView, "source" | "sourceUrl" | "initiator">): string {
  let host = "";
  try {
    host = item.sourceUrl ? new URL(item.sourceUrl).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }
  const who = item.initiator.name;
  switch (item.source) {
    case "trigger":
      return host ? `from a watch on ${host}` : "from a watch";
    case "slack":
      return who === DESKTOP_PERSON.name ? "from Slack" : `from ${who} in Slack`;
    case "schedule":
      return "on a schedule";
    case "console":
      return `from ${who} in the console`;
    case "api":
      return "from the API";
    default:
      return who === DESKTOP_PERSON.name ? "put in here" : `put in by ${who}`;
  }
}

export type StageCardState = "done" | "now" | "stuck" | "next";

/// One card on the stage track.
export type StageCard = {
  stage: ProcessStage;
  index: number;
  state: StageCardState;
  who: string;
  status: string;
  /// It's waiting on the viewer: drawn amber.
  mine: boolean;
};

function laterWords(stage: ProcessStage, first: boolean): string {
  const parts: string[] = [];
  if (stage.delayDays) parts.push(stage.delayDays === 1 ? "A day after the stage before" : `${daySpan(stage.delayDays)} after the stage before`);
  if (stage.repeat) parts.push(`${stage.repeat.everyDays === 7 ? "weekly" : `every ${daySpan(stage.repeat.everyDays)}`}, ${stage.repeat.times} runs`);
  if (parts.length) return parts.join(" · ").replace(/^./, (c) => c.toUpperCase());
  return first ? "Next" : "Later";
}

/// The stage track: each stage done (with its time and redos), the one it's
/// at (what it's doing, or waiting on you), and the ones ahead (when they start).
export function stageCards(item: ProcessItemView, stages: readonly ProcessStage[], doerName: (s: ProcessStage) => string, now = Date.now()): StageCard[] {
  const times = stageTimes(item, stages, now);
  return stages.map((stage, index) => {
    const who = stageWho(stage, doerName(stage));
    const base = { stage, index, who, mine: false };
    const t = times[index];
    if (item.status === "done" || index < item.stageIndex) {
      if (!t.visits) return { ...base, state: "done", status: "Skipped" };
      return { ...base, state: "done", status: `Done · ${shortSpan(t.ms)}${t.redos ? `, ${redoWords(t.redos)}` : ""}` };
    }
    if (index === item.stageIndex) {
      if (item.status === "stopped") return { ...base, state: "stuck", status: "Stopped here" };
      if (item.blocked) return { ...base, state: "stuck", status: "Stuck" };
      if (item.startsAt) {
        const when = dayWords(item.startsAt, now);
        const run = stage.repeat && item.runs ? `Run ${item.runs + 1} of ${stage.repeat.times} starts` : "Starts";
        return { ...base, state: "now", status: `${run} ${when}` };
      }
      if (stage.kind === "people") {
        if (item.canDecide || item.yourTurn) return { ...base, state: "now", status: "Waiting on you", mine: true };
        return { ...base, state: "now", status: `Waiting on ${item.waitsOn ?? decidersText(stage)}` };
      }
      // A team's questions, plan or pack wait on its stage owner: maybe you.
      const doing = item.ownerTurn ? nowLine(item, stage) : item.stageNote ?? "Working";
      return { ...base, state: "now", mine: !!item.ownerTurn && item.yourTurn, status: stage.repeat ? `Run ${(item.runs ?? 0) + 1} of ${stage.repeat.times} · ${doing}` : doing };
    }
    if (item.status === "stopped") return { ...base, state: "next", status: "Not reached" };
    return { ...base, state: "next", status: laterWords(stage, index === item.stageIndex + 1) };
  });
}

/// One row in "The vote".
export type VoteRow = { name: string; state: "approved" | "waiting" | "notNeeded"; at?: number; note?: string; you: boolean; group: boolean };

/// Who has a say at a people stage and where each stands: approved (with
/// when and what they said), waiting, or not needed now enough have approved.
export function voteRows(item: Pick<ProcessItemView, "votes">, stage: ProcessStage): { rows: VoteRow[]; have: number; need: number } {
  const votes = item.votes ?? [];
  const { need } = voteNeed(stage);
  const left = need - votes.length;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const you = (n: string) => same(n, DESKTOP_PERSON.name);
  const rows: VoteRow[] = [];
  for (const p of stage.approvers ?? []) {
    const v = votes.find((x) => same(x.by, p.name));
    rows.push(
      v
        ? { name: p.name, state: "approved", at: v.at, ...(v.note ? { note: v.note } : {}), you: you(p.name), group: false }
        : { name: p.name, state: left > 0 ? "waiting" : "notNeeded", you: you(p.name), group: false },
    );
  }
  for (const v of votes) {
    if (rows.some((r) => same(r.name, v.by))) continue;
    rows.push({ name: v.by, state: "approved", at: v.at, ...(v.note ? { note: v.note } : {}), you: you(v.by), group: false });
  }
  for (const g of stage.approverGroups ?? []) {
    rows.push({ name: g.name, state: left > 0 ? "waiting" : "notNeeded", note: "Anyone in the group", you: false, group: true });
  }
  const rank = (r: VoteRow) => (r.state === "approved" ? 0 : r.you ? 1 : r.state === "waiting" ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b));
  return { rows, have: votes.length, need };
}

/// The line under "Your call": the rule, who already approved, whether
/// yours settles it, and how long it has waited.
export function callLine(item: ProcessItemView, stage: ProcessStage, now = Date.now()): string {
  const rule = voteRuleText(stage);
  const parts = [`${decidersText(stage)}${rule ? `, ${rule}` : ""}.`];
  const { have, need } = voteRows(item, stage);
  const voted = (item.votes ?? []).map((v) => v.by);
  if (voted.length) parts.push(`${voted.join(" and ")} approved${need - have === 1 ? ", so yours would settle it" : ""}.`);
  else if (need > 1) parts.push(`It needs ${need} approvals.`);
  const since = stageSince(item, stage.id);
  if (since !== undefined) parts.push(`Waiting ${shortSpan(now - since)}.`);
  return parts.join(" ");
}

/// Where a send back can go from stage `index`: every stage before it, with
/// the one it goes to by default (its own choice, else the team stage before).
export function sendBackChoices(stages: readonly ProcessStage[], index: number): { choices: Array<{ index: number; name: string }>; defaultIndex: number } {
  const choices = stages.slice(0, Math.max(0, index)).map((s, i) => ({ index: i, name: s.name }));
  const chosen = stages[index]?.sendBackTo;
  let def = chosen ? stages.findIndex((s) => s.id === chosen) : -1;
  if (def < 0 || def >= index) {
    def = 0;
    for (let i = index - 1; i >= 0; i--) {
      if (stages[i].kind !== "people") {
        def = i;
        break;
      }
    }
  }
  return { choices, defaultIndex: def };
}

/// The big "Where it stands" card: the latest stage's result, else where
/// the current stage is.
export function whereItStands(item: ProcessItemView): { from: string | null; text: string } {
  const last = item.artifacts.length ? [...item.artifacts].sort((a, b) => a.at - b.at)[item.artifacts.length - 1] : undefined;
  if (last?.summary.trim()) return { from: last.stageName, text: last.summary };
  if (item.blocked) return { from: null, text: item.blocked };
  return { from: null, text: item.stageNote ?? firstLine(item.brief) };
}

/// Pull requests and branches an item has touched, for chips and "Open PR".
export function itemLinks(item: Pick<ProcessItemView, "artifacts" | "branch" | "stageNote">): { prs: Array<{ url: string; label: string }>; branches: string[] } {
  const prs: Array<{ url: string; label: string }> = [];
  const re = /https?:\/\/[^\s)>\]]+\/(?:pull|pulls|merge_requests)\/(\d+)/g;
  for (const text of [...item.artifacts.map((a) => a.summary), item.stageNote ?? ""]) {
    for (const m of text.matchAll(re)) if (!prs.some((p) => p.url === m[0])) prs.push({ url: m[0], label: `PR #${m[1]}` });
  }
  const branches = [...new Set([...item.artifacts.map((a) => a.branch), item.branch].filter((b): b is string => !!b))];
  return { prs, branches };
}

/// "Handed on so far": one line per pack, oldest first.
export function handedOnLines(item: Pick<ProcessItemView, "artifacts">): Array<{ key: string; stage: string; line: string }> {
  return [...item.artifacts]
    .sort((a, b) => a.at - b.at)
    .map((a, i) => {
      const run = /run \d+ of \d+$/.exec(a.title);
      return { key: `${a.stageId}:${a.at}:${i}`, stage: run ? `${a.stageName} · ${run[0]}` : a.stageName, line: firstSentence(a.summary) };
    });
}

/// "What happens next", in a few lines, from the stages after this one.
export function nextSteps(item: ProcessItemView, stages: readonly ProcessStage[], doerName: (s: ProcessStage) => string): string[] {
  if (item.status === "done") return ["Nothing: it made it through every stage."];
  if (item.status === "stopped") return ["Nothing: it was stopped. What it produced stays here."];
  const idx = item.stageIndex;
  const cur = stages[idx];
  if (!cur) return [];
  const next = stages[idx + 1];
  const out: string[] = [];
  const onTo = next ? `it moves on to ${next.name}` : "it's done";
  if (item.blocked) out.push(`It's stuck at ${cur.name}. Start it again or move it on.`);
  else if (cur.kind === "people") {
    const { have, need } = voteRows(item, cur);
    const left = Math.max(1, need - have);
    if (item.canDecide || item.yourTurn) out.push(left === 1 ? `Your approval settles it, and ${onTo}.` : `Your approval counts: ${left} more are needed before ${onTo}.`);
    else out.push(`Once ${item.waitsOn ?? decidersText(cur)} approve${left > 1 ? ` (${left} more)` : ""}, ${onTo}.`);
  } else {
    if (cur.repeat) {
      const left = cur.repeat.times - (item.runs ?? 0);
      if (left > 1) out.push(`${left - 1} more ${left - 1 === 1 ? "run" : "runs"} of ${cur.name} after this one, ${cur.repeat.everyDays === 7 ? "a week" : daySpan(cur.repeat.everyDays)} apart.`);
    }
    if (item.ownerTurn) {
      const turn = OWNER_TURN[item.ownerTurn];
      out.push(item.yourTurn ? `${turn.title} and ${doerName(cur)} carries on.` : `${item.waitsOn ?? "Its stage owner"} has to ${turn.doing} before ${doerName(cur)} carries on.`);
    }
    out.push(item.ownerTurn === "pack" ? `Once the pack is signed off, ${onTo}.` : `When ${doerName(cur)} finishes ${cur.name}, ${onTo}.`);
  }
  for (const s of stages.slice(idx + 1, idx + 3)) {
    const timing = timingText(s);
    if (s.kind === "people") out.push(`${decidersText(s)} decide at ${s.name}.`);
    else out.push(`${doerName(s)} does ${s.name}${timing ? `, ${timing}` : ""}.`);
  }
  if (!next) out.push("This is the last stage.");
  const decide = stages.findIndex((s, i) => i >= idx && s.kind === "people");
  if (decide >= 0) {
    const back = sendBackChoices(stages, decide);
    const to = stages[back.defaultIndex];
    if (to && decide > 0) out.push(`If ${stages[decide].name} sends it back, it reopens at ${to.name}.`);
  }
  return out;
}

/// The pack a "finished" event stands for: same stage, handed on within a
/// minute of it. -1 when it was replaced by a later run of the stage.
export function artifactForEvent(item: Pick<ProcessItemView, "artifacts">, ev: Pick<ProcessEvent, "kind" | "stageId" | "at">): number {
  if (ev.kind !== "finished" || !ev.stageId) return -1;
  let best = -1;
  let gap = 60_000;
  item.artifacts.forEach((a, i) => {
    const d = Math.abs(a.at - ev.at);
    if (a.stageId === ev.stageId && d <= gap) {
      best = i;
      gap = d;
    }
  });
  return best;
}

/// How many files, said: "2 files", "1 file", "" for none.
export function filesWords(n: number): string {
  return n ? plural(n, "file", "files") : "";
}

/// A finished item's outcome: the last pack in full, then one line per
/// earlier pack ("Gather evidence · Product Team · 2 files").
export type OutcomeRow = { index: number; artifact: ProcessItemView["artifacts"][number]; line: string };

export function outcomeView(
  item: Pick<ProcessItemView, "artifacts">,
  stages: readonly ProcessStage[],
  doerName: (s: ProcessStage) => string,
): { last: OutcomeRow | null; earlier: OutcomeRow[] } {
  const rows: OutcomeRow[] = item.artifacts
    .map((artifact, index) => {
      const stage = stages.find((s) => s.id === artifact.stageId);
      const run = /run \d+ of \d+$/.exec(artifact.title);
      const line = [run ? `${artifact.stageName} · ${run[0]}` : artifact.stageName, stage ? (stage.kind === "people" ? decidersText(stage) : doerName(stage)) : "", filesWords(artifact.files.length)]
        .filter(Boolean)
        .join(" · ");
      return { index, artifact, line };
    })
    .sort((a, b) => a.artifact.at - b.artifact.at);
  const last = rows.length ? rows[rows.length - 1] : null;
  return { last, earlier: rows.slice(0, -1) };
}

/// Who stopped a stopped item, where and why, from its history.
export function stoppedInfo(item: Pick<ProcessItemView, "history" | "stageIndex">, stages: readonly ProcessStage[]): { at?: number; by?: string; why?: string; stage: string } {
  const ev = [...item.history].reverse().find((e) => e.kind === "stopped");
  return { stage: stages[item.stageIndex]?.name ?? "a stage", ...(ev?.at ? { at: ev.at } : {}), ...(ev?.by ? { by: ev.by } : {}), ...(ev?.note ? { why: ev.note } : {}) };
}

export type JourneyTone = "start" | "done" | "redo" | "stuck" | "note" | "now";

/// One line on the Journey tab.
export type JourneyRow = { key: string; title: string; at: number | null; detail?: string; tone: JourneyTone; tag?: "Redo" | "Now" | "Stuck"; artifact?: number };

/// The item's history as a timeline, oldest first: send backs and starts
/// again tagged Redo with why, and a last "Now" line while it's live.
export function journeyRows(item: ProcessItemView, stages: readonly ProcessStage[], nowStatus?: string): JourneyRow[] {
  const name = (id?: string) => (id ? stages.find((s) => s.id === id)?.name : undefined) ?? "a stage";
  let current: string | undefined;
  const rows: JourneyRow[] = [];
  [...item.history]
    .sort((a, b) => a.at - b.at)
    .forEach((ev, i) => {
      const key = `${ev.at}:${i}`;
      const by = ev.by ? ` by ${ev.by}` : "";
      const base = { key, at: ev.at, ...(ev.note ? { detail: ev.note } : {}) };
      switch (ev.kind) {
        case "submitted":
          rows.push({ ...base, title: `Put in${by}`, tone: "start" });
          break;
        case "entered":
          current = ev.stageId;
          rows.push({ ...base, title: `${name(ev.stageId)} started`, tone: "done" });
          break;
        case "finished": {
          const a = artifactForEvent(item, ev);
          rows.push({ ...base, title: `${name(ev.stageId)} finished`, tone: "done", ...(a >= 0 ? { artifact: a } : {}) });
          break;
        }
        case "approved":
          rows.push({ ...base, title: `${ev.by ?? "Someone"} approved`, tone: "done" });
          break;
        case "sentBack":
          rows.push({ ...base, title: `Sent back to ${name(ev.stageId)}${by}`, tone: "redo", tag: "Redo" });
          break;
        case "retried":
          rows.push({ ...base, title: `${name(current)} started again${by}`, tone: "redo", tag: "Redo" });
          break;
        case "moved":
          rows.push({ ...base, title: `Moved to ${name(ev.stageId)}${by}`, tone: "note" });
          break;
        case "blocked":
          rows.push({ ...base, title: `Stuck at ${name(ev.stageId ?? current)}`, tone: "stuck", tag: "Stuck" });
          break;
        case "stopped":
          rows.push({ ...base, title: `Stopped${by}`, tone: "stuck" });
          break;
        case "note":
          rows.push({ ...base, title: ev.by ? `Note from ${ev.by}` : "Note", tone: "note" });
          break;
        case "done":
          rows.push({ ...base, title: "Made it through", tone: "done" });
          break;
      }
    });
  if (item.status === "active") {
    const stage = stages[item.stageIndex];
    rows.push({ key: "now", title: nowStatus ?? item.stageNote ?? "Here now", at: null, detail: stage ? `At ${stage.name}` : undefined, tone: "now", tag: "Now" });
  }
  return rows;
}

/// "Who does what": a badge per stage (W, T, P), who, and how long it took.
export type CrewRow = { stage: ProcessStage; index: number; badge: "W" | "T" | "P"; who: string; took: string };

export function crewRows(item: ProcessItemView, stages: readonly ProcessStage[], doerName: (s: ProcessStage) => string, now = Date.now()): CrewRow[] {
  const times = stageTimes(item, stages, now);
  return stages.map((stage, index) => {
    const t = times[index];
    const badge = stage.kind === "worker" ? "W" : stage.kind === "team" ? "T" : "P";
    const who = stage.kind === "people" ? decidersText(stage) : doerName(stage);
    const took = t.running
      ? `${shortSpan(t.ms)} so far`
      : t.visits
        ? shortSpan(t.ms)
        : item.status === "active" && index === item.stageIndex + 1
          ? "next"
          : item.status === "active" && index > item.stageIndex
            ? "later"
            : "–";
    return { stage, index, badge, who, took };
  });
}

/// "Time so far": each stage's share, and the caption under the bar.
export function timeSplit(item: ProcessItemView, stages: readonly ProcessStage[], now = Date.now()): { total: number; parts: Array<{ index: number; stage: ProcessStage; ms: number }>; caption: string } {
  const times = stageTimes(item, stages, now);
  const parts = stages.map((stage, index) => ({ index, stage, ms: times[index].ms })).filter((p) => p.ms > 0);
  const total = parts.reduce((n, p) => n + p.ms, 0);
  if (!total) return { total: 0, parts: [], caption: "Nothing timed yet." };
  const bits = parts.map((p) => {
    const t = times[p.index];
    const redo = t.redos ? `, including ${t.redos === 1 ? "one redo" : `${t.redos} redos`}` : "";
    return `${p.stage.name} ${shortSpan(p.ms)}${redo}${t.running ? " so far" : ""}`;
  });
  return { total, parts, caption: [`${shortSpan(total)} in all`, ...bits].join(" · ") };
}

// ---- THE PROCESS PAGE ----------------------------------------------------
// One process opened up: a summary line, the flow drawn as cards with the
// ways round it, and either how to start one (nothing in flight) or the
// board, items under the stage they're at.

/// Live items counted for the summary line and the filters.
export function filterCounts(items: readonly ProcessItemView[]): Record<BoardFilter, number> {
  const live = items.filter((i) => i.status === "active");
  return {
    all: live.length,
    you: live.filter((i) => boardFilterHit(i, "you")).length,
    stuck: live.filter((i) => boardFilterHit(i, "stuck")).length,
    mine: live.filter((i) => boardFilterHit(i, "mine")).length,
  };
}

/// The page's figures: live counts, and what finished or stopped in the
/// last 30 days.
export function pageStats(
  items: readonly ProcessItemView[],
  now = Date.now(),
): { inFlight: number; waiting: number; stuck: number; done30: number; stopped30: number } {
  const recent = (i: ProcessItemView) => now - (i.finishedAt ?? i.updatedAt) <= 30 * DAY_MS;
  const c = filterCounts(items);
  return {
    inFlight: c.all,
    waiting: c.you,
    stuck: c.stuck,
    done30: items.filter((i) => i.status === "done" && recent(i)).length,
    stopped30: items.filter((i) => i.status === "stopped" && recent(i)).length,
  };
}

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/// How long each stage takes, from items' history: every finished visit's
/// time (stageTimes), the median of them, and the latest one.
export type StageDuration = { samples: number; medianMs: number | null; lastMs: number | null };

/// Enough finished items to say "usually".
export const USUALLY_AFTER = 3;

export function stageDurations(items: readonly ProcessItemView[], stages: readonly ProcessStage[], now = Date.now()): StageDuration[] {
  const spans: number[][] = stages.map(() => []);
  const last: Array<{ at: number; ms: number } | null> = stages.map(() => null);
  for (const item of items) {
    const times = stageTimes(item, stages, now);
    times.forEach((t, i) => {
      if (!t.visits || t.running) return;
      spans[i].push(t.ms);
      if (!last[i] || item.updatedAt > last[i]!.at) last[i] = { at: item.updatedAt, ms: t.ms };
    });
  }
  return stages.map((_, i) => ({ samples: spans[i].length, medianMs: median(spans[i]), lastMs: last[i]?.ms ?? null }));
}

/// A stage's time in words: "usually 6 h" once enough have been through
/// it, "took 4 h last time" before that, "" when none has.
export function stageTimeWords(d: StageDuration | undefined): string {
  if (!d || !d.samples) return "";
  if (d.samples >= USUALLY_AFTER && d.medianMs !== null) return `usually ${shortSpan(d.medianMs)}`;
  return d.lastMs !== null ? `took ${shortSpan(d.lastMs)} last time` : "";
}

/// End to end, once enough have made it through: the median time from put
/// in to done, and the stage where most of it goes.
export function endToEnd(items: readonly ProcessItemView[], stages: readonly ProcessStage[], now = Date.now()): { typicalMs: number; slowest: string | null } | null {
  const done = items.filter((i) => i.status === "done" && i.finishedAt);
  if (done.length < USUALLY_AFTER) return null;
  const typicalMs = median(done.map((i) => i.finishedAt! - i.createdAt))!;
  const per = stageDurations(done, stages, now);
  let slow = -1;
  per.forEach((d, i) => {
    if (d.medianMs !== null && (slow < 0 || d.medianMs > per[slow].medianMs!)) slow = i;
  });
  return { typicalMs, slowest: slow >= 0 ? stages[slow].name : null };
}

/// "Where items spend their time": each stage's median time from items
/// that made it through, once there are enough; null before.
export function timeBars(items: readonly ProcessItemView[], stages: readonly ProcessStage[], now = Date.now()): Array<{ stage: ProcessStage; ms: number; share: number }> | null {
  const done = items.filter((i) => i.status === "done");
  if (done.length < USUALLY_AFTER) return null;
  const per = stageDurations(done, stages, now);
  const max = Math.max(0, ...per.map((d) => d.medianMs ?? 0));
  return stages.map((stage, i) => {
    const ms = per[i].medianMs ?? 0;
    return { stage, ms, share: max ? ms / max : 0 };
  });
}

function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

type IntakeLike = { schedules?: unknown[]; watches?: Array<{ server: string }> } | null;

/// The ways in as a sentence: "Comes in from this page and a watch on Tracker".
export function waysInPhrase(intake: IntakeLike, slackOn: boolean): string {
  const parts = ["this page"];
  if (slackOn) parts.push("Slack");
  for (const server of [...new Set((intake?.watches ?? []).map((w) => w.server))]) parts.push(`a watch on ${server}`);
  const n = intake?.schedules?.length ?? 0;
  if (n) parts.push(n === 1 ? "a schedule" : `${n} schedules`);
  return `Comes in from ${andList(parts)}`;
}

/// The ways in for the Start card, a word each: "page · Tracker · Slack".
export function waysInShort(intake: IntakeLike, slackOn: boolean): string {
  const parts = ["page", ...new Set((intake?.watches ?? []).map((w) => w.server))];
  if (slackOn) parts.push("Slack");
  if (intake?.schedules?.length) parts.push("schedule");
  return parts.join(" · ");
}

/// The quiet summary line: who owns it, what's moving, what stopped or
/// finished lately, and how it comes in.
export function quietSummary(owner: ProcessPerson, stats: ReturnType<typeof pageStats>, ways: string): string[] {
  const you = owner.name.trim().toLowerCase() === DESKTOP_PERSON.name.toLowerCase();
  const parts = [`Owned by ${you ? "you" : owner.name}`, stats.inFlight ? `${stats.inFlight} in flight` : "Nothing in flight"];
  if (stats.done30) parts.push(`${stats.done30} done this month`);
  if (stats.stopped30) parts.push(`${stats.stopped30} stopped this month`);
  parts.push(ways);
  return parts;
}

/// What a stage does, in a sentence, for the list under the flow: its own
/// words, else the library's.
export function stageSentence(stage: ProcessStage, templateId?: string): string {
  const lib = libraryStageFor(templateId, stage.id);
  return firstSentence(stage.ask?.trim() || stage.why?.trim() || lib?.ask || lib?.why || "");
}

/// One item card's colour: amber when it's your turn, red when stuck.
export function itemTone(item: Pick<ProcessItemView, "yourTurn" | "blocked" | "status">): "you" | "stuck" | "plain" {
  if (item.status !== "active") return "plain";
  if (item.blocked) return "stuck";
  return item.yourTurn ? "you" : "plain";
}

/// A finished or stopped item's track: done up to where it ended, the stage
/// it was stopped at marked stuck.
export function recentTrack(item: Pick<ProcessItemView, "status" | "stageIndex" | "blocked">, stageCount: number): TrackStep[] {
  return itemTrack(item, stageCount).map((t, i) => (item.status === "stopped" && i === item.stageIndex ? "stuck" : t));
}

/// A finished item's outcome in a line: why it was stopped, else the first
/// sentence of what its last stage handed on.
export function outcomeLine(item: ProcessItemView, stages: readonly ProcessStage[]): string {
  if (item.status === "stopped") {
    const s = stoppedInfo(item, stages);
    return `Stopped${s.by ? ` by ${s.by === DESKTOP_PERSON.name ? "you" : s.by}` : ""} at ${s.stage}${s.why ? `: \u201c${firstSentence(s.why, 200)}\u201d` : "."}`;
  }
  const last = [...item.artifacts].sort((a, b) => a.at - b.at).pop();
  const line = firstSentence(last?.summary);
  if (line) return line;
  return item.status === "done" ? "Made it through every stage." : nowLine(item, stages[item.stageIndex]);
}

/// Finished and stopped items from the last `days`, latest first.
export function recentFinished(items: readonly ProcessItemView[], now = Date.now(), days = 30): ProcessItemView[] {
  return items
    .filter((i) => i.status !== "active" && now - (i.finishedAt ?? i.updatedAt) <= days * DAY_MS)
    .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
}

// ---- THE FLOW DIAGRAM ----------------------------------------------------
// Cards in a row: Start, one per stage, End. Solid arrows between them;
// dashed loops round the outside for what goes back: a decision's send back
// and a stage that repeats. Loops are stacked in lanes, below the row first,
// then above, so none overlap.

/// One loop round the outside. `from` and `to` are stage indexes; a repeat
/// loops a stage onto itself.
export type FlowLoop = {
  kind: "sendBack" | "repeat";
  from: number;
  to: number;
  side: "below" | "above";
  /// 1 is the lane nearest the cards.
  level: number;
  label: string;
};

export type FlowPlan = {
  loops: FlowLoop[];
  /// Stages that wait before they start, labelled on their incoming arrow.
  delays: Array<{ index: number; lines: string[] }>;
  /// How many lanes each side needs.
  above: number;
  below: number;
};

/// Which loops a process has and the lane each goes in. Only what the
/// process defines: every decision's send back, every repeat, every wait.
export function flowPlan(stages: readonly ProcessStage[]): FlowPlan {
  const want: Array<Omit<FlowLoop, "side" | "level">> = [];
  stages.forEach((s, i) => {
    if (s.repeat) want.push({ kind: "repeat", from: i, to: i, label: `every ${s.repeat.everyDays} ${s.repeat.everyDays === 1 ? "day" : "days"} \u00d7 ${s.repeat.times}` });
    if (s.kind === "people") want.push({ kind: "sendBack", from: i, to: sendBackIndex({ stages: stages as ProcessStage[] }, i), label: "sent back with what to change" });
  });
  // Shortest first, so the near lanes hold the small loops and longer ones
  // go round them.
  const order = want.map((l, n) => ({ l, n })).sort((a, b) => Math.abs(a.l.from - a.l.to) - Math.abs(b.l.from - b.l.to) || a.n - b.n);
  const taken: Array<{ side: "below" | "above"; level: number; lo: number; hi: number }> = [];
  const placed: Array<{ n: number; loop: FlowLoop }> = [];
  for (const { l, n } of order) {
    const lo = Math.min(l.from, l.to);
    const hi = Math.max(l.from, l.to);
    const sides: Array<"below" | "above"> = l.kind === "repeat" ? ["above", "below"] : ["below", "above"];
    let spot: { side: "below" | "above"; level: number } | null = null;
    for (let level = 1; !spot; level++) {
      for (const side of sides) {
        if (!taken.some((t) => t.side === side && t.level === level && t.lo <= hi && lo <= t.hi)) {
          spot = { side, level };
          break;
        }
      }
    }
    taken.push({ ...spot, lo, hi });
    placed.push({ n, loop: { ...l, ...spot } });
  }
  const loops = placed.sort((a, b) => a.n - b.n).map((p) => p.loop);
  const delays = stages.flatMap((s, index) => (s.delayDays ? [{ index, lines: ["waits", daySpan(s.delayDays)] }] : []));
  return {
    loops,
    delays,
    above: Math.max(0, ...loops.filter((l) => l.side === "above").map((l) => l.level)),
    below: Math.max(0, ...loops.filter((l) => l.side === "below").map((l) => l.level)),
  };
}

/// Lane spacing, and the room a side with no lanes still keeps.
export const FLOW_LANE = 30;
export const FLOW_EDGE = 12;
/// The gap between two cards, where an arrow and a wait's label go.
export const FLOW_GAP = 48;

/// The column grid the flow and the board share: Start, the stages, End.
export function flowColumns(stageCount: number): string {
  return `minmax(104px, 0.65fr) repeat(${Math.max(1, stageCount)}, minmax(168px, 1fr)) minmax(88px, 0.5fr)`;
}

/// The narrowest the grid gets before its box scrolls sideways.
export function flowMinWidth(stageCount: number): number {
  const n = Math.max(1, stageCount);
  return 104 + 88 + n * 168 + (n + 1) * FLOW_GAP;
}

/// The room above and below the cards for the lanes.
export function flowPadding(plan: Pick<FlowPlan, "above" | "below">): { top: number; bottom: number } {
  return { top: FLOW_EDGE + plan.above * FLOW_LANE, bottom: FLOW_EDGE + plan.below * FLOW_LANE };
}

export type FlowRect = { x: number; y: number; w: number; h: number };

export type FlowDrawing = {
  arrows: string[];
  loops: Array<{ d: string; kind: FlowLoop["kind"]; label: string; lx: number; ly: number; side: FlowLoop["side"] }>;
  delays: Array<{ x: number; y: number; lines: string[] }>;
};

/// The paths, from the cards' boxes (Start, each stage, End, in the
/// overlay's own coordinates): an arrow across each gap, each loop out to
/// its lane and back, each label's spot.
export function flowDrawing(plan: FlowPlan, rects: readonly FlowRect[]): FlowDrawing {
  const empty: FlowDrawing = { arrows: [], loops: [], delays: [] };
  if (rects.length < 2) return empty;
  const r = (n: number) => Math.round(n * 10) / 10;
  const arrows: string[] = [];
  for (let i = 0; i < rects.length - 1; i++) {
    const a = rects[i];
    const b = rects[i + 1];
    const y = r(a.y + a.h / 2);
    arrows.push(`M ${r(a.x + a.w)} ${y} L ${r(b.x - 2)} ${y}`);
  }
  const top = Math.min(...rects.map((c) => c.y));
  const bottom = Math.max(...rects.map((c) => c.y + c.h));
  const loops = plan.loops.flatMap((l) => {
    const src = rects[l.from + 1];
    const dst = rects[l.to + 1];
    if (!src || !dst) return [];
    const step = 0.07 * (l.level - 1);
    const self = l.from === l.to;
    const sx = r(src.x + src.w * (self ? 0.62 + step : 0.7 + step));
    const tx = r(dst.x + dst.w * (self ? 0.38 - step : 0.3 - step));
    const below = l.side === "below";
    const lane = r(below ? bottom + l.level * FLOW_LANE : top - l.level * FLOW_LANE);
    const sy = r(below ? src.y + src.h : src.y);
    const ty = r(below ? dst.y + dst.h + 2 : dst.y - 2);
    return [{ d: `M ${sx} ${sy} L ${sx} ${lane} L ${tx} ${lane} L ${tx} ${ty}`, kind: l.kind, label: l.label, lx: r((sx + tx) / 2), ly: lane, side: l.side }];
  });
  const delays = plan.delays.flatMap((d) => {
    const a = rects[d.index];
    const b = rects[d.index + 1];
    if (!a || !b) return [];
    return [{ x: r((a.x + a.w + b.x) / 2), y: r(b.y + b.h / 2), lines: d.lines }];
  });
  return { arrows, loops, delays };
}
