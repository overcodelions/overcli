import { describe, expect, it } from 'vitest';
import { parseCodexRateLimitLine } from './stats';

const LINE =
  '{"timestamp":"2026-08-19T17:46:04.755Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":82,"window_minutes":10080,"resets_at":1787219794},"secondary":null,"plan_type":"plus"}}}';

describe('parseCodexRateLimitLine', () => {
  it('reads the reported percentage, window and reset', () => {
    const snap = parseCodexRateLimitLine(LINE)!;
    expect(snap.planType).toBe('plus');
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0].usedPercent).toBe(82);
    expect(snap.windows[0].label).toBe('7d window');
    expect(snap.windows[0].resetsAt).toBe(1787219794000);
  });

  it('returns null for unrelated or malformed lines', () => {
    expect(parseCodexRateLimitLine('{"type":"event_msg"}')).toBeNull();
    expect(parseCodexRateLimitLine('{"rate_limits": broken')).toBeNull();
  });
});
