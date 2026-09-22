import { describe, expect, it } from 'vitest';
import { claudeModelPrice, estimateCost } from './modelPricing';

describe('claudeModelPrice', () => {
  it('prices older Opus ids above the current Opus line', () => {
    expect(claudeModelPrice('claude-opus-4-1-20250805')).toEqual({ input: 15, output: 75 });
    expect(claudeModelPrice('claude-opus-4-20250514')).toEqual({ input: 15, output: 75 });
    expect(claudeModelPrice('claude-opus-5')).toEqual({ input: 5, output: 25 });
    // Opus 5.5 undercuts the rest of the Opus line, so it needs its own row
    // above the `claude-opus` catch-all.
    expect(claudeModelPrice('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(claudeModelPrice('claude-opus-4-7')).toEqual({ input: 5, output: 25 });
  });

  it('separates Sonnet 5 from earlier Sonnets', () => {
    expect(claudeModelPrice('claude-sonnet-5')).toEqual({ input: 2, output: 10 });
    expect(claudeModelPrice('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 });
  });

  it('falls back to Sonnet pricing for an unknown id', () => {
    expect(claudeModelPrice('something-new')).toEqual({ input: 3, output: 15 });
  });
});

describe('estimateCost', () => {
  it('weights cache reads at a tenth of input and cache writes by TTL', () => {
    const c = estimateCost('claude-opus-5', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
    });
    expect(c.input).toBeCloseTo(5);
    expect(c.output).toBeCloseTo(25);
    expect(c.cacheRead).toBeCloseTo(0.5);
    expect(c.cacheWrite).toBeCloseTo(6.25 + 10);
    expect(c.total).toBeCloseTo(46.75);
  });
});

describe('estimateCost — per-model cache-read rates', () => {
  const cacheOnly = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0 };

  it('uses a model-specific cache-read rate where one is published', () => {
    // Opus 5.5 reads cache at $0.20 (0.05× input), not the usual tenth.
    expect(estimateCost('claude-opus-5-5', cacheOnly).cacheRead).toBeCloseTo(0.2);
    // Fable 5.1 reads cache at $0.25 (0.025× input); Fable 5 keeps 0.1×.
    expect(estimateCost('claude-fable-5-1', cacheOnly).cacheRead).toBeCloseTo(0.25);
    expect(estimateCost('claude-fable-5', cacheOnly).cacheRead).toBeCloseTo(1);
  });

  it('still prices cache writes off input for those models', () => {
    const c = estimateCost('claude-opus-5-5', {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
    });
    expect(c.cacheWrite).toBeCloseTo(4 * 1.25 + 4 * 2);
  });
});
