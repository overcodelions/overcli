// Which CLI should the "Describe a flow" drafter use? The picker (for its
// copy) and the main-process drafter (for the actual call) both resolve it
// through this one function so the label the user sees always matches the
// backend that actually runs.
//
// Rule: use the user's explicitly-preferred backend when it's healthy +
// enabled, otherwise the first healthy + enabled premium backend. Ollama is
// deliberately excluded — drafting a strict YAML body from a one-line prompt
// is a reasoning task that small local models handle poorly.

import type { Backend } from '../types';
import { PREMIUM_MODELS, modelSpeed, type ModelSpeed } from '../modelCatalog';

/// Fallback order when the preferred backend isn't usable. Claude first
/// (most common entry point), then the rest in coverage order. Matches
/// PREMIUM_PREFERENCE in templateResolver so the two stay intuitive.
const DRAFTER_PREFERENCE: Backend[] = ['claude', 'codex', 'gemini', 'copilot'];

export function pickDrafterBackend(args: {
  preferred?: Backend;
  isHealthy: (b: Backend) => boolean;
  isEnabled: (b: Backend) => boolean;
}): Backend | null {
  const { preferred, isHealthy, isEnabled } = args;
  const ordered: Backend[] = [];
  if (preferred && DRAFTER_PREFERENCE.includes(preferred)) ordered.push(preferred);
  for (const b of DRAFTER_PREFERENCE) if (!ordered.includes(b)) ordered.push(b);
  for (const b of ordered) {
    if (isEnabled(b) && isHealthy(b)) return b;
  }
  return null;
}

/// The model the drafter runs on a given backend: the strongest premium
/// model in the catalog (first entry). Backends here are always premium —
/// `pickDrafterBackend` never returns ollama.
export function drafterModelFor(backend: Backend): string {
  const models = PREMIUM_MODELS[backend as Exclude<Backend, 'ollama'>];
  return models?.[0] ?? '';
}

/// One model id per speed tier for a backend, used to fill the drafter's
/// CONVENTIONS so a generated flow's steps default to the user's preferred
/// CLI rather than always Claude. Each tier degrades gracefully to the
/// nearest stronger tier when a backend lacks one (e.g. Gemini has no
/// dedicated 'standard' model).
export function drafterModelHints(
  backend: Backend,
): { thinking: string; standard: string; fast: string } {
  const models = PREMIUM_MODELS[backend as Exclude<Backend, 'ollama'>] ?? [];
  const atTier = (tier: ModelSpeed) => models.find((m) => modelSpeed(m) === tier);
  const thinking = atTier('thinking') ?? models[0] ?? '';
  const standard = atTier('standard') ?? thinking;
  const fast = atTier('fast') ?? standard;
  return { thinking, standard, fast };
}
