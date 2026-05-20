// Remap a template's participant backend+model picks to whatever the
// user actually has available. Templates ship with sensible defaults
// (Claude Opus for design, ollama for build, Claude Sonnet for verify)
// — but those defaults assume Claude + Ollama are configured. If the
// user only has Codex, or only has Claude, we want the template to
// still produce a workable flow without making them edit every step.
//
// Approach: each template participant has an *intended speed tier*
// (thinking / standard / fast) implied by its placeholder model. We
// pick the best available model at that tier from the user's healthy
// backends, preferring the template's original backend when it's
// healthy. Ollama-backed participants are treated as "fast intent",
// so when ollama isn't available we fall back to a fast premium
// model (e.g. claude-haiku) — matching the user's explicit ask:
// "if the user only has claude then it should use the opus for the
// design, haiku for the coding, and sonnet for the review".

import type { Backend } from '../types';
import { PREMIUM_MODELS, friendlyModelLabel, modelSpeed, type ModelSpeed } from '../modelCatalog';
import type { Flow, FlowParticipant } from './schema';

export interface TemplateResolveContext {
  /// Backends the user currently has working ('ready' health). Order
  /// doesn't matter; the resolver applies its own preference.
  healthyBackends: Backend[];
  /// Installed ollama models, in detection order. Empty if ollama
  /// isn't running. The resolver picks the first one for fast steps.
  ollamaModels: string[];
}

/// Preference order when the template-original backend isn't healthy.
/// Claude first because it's the most common entry point; the others
/// follow in capability/coverage order.
const PREMIUM_PREFERENCE: Backend[] = ['claude', 'codex', 'gemini', 'copilot'];

/// What tier did the template intend for this participant? Ollama is
/// always treated as 'fast' regardless of the specific model since
/// templates use ollama as the "local fast worker" slot.
function intendedTier(p: FlowParticipant): ModelSpeed {
  if (p.backend === 'ollama') return 'fast';
  return modelSpeed(p.model);
}

/// Pick a premium model at the requested tier from the user's healthy
/// backends. Prefers `preferredBackend` if healthy, then falls through
/// PREMIUM_PREFERENCE. If no backend has a model at the exact tier,
/// degrades gracefully (thinking → standard → fast) so the user still
/// gets *something* runnable.
function pickPremium(
  tier: ModelSpeed,
  preferredBackend: Backend,
  healthy: Backend[],
): { backend: Backend; model: string } | undefined {
  const order = collectBackendOrder(preferredBackend, healthy);
  // Exact-tier match.
  for (const b of order) {
    const m = firstAtTier(b, tier);
    if (m) return { backend: b, model: m };
  }
  // Tier fallback ladder. For 'thinking' drop to 'standard' then 'fast';
  // for 'fast' bump up to 'standard' then 'thinking'. Always lands on
  // *some* model from a healthy backend if any premium backend is up.
  const fallback: ModelSpeed[] =
    tier === 'thinking'
      ? ['standard', 'fast']
      : tier === 'fast'
      ? ['standard', 'thinking']
      : ['thinking', 'fast'];
  for (const t of fallback) {
    for (const b of order) {
      const m = firstAtTier(b, t);
      if (m) return { backend: b, model: m };
    }
  }
  return undefined;
}

function collectBackendOrder(preferred: Backend, healthy: Backend[]): Backend[] {
  const order: Backend[] = [];
  if (preferred !== 'ollama' && healthy.includes(preferred)) order.push(preferred);
  for (const b of PREMIUM_PREFERENCE) {
    if (b === preferred) continue;
    if (healthy.includes(b)) order.push(b);
  }
  return order;
}

function firstAtTier(backend: Backend, tier: ModelSpeed): string | undefined {
  if (backend === 'ollama') return undefined;
  const models = PREMIUM_MODELS[backend as Exclude<Backend, 'ollama'>];
  return models?.find((m) => modelSpeed(m) === tier);
}

/// Pick the replacement backend+model for a single template participant
/// based on what's available. Returns `undefined` to mean "leave as-is"
/// (no healthy backends, or the original was already a custom fit).
export function pickForParticipant(
  p: FlowParticipant,
  ctx: TemplateResolveContext,
): { backend: Backend; model: string } | undefined {
  const tier = intendedTier(p);

  // Fast intent + ollama actually available → prefer the user's first
  // installed ollama model. This keeps the "local worker" pattern from
  // the template when the user has set it up.
  if (tier === 'fast' && ctx.healthyBackends.includes('ollama') && ctx.ollamaModels.length > 0) {
    return { backend: 'ollama', model: ctx.ollamaModels[0] };
  }

  // Otherwise pick a premium model at the intended tier.
  const pick = pickPremium(tier, p.backend, ctx.healthyBackends);
  if (pick) return pick;

  return undefined;
}

/// Walk a template's participants (and legacy step-level model refs)
/// and rebind each to a working model from the user's environment.
/// Returns a fresh flow object — never mutates the input.
export function resolveTemplateForUser(flow: Flow, ctx: TemplateResolveContext): Flow {
  const out: Flow = JSON.parse(JSON.stringify(flow));
  for (const p of out.participants) {
    const pick = pickForParticipant(p, ctx);
    if (!pick) continue;
    p.backend = pick.backend;
    p.model = pick.model;
    p.name = friendlyModelLabel(pick.backend, pick.model);
  }
  // Sync the legacy step-level `model` field so downstream code that
  // still reads it sees the same picks. Participants are the source of
  // truth post-migration, but keep these mirrored for safety.
  for (const step of out.steps) {
    if (!step.model) continue;
    const p = out.participants.find((x) => x.id === step.participantId);
    if (p) step.model = { backend: p.backend, model: p.model };
  }
  return out;
}
