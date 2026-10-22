// A process drafted from a picture: a flowchart, a swimlane, a slide someone
// found online. One model turn reads the diagram and lists its boxes as
// stages, in order; this file reads that answer leniently, cleans it to what
// a process can hold, and suggests which of your teams or workers does each
// stage, with the same matching the library uses (suggestTeamFor). Nothing is
// saved: the editor opens with the draft and the person checks it.

import fs from 'node:fs';
import path from 'node:path';
import { oneShotDraftText, type DraftDeps } from '../flows/drafter';
import { suggestTeamFor, type LibraryStage } from '../../shared/org/processLibrary';
import type { ProcessPerson, ProcessStage, ProcessStageKind } from '../../shared/org/process';
import type { Attachment } from '../../shared/types';

/// A drafted stage: a process stage, plus who the picture says does it when
/// none of yours clearly fits ("Legal reviewer").
export type DraftedStage = ProcessStage & { suggestedRole?: string };

export interface ProcessDraft {
  name: string;
  about?: string;
  stages: DraftedStage[];
}

export type ProcessDraftResult = { ok: true; draft: ProcessDraft; notes: string[] } | { ok: false; error: string };

export interface DraftTeam {
  id: string;
  name: string;
  purpose?: string;
  members?: Array<{ role?: string }>;
}

export interface DraftWorker {
  id: string;
  name: string;
  tagline?: string;
}

export interface ProcessImageInput {
  image: Attachment;
  /// What to change, in the person's words: "use our Product Team for design".
  note?: string;
  teams: readonly DraftTeam[];
  workers: readonly DraftWorker[];
  /// People who can decide, for a decision box that names someone.
  people?: readonly ProcessPerson[];
}

export const MAX_DRAFT_STAGES = 12;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/// A pasted or picked picture, as a data URL, checked: one of the image
/// kinds the models read, and no bigger than MAX_IMAGE_BYTES.
export function imageFromDataUrl(raw: unknown): { ok: true; image: Attachment } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.startsWith('data:')) return { ok: false, error: 'Add a picture of the process: a PNG, JPEG, WebP or GIF.' };
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (!m) return { ok: false, error: 'That isn’t a picture overcli can read. Use a PNG, JPEG, WebP or GIF.' };
  const data = m[2].replace(/\s+/g, '');
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) return { ok: false, error: `That picture is ${(bytes / 1024 / 1024).toFixed(1)} MB. Use one under 5 MB: a screenshot of the diagram is plenty.` };
  if (bytes < 64) return { ok: false, error: 'That picture is empty.' };
  const mimeType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  return { ok: true, image: { id: 'process-diagram', mimeType, dataBase64: data, label: 'process diagram', size: bytes } };
}

/// A picture on disk (the desktop's file picker), checked the same way.
export function imageFromFile(file: string): { ok: true; image: Attachment } | { ok: false; error: string } {
  const type = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
  if (!type) return { ok: false, error: 'That isn’t a picture overcli can read. Use a PNG, JPEG, WebP or GIF.' };
  let data: Buffer;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_IMAGE_BYTES) return { ok: false, error: `That picture is ${(size / 1024 / 1024).toFixed(1)} MB. Use one under 5 MB: a screenshot of the diagram is plenty.` };
    data = fs.readFileSync(file);
  } catch {
    return { ok: false, error: 'Couldn’t read that file.' };
  }
  return imageFromDataUrl(`data:${type};base64,${data.toString('base64')}`);
}

const SYSTEM = [
  'You turn a picture of a business process (a flowchart, a swimlane, a RACI-style chart, a slide) into the stages of a process in a work tool.',
  'In the tool, each stage is done by one of:',
  '- "team": a team of AI workers that produces something (a document, a review, a build);',
  '- "worker": one AI worker, for a small step one worker can do alone;',
  '- "people": people decide: approve it, send it back, or stop it.',
  '',
  'Read the diagram and list its steps as stages, in the order work moves through them:',
  '- Each box or step that does work is a "team" stage (a "worker" stage only when it is clearly one small task).',
  '- Decision diamonds, approvals, sign-offs, reviews by a named role or a gate ("Approved?", "Go / no go") are "people" stages.',
  '- An arrow that loops back ("rework", "reject", "no", "changes needed") from a decision to an earlier step is that decision\'s sendBackTo: the number of the earlier stage it returns to.',
  '- A wait or a duration on an arrow or step ("after 2 weeks", "30 days later") is delayDays on the stage that waits, in whole days.',
  '- A step that recurs ("weekly for 4 weeks", "monthly check-in x3") is repeat: {"everyDays": days apart, "times": how many runs}.',
  '- Parallel branches: list their stages one after another in a sensible order, and add a note saying the picture runs them in parallel.',
  '- A swimlane or role label ("Legal", "Finance", "Design team") says who does the steps in it: put it in role.',
  '- Start and end markers ("Start", "End", "Done") are not stages. Ignore titles, logos, legends, watermarks and decorative text.',
  'Never invent a stage that is not in the picture. If the picture is not a process at all, return no stages and say so in notes.',
  `Keep names short and plain (2 to 4 words, sentence case). At most ${MAX_DRAFT_STAGES} stages: if there are more, keep the main path and say what you left out.`,
  'ask: one or two sentences, what the stage should produce, or for people what they look for when deciding.',
  'team / worker: the number of one of the listed teams or workers only when it clearly does that step; otherwise null.',
  'deciders: for a people stage, the numbers of listed people the picture names as deciding; otherwise [].',
  'input: a step where people add something rather than decide (a form, data, feedback); ask is what they add, deciders who adds it.',
  'If the person added a note, follow it: it may rename stages, pick a team, or leave something out.',
  '',
  'Answer with JSON only, no prose and no code fence:',
  '{"name": "<short process name>", "about": "<one sentence: what goes in and what comes out>",',
  ' "stages": [{"name": "...", "kind": "team" | "worker" | "people" | "input", "ask": "...", "role": "<who does it in the picture, or empty>",',
  '   "team": <number or null>, "worker": <number or null>, "deciders": [<numbers>], "sendBackTo": <stage number or null>,',
  '   "delayDays": <number or null>, "repeat": {"everyDays": <n>, "times": <n>} or null}],',
  ' "notes": ["<what was unclear or left out, each under 25 words>"]}',
].join('\n');

