import { describe, expect, it } from 'vitest';
import { BATCHING_DIRECTIVE, resolveTurboEffort, withBatchingDirective } from './turbo';

describe('resolveTurboEffort', () => {
  it('pins low when turbo is on, overriding an explicit effort', () => {
    expect(resolveTurboEffort(true, 'max')).toBe('low');
    expect(resolveTurboEffort(true, undefined)).toBe('low');
  });

  it('leaves effort untouched when turbo is off or unset', () => {
    expect(resolveTurboEffort(false, 'max')).toBe('max');
    expect(resolveTurboEffort(undefined, 'high')).toBe('high');
    // Empty string is Auto and must survive — it means "let the CLI decide",
    // which is not the same as unset.
    expect(resolveTurboEffort(undefined, '')).toBe('');
  });
});

describe('BATCHING_DIRECTIVE', () => {
  it('keeps the correctness caveat that stops it reading as skip-your-checks', () => {
    expect(BATCHING_DIRECTIVE).toMatch(/fewer, larger tool calls/i);
    expect(BATCHING_DIRECTIVE).toMatch(/never skip a check/i);
  });
});

describe('withBatchingDirective', () => {
  // Unconditional by design: the directive is no longer turbo-gated, so
  // there is no `turbo` argument to forget to pass. Batching costs nothing
  // in answer quality, unlike the effort half `resolveTurboEffort` still
  // guards.
  it('appends the directive and keeps the prompt intact', () => {
    const out = withBatchingDirective('do the thing');
    expect(out.endsWith(BATCHING_DIRECTIVE)).toBe(true);
    expect(out).toContain('do the thing');
  });

  // Load-bearing, not cosmetic: codex app-server turns show up as
  // conversations in the ChatGPT client, which titles each one from the
  // first line of the first message. Prepending the directive made every
  // conversation identically titled and unfindable.
  it('leaves the user prompt as the first line so titles stay distinct', () => {
    const out = withBatchingDirective('do the thing');
    expect(out.split('\n')[0]).toBe('do the thing');
    expect(out.startsWith(BATCHING_DIRECTIVE)).toBe(false);
  });
});
