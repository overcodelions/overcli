import { describe, expect, it } from 'vitest';

import { digestFor, kindOf, skimDigest, taggedDigest } from './digestSummary';

describe('taggedDigest', () => {
  it('prefers what the worker said about its own work', () => {
    const d = taggedDigest(
      'Done.\n<headline>Two gaps: a London hotel and a Norwalk car</headline>\n<points>\n- London: 3 hotels under $240\n- Norwalk: car $58/day\n</points>',
    );
    expect(d).toEqual({
      headline: 'Two gaps: a London hotel and a Norwalk car',
      summary: '',
      points: ['London: 3 hotels under $240', 'Norwalk: car $58/day'],
    });
  });

  it('is null without a headline, so the skim takes over', () => {
    expect(taggedDigest('<points>- a</points>')).toBeNull();
  });
});

describe('skimDigest', () => {
  it('uses a heading that says something, then the first paragraph and bullets', () => {
    const d = skimDigest(
      '# Two gaps in the next 90 days\n\nChecked mail and calendar for three trips, then priced what is missing.\n\n- London: hotel not booked\n- Norwalk: no rental car\n- Alpharetta: all set\n- extra',
      'fallback',
    );
    expect(d.headline).toBe('Two gaps in the next 90 days');
    expect(d.summary).toBe('Checked mail and calendar for three trips, then priced what is missing.');
    expect(d.points).toEqual(['London: hotel not booked', 'Norwalk: no rental car', 'Alpharetta: all set']);
  });

  it('skips a generic title and leads with the first sentence instead', () => {
    const d = skimDigest('# Summary\n\nThe export hangs because the worker never acks. A retry fixes it.', 'fallback');
    expect(d.headline).toBe('The export hangs because the worker never acks.');
    expect(d.summary).toBe('A retry fixes it.');
  });

  it('strips markdown decoration and falls back to the job title on an empty file', () => {
    expect(skimDigest('Found **3** issues in [the repo](https://x).', 'f').headline).toBe('Found 3 issues in the repo.');
    expect(skimDigest('', 'Weekly gap review').headline).toBe('Weekly gap review');
  });
});

describe('digestFor', () => {
  it('reads an html deliverable through its headings and list items', () => {
    const d = digestFor(
      '<html><head><style>h1{}</style></head><body><h1>Morning briefing: 4 meetings, 2 need prep</h1><p>Pulled the calendar.</p><ul><li>10:00 roadmap review</li></ul></body></html>',
      'html',
      'f',
    );
    expect(d.headline).toBe('Morning briefing: 4 meetings, 2 need prep');
    expect(d.summary).toBe('Pulled the calendar.');
    expect(d.points).toEqual(['10:00 roadmap review']);
  });

  it('never heads a card with the script of a page that draws itself', () => {
    const page =
      '<html><head><title>Daily Executive Brief — Sep 24</title></head><body><div id="app"></div><script>const JIRA = "https://example.test/browse/"; render();';
    const d = digestFor(page, 'html', 'Morning briefing');
    expect(d.headline).toBe('Daily Executive Brief — Sep 24');
    expect(d.summary).toBe('');
    expect(digestFor('<body><script>const x = 1;</script></body>', 'html', 'Fallback title').headline).toBe(
      'Fallback title',
    );
  });

  it('knows how to read a file by its name', () => {
    expect(kindOf('trips.md')).toBe('markdown');
    expect(kindOf('briefing.HTML')).toBe('html');
    expect(kindOf('data.json')).toBe('text');
  });
});
