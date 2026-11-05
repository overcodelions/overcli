// A process as a file you can read and write: stages by the names people use,
// not ids. Reading one only drafts: the editor opens with it, and saving goes
// through the same checks as any other save, so a file can't do what its
// author couldn't. What can't be matched is said, never guessed.

import { parse, stringify } from 'yaml';
import type { ProcessAccess, ProcessDef, ProcessField, ProcessPerson, ProcessStage } from './process';

export interface ProcessYamlNames {
  teams: ReadonlyArray<{ id: string; name: string }>;
  workers: ReadonlyArray<{ id: string; name: string }>;
  /// `handle`: their Slack handle, which a file can use in place of the name.
  people: ReadonlyArray<{ name: string; slackUserId?: string; handle?: string }>;
  groups?: ReadonlyArray<{ id: string; name: string }>;
  /// Connected repos and workspaces, by name. Absent: not checked here.
  places?: readonly string[];
  /// The stages of the process it replaces: a stage keeps its id by its name,
  /// so items already at it stay where they are.
  existingStages?: ReadonlyArray<{ id: string; name: string }>;
}

/// As the editor holds a process: `codeIn` by name, stages ready to save.
export interface ProcessYamlDraft {
  name: string;
  shortName?: string;
  purpose?: string;
  about?: string;
  owner?: ProcessPerson;
  access?: unknown;
  codeIn?: string | null;
  stages: ProcessStage[];
}

export const MAX_YAML_CHARS = 100_000;
const MAX_STAGES = 20;

const PROCESS_KEYS = new Set(['name', 'short_name', 'purpose', 'about', 'owner', 'access', 'code_in', 'stages']);
const STAGE_KEYS = new Set(['name', 'team', 'worker', 'lead', 'job', 'why', 'decide', 'needs', 'fields', 'send_back_to', 'delay_days', 'repeat']);

export const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(text).filter(Boolean);

/// One entry by name, or why there isn't one.
export function byName<T extends { name: string }>(all: ReadonlyArray<T>, name: string): T | 'none' | 'several' {
  const hits = all.filter((x) => same(x.name, name));
  return hits.length === 1 ? hits[0] : hits.length ? 'several' : 'none';
}

/// What a file names that doesn't exist here: what to set up before it can be
/// saved, as opposed to what only needs a look.
export interface ProcessYamlMissing {
  teams: string[];
  workers: string[];
  people: string[];
  places: string[];
}

