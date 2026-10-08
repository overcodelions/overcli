import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_SCALE, UI_SCALE_STEPS, clampUiScale, stepUiScale } from './uiScale';

describe('clampUiScale', () => {
  it('defaults anything that is not a number', () => {
    expect(clampUiScale(undefined)).toBe(DEFAULT_UI_SCALE);
    expect(clampUiScale('1.25')).toBe(DEFAULT_UI_SCALE);
    expect(clampUiScale(Number.NaN)).toBe(DEFAULT_UI_SCALE);
  });

  it('keeps an in-range value, even between steps', () => {
    expect(clampUiScale(1.25)).toBe(1.25);
    expect(clampUiScale(1.75)).toBe(1.75);
  });

  it('pins values outside 0.75–2', () => {
    expect(clampUiScale(0.1)).toBe(0.75);
    expect(clampUiScale(9)).toBe(2);
  });
});

describe('stepUiScale', () => {
  it('walks the steps in both directions', () => {
    expect(stepUiScale(1, 1)).toBe(1.1);
    expect(stepUiScale(1.1, 1)).toBe(1.25);
    expect(stepUiScale(1, -1)).toBe(0.85);
  });

  it('stays put at either end', () => {
    expect(stepUiScale(UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1], 1)).toBe(1.5);
    expect(stepUiScale(UI_SCALE_STEPS[0], -1)).toBe(0.85);
  });

  it('moves an off-step value to the nearest step in that direction', () => {
    expect(stepUiScale(1.2, 1)).toBe(1.25);
    expect(stepUiScale(1.2, -1)).toBe(1.1);
    // Beyond the largest step, + leaves it alone and − comes back in range.
    expect(stepUiScale(1.75, 1)).toBe(1.75);
    expect(stepUiScale(1.75, -1)).toBe(1.5);
  });
});
