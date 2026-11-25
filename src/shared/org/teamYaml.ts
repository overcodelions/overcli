// A team as a file, to bring it to another server or keep it in a repo: its
// members by name, how it checks in, and how it should work, and each
// member's own worker file under `worker_files`. Reading one only drafts: the
// Make a team form opens with it. A member already here is used as it is; one
// that isn't is hired from its file when the team is made, under the same
// rules as publishing a worker, so a file can't put on a worker its author
// couldn't.

import { parse, stringify } from 'yaml';
import { MAX_YAML_CHARS, byName, text } from './processYaml';

export interface TeamYamlDraft {
  name: string;
  shortName?: string;
  purpose?: string;
  guidance?: string;
  budgetUSDPerTask?: number;
  workIn?: string;
  whoCanBrief?: 'managers' | 'team' | 'org';
  piecesAskFirst?: boolean;
  checkpoints?: { askFirst?: boolean; reviewBeforeChallenge?: boolean; finalReview?: boolean; approveRoomWork?: boolean };
  members: Array<{ workerId: string; name: string; role: string }>;
  /// Members not here yet whose worker file the team file carries: hired
  /// from it when the team is made.
  bring?: Array<{ name: string; role: string }>;
}

/// A member's worker file as the team file carries it. `sourceId`: its id
/// where it came from, so importing again finds the one already hired.
export interface TeamWorkerFile {
  name: string;
  sourceId?: string;
  yaml: string;
}

/// A team file with its members' worker files is far bigger than one without.
export const MAX_TEAM_FILE_CHARS = 12_000_000;

export interface TeamYamlMissing {
  workers: string[];
  places: string[];
}

const TOP_KEYS = new Set(['name', 'short_name', 'purpose', 'guidance', 'budget_per_task', 'works_in', 'who_can_give_tasks', 'pieces_ask_first', 'checkpoints', 'members', 'worker_files']);
const CHECKS = { ask_first: 'askFirst', read_draft_first: 'reviewBeforeChallenge', final_review: 'finalReview', approve_follow_up_work: 'approveRoomWork' } as const;

export function teamFromYaml(
  source: string,
  names: { workers: ReadonlyArray<{ id: string; name: string }>; places?: readonly string[] },
): { ok: true; draft: TeamYamlDraft; notes: string[]; missing: TeamYamlMissing } | { ok: false; error: string } {
  const read = readTeamDoc(source);
  if (!read.ok) return read;
  const doc = read.doc;
  const name = text(doc.name);
  if (!name) return { ok: false, error: 'Give the team a name: `name: Design Team`.' };
  if (!Array.isArray(doc.members) || !doc.members.length) return { ok: false, error: 'List its members under `members:`.' };

  const notes: string[] = [];
  const missing: TeamYamlMissing = { workers: [], places: [] };
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) notes.push(`Ignored \`${k}\`: it isn’t something a team file sets.`);

  const files = workerFilesIn(doc);
  const members: TeamYamlDraft['members'] = [];
  const bring: NonNullable<TeamYamlDraft['bring']> = [];
  for (const m of doc.members) {
    const r = (typeof m === 'string' ? { worker: m } : (m ?? {})) as { worker?: unknown; role?: unknown };
    const who = text(r.worker);
    if (!who) {
      notes.push('A member doesn’t say which worker it is.');
      continue;
    }
    const hit = byName(names.workers, who);
    if (hit === 'none') {
      const key = who.toLowerCase();
      if (bring.some((x) => x.name.toLowerCase() === key)) notes.push(`${who} is listed twice.`);
      else if (files.some((f) => f.name.toLowerCase() === key)) bring.push({ name: files.find((f) => f.name.toLowerCase() === key)!.name, role: text(r.role) });
      else {
        notes.push(`No worker called ${who} that you can see, and the file doesn’t carry theirs.`);
        missing.workers.push(who);
      }
    } else if (hit === 'several') notes.push(`More than one worker is called ${who}, so pick one in the form.`);
    else if (members.some((x) => x.workerId === hit.id)) notes.push(`${hit.name} is listed twice.`);
    else members.push({ workerId: hit.id, name: hit.name, role: text(r.role) });
  }

  const draft: TeamYamlDraft = { name, members };
  if (bring.length) draft.bring = bring;
  if (text(doc.short_name)) draft.shortName = text(doc.short_name);
  if (text(doc.purpose)) draft.purpose = text(doc.purpose);
  if (text(doc.guidance)) draft.guidance = text(doc.guidance);
  if (doc.budget_per_task !== undefined) {
    if (typeof doc.budget_per_task === 'number' && doc.budget_per_task > 0) draft.budgetUSDPerTask = doc.budget_per_task;
    else notes.push('`budget_per_task` is a number of dollars above 0.');
  }
  const place = text(doc.works_in);
  if (place) {
    if (names.places && !names.places.includes(place)) {
      notes.push(`No connected repo or workspace called ${place}.`);
      missing.places.push(place);
    } else draft.workIn = place;
  }
  const who = text(doc.who_can_give_tasks);
  if (who === 'managers' || who === 'team' || who === 'org') draft.whoCanBrief = who;
  else if (who) notes.push('`who_can_give_tasks` is managers, team or org.');
  if (typeof doc.pieces_ask_first === 'boolean') draft.piecesAskFirst = doc.pieces_ask_first;
  if (doc.checkpoints && typeof doc.checkpoints === 'object') {
    const checks: NonNullable<TeamYamlDraft['checkpoints']> = {};
    for (const [k, v] of Object.entries(doc.checkpoints as Record<string, unknown>)) {
      const key = CHECKS[k as keyof typeof CHECKS];
      if (key && typeof v === 'boolean') checks[key] = v;
      else notes.push(`Ignored \`${k}\` under checkpoints.`);
    }
    draft.checkpoints = checks;
  }
  return { ok: true, draft, notes, missing };
}

