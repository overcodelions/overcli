// Shared catalog of premium-model ids per backend. Same list the welcome
// pane uses to populate the model picker; the flow editor + participants
// editor both read from here so they stay in sync. Local Ollama models
// aren't here — those are detected live via the `ollama:detect` IPC.

import type { Backend } from './types';

/// Premium models per backend. New models added here automatically
/// surface in every picker that imports `PREMIUM_MODELS`. The first
/// entry per backend is the auto-pick default — the "(pick a model)"
/// fallback and the template resolver's per-tier substitution both take
/// the first matching id. We keep `claude-opus-4-8` first so it's the
/// default Claude model. `claude-fable-5` is the most premium/advanced
/// model (roughly 2x the cost of Opus 4.8), listed right after the
/// default for anyone who explicitly wants it.
export const PREMIUM_MODELS: Record<Exclude<Backend, 'ollama'>, string[]> = {
  claude: ['claude-opus-4-8', 'claude-fable-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  // Copilot CLI accepts a curated set of ids served via GitHub's Bedrock
  // gateway. These are the public Copilot-CLI-supported set as of
  // mid-2026; the user can override via Settings → Models if a newer id
  // ships.
  copilot: ['claude-haiku-4.5', 'claude-sonnet-4.6', 'gpt-5.5'],
};

export function premiumModelsForBackend(backend: Exclude<Backend, 'ollama'>): string[] {
  return PREMIUM_MODELS[backend];
}

export function isSupportedPremiumModel(backend: Exclude<Backend, 'ollama'>, model: string): boolean {
  return PREMIUM_MODELS[backend]?.includes(model) ?? false;
}

/// Snap a near-miss model id to its canonical catalog spelling for a
/// backend. AI-drafted flows frequently emit a model with the wrong
/// version separator: most commonly `claude-haiku-4.5` (dotted — which is
/// literally the Copilot spelling) on the `claude` backend, whose catalog
/// id is `claude-haiku-4-5` (dashed). They name the same model, but
/// `isSupportedPremiumModel` is an exact-string match, so the dotted form
/// fails validation. This compares against the catalog ignoring `.` vs `-`
/// version-separator differences and returns the catalog's spelling when
/// one matches; otherwise returns the input unchanged so genuinely-unknown
/// ids still surface a clear "not supported" error.
export function canonicalizePremiumModel(
  backend: Exclude<Backend, 'ollama'>,
  model: string,
): string {
  const list = PREMIUM_MODELS[backend];
  if (!list) return model;
  if (list.includes(model)) return model;
  const norm = (s: string) => s.toLowerCase().replace(/\./g, '-');
  const wanted = norm(model);
  return list.find((m) => norm(m) === wanted) ?? model;
}

/// Speed tier per model id. Drives a ⚡ marker in the picker so users
/// can spot the fast/cheap tier at a glance.
///   - 'fast': low latency, low cost; good for workers and quick tasks
///   - 'standard': mid tier; balanced cost vs. quality
///   - 'thinking': premium reasoning models, slower + more expensive
///   - 'frontier': the most advanced + most expensive tier (Fable 5,
///     ~2x Opus). Kept distinct from 'thinking' so the template resolver
///     only assigns it to steps that explicitly ask for it (e.g.
///     planning) instead of substituting it for any thinking step.
export type ModelSpeed = 'fast' | 'standard' | 'thinking' | 'frontier';

const MODEL_SPEED: Record<string, ModelSpeed> = {
  // Claude
  'claude-fable-5': 'frontier',
  'claude-opus-4-8': 'thinking',
  'claude-opus-4-7': 'thinking',
  'claude-sonnet-4-6': 'fast',
  'claude-haiku-4-5': 'fast',
  // Codex (OpenAI)
  'gpt-5.5': 'thinking',
  'gpt-5.4': 'standard',
  'gpt-5.4-mini': 'fast',
  // Gemini
  'gemini-2.5-pro': 'thinking',
  'gemini-2.5-flash': 'fast',
  // Copilot (uses the underlying model's profile)
  'claude-haiku-4.5': 'fast',
  'claude-sonnet-4.6': 'fast',
};

export function modelSpeed(model: string): ModelSpeed {
  return MODEL_SPEED[model] ?? 'standard';
}

/// Pretty label for a backend+model combo. Used in the flow editor's
/// unified picker and in run UI breadcrumbs.
///
/// Conventions:
///   - Claude: "Claude Opus 4.7" — title-cased name, dot version
///   - Codex (GPT): "GPT-5.4 mini" — keep "GPT" as a literal initialism;
///     dot version; lowercase qualifier ("mini") since "MINI" looked
///     shouty in the picker
///   - Gemini: "Gemini 2.5 Pro" — title-cased qualifier
///   - Copilot: "{underlying model} (Copilot)" — render the underlying
///     model's nice form, suffix with the gateway in parens
export function friendlyModelLabel(backend: Backend, model: string): string {
  if (!model) return `${backend} (pick model)`;
  if (backend === 'claude') {
    return titleCaseClaude(model);
  }
  if (backend === 'codex') {
    return formatGptId(model) + ' (Codex)';
  }
  if (backend === 'gemini') {
    return titleCaseGemini(model);
  }
  if (backend === 'copilot') {
    // Copilot serves underlying claude-* / gpt-* ids; reuse the same
    // formatters so they read consistently.
    if (model.startsWith('claude-')) return titleCaseClaude(normalizeClaudeId(model)) + ' (Copilot)';
    if (model.startsWith('gpt-')) return formatGptId(model) + ' (Copilot)';
    return `${model} (Copilot)`;
  }
  if (backend === 'ollama') {
    return `${model} (local)`;
  }
  return `${backend}:${model}`;
}

/// Convert `claude-opus-4-7` (or `claude-opus-4.7`) → `Claude Opus 4.7`.
function titleCaseClaude(model: string): string {
  // Normalize the version separator so `4-7` and `4.7` both end up as `4.7`.
  const tail = model.replace(/^claude-/, '');
  const versionFixed = tail.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  return (
    'Claude ' +
    versionFixed
      .split('-')
      .map((part) => (/^\d/.test(part) ? part : (part[0]?.toUpperCase() ?? '') + part.slice(1)))
      .join(' ')
  );
}

/// Map `claude-haiku-4.5` (Copilot-style) to `claude-haiku-4-5` so the
/// shared formatter handles both spellings.
function normalizeClaudeId(model: string): string {
  return model.replace(/(\d+)\.(\d+)$/, '$1-$2');
}

/// `gpt-5.4-mini` → `GPT-5.4 mini`.
function formatGptId(model: string): string {
  // Capture the GPT prefix + version, then format any trailing qualifier.
  const m = model.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (!m) return model;
  const [, version, qualifier] = m;
  return qualifier ? `GPT-${version} ${qualifier.toLowerCase()}` : `GPT-${version}`;
}

/// `gemini-2.5-pro` → `Gemini 2.5 Pro`.
function titleCaseGemini(model: string): string {
  const m = model.match(/^gemini-(\d+(?:\.\d+)?)-(.+)$/i);
  if (!m) return model;
  const [, version, qualifier] = m;
  return `Gemini ${version} ${(qualifier[0]?.toUpperCase() ?? '') + qualifier.slice(1)}`;
}

/// Tier classification used to group choices in pickers. Premium = paid
/// API backends, Local = ollama, Other = the catch-all fallback for
/// hand-typed model ids the user wants to use despite not being in the
/// catalog.
export function modelTierLabel(backend: Backend): 'Premium' | 'Local' | 'Other' {
  if (backend === 'ollama') return 'Local';
  if (
    backend === 'claude' ||
    backend === 'codex' ||
    backend === 'gemini' ||
    backend === 'copilot'
  ) {
    return 'Premium';
  }
  return 'Other';
}
