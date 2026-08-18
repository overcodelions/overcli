import { describe, expect, it } from 'vitest';
import { TURBO_SYSTEM_PROMPT, resolveTurboEffort } from './turbo';

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

describe('TURBO_SYSTEM_PROMPT', () => {
  it('keeps the correctness caveat that stops it reading as skip-your-checks', () => {
    expect(TURBO_SYSTEM_PROMPT).toMatch(/fewer, larger tool calls/i);
    expect(TURBO_SYSTEM_PROMPT).toMatch(/never skip a check/i);
  });
});
