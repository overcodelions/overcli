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
    expect(drafterModelFor('gemini')).toBe('gemini-3.1-pro');
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
    // codex: the GPT-5.6 family covers all three tiers on its own — sol
    // reasons, terra is the middle tier, luna is the cheap one — so no
    // tier has to degrade into a neighbour or into a legacy gpt-5.x id.
    expect(drafterModelHints('codex')).toEqual({
      thinking: 'gpt-5.6-sol',
      standard: 'gpt-5.6-terra',
      fast: 'gpt-5.6-luna',
    });
  });

  it('fills all three tiers for gemini from pro / flash / flash-lite', () => {
    // Flash-Lite is the cheap tier, so the critic-loop hint lands on the
    // cheapest model rather than degrading into Flash.
    expect(drafterModelHints('gemini')).toEqual({
      thinking: 'gemini-3.1-pro',
      standard: 'gemini-3.7-flash',
      fast: 'gemini-3.5-flash-lite',
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

describe('drafterModelHints — user pins', () => {
  it('hands the drafter the model the user pinned', () => {
    expect(drafterModelHints('codex', { codex: { standard: 'gpt-5.4' } })).toEqual({
      thinking: 'gpt-5.6-sol',
      standard: 'gpt-5.4',
      fast: 'gpt-5.6-luna',
    });
  });

  it('a pin on one backend does not leak into another', () => {
    const hints = drafterModelHints('claude', { codex: { fast: 'gpt-5.4-mini' } });
    expect(hints.fast).toBe('claude-sonnet-5');
  });

  it('degrades a pinned-but-retired model back to auto', () => {
    expect(drafterModelHints('claude', { claude: { thinking: 'claude-opus-4-1' } }).thinking).toBe(
      'claude-opus-5',
    );
  });

  it('still degrades a tier the backend lacks, pin or no pin', () => {
    // Claude has no standard-tier model; the hint degrades downward to fast
    // so critic loops stay cheap.
    const hints = drafterModelHints('claude', {});
    expect(hints.standard).toBe(hints.fast);
    expect(hints.standard).toBe('claude-sonnet-5');
  });
});
