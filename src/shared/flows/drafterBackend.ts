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
import {
  PREMIUM_MODELS,
  canonicalizePremiumModel,
  isSupportedPremiumModel,
  modelSpeed,
  tierDefault,
  type FlowModelDefaults,
  type ModelSpeed,
} from '../modelCatalog';

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
/// CLI rather than always Claude.
///
/// A missing tier degrades DOWNWARD, toward cheaper. The drafter spends
/// `standard` on "rebound critic / cheaper steps", so when a backend has no
/// middle model the honest substitute is its fast one — degrading upward
/// put every critic loop in every Claude-drafted flow on Opus, which is the
/// exact opposite of what that prompt line is asking for. Claude still
/// lacks a 'standard' model today, so this is a live path rather than an
/// edge case; gemini gained a real middle tier once Flash / Flash-Lite
/// split its catalog. `thinking` still degrades upward (to the strongest available)
/// because that line asks for the best reasoning model.
///
/// Each tier resolves through `tierDefault`, so a model the user pinned in
/// Settings → Flows is the one the drafter is told to use — the hint and the
/// post-draft snap can't disagree about what a tier means.
export function drafterModelHints(
  backend: Backend,
  defaults?: FlowModelDefaults,
): { thinking: string; standard: string; fast: string } {
  const premium = backend as Exclude<Backend, 'ollama'>;
  const models = PREMIUM_MODELS[premium] ?? [];
  const atTier = (tier: ModelSpeed) => tierDefault(premium, tier, defaults);
  const thinking = atTier('thinking') ?? models[0] ?? '';
  const standard = atTier('standard') ?? atTier('fast') ?? thinking;
  const fast = atTier('fast') ?? standard;
  return { thinking, standard, fast };
}

/// Resolve the model a producer turn should run, given the backend that was
/// actually picked and whatever model the caller pinned.
///
/// Worker heartbeat models are stored as a bare id with no backend, while the
/// backend is re-resolved from `preferredBackend` + health on every run. Those
/// two facts are fine in isolation and unsound together: switch the default
/// provider and every worker hired under the old one is suddenly pinned to a
/// model its backend has never heard of, and the turn dies with "Model X is
/// not supported for backend Y" — unattended, on a cadence, where nobody sees
/// it until the work stops arriving.
///
/// So an unsupported pin is TRANSLATED rather than obeyed or discarded. The
/// pin's real content is its speed tier — a heartbeat is "the cheap
/// shift-planning turn", and `claude-sonnet-5` says fast far more than it says
/// Claude — so the same tier on the new backend is the honest reading of what
/// the worker was configured to want. `claude-sonnet-5` → `gpt-5.6-luna`, not
/// codex's flagship and not an error.
///
/// A pin the backend DOES support is passed through (canonicalized), and an
/// empty pin falls back to that backend's strongest model, exactly as before.
///
/// Translation degrades DOWNWARD when the destination backend has no model at
/// the tier, reusing `drafterModelHints`' ladder. Going upward would be a
/// quiet cost increase on the one turn that is defined as cheap: Claude ships
/// no 'standard' model, so an unrecognised heartbeat id resolving "up" landed
/// on Opus — the flagship — for shift planning.
export function resolveProducerModel(
  backend: Backend,
  pinned: string | undefined,
  defaults?: FlowModelDefaults,
): string {
  const wanted = pinned?.trim();
  if (!wanted) return drafterModelFor(backend);
  // Local ollama ids are never in the premium catalog; there's nothing to
  // validate them against and nothing to translate them to.
  if (backend === 'ollama') return wanted;
  const premium = backend as Exclude<Backend, 'ollama'>;
  const canon = canonicalizePremiumModel(premium, wanted);
  if (isSupportedPremiumModel(premium, canon)) return canon;
  // `modelSpeed` falls back to 'standard' for an id from no catalog we know,
  // which is the right neutral guess for a hand-typed or imported model.
  const hints = drafterModelHints(backend, defaults);
  const tier = modelSpeed(wanted);
  // 'frontier' maps to the strongest reasoning model the backend has rather
  // than nothing — but never auto-promotes a lower tier into it.
  const translated = tier === 'frontier' ? hints.thinking : hints[tier];
  return translated || drafterModelFor(backend);
}
