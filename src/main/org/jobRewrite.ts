// Changing a worker's job by saying what should change: "also watch the
// DEVOP board", "stop proposing moves on a hunch". One short model turn
// rewrites the whole job with the change worked in, and the person reads it
// before anything is saved. Nothing here saves.

import { oneShotDraftText, type DraftDeps } from '../flows/drafter';

/// Longer than any job anyone writes; a runaway reply is cut here.
const JOB_MAX = 20_000;

const SYSTEM = [
  'You edit the job description of an AI worker at a company. The worker reads it before every run and plans its work from it.',
  'You are given the current job and a change someone asked for. Rewrite the job with that change worked in.',
  'Keep everything the change does not touch: its wording, its order, its lists, its names, keys and links.',
  'Work the change into the place it belongs rather than adding it at the end, and remove anything it replaces.',
  'Do not add duties, tools, schedules or safety rules nobody asked for. Do not explain what you changed.',
  'Reply with the new job text only: no preamble, no heading, no code fence.',
].join('\n');

export function rewritePrompt(name: string, job: string, ask: string): string {
  return `The worker: ${name}\n\nIts job now:\n<job>\n${job}\n</job>\n\nThe change asked for:\n<change>\n${ask}\n</change>`;
}

/// The model's reply as a job: fences and a stray "Here is…" line dropped.
export function readRewrite(reply: string): string | null {
  let t = reply.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  t = t.replace(/^<job>\s*|\s*<\/job>$/g, '').trim();
  if (/^(?:here(?:'s| is)|sure|okay)\b[^\n]*:\s*\n/i.test(t)) t = t.replace(/^[^\n]*\n/, '').trim();
  return t ? t.slice(0, JOB_MAX) : null;
}

export async function rewriteJob(deps: DraftDeps, args: { name: string; job: string; ask: string }): Promise<string | null> {
  const res = await oneShotDraftText(deps, {
    buildSystemPrompt: () => SYSTEM,
    userMessage: rewritePrompt(args.name, args.job, args.ask),
    verb: 'rewrite the job',
    timeouts: { timeoutMs: 120_000, idleTimeoutMs: 60_000 },
    permissionMode: 'plan',
  });
  return res.ok ? readRewrite(res.text) : null;
}
