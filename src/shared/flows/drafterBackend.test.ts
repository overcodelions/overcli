import { describe, expect, it } from 'vitest';

import type { Backend } from '../types';
import { pickDrafterBackend, drafterModelFor, drafterModelHints } from './drafterBackend';

const allHealthy = () => true;
const allEnabled = () => true;

describe('pickDrafterBackend', () => {
  it('uses the preferred backend when healthy + enabled', () => {
    expect(
      pickDrafterBackend({ preferred: 'codex', isHealthy: allHealthy, isEnabled: allEnabled }),
    ).toBe('codex');
  });

  it('falls back to the first healthy premium backend when preferred is unhealthy', () => {
    const healthy = new Set<Backend>(['gemini', 'copilot']);
    expect(
      pickDrafterBackend({
        preferred: 'codex',
        isHealthy: (b) => healthy.has(b),
        isEnabled: allEnabled,
      }),
    ).toBe('gemini');
  });

  it('falls back to claude-first ordering when no preference is set', () => {
    expect(
      pickDrafterBackend({ preferred: undefined, isHealthy: allHealthy, isEnabled: allEnabled }),
    ).toBe('claude');
  });

  it('skips disabled backends', () => {
    expect(
      pickDrafterBackend({
        preferred: 'claude',
        isHealthy: allHealthy,
        isEnabled: (b) => b !== 'claude',
      }),
    ).toBe('codex');
  });

  it('never selects ollama, even when preferred', () => {
    const onlyOllama = (b: Backend) => b === 'ollama';
    expect(
      pickDrafterBackend({ preferred: 'ollama', isHealthy: onlyOllama, isEnabled: allEnabled }),
    ).toBeNull();
  });

  it('returns null when nothing is usable', () => {
    expect(
      pickDrafterBackend({ preferred: 'claude', isHealthy: () => false, isEnabled: allEnabled }),
    ).toBeNull();
  });
});

describe('drafterModelFor', () => {
  it('returns the strongest premium model per backend', () => {
    // claude defaults to opus-5 (first entry, the newest thinking model);
    // fable-5 is the frontier opt-in, not the drafter default.
    expect(drafterModelFor('claude')).toBe('claude-opus-5');
    expect(drafterModelFor('codex')).toBe('gpt-5.6-sol');
    expect(drafterModelFor('gemini')).toBe('gemini-2.5-pro');
  });
});

describe('drafterModelHints', () => {
  it('maps a model to each speed tier for a backend', () => {
    // fable-5 is 'frontier' (not 'thinking'), so the thinking hint is the
    // first thinking model — opus-5. sonnet is classified 'fast', so claude
    // has no 'standard' model — standard degrades DOWN to the fast pick
    // (sonnet-5), keeping "cheaper steps" actually cheaper.
    expect(drafterModelHints('claude')).toEqual({
      thinking: 'claude-opus-5',
      standard: 'claude-sonnet-5',
      fast: 'claude-sonnet-5',
    });
    // codex: sol is the first thinking model, terra the first fast model
    // (both precede the legacy gpt-5.x entries); gpt-5.4 is the sole
    // 'standard' pick.
    expect(drafterModelHints('codex')).toEqual({
      thinking: 'gpt-5.6-sol',
      standard: 'gpt-5.4',
      fast: 'gpt-5.6-terra',
    });
  });

  it('degrades a missing middle tier downward, not up to the expensive one', () => {
    // Gemini has no 'standard' model. It must fall to flash, not pro: the
    // drafter spends this hint on critic loops and cheap steps, so picking
    // the thinking model there inverts the intent and quietly runs the
    // cheapest steps of every drafted flow on the priciest model.
    expect(drafterModelHints('gemini')).toEqual({
      thinking: 'gemini-2.5-pro',
      standard: 'gemini-2.5-flash',
      fast: 'gemini-2.5-flash',
    });
  });

  it('falls all the way back to the thinking pick when a backend has only one tier', () => {
    // copilot lists gpt-5.5 (thinking) plus two fast claude ids, so it has
    // a fast model to degrade into; the thinking-only path is the guard
    // for a backend whose catalog is a single strong model.
    const hints = drafterModelHints('copilot');
    expect(hints.thinking).toBe('gpt-5.5');
    expect(hints.standard).toBe(hints.fast);
  });
});
