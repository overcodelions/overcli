import { describe, expect, it } from 'vitest';
import { parseClaudeUsage } from './claudeUsage';

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