export function processFromYaml(source: string, names: ProcessYamlNames): { ok: true; draft: ProcessYamlDraft; notes: string[]; missing: ProcessYamlMissing } | { ok: false; error: string } {
  if (!source.trim()) return { ok: false, error: 'Paste the process’s YAML first.' };
  if (source.length > MAX_YAML_CHARS) return { ok: false, error: 'That’s too long to be one process.' };
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (err) {
    return { ok: false, error: `That isn’t valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'A process file starts with its name and stages.' };
  const doc = raw as Record<string, unknown>;
  const name = text(doc.name);
  if (!name) return { ok: false, error: 'Give the process a name: `name: Idea to launch`.' };
  if (!Array.isArray(doc.stages) || !doc.stages.length) return { ok: false, error: 'List its stages under `stages:`.' };
  if (doc.stages.length > MAX_STAGES) return { ok: false, error: `A process can have at most ${MAX_STAGES} stages.` };

  const notes: string[] = [];
  const missing: ProcessYamlMissing = { teams: [], workers: [], people: [], places: [] };
  const lacks = (list: string[], name: string) => {
    if (!list.some((x) => same(x, name))) list.push(name);
  };
  const ignored = (keys: string[], allowed: Set<string>, where: string) => {
    for (const k of keys) if (!allowed.has(k)) notes.push(`Ignored \`${k}\` ${where}: it isn’t something a process file sets.`);
  };
  ignored(Object.keys(doc), PROCESS_KEYS, 'at the top');

  const person = (who: string, where: string): ProcessPerson | undefined => {
    const handle = who.replace(/^@/, '');
    const named = byName(names.people, who);
    const byHandle = names.people.filter((p) => !!p.handle && same(p.handle, handle));
    const hit = named === 'none' && byHandle.length === 1 ? byHandle[0] : named === 'none' && byHandle.length > 1 ? 'several' : named;
    if (hit === 'several') {
      notes.push(`More than one person is called ${who}, so pick ${where} in the editor.`);
      return undefined;
    }
    if (hit === 'none') {
      notes.push(`Nobody called ${who} in Slack here, so pick ${where} in the editor.`);
      lacks(missing.people, who);
      return undefined;
    }
    return { name: hit.name, ...(hit.slackUserId ? { slackUserId: hit.slackUserId } : {}) };
  };

  // Stage ids first, so a send-back can name a stage further down.
  const rows = doc.stages.map((s) => (s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}));
  const used = new Set<string>();
  const ids = rows.map((r, i) => {
    const stageName = text(r.name);
    const kept = names.existingStages?.find((e) => same(e.name, stageName))?.id;
    const made = kept && !used.has(kept) ? kept : `s${i + 1}-${stageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'stage'}`;
    used.add(made);
    return made;
  });

  const stages = rows.map((r, i): ProcessStage => {
    const stageName = text(r.name);
    const label = stageName || `Stage ${i + 1}`;
    if (!stageName) notes.push(`${label} has no name.`);
    ignored(Object.keys(r), STAGE_KEYS, `on ${label}`);
    if (rows.some((o, j) => j < i && same(text(o.name), stageName)) && stageName) notes.push(`Two stages are called ${stageName}: rename one.`);

    const hasTeam = r.team !== undefined;
    const hasWorker = r.worker !== undefined;
    const hasPeople = r.decide !== undefined || r.fields !== undefined;
    if (Number(hasTeam) + Number(hasWorker) + Number(hasPeople) > 1) notes.push(`${label} names more than one of team, worker and decide: it uses ${hasTeam ? 'the team' : 'the worker'}.`);
    if (!hasTeam && !hasWorker && !hasPeople) notes.push(`${label} doesn’t say who does it: give it a team, a worker or \`decide\`.`);

    const stage: ProcessStage = { id: ids[i], name: stageName, kind: hasWorker && !hasTeam ? 'worker' : !hasTeam && hasPeople ? 'people' : 'team' };
    const job = text(r.job);
    if (job) stage.ask = job;
    const why = text(r.why);
    if (why) stage.why = why;

    if (stage.kind === 'team' && hasTeam) {
      const hit = byName(names.teams, text(r.team));
      if (typeof hit === 'object') stage.teamId = hit.id;
      else {
        notes.push(`${label}: ${hit === 'several' ? `more than one team is called ${text(r.team)}` : `no team called ${text(r.team)} that you can see`}. Pick one in the editor.`);
        if (hit === 'none') lacks(missing.teams, text(r.team));
      }
    }
    if (stage.kind === 'worker') {
      const hit = byName(names.workers, text(r.worker));
      if (typeof hit === 'object') stage.workerId = hit.id;
      else {
        notes.push(`${label}: ${hit === 'several' ? `more than one worker is called ${text(r.worker)}` : `no worker called ${text(r.worker)} that you can see`}. Pick one in the editor.`);
        if (hit === 'none') lacks(missing.workers, text(r.worker));
      }
    }
    if (stage.kind !== 'people' && text(r.lead)) {
      const lead = person(text(r.lead), `the lead of ${label}`);
      if (lead) stage.owner = lead;
    }
    if (stage.kind === 'people') {
      const approvers: ProcessPerson[] = [];
      const groups: Array<{ id: string; name: string }> = [];
      for (const who of listOf(r.decide)) {
        const group = byName(names.groups ?? [], who);
        if (typeof group === 'object' && byName(names.people, who) === 'none') groups.push({ id: group.id, name: group.name });
        else {
          const p = person(who, `who decides ${label}`);
          if (p) approvers.push(p);
        }
      }
      stage.approvers = approvers;
      if (groups.length) stage.approverGroups = groups;
      if (r.needs === 'all' || (typeof r.needs === 'number' && Number.isInteger(r.needs) && r.needs > 1)) stage.needs = r.needs;
      else if (r.needs !== undefined && r.needs !== 'any' && r.needs !== 1) notes.push(`${label}: \`needs\` is any, all or a number.`);
      const fields = fieldsFrom(r.fields);
      if (fields.length) {
        stage.mode = 'input';
        stage.fields = fields;
      }
    }
    const back = text(r.send_back_to);
    if (back) {
      const at = rows.findIndex((o) => same(text(o.name), back));
      if (at >= 0) stage.sendBackTo = ids[at];
      else notes.push(`${label} sends back to ${back}, and there’s no stage called that.`);
    }
    if (typeof r.delay_days === 'number' && r.delay_days > 0) stage.delayDays = r.delay_days;
    const repeat = r.repeat as { every_days?: unknown; times?: unknown } | undefined;
    if (repeat && typeof repeat.every_days === 'number' && typeof repeat.times === 'number') stage.repeat = { everyDays: repeat.every_days, times: repeat.times };
    return stage;
  });

  const draft: ProcessYamlDraft = { name, stages };
  if (text(doc.short_name)) draft.shortName = text(doc.short_name);
  if (text(doc.purpose)) draft.purpose = text(doc.purpose);
  if (text(doc.about)) draft.about = text(doc.about);
  if (text(doc.owner)) {
    const owner = person(text(doc.owner), 'its owner');
    if (owner) draft.owner = owner;
  }
  if (doc.code_in !== undefined) {
    const place = text(doc.code_in);
    if (place && names.places && !names.places.includes(place)) {
      notes.push(`No connected repo or workspace called ${place}, so pick where its code lives in the editor.`);
      lacks(missing.places, place);
    } else draft.codeIn = place || null;
  }
  if (doc.access !== undefined) {
    const access = accessFrom(doc.access, person, names, notes);
    if (access) draft.access = access;
  }
  return { ok: true, draft, notes, missing };
}

