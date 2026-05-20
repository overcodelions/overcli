// Shared catalog of premium-model ids per backend. Same list the welcome
// pane uses to populate the model picker; the flow editor + participants
// editor both read from here so they stay in sync. Local Ollama models
// aren't here — those are detected live via the `ollama:detect` IPC.

import type { Backend } from './types';

/// Premium models per backend. New models added here automatically
/// surface in every picker that imports `PREMIUM_MODELS`. Ordered with
/// the strongest model first so a "(pick a model)" default with the
/// first item is a sensible choice.
export const PREMIUM_MODELS: Record<Exclude<Backend, 'ollama'>, string[]> = {
  claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  // Copilot CLI accepts a curated set of ids served via GitHub's Bedrock
  // gateway. These are the public Copilot-CLI-supported set as of
  // mid-2026; the user can override via Settings → Models if a newer id
  // ships.
  copilot: ['claude-haiku-4.5', 'claude-sonnet-4.6', 'gpt-5.5'],
};

/// Speed tier per model id. Drives a ⚡ marker in the picker so users
/// can spot the fast/cheap tier at a glance.
///   - 'fast': low latency, low cost; good for workers and quick tasks
///   - 'standard': mid tier; balanced cost vs. quality
///   - 'thinking': premium reasoning models, slower + more expensive
export type ModelSpeed = 'fast' | 'standard' | 'thinking';

const MODEL_SPEED: Record<string, ModelSpeed> = {
  // Claude
  'claude-opus-4-7': 'thinking',
  'claude-sonnet-4-6': 'standard',
  'claude-haiku-4-5': 'fast',
  // Codex (OpenAI)
  'gpt-5.5': 'thinking',
  'gpt-5.4': 'standard',
  'gpt-5.4-mini': 'fast',
  'gpt-5.3-codex': 'standard',
  'gpt-5.2': 'standard',
  // Gemini
  'gemini-2.5-pro': 'thinking',
  'gemini-2.5-flash': 'fast',
  // Copilot (uses the underlying model's profile)
  'claude-haiku-4.5': 'fast',
  'claude-sonnet-4.6': 'standard',
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

/// `gpt-5.4-mini` → `GPT-5.4 mini`. `gpt-5.3-codex` → `GPT-5.3 codex`.
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
export function modelTier(backend: Backend): 'Premium' | 'Local' | 'Other' {
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
