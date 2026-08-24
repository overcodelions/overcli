import { describe, expect, it } from 'vitest';

import {
  MOMENTUM_HALF_LIFE_MS,
  actionMomentum,
  momentumBars,
  momentumScore,
} from './sidebarMomentum';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('momentumScore', () => {
  it('is zero for something never driven', () => {
    expect(momentumScore({ turns: 0, firstAt: NOW - HOUR, lastAt: NOW }, NOW)).toBe(0);
  });

  it('ranks a worked thread above a one-off fired more recently', () => {
    // The case the Working-on section used to get wrong: `promptedAt` alone
    // put the stray message on top.
    const worked = momentumScore({ turns: 40, firstAt: NOW - 4 * HOUR, lastAt: NOW - HOUR }, NOW);
    const oneOff = momentumScore({ turns: 1, firstAt: NOW - 5 * 60_000, lastAt: NOW - 5 * 60_000 }, NOW);
    expect(worked).toBeGreaterThan(oneOff);
  });

  it('quotes turns per hour, so the same turns over longer count for less', () => {
    const dense = momentumScore({ turns: 20, firstAt: NOW - 2 * HOUR, lastAt: NOW }, NOW);
    const spread = momentumScore({ turns: 20, firstAt: NOW - 200 * HOUR, lastAt: NOW }, NOW);
    expect(dense).toBeGreaterThan(spread);
  });

  it('halves the score every half-life of silence', () => {
    const fresh = momentumScore({ turns: 10, firstAt: NOW - HOUR, lastAt: NOW }, NOW);
    const stale = momentumScore(
      { turns: 10, firstAt: NOW - HOUR - MOMENTUM_HALF_LIFE_MS, lastAt: NOW - MOMENTUM_HALF_LIFE_MS },
      NOW,
    );
    expect(stale).toBeCloseTo(fresh / 2, 6);
  });

  it('never reorders two items on its own as time passes', () => {
    // The property the Active section is built on: rows move when the user
    // takes a turn and at no other moment. `now` cancels out of the ratio.
    const a = { turns: 30, firstAt: NOW - 3 * HOUR, lastAt: NOW - 2 * HOUR };
    const b = { turns: 4, firstAt: NOW - 30 * HOUR, lastAt: NOW - 10 * 60_000 };
    const orderNow = Math.sign(momentumScore(a, NOW) - momentumScore(b, NOW));
    for (const later of [NOW + HOUR, NOW + 24 * HOUR, NOW + 400 * HOUR]) {
      expect(Math.sign(momentumScore(a, later) - momentumScore(b, later))).toBe(orderNow);
    }
  });

  it('treats a burst inside the window floor as one hour, not a divide by zero', () => {
    const score = momentumScore({ turns: 6, firstAt: NOW - 1000, lastAt: NOW }, NOW);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeCloseTo(6, 6);
  });

  it('clamps a lastAt in the future rather than inflating the score', () => {
    const score = momentumScore({ turns: 5, firstAt: NOW, lastAt: NOW + 10 * HOUR }, NOW);
    expect(score).toBeCloseTo(5, 6);
  });
});

describe('actionMomentum', () => {
  it('lets a just-launched run rank against a chat', () => {
    const justLaunched = actionMomentum(1, NOW, NOW);
    const chatIdleADay = momentumScore(
      { turns: 20, firstAt: NOW - 25 * HOUR, lastAt: NOW - 24 * HOUR },
      NOW,
    );
    expect(justLaunched).toBeGreaterThan(chatIdleADay);
  });

  it('decays an old run below a chat being worked now', () => {
    expect(actionMomentum(1, NOW - 48 * HOUR, NOW)).toBeLessThan(
      momentumScore({ turns: 12, firstAt: NOW - HOUR, lastAt: NOW }, NOW),
    );
  });
});

describe('momentumBars', () => {
  it('renders nothing below one turn an hour', () => {
    expect(momentumBars(0)).toBe(0);
    expect(momentumBars(0.9)).toBe(0);
  });

  it('steps through steady and heads-down', () => {
    expect(momentumBars(1)).toBe(1);
    expect(momentumBars(3)).toBe(2);
    expect(momentumBars(8)).toBe(3);
    expect(momentumBars(500)).toBe(3);
  });
});