function readTeamDoc(source: string): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  if (!source.trim()) return { ok: false, error: 'Paste the team’s YAML first.' };
  // Its members' worker files may make it long; the team itself is short.
  if (source.length > MAX_TEAM_FILE_CHARS) return { ok: false, error: 'That’s too long to be one team.' };
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (err) {
    return { ok: false, error: `That isn’t valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'A team file starts with its name and members.' };
  const doc = raw as Record<string, unknown>;
  // Without the worker files, what's left is held to a process file's size.
  const rest = { ...doc };
  delete rest.worker_files;
  if (stringify(rest).length > MAX_YAML_CHARS) return { ok: false, error: 'That’s too long to be one team.' };
  return { ok: true, doc };
}

function workerFilesIn(doc: Record<string, unknown>): TeamWorkerFile[] {
  if (!Array.isArray(doc.worker_files)) return [];
  return doc.worker_files.flatMap((x): TeamWorkerFile[] => {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
    const name = text(o.worker);
    const yaml = typeof o.file === 'string' ? o.file : '';
    if (!name || !yaml.trim()) return [];
    const id = text(o.id);
    return [{ name, yaml, ...(id ? { sourceId: id } : {}) }];
  });
}

/// The worker files a team file carries, for hiring the members that aren't
/// here when the team is made.
export function teamWorkerFiles(source: string): { ok: true; files: TeamWorkerFile[] } | { ok: false; error: string } {
  const read = readTeamDoc(source);
  return read.ok ? { ok: true, files: workerFilesIn(read.doc) } : read;
}

/// A team as its file. Round-trips through `teamFromYaml`. Who was picked to
/// give it tasks stays behind: those are people on this server. `workerFiles`:
/// its members' own files, so the other server can hire any it lacks.
export function teamToYaml(t: {
  name: string;
  shortName?: string;
  shortNameAuto?: boolean;
  purpose?: string;
  guidance?: string;
  budgetUSDPerTask: number;
  workInLabel?: string;
  whoCanBrief?: string;
  piecesAskFirst?: boolean;
  checkpoints: { askFirst?: boolean; reviewBeforeChallenge?: boolean; finalReview?: boolean; approveRoomWork?: boolean };
  members: ReadonlyArray<{ name: string; role?: string }>;
}, workerFiles: readonly TeamWorkerFile[] = []): string {
  const doc: Record<string, unknown> = { name: t.name };
  if (t.shortName && !t.shortNameAuto) doc.short_name = t.shortName;
  if (t.purpose) doc.purpose = t.purpose;
  doc.members = t.members.map((m) => ({ worker: m.name, ...(m.role ? { role: m.role } : {}) }));
  doc.budget_per_task = t.budgetUSDPerTask;
  const place = t.workInLabel?.replace(/^(?:Repo|Workspace): /, '');
  if (place && place !== t.workInLabel) doc.works_in = place;
  if (t.whoCanBrief) doc.who_can_give_tasks = t.whoCanBrief;
  if (t.piecesAskFirst !== undefined) doc.pieces_ask_first = t.piecesAskFirst;
  doc.checkpoints = {
    ask_first: !!t.checkpoints.askFirst,
    read_draft_first: !!t.checkpoints.reviewBeforeChallenge,
    final_review: !!t.checkpoints.finalReview,
    approve_follow_up_work: t.checkpoints.approveRoomWork !== false,
  };
  if (t.guidance) doc.guidance = t.guidance;
  // Last: long, and only read when a member isn't on the other server.
  if (workerFiles.length) doc.worker_files = workerFiles.map((f) => ({ worker: f.name, ...(f.sourceId ? { id: f.sourceId } : {}), file: f.yaml }));
  return stringify(doc, { lineWidth: 0 });
}

