// "Whats next on the roadmap?" — when a team already worked it out, the
// answer is what it worked out, said in the thread, not a list of places to
// look.
//
// One model turn over what the person can see: the finished work that
// matches the question and what each team knows. It answers from those
// alone, or says they don't cover it, and the question goes on as before.

import { oneShotDraftText, type DraftDeps } from '../flows/drafter';
import type { ExistingHit } from './existingWork';
import { tierModel } from './frontDoorRoute';

export interface AnswerSource {
  /// "Product Team's task "Q1 roadmap" (2 days ago)", "What Product Team knows".
  label: string;
  /// The team or worker it came from: the answer is said under its name.
  who: string;
  body: string;
  /// The finished work it is, when it is one (not a team's knowledge).
  hit?: ExistingHit;
}

/// Each source cut to this, and all of them together to the total.
const SOURCE_MAX = 15_000;
const TOTAL_MAX = 60_000;
/// How long a lookup waits on the model before the question goes on as before.
const ANSWER_TIMEOUT_MS = 45_000;

const SYSTEM = [
  'You answer a question someone at work asked in Slack, using only the numbered sources given:',
  'finished work their AI teams and workers delivered, and what each team knows about its area.',
  'Read them properly and answer the question itself, the way a colleague who read them would:',
  'lead with the answer, then the few facts that matter, with names, dates and ticket ids as the sources give them.',
  'Say how old the information is when it matters, and say plainly what the sources disagree on or leave open.',
  'Keep it short enough to read in Slack without opening anything: under 180 words, at most five bullets.',
  'Leave out what does not answer the question; the person can open the source for the rest.',
  'Reply with the answer itself, as it will be posted: no preface ("Here\'s the reply"), no separators, and write no files.',
  'Never invent anything the sources do not say, and do not describe the sources themselves ("the pack says").',
  'Write for a business reader who has not seen the sources. Never use an internal label on its own (item codes',
  'like C1 or Q5, section marks like §6, stage names): say what the thing is, e.g. "the MDF Programs pilot".',
  'The reader is in Slack and cannot open files on the server: never give a file path, folder or file name.',
  'Say what the document is ("Hugo\'s roadmap report") and that it opens from the link under this answer; a web address (https://…) is fine.',
  'A ticket id may follow what it is, in brackets. Leave out the team\'s own process (what to change in the pack, who reviews).',
  'A task\'s later room conversation is newer than its pack: where they differ, the room is the latest word.',
  'A source in which a worker only declines or says it cannot help is not an answer: ignore it.',
  'If the sources do not answer the question, reply with exactly NONE and nothing else.',
  'Otherwise end with one last line naming the sources you used: "Sources: 1, 3".',
].join('\n');

export function answerPrompt(question: string, sources: AnswerSource[]): string {
  let left = TOTAL_MAX;
  const parts: string[] = [];
  sources.forEach((s, i) => {
    const body = s.body.trim().slice(0, Math.min(SOURCE_MAX, left));
    left -= body.length;
    if (body) parts.push(`[${i + 1}] ${s.label}\n${body}`);
  });
  return `Question:\n${question.slice(0, 2000)}\n\nSources:\n\n${parts.join('\n\n---\n\n')}`;
}

/// A path on the server, which nobody in Slack can open: "~/.overcli/…/plan.html",
/// "Workers/Hugo/2026-10-19 report/". Web addresses are left alone.
const SERVER_ROOT = /^(?:~\/|\/(?:Users|home|private|tmp|var)\/|(?:Workers|team-files|worker-files|coordinators|pack|files)\/)/;
const BARE_PATH = /(?<![\w:/`])(?:~\/|\/(?:Users|home|private|tmp|var)\/)[^\s`)]+?(?=[.,;]?(?:\s|$|\)))/g;

/// A path said as the document's own name, or nothing when it is a folder.
function saidAs(p: string): string {
  const name = p.trim().replace(/\/+$/, '').split('/').pop() ?? '';
  return /\.[a-z0-9]{1,5}$/i.test(name) ? `_${name}_` : '';
}

/// Each server path said as the document's name, or dropped when it is a folder.
export function withoutPaths(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, (m, inner: string) => (SERVER_ROOT.test(inner.trim()) ? saidAs(inner) : m))
    .replace(BARE_PATH, saidAs)
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([.,;])/g, '$1')
    .replace(/ {2,}/g, ' ');
}

/// The model's answer and the sources it used, or null when it said they
/// don't cover the question.
export function readAnswer(reply: string, sources: AnswerSource[]): { text: string; used: AnswerSource[] } | null {
  // A preface the model added anyway ("I've written it to the plan file.
  // Here's the reply for Slack:", then a rule): not part of the answer.
  const t = reply
    .trim()
    .replace(/^[^\n]*(?:plan file|here'?s (?:the|my|a|your) (?:reply|answer|response))[^\n]*\n+(?:\s*-{3,}\s*\n+)?/i, '')
    .trim();
  if (!t || /^NONE[.!]?$/i.test(t)) return null;
  const m = /\n\s*\**sources?\**:\s*([\d,\sand]+?)\s*[.!]?\**\s*$/i.exec(t);
  const used = m
    ? [...new Set(m[1].split(/[^\d]+/).filter(Boolean).map(Number))].map((n) => sources[n - 1]).filter((s): s is AnswerSource => !!s)
    : [];
  const text = withoutPaths((m ? t.slice(0, m.index) : t).replace(/\n\s*-{3,}\s*$/, '')).trim();
  return text ? { text, used: used.length ? used : sources.slice(0, 1) } : null;
}

export async function answerFromWork(deps: DraftDeps, question: string, sources: AnswerSource[]): Promise<{ text: string; used: AnswerSource[] } | null> {
  if (!sources.length) return null;
  // Reading and saying what it read, not working something out: the standard
  // tier, no extended thinking, keeps it to seconds.
  const model = await tierModel(deps, 'standard');
  const res = await oneShotDraftText(deps, {
    ...(model ? { model } : {}),
    buildSystemPrompt: () => SYSTEM,
    userMessage: answerPrompt(question, sources),
    verb: 'answer the question',
    // The person is waiting in the thread and the question still has to be
    // routed after a NONE: a slow answer gives way to that.
    timeouts: { timeoutMs: ANSWER_TIMEOUT_MS, idleTimeoutMs: ANSWER_TIMEOUT_MS },
    // Not `plan`: plan mode has it write a plan file and present the
    // answer as a plan. Everything it needs is in the prompt.
    permissionMode: 'default',
  });
  return res.ok ? readAnswer(res.text, sources) : null;
}
