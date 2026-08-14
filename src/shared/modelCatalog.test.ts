import { describe, expect, it } from 'vitest';

import {
  canonicalizePremiumModel,
  friendlyModelLabel,
  liftMissingModel,
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

  it('lists claude-opus-5 first so it is the default Claude model', () => {
    expect(PREMIUM_MODELS.claude[0]).toBe('claude-opus-5');
  });

  it('has retired claude-opus-4-7', () => {
    expect(PREMIUM_MODELS.claude).not.toContain('claude-opus-4-7');
  });
});

// ─── liftMissingModel ─────────────────────────────────────────────────────────

describe('liftMissingModel', () => {
  it('passes through a supported id untouched', () => {
    expect(liftMissingModel('claude', 'claude-opus-5')).toBe('claude-opus-5');
    expect(liftMissingModel('claude', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('lifts a retired opus 4.7 to the next-highest opus (4.8, not 5)', () => {
    expect(liftMissingModel('claude', 'claude-opus-4-7')).toBe('claude-opus-4-8');
  });

  it('lifts a dotted retired id too (relies on version parsing, not exact spelling)', () => {
    expect(liftMissingModel('claude', 'claude-opus-4.7')).toBe('claude-opus-4-8');
  });

  it('lifts a below-catalog opus to the lowest available opus', () => {
    // Opus 4.6 is retired and below everything we ship; next-highest is 4.8.
    expect(liftMissingModel('claude', 'claude-opus-4-6')).toBe('claude-opus-4-8');
  });

  it('falls back to the highest in-family version when nothing is newer', () => {
    // A hypothetical opus 6: nothing higher ships, so settle for the top.
    expect(liftMissingModel('claude', 'claude-opus-6')).toBe('claude-opus-5');
  });

  it('stays within the model family (sonnet lifts to sonnet, not opus)', () => {
    // Sonnet 4.5 is not in the catalog; lifts to Sonnet 4.6, never a sibling family.
    expect(liftMissingModel('claude', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-6');
  });

  it('leaves an unknown-family id unchanged so validation can still reject it', () => {
    expect(liftMissingModel('claude', 'claude-3-5-haiku-20241022')).toBe(
      'claude-3-5-haiku-20241022',
    );
    expect(liftMissingModel('claude', 'totally-made-up')).toBe('totally-made-up');
  });
});

// ─── friendlyModelLabel ───────────────────────────────────────────────────────

describe('friendlyModelLabel — claude', () => {
  it('formats opus-5', () => {
    expect(friendlyModelLabel('claude', 'claude-opus-5')).toBe('Claude Opus 5');
  });

  it('formats opus-4-8', () => {
    expect(friendlyModelLabel('claude', 'claude-opus-4-8')).toBe('Claude Opus 4.8');
  });

  it('formats opus-4-7 (retired, still label-able)', () => {
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

  it('lists gemini-3.1-pro first so it is the gemini default', () => {
    // Pro leads even though Flash is on a much newer version number — the
    // first entry is the strongest model, not the newest release.
    expect(PREMIUM_MODELS.gemini[0]).toBe('gemini-3.1-pro');
  });

  it('does not expose the retired 2.5 gemini models', () => {
    expect(PREMIUM_MODELS.gemini).not.toContain('gemini-2.5-pro');
    expect(PREMIUM_MODELS.gemini).not.toContain('gemini-2.5-flash');
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
  it('formats 3.1-pro with title-cased qualifier', () => {
    expect(friendlyModelLabel('gemini', 'gemini-3.1-pro')).toBe('Gemini 3.1 Pro');
  });

  it('formats 3.7-flash with title-cased qualifier', () => {
    expect(friendlyModelLabel('gemini', 'gemini-3.7-flash')).toBe('Gemini 3.7 Flash');
  });

  it('title-cases both segments of a hyphenated qualifier', () => {
    expect(friendlyModelLabel('gemini', 'gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite');
  });

  it('still formats a retired 2.5 id', () => {
    expect(friendlyModelLabel('gemini', 'gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
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
    ['claude-opus-5', 'thinking'],
    ['claude-opus-4-8', 'thinking'],
    ['claude-sonnet-5', 'fast'],
    ['claude-sonnet-4-6', 'fast'],
    ['claude-haiku-4-5', 'fast'],
    ['gpt-5.6-sol', 'thinking'],
    ['gpt-5.6-terra', 'fast'],
    ['gpt-5.6-luna', 'fast'],
    ['gpt-5.5', 'thinking'],
    ['gpt-5.4', 'standard'],
    ['gpt-5.4-mini', 'fast'],
    ['gemini-3.1-pro', 'thinking'],
    ['gemini-3.7-flash', 'standard'],
    ['gemini-3.6-flash', 'standard'],
    ['gemini-3.5-flash-lite', 'fast'],
    ['gemini-3.1-flash-lite', 'fast'],
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
