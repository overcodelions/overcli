// "Ask the crew": you say what you need, and the crew works out who should
// take it.
//
// One small turn — the fast model, no tools — reads each active worker's
// name, tagline and job and picks the one whose job this is, or says nobody
// fits. It only PICKS: the renderer shows the pick and you send it (or choose
// someone else), because a wrong worker costs a run and a budget, and a
// glance costs nothing. Workers can still hand the errand on to a colleague
// once they have it, so a near miss still lands.

import type { Backend } from '../../shared/types';
import type { Worker } from '../../shared/flows/worker';
import { pickDrafterBackend } from '../../shared/flows/drafterBackend';
import { tierDefault } from '../../shared/modelCatalog';
import { healthyBackends } from '../health';
import { oneShotDraftText, type DraftDeps } from './drafter';

export type RouteResult =
  | { ok: true; workerId: string; why: string; confident: boolean }
  | { ok: true; workerId: null; why: string; confident: false }
  | { ok: false; error: string };

/// Enough of a job to route on, without paying for every word of it.
const JOB_CHARS = 600;

export function routePrompt(workers: Array<Pick<Worker, 'name' | 'tagline' | 'jobDescription'>>): string {
  return [
    'You route a request to the ONE worker on a small crew whose job it is.',
    '',
    'THE CREW:',
    ...workers.map((w) => {
      const job = w.jobDescription.replace(/\s+/g, ' ').trim().slice(0, JOB_CHARS);
      return `- ${w.name}${w.tagline ? ` (${w.tagline})` : ''}: ${job}`;
    }),
    '',
    'Pick the worker whose job most clearly covers the request. If none of them',
    'reasonably does, pick nobody — do not force a fit.',
    '"sure" is true only when the request plainly falls in that one worker\'s job and no',
    'other worker could reasonably claim it — the request is then sent without asking.',
    'Reply with exactly one block and nothing else:',
    '<route>{"worker": "<name exactly as listed, or null>", "sure": true|false, "why": "<one short clause>"}</route>',
  ].join('\n');
}

/// Read the model's pick back to a worker on the crew. A name that is not
/// exactly on the crew (case aside) is treated as nobody, never guessed at.
export function parseRoute(
  text: string,
  workers: Array<Pick<Worker, 'id' | 'name'>>,
): { workerId: string | null; why: string; confident: boolean } | null {
  const block = text.match(/<route>([\s\S]*?)<\/route>/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  let parsed: { worker?: unknown; why?: unknown; sure?: unknown };
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }
  const why = typeof parsed.why === 'string' ? parsed.why.trim() : '';
  const name = typeof parsed.worker === 'string' ? parsed.worker.trim().toLowerCase() : '';
  const hit = name ? workers.find((w) => w.name.trim().toLowerCase() === name) : undefined;
  // Only an explicit true counts: an unsure or silent router asks first.
  return { workerId: hit?.id ?? null, why, confident: !!hit && parsed.sure === true };
}

export async function routeErrand(ask: string, workers: Worker[], deps: DraftDeps): Promise<RouteResult> {
  const text = ask.trim();
  if (!text) return { ok: false, error: 'Say what you need first.' };
  const crew = workers.filter((w) => w.enabled);
  if (crew.length === 0) return { ok: true, workerId: null, why: 'Nobody on the crew is working right now.', confident: false };
  if (crew.length === 1) return { ok: true, workerId: crew[0].id, why: 'the only worker on duty', confident: true };

  // A lookup, not a design: the fast tier answers in a second or two, which is
  // what a box you type into has to feel like.
  const healthy = await healthyBackends(deps.settings.backendPaths);
  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) => healthy.has(b),
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  const model =
    backend && backend !== 'ollama'
      ? tierDefault(backend as Exclude<Backend, 'ollama'>, 'fast', deps.settings.flowModelDefaults)
      : undefined;

  const out = await oneShotDraftText(deps, {
    model,
    buildSystemPrompt: () => routePrompt(crew),
    userMessage: `REQUEST:\n${text}`,
    verb: 'route',
  });
  if (!out.ok) return out;
  const route = parseRoute(out.text, crew);
  if (!route) return { ok: false, error: `${out.label} did not say who should take it.` };
  return route.workerId
    ? { ok: true, workerId: route.workerId, why: route.why, confident: route.confident }
    : { ok: true, workerId: null, why: route.why || 'Nobody on the crew covers this.', confident: false };
}
