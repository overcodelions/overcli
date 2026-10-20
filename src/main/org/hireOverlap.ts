// Before hiring: does someone already do this job? One short model turn over
// the workers the person can see, run beside the drafting so it costs no
// wait. A match is said, not enforced: they may still want a second one.

import { oneShotDraftText, type DraftDeps } from '../flows/drafter';

export interface OverlapWorker {
  id: string;
  name: string;
  tagline?: string;
  job?: string;
}

const SYSTEM = [
  'Someone at work is about to hire a new AI worker for a job. You are given the job and a numbered list of',
  'the workers they already have, each with what it does.',
  'Say whether one of them already does this job, or most of it, so they could ask it instead of hiring.',
  'Only a real match: the same kind of work and output. Sharing a topic or a word is not enough.',
  'Answer with JSON only, no prose and no code fence:',
  '{"worker": <its number, or null>, "why": "<under 15 words: what it already does that covers the job>"}',
].join('\n');

export function overlapPrompt(job: string, workers: OverlapWorker[]): string {
  const list = workers
    .map((w, i) => `${i + 1}. ${w.name}${w.tagline ? ` — ${w.tagline}` : ''}\n   Does: ${(w.job ?? '').replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');
  return `The job to hire for:\n${job.slice(0, 2000)}\n\nWorkers they have:\n${list}`;
}

export function readOverlap(reply: string, workers: OverlapWorker[]): { workerId: string; why: string } | null {
  const m = /\{[\s\S]*\}/.exec(reply);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { worker?: unknown; why?: unknown };
    const n = typeof parsed.worker === 'number' ? parsed.worker : typeof parsed.worker === 'string' ? Number(parsed.worker) : NaN;
    const w = Number.isInteger(n) ? workers[n - 1] : undefined;
    return w ? { workerId: w.id, why: typeof parsed.why === 'string' ? parsed.why.trim().slice(0, 120) : '' } : null;
  } catch {
    return null;
  }
}

export async function findOverlap(deps: DraftDeps, job: string, workers: OverlapWorker[]): Promise<{ workerId: string; why: string } | null> {
  if (!workers.length) return null;
  const res = await oneShotDraftText(deps, {
    buildSystemPrompt: () => SYSTEM,
    userMessage: overlapPrompt(job, workers.slice(0, 40)),
    verb: 'check for a worker who already does this',
    timeouts: { timeoutMs: 60_000, idleTimeoutMs: 45_000 },
    permissionMode: 'plan',
  });
  return res.ok ? readOverlap(res.text, workers) : null;
}