export function processImagePrompt(input: Omit<ProcessImageInput, 'image'>): string {
  const teams = input.teams.slice(0, 40).map((t, i) => `${i + 1}. ${t.name}${t.purpose ? ` — ${t.purpose.replace(/\s+/g, ' ').slice(0, 200)}` : ''}${t.members?.length ? ` (roles: ${t.members.map((m) => m.role).filter(Boolean).slice(0, 8).join(', ')})` : ''}`);
  const workers = input.workers.slice(0, 40).map((w, i) => `${i + 1}. ${w.name}${w.tagline ? ` — ${w.tagline.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
  const people = (input.people ?? []).slice(0, 60).map((p, i) => `${i + 1}. ${p.name}`);
  return [
    'The diagram is the attached image.',
    input.note?.trim() ? `\nThe person's note: ${input.note.trim().slice(0, 1000)}` : '',
    `\nTeams:\n${teams.join('\n') || '(none yet)'}`,
    `\nWorkers:\n${workers.join('\n') || '(none yet)'}`,
    people.length ? `\nPeople:\n${people.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/// The first whole JSON object in a reply, braces balanced outside strings,
/// so a sentence before it or after it doesn't matter.
export function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function text(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function num(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function kindOf(raw: unknown): ProcessStageKind {
  const k = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (k === 'people' || k === 'decision' || k === 'approval' || k === 'person' || isInput(k)) return 'people';
  if (k === 'worker') return 'worker';
  return 'team';
}

/// A people step that gathers something rather than deciding: "form",
/// "input", "feedback". Its one field is what the step asks, to be edited.
function isInput(raw: unknown): boolean {
  const k = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return k === 'input' || k === 'form' || k === 'feedback' || k === 'data';
}

/// Words in a stage that say what it is about, for matching it to a team.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'stage', 'step', 'review', 'check', 'final', 'first', 'next', 'then', 'team', 'make', 'send', 'what', 'this', 'that', 'should', 'produce']);
function subjectWords(...parts: string[]): string[] {
  return [...new Set(parts.join(' ').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !STOP.has(w)))];
}

/// Who does a stage, when one of yours clearly fits: a team for a team
/// stage, a worker for a worker stage, matched on the stage's name and the
/// role the picture gives, as the library matches its stages.
export function suggestDoer(stage: Pick<DraftedStage, 'kind' | 'name' | 'ask'> & { role?: string }, teams: readonly DraftTeam[], workers: readonly DraftWorker[]): { teamId?: string; workerId?: string } {
  if (stage.kind === 'people') return {};
  const probe: LibraryStage = {
    key: 'probe',
    name: stage.name,
    kind: 'team',
    ask: stage.ask ?? '',
    why: '',
    who: stage.role ?? '',
    words: subjectWords(stage.name, stage.role ?? ''),
    crew: stage.role ? [stage.role] : [],
  };
  if (stage.kind === 'team') {
    const hit = suggestTeamFor(probe, teams);
    return hit ? { teamId: hit.team.id } : {};
  }
  const hit = suggestTeamFor(probe, workers.map((w) => ({ id: w.id, name: w.name, purpose: w.tagline })));
  return hit ? { workerId: hit.team.id } : {};
}

/// The model's answer as a draft: kinds, lengths and numbers checked, links
/// back kept only to an earlier stage that does work, and each stage's doer
/// picked from the lists (the model's pick, else a clear match), else left
/// for the person with the role the picture gives.
export function readProcessDraft(reply: string, input: Omit<ProcessImageInput, 'image'>): ProcessDraftResult {
  const parsed = firstJsonObject(reply);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'The diagram couldn’t be read. Try a sharper picture, or crop it to the process.' };
  const o = parsed as Record<string, unknown>;
  const notes = (Array.isArray(o.notes) ? o.notes : []).map((n) => text(n, 240)).filter(Boolean).slice(0, 6);
  const raw = (Array.isArray(o.stages) ? o.stages : []).filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s) && !!text((s as Record<string, unknown>).name, 60));
  if (!raw.length) return { ok: false, error: notes[0] ?? 'No process steps showed up in that picture. Try one that shows the steps as boxes or a list.' };
  if (raw.length > MAX_DRAFT_STAGES) notes.push(`The picture has ${raw.length} steps; the first ${MAX_DRAFT_STAGES} are here. Add the rest by hand.`);
  const kept = raw.slice(0, MAX_DRAFT_STAGES);
  const stages: DraftedStage[] = kept.map((s, i) => {
    const kind = kindOf(s.kind);
    const name = text(s.name, 60);
    const ask = text(s.ask, 600);
    const role = text(s.role, 60);
    const stage: DraftedStage = { id: `d${i + 1}`, name, kind, ...(ask ? { ask } : {}) };
    if (kind === 'people') {
      if (isInput(s.kind)) {
        stage.mode = 'input';
        stage.fields = [{ id: 'f1', label: ask || name, kind: 'longText', required: true }];
      }
      const picked = (Array.isArray(s.deciders) ? s.deciders : []).map(num).filter((n): n is number => n !== null && Number.isInteger(n));
      const approvers = [...new Set(picked)].map((n) => input.people?.[n - 1]).filter((p): p is ProcessPerson => !!p).slice(0, 10);
      stage.approvers = approvers.map((p) => ({ name: p.name, ...(p.slackUserId ? { slackUserId: p.slackUserId } : {}) }));
    } else {
      const delay = num(s.delayDays);
      if (delay !== null && delay >= 1) stage.delayDays = Math.min(365, Math.round(delay));
      const rep = s.repeat && typeof s.repeat === 'object' ? (s.repeat as Record<string, unknown>) : null;
      const every = rep ? num(rep.everyDays) : null;
      const times = rep ? num(rep.times) : null;
      if (every !== null && times !== null && times >= 2) stage.repeat = { everyDays: Math.max(1, Math.min(90, Math.round(every))), times: Math.min(52, Math.round(times)) };
      const n = num(kind === 'team' ? s.team : s.worker);
      const chosen = n !== null && Number.isInteger(n) ? (kind === 'team' ? input.teams[n - 1] : input.workers[n - 1]) : undefined;
      if (chosen) Object.assign(stage, kind === 'team' ? { teamId: chosen.id } : { workerId: chosen.id });
      else Object.assign(stage, suggestDoer({ kind, name, ask, role }, input.teams, input.workers));
    }
    const assigned = kind === 'people' ? !!stage.approvers?.length : !!(stage.teamId || stage.workerId);
    if (!assigned && role) stage.suggestedRole = role;
    return stage;
  });
  // Send back: by stage number, to an earlier stage that does work. A
  // decision is the only stage that sends back here.
  kept.forEach((s, i) => {
    const n = num(s.sendBackTo);
    if (n === null || !Number.isInteger(n) || n === i + 1) return;
    const target = stages[n - 1];
    const stage = stages[i];
    if (!target) return;
    if (stage.kind !== 'people') {
      notes.push(`In the picture ${stage.name} sends work back to ${target.name}. Only a decision sends back here: add one after ${stage.name} if you want that.`);
      return;
    }
    if (n > i) {
      notes.push(`${stage.name} points forward to ${target.name}, so it isn’t a send back. It sends back to the stage before it.`);
      return;
    }
    if (target.kind === 'people') {
      const before = stages.slice(0, n - 1).map((x) => x.kind !== 'people').lastIndexOf(true);
      if (before >= 0) stage.sendBackTo = stages[before].id;
      return;
    }
    stage.sendBackTo = target.id;
  });
  const name = text(o.name, 120) || 'Process from a picture';
  const about = text(o.about, 1000);
  return { ok: true, draft: { name, ...(about ? { about } : {}), stages }, notes: notes.slice(0, 8) };
}

/// Read the picture and draft the process. Never saves anything.
export async function draftProcessFromImage(deps: DraftDeps, input: ProcessImageInput): Promise<ProcessDraftResult> {
  const res = await oneShotDraftText(deps, {
    buildSystemPrompt: () => SYSTEM,
    userMessage: processImagePrompt(input),
    attachments: [input.image],
    verb: 'read the diagram',
    // Reading a dense diagram is a slow first token: budget on silence.
    timeouts: { timeoutMs: 4 * 60_000, idleTimeoutMs: 150_000 },
    permissionMode: 'plan',
  });
  if (!res.ok) return res;
  return readProcessDraft(res.text, input);
}