function fieldsFrom(raw: unknown): ProcessField[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f, i): ProcessField => {
    const r = (typeof f === 'string' ? { label: f } : (f ?? {})) as { label?: unknown; kind?: unknown; options?: unknown; required?: unknown };
    const kind = r.kind === 'longText' || r.kind === 'choice' ? r.kind : 'text';
    const options = listOf(r.options);
    return {
      id: `f${i + 1}`,
      label: text(r.label),
      kind,
      ...(kind === 'choice' && options.length ? { options } : {}),
      ...(r.required === true ? { required: true } : {}),
    };
  });
}

/// `private`, `everyone`, or who by name. What's set is checked when it's saved.
function accessFrom(raw: unknown, person: (who: string, where: string) => ProcessPerson | undefined, names: ProcessYamlNames, notes: string[]): unknown {
  if (typeof raw === 'string') return { who: raw.trim() };
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { who?: unknown; people?: unknown; groups?: unknown; roles?: unknown };
  const groups = listOf(r.groups).flatMap((g) => {
    const hit = byName(names.groups ?? [], g);
    if (typeof hit === 'object') return [{ id: hit.id, name: hit.name }];
    notes.push(`No group called ${g}, so pick who can start it in the editor.`);
    return [];
  });
  const people = listOf(r.people).flatMap((p) => {
    const hit = person(p, 'who can start it');
    return hit ? [hit] : [];
  });
  return { who: text(r.who), ...(groups.length ? { groups } : {}), ...(people.length ? { people } : {}), ...(listOf(r.roles).length ? { roles: listOf(r.roles) } : {}) };
}

/// A process as its file. Round-trips through `processFromYaml`.
export function processToYaml(def: Pick<ProcessDef, 'name' | 'shortName' | 'shortNameAuto' | 'purpose' | 'about' | 'owner' | 'access' | 'codeIn' | 'stages'>, names: Pick<ProcessYamlNames, 'teams' | 'workers'>): string {
  const nameOf = (all: ReadonlyArray<{ id: string; name: string }>, id: string | undefined) => all.find((x) => x.id === id)?.name;
  const doc: Record<string, unknown> = { name: def.name };
  if (def.shortName && !def.shortNameAuto) doc.short_name = def.shortName;
  if (def.purpose) doc.purpose = def.purpose;
  if (def.about) doc.about = def.about;
  doc.owner = def.owner.name;
  if (def.access) doc.access = accessToYaml(def.access);
  if (def.codeIn) doc.code_in = def.codeIn.name;
  doc.stages = def.stages.map((s) => {
    const out: Record<string, unknown> = { name: s.name };
    if (s.kind === 'team') out.team = nameOf(names.teams, s.teamId) ?? '';
    if (s.kind === 'worker') out.worker = nameOf(names.workers, s.workerId) ?? '';
    if (s.kind !== 'people' && s.owner) out.lead = s.owner.name;
    if (s.kind === 'people') out.decide = [...(s.approvers ?? []).map((a) => a.name), ...(s.approverGroups ?? []).map((g) => g.name)];
    if (s.needs !== undefined && s.needs !== 'any') out.needs = s.needs;
    if (s.fields?.length) out.fields = s.fields.map((f) => ({ label: f.label, kind: f.kind, ...(f.options?.length ? { options: f.options } : {}), ...(f.required ? { required: true } : {}) }));
    if (s.ask) out.job = s.ask;
    if (s.why) out.why = s.why;
    const back = def.stages.find((o) => o.id === s.sendBackTo);
    if (back) out.send_back_to = back.name;
    if (s.delayDays) out.delay_days = s.delayDays;
    if (s.repeat) out.repeat = { every_days: s.repeat.everyDays, times: s.repeat.times };
    return out;
  });
  return stringify(doc, { lineWidth: 0 });
}

function accessToYaml(access: ProcessAccess): unknown {
  if (access.who === 'private' || access.who === 'everyone') return access.who;
  return {
    who: access.who,
    ...(access.groups?.length ? { groups: access.groups.map((g) => g.name) } : {}),
    ...(access.people?.length ? { people: access.people.map((p) => p.name) } : {}),
    ...(access.roles?.length ? { roles: access.roles } : {}),
  };
}
