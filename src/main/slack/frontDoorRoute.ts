// Which worker should take a request, when its words don't settle it. One
// short model turn over the workers' jobs; it may say nobody fits, and then
// the person is asked to pick.

import { oneShotDraftText, type DraftDeps } from '../flows/drafter';
import type { FrontDoorWorker } from './frontDoor';

const SYSTEM = [
  'You route a request from someone at work to the one AI worker best suited to do it.',
  'You are given the request and a numbered list of workers, each with its job.',
  'Some entries are TEAMS. Pick a team only when the request asks for a substantial deliverable',
  '(a PR/FAQ, a review, a plan, a report) that matches the team’s purpose. A question, a lookup or',
  'a small fix goes to a single worker, even when a team covers the topic.',
  'A request about a specific thing in a system (a ticket, an account, a page, a pull request) needs a',
  'worker whose tools reach that system: prefer it, and never pick one with no tool that could look it up.',
  'Pick the worker or team whose job covers the request. If none of them plausibly does, pick none.',
  'Answer with JSON only, no prose and no code fence:',
  '{"worker": <the worker\'s number, or null>, "why": "<under 12 words, why this worker>"}',
].join('\n');

export function routePrompt(text: string, workers: FrontDoorWorker[]): string {
  const list = workers
    .map((w, i) => `${i + 1}. ${w.name}${w.tagline ? ` — ${w.tagline}` : ''}\n   Job: ${(w.job ?? '').replace(/\s+/g, ' ').slice(0, 400)}\n   Tools: ${w.tools?.length ? w.tools.join(', ') : 'none beyond files and the web'}`)
    .join('\n');
  return `Request:\n${text.slice(0, 2000)}\n\nWorkers:\n${list}`;
}

/// The model's answer, read leniently: the first JSON object in it.
export function readRoute(reply: string, workers: FrontDoorWorker[]): { workerId: string; why: string } | null {
  const m = /\{[\s\S]*\}/.exec(reply);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { worker?: unknown; why?: unknown };
    const n = typeof parsed.worker === 'number' ? parsed.worker : typeof parsed.worker === 'string' ? Number(parsed.worker) : NaN;
    const w = Number.isInteger(n) ? workers[n - 1] : undefined;
    if (!w) return null;
    return { workerId: w.id, why: typeof parsed.why === 'string' ? parsed.why.trim().slice(0, 100) : '' };
  } catch {
    return null;
  }
}

export async function routeRequest(deps: DraftDeps, text: string, workers: FrontDoorWorker[]): Promise<{ workerId: string; why: string } | null> {
  if (!workers.length) return null;
  const res = await oneShotDraftText(deps, {
    buildSystemPrompt: () => SYSTEM,
    userMessage: routePrompt(text, workers.slice(0, 40)),
    verb: 'route the request',
    timeouts: { timeoutMs: 60_000, idleTimeoutMs: 45_000 },
    permissionMode: 'plan',
  });
  return res.ok ? readRoute(res.text, workers) : null;
}
