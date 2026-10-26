// Which worker should take a request, when its words don't settle it. One
// short model turn over the workers' jobs; it may say nobody fits, and then
// the person is asked to pick.

import { oneShotDraftText, type DraftDeps } from '../flows/drafter';
import { pickDrafterBackend } from '../../shared/flows/drafterBackend';
import { tierDefault, type ModelSpeed } from '../../shared/modelCatalog';
import { healthyBackends } from '../health';
import type { FrontDoorWorker } from './frontDoor';

/// The model at `tier` for whichever CLI is signed in. Undefined: the
/// drafter's own default (no tiers on that backend).
export async function tierModel(deps: DraftDeps, tier: ModelSpeed): Promise<string | undefined> {
  const healthy = await healthyBackends(deps.settings.backendPaths);
  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) => healthy.has(b),
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  return backend && backend !== 'ollama' ? tierDefault(backend, tier, deps.settings.flowModelDefaults) : undefined;
}

const SYSTEM = [
  'You route a request from someone at work to the one AI worker best suited to do it.',
  'You are given the request and a numbered list of workers, each with its job.',
  'Some entries are TEAMS. Pick a team only when the request asks for a substantial deliverable',
  '(a PR/FAQ, a review, a plan, a report) that matches the team’s purpose. A question, a lookup or',
  'a small fix goes to a single worker, even when a team covers the topic.',
  'A request about a specific thing in a system (a ticket, an account, a page, a pull request) needs a',
  'worker whose tools reach that system: prefer it, and never pick one with no tool that could look it up.',
  'A question about how something in the product works or was built (a module, a feature\'s behaviour, its logic,',
  'who wrote the code) needs a worker that reads that code: prefer one whose "Reads code" covers it. A tracker',
  'search only shows who touched tickets about it, not how it works.',
  'Some entries are PROCESSES. Pick a process only when the request is a new item of the kind it takes in',
  '(a new idea for an idea process, a bug report for a bug process); never for a question about something.',
  'You may also be given recent work that may be related, each with the team or worker that made it.',
  'A question about something listed there goes to the worker that made it, or for a team\'s work to the',
  'member of that team whose job fits the question best: they know it best, and someone else would make',
  'it again from scratch. A question never goes to a TEAM itself.',
  'Pick the worker, team or process whose job covers the request. If none of them plausibly does, pick none.',
  'Answer with JSON only, no prose and no code fence:',
  '{"worker": <the worker\'s number, or null>, "why": "<under 12 words, why this worker>"}',
].join('\n');

export function routePrompt(text: string, workers: FrontDoorWorker[], related: Array<{ title: string; who: string }> = []): string {
  const list = workers
    .map((w, i) => `${i + 1}. ${w.name}${w.tagline ? ` — ${w.tagline}` : ''}\n   Job: ${(w.job ?? '').replace(/\s+/g, ' ').slice(0, 400)}\n   Tools: ${w.tools?.length ? w.tools.join(', ') : 'none beyond files and the web'}\n   Reads code: ${w.code ?? 'none'}`)
    .join('\n');
  const recent = related.length ? `\n\nRecent work that may be related:\n${related.slice(0, 5).map((r) => `- ${r.title.replace(/\s+/g, ' ').slice(0, 160)} — by ${r.who}`).join('\n')}` : '';
  return `Request:\n${text.slice(0, 2000)}\n\nWorkers:\n${list}${recent}`;
}

const DESK = [
  'You are the front desk for a company\'s AI workers, answering in a Slack thread.',
  'Nobody\'s job covers this question, so you answer it yourself: directly, briefly, in plain words, using the thread for context.',
  'You cannot see the company\'s systems (tickets, accounts, code, documents). When the answer depends on them, say so in a line,',
  'and if one of the workers listed could look it up, name that worker and say to ask them by name.',
  'Never claim to have checked something you could not. No preamble, no sign-off; Slack markdown only (*bold*, _italic_, • lists).',
].join('\n');

/// A question nobody's job covers, answered by the door itself, with the
/// workers named so it can point at one that could look something up.
export async function answerGeneral(deps: DraftDeps, text: string, context: string, workers: FrontDoorWorker[]): Promise<string | null> {
  const model = await tierModel(deps, 'standard');
  const list = workers.slice(0, 40).map((w) => `- ${w.name}${w.tagline ? ` — ${w.tagline}` : ''}${w.tools?.length ? ` (tools: ${w.tools.join(', ')})` : ''}${w.code ? ` (reads code: ${w.code})` : ''}`).join('\n');
  const res = await oneShotDraftText(deps, {
    ...(model ? { model } : {}),
    buildSystemPrompt: () => DESK,
    userMessage: `Question:\n${text.slice(0, 4000)}${context ? `\n\nThe thread so far:\n${context}` : ''}${list ? `\n\nWorkers people can ask:\n${list}` : ''}`,
    verb: 'answer the question',
    timeouts: { timeoutMs: 120_000, idleTimeoutMs: 60_000 },
    permissionMode: 'plan',
  });
  return res.ok && res.text.trim() ? res.text.trim() : null;
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

export async function routeRequest(deps: DraftDeps, text: string, workers: FrontDoorWorker[], related?: Array<{ title: string; who: string }>): Promise<{ workerId: string; why: string } | null> {
  if (!workers.length) return null;
  // Picking from a list: the fast tier, so the person isn't kept waiting.
  const model = await tierModel(deps, 'fast');
  const res = await oneShotDraftText(deps, {
    ...(model ? { model } : {}),
    buildSystemPrompt: () => SYSTEM,
    userMessage: routePrompt(text, workers.slice(0, 40), related),
    verb: 'route the request',
    timeouts: { timeoutMs: 60_000, idleTimeoutMs: 45_000 },
    permissionMode: 'plan',
  });
  return res.ok ? readRoute(res.text, workers) : null;
}
