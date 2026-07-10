import { describe, expect, it } from 'vitest';

import {
  canonicalizePremiumModel,
  friendlyModelLabel,
  modelSpeed,
  modelTierLabel,
  PREMIUM_MODELS,
} from './modelCatalog';

// ─── PREMIUM_MODELS shape ─────────────────────────────────────────────────────

describe('PREMIUM_MODELS', () => {
  it('covers all non-ollama backends', () => {
    expect(Object.keys(PREMIUM_MODELS).sort()).toEqual(
      ['claude', 'codex', 'copilot', 'gemini'],
    );
  });

  it('each backend list is non-empty', () => {
    for (const [backend, models] of Object.entries(PREMIUM_MODELS)) {
      expect(models.length, `${backend} should have at least one model`).toBeGreaterThan(0);
    }
  });
});

// ─── friendlyModelLabel ───────────────────────────────────────────────────────

describe('friendlyModelLabel — claude', () => {
  it('formats opus-4-8', () => {
    expect(friendlyModelLabel('claude', 'claude-opus-4-8')).toBe('Claude Opus 4.8');
  });

  it('formats opus-4-7', () => {
    expect(friendlyModelLabel('claude', 'claude-opus-4-7')).toBe('Claude Opus 4.7');
  });

  it('formats fable-5', () => {
    expect(friendlyModelLabel('claude', 'claude-fable-5')).toBe('Claude Fable 5');
  });

  it('formats sonnet-5', () => {
    expect(friendlyModelLabel('claude', 'claude-sonnet-5')).toBe('Claude Sonnet 5');
  });

  it('formats sonnet-4-6', () => {
    expect(friendlyModelLabel('claude', 'claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
  });

  it('formats haiku-4-5', () => {
    expect(friendlyModelLabel('claude', 'claude-haiku-4-5')).toBe('Claude Haiku 4.5');
  });

  it('returns a pick-model placeholder when model is empty', () => {
    expect(friendlyModelLabel('claude', '')).toBe('claude (pick model)');
  });
});

describe('friendlyModelLabel — codex (OpenAI GPT)', () => {
  it('formats gpt-5.5 with Codex suffix', () => {
    expect(friendlyModelLabel('codex', 'gpt-5.5')).toBe('GPT-5.5 (Codex)');
  });

  it('title-cases the GPT-5.6 codenames', () => {
    expect(friendlyModelLabel('codex', 'gpt-5.6-sol')).toBe('GPT-5.6 Sol (Codex)');
    expect(friendlyModelLabel('codex', 'gpt-5.6-terra')).toBe('GPT-5.6 Terra (Codex)');
    expect(friendlyModelLabel('codex', 'gpt-5.6-luna')).toBe('GPT-5.6 Luna (Codex)');
  });

  it('lists gpt-5.6-sol first so it is the codex default', () => {
    expect(PREMIUM_MODELS.codex[0]).toBe('gpt-5.6-sol');
  });

  it('formats gpt-5.4 with Codex suffix', () => {
    expect(friendlyModelLabel('codex', 'gpt-5.4')).toBe('GPT-5.4 (Codex)');
  });

  it('does not expose gpt-5.2 as a supported Codex model', () => {
    expect(PREMIUM_MODELS.codex).not.toContain('gpt-5.2');
  });

  it('lowercases the mini qualifier', () => {
    expect(friendlyModelLabel('codex', 'gpt-5.4-mini')).toBe('GPT-5.4 mini (Codex)');
  });

  it('returns a pick-model placeholder when model is empty', () => {
    expect(friendlyModelLabel('codex', '')).toBe('codex (pick model)');
  });
});

describe('friendlyModelLabel — gemini', () => {
  it('formats 2.5-pro with title-cased qualifier', () => {
    expect(friendlyModelLabel('gemini', 'gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
  });

  it('formats 2.5-flash with title-cased qualifier', () => {
    expect(friendlyModelLabel('gemini', 'gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
  });

  it('returns a pick-model placeholder when model is empty', () => {
    expect(friendlyModelLabel('gemini', '')).toBe('gemini (pick model)');
  });
});

describe('friendlyModelLabel — copilot', () => {
  it('formats a copilot claude model using Claude title-case plus suffix', () => {
    // Copilot Claude ids use dot separators (e.g. claude-haiku-4.5).
    // The formatter normalises 4.5 → 4-5 and then title-cases.
    expect(friendlyModelLabel('copilot', 'claude-haiku-4.5')).toBe('Claude Haiku 4.5 (Copilot)');
  });

  it('formats a copilot sonnet model', () => {
    expect(friendlyModelLabel('copilot', 'claude-sonnet-4.6')).toBe('Claude Sonnet 4.6 (Copilot)');
  });

  it('formats a copilot gpt model', () => {
    expect(friendlyModelLabel('copilot', 'gpt-5.5')).toBe('GPT-5.5 (Copilot)');
  });

  it('returns a pick-model placeholder when model is empty', () => {
    expect(friendlyModelLabel('copilot', '')).toBe('copilot (pick model)');
  });
});

describe('friendlyModelLabel — ollama', () => {
  it('appends (local) to the raw model id', () => {
    expect(friendlyModelLabel('ollama', 'qwen2.5-coder:7b')).toBe('qwen2.5-coder:7b (local)');
  });

  it('appends (local) to a model with a colon tag', () => {
    expect(friendlyModelLabel('ollama', 'gemma4:26b')).toBe('gemma4:26b (local)');
  });

  it('returns a pick-model placeholder when model is empty', () => {
    expect(friendlyModelLabel('ollama', '')).toBe('ollama (pick model)');
  });
});

// ─── modelSpeed ───────────────────────────────────────────────────────────────

describe('modelSpeed', () => {
  it.each([
    ['claude-fable-5', 'frontier'],
    ['claude-opus-4-8', 'thinking'],
    ['claude-opus-4-7', 'thinking'],
    ['claude-sonnet-5', 'fast'],
    ['claude-sonnet-4-6', 'fast'],
    ['claude-haiku-4-5', 'fast'],
    ['gpt-5.6-sol', 'thinking'],
    ['gpt-5.6-terra', 'fast'],
    ['gpt-5.6-luna', 'fast'],
    ['gpt-5.5', 'thinking'],
    ['gpt-5.4', 'standard'],
    ['gpt-5.4-mini', 'fast'],
    ['gemini-2.5-pro', 'thinking'],
    ['gemini-2.5-flash', 'fast'],
    ['claude-haiku-4.5', 'fast'],
    ['claude-sonnet-4.6', 'fast'],
  ] as const)('%s → %s', (model, expected) => {
    expect(modelSpeed(model)).toBe(expected);
  });

  it('returns "standard" for an unknown model id', () => {
    expect(modelSpeed('some-future-model-99')).toBe('standard');
  });
});

// ─── canonicalizePremiumModel ───────────────────────────────────────────────

describe('canonicalizePremiumModel', () => {
  it('passes through an exact catalog match', () => {
    expect(canonicalizePremiumModel('claude', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('snaps a dotted claude id to the dashed catalog spelling', () => {
    // The AI drafter bug: it emits the Copilot-style dotted form on the
    // claude backend; without this it fails the exact-match validator.
    expect(canonicalizePremiumModel('claude', 'claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(canonicalizePremiumModel('claude', 'claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(canonicalizePremiumModel('claude', 'claude-opus-4.8')).toBe('claude-opus-4-8');
  });

  it('snaps a dashed claude id to the dotted copilot spelling', () => {
    expect(canonicalizePremiumModel('copilot', 'claude-haiku-4-5')).toBe('claude-haiku-4.5');
  });

  it('leaves a genuinely-unknown id unchanged so validation can reject it', () => {
    expect(canonicalizePremiumModel('claude', 'claude-3-5-haiku-20241022')).toBe(
      'claude-3-5-haiku-20241022',
    );
    expect(canonicalizePremiumModel('claude', 'totally-made-up')).toBe('totally-made-up');
  });
});

// ─── modelTierLabel ───────────────────────────────────────────────────────────

describe('modelTierLabel', () => {
  it.each(['claude', 'codex', 'gemini', 'copilot'] as const)(
    '%s → Premium',
    (backend) => expect(modelTierLabel(backend)).toBe('Premium'),
  );

  it('ollama → Local', () => {
    expect(modelTierLabel('ollama')).toBe('Local');
  });
});
