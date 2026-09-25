import { describe, expect, it } from 'vitest';
import { parseRunDigest } from './runDigest';

describe('parseRunDigest', () => {
  it('reads the headline, summary and points written after the output', () => {
    expect(
      parseRunDigest(
        '<output name="plan.md"># Plan</output>\n<headline>Two gaps: London hotel, Norwalk car</headline>\n<summary>Priced both.</summary>\n<points>\n- London: 3 hotels under $240\n- Norwalk: $58/day\n</points>',
      ),
    ).toEqual({
      headline: 'Two gaps: London hotel, Norwalk car',
      summary: 'Priced both.',
      points: ['London: 3 hotels under $240', 'Norwalk: $58/day'],
    });
  });

  it('ignores tags inside the deliverable, and is null without a headline', () => {
    expect(parseRunDigest('<output name="x"><headline>not mine</headline></output>')).toBeNull();
    expect(parseRunDigest('just text')).toBeNull();
  });

  it('keeps only three points and clips long lines', () => {
    const d = parseRunDigest(`<headline>${'h'.repeat(300)}</headline><points>\n- a\n- b\n- c\n- d\n</points>`)!;
    expect(d.headline.length).toBeLessThanOrEqual(160);
    expect(d.points).toEqual(['a', 'b', 'c']);
  });
});
