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
    // claude defaults to opus-4-8 (first entry); fable-5 is the frontier
    // opt-in, not the drafter default.
    expect(drafterModelFor('claude')).toBe('claude-opus-4-8');
    expect(drafterModelFor('codex')).toBe('gpt-5.5');
    expect(drafterModelFor('gemini')).toBe('gemini-2.5-pro');
  });
});

describe('drafterModelHints', () => {
  it('maps a model to each speed tier for a backend', () => {
    // fable-5 is 'frontier' (not 'thinking'), so the thinking hint is the
    // first thinking model — opus-4-8. sonnet is classified 'fast', so
    // claude has no 'standard' model — standard degrades up to the thinking
    // pick (opus-4-8), and fast is the first fast model (sonnet-5, which
    // precedes sonnet-4.6 and haiku among the 'fast' models).
    expect(drafterModelHints('claude')).toEqual({
      thinking: 'claude-opus-4-8',
      standard: 'claude-opus-4-8',
      fast: 'claude-sonnet-5',
    });
    expect(drafterModelHints('codex')).toEqual({
      thinking: 'gpt-5.5',
      standard: 'gpt-5.4',
      fast: 'gpt-5.4-mini',
    });
  });

  it('degrades to the nearest stronger tier when a backend lacks one', () => {
    // Gemini has no 'standard' model — standard falls back to thinking.
    expect(drafterModelHints('gemini')).toEqual({
      thinking: 'gemini-2.5-pro',
      standard: 'gemini-2.5-pro',
      fast: 'gemini-2.5-flash',
    });
  });
});
