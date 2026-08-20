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
  it('prepends the directive and keeps the prompt intact', () => {
    const out = withBatchingDirective('do the thing');
    expect(out.startsWith(BATCHING_DIRECTIVE)).toBe(true);
    expect(out.endsWith('do the thing')).toBe(true);
  });
});
