import { describe, expect, it } from 'vitest';
import { parseClaudeUsage, parseResetLabel } from './claudeUsage';

describe('parseResetLabel', () => {
  const REF = new Date(2026, 7, 19, 14, 0).getTime(); // Aug 19 2026, 2:00pm local

  it('reads a month, day and time in local time', () => {
    expect(parseResetLabel('Aug 19 at 6:59pm', REF)).toBe(new Date(2026, 7, 19, 18, 59).getTime());
    expect(parseResetLabel('Aug 25 at 10:59am', REF)).toBe(new Date(2026, 7, 25, 10, 59).getTime());
  });

  it('handles hour-only times and 12am/12pm', () => {
    expect(parseResetLabel('Aug 19 at 7pm', REF)).toBe(new Date(2026, 7, 19, 19, 0).getTime());
    expect(parseResetLabel('Aug 20 at 12am', REF)).toBe(new Date(2026, 7, 20, 0, 0).getTime());
    expect(parseResetLabel('Aug 19 at 12pm', REF)).toBe(new Date(2026, 7, 19, 12, 0).getTime());
  });

  it('rolls a yearless date into next year when it would already be past', () => {
    const dec31 = new Date(2026, 11, 31, 22, 0).getTime();
    expect(parseResetLabel('Jan 1 at 2:59am', dec31)).toBe(new Date(2027, 0, 1, 2, 59).getTime());
  });

  it('treats a bare time as the next occurrence', () => {
    expect(parseResetLabel('6:59pm', REF)).toBe(new Date(2026, 7, 19, 18, 59).getTime());
    expect(parseResetLabel('9am', REF)).toBe(new Date(2026, 7, 20, 9, 0).getTime());
  });

  it('returns null for wording it does not recognise', () => {
    expect(parseResetLabel('in 2 hours', REF)).toBeNull();
    expect(parseResetLabel('Foo 19 at 6pm', REF)).toBeNull();
  });
});

/// Captured verbatim from `claude -p "/usage"`.
const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 15% used · resets Aug 19 at 6:59pm (America/New_York)
Current week (all models): 22% used · resets Aug 25 at 10:59am (America/New_York)
Current week (Fable): 9% used · resets Aug 25 at 10:59am (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 3070 requests · 111 sessions
  45% of your usage was at >150k context
  27% of your usage was while 4+ sessions ran in parallel
  Top subagents: general-purpose 1%, Explore 1%
`;

describe('parseClaudeUsage', () => {
  it('pulls the three limit windows out of the real output', () => {
    const snap = parseClaudeUsage(REAL, 1_000)!;
    expect(snap.planType).toBe('subscription');
    expect(snap.capturedAt).toBe(1_000);
    expect(snap.windows.map((w) => w.label)).toEqual([
      'Session',
      'Week (all models)',
      'Week (Fable)',
    ]);
    expect(snap.windows.map((w) => w.usedPercent)).toEqual([15, 22, 9]);
  });

  it('tags the session as a 5h window and the weeklies as 7d', () => {
    const snap = parseClaudeUsage(REAL, 1_000)!;
    expect(snap.windows.map((w) => w.windowMinutes)).toEqual([300, 10080, 10080]);
  });

  it('keeps the printed reset text and drops the timezone parenthetical', () => {
    const snap = parseClaudeUsage(REAL, 1_000)!;
    expect(snap.windows[0].resetsLabel).toBe('Aug 19 at 6:59pm');
    expect(snap.windows[1].resetsLabel).toBe('Aug 25 at 10:59am');
    // No epoch is invented from a string with no year in it.
    expect(snap.windows[0].resetsAt).toBeNull();
  });

  it('ignores the percentages in the prose below the limits', () => {
    // "45% of your usage was at >150k context" must not become a window.
    expect(parseClaudeUsage(REAL, 1_000)!.windows).toHaveLength(3);
  });

  it('returns null when the wording changes, so callers fall back', () => {
    expect(parseClaudeUsage('Some entirely different output', 1_000)).toBeNull();
    expect(parseClaudeUsage('', 1_000)).toBeNull();
  });

  it('survives a missing reset clause', () => {
    const snap = parseClaudeUsage('Current session: 7% used', 1_000)!;
    expect(snap.windows[0].usedPercent).toBe(7);
    expect(snap.windows[0].resetsLabel).toBeUndefined();
  });
});
