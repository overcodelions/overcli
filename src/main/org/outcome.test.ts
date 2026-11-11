import { describe, expect, it } from 'vitest';
import { outcomeFromBody, outcomeOf } from './outcome';

describe('outcomeOf', () => {
  it('takes the worker’s own Outcome line first, bold or not', () => {
    expect(outcomeOf({ title: 'paste it here', body: '**Outcome:** Explained how to seed test data.\n\nRun `npm run seed`…', headline: 'Something else' })).toBe('Explained how to seed test data');
    expect(outcomeOf({ title: 'why is the acme bot quiet', body: 'Outcome: Found the acme bot was missing from the channel\n\nDetails…' })).toBe('Found the acme bot was missing from the channel');
  });

  it('uses the run’s digest headline next, unless it only repeats the title', () => {
    expect(outcomeOf({ title: 'can you check the acme invoices', body: 'Long report', headline: 'Flagged two duplicate acme invoices' })).toBe('Flagged two duplicate acme invoices');
    expect(outcomeOf({ title: 'Weekly acme digest', headline: 'Weekly acme digest.' })).toBeUndefined();
  });

  it('falls back to an opening heading, bold line or first sentence', () => {
    expect(outcomeFromBody('## Seeded the staging database\n\nI ran…', 'paste it here')).toBe('Seeded the staging database');
    expect(outcomeFromBody('**Restarted the acme sync job**\n\nIt had stalled.', 'why is it stuck')).toBe('Restarted the acme sync job');
    expect(outcomeFromBody('The acme bot was removed from the channel on Monday. Re-add it from the channel settings.', 'why isnt the bot replying here')).toBe('The acme bot was removed from the channel on Monday');
  });

  it('leaves the title alone when the reply opens with talk, a question, material or a long sentence', () => {
    for (const body of [
      "Sure! Here's what I found.",
      "Here's the summary:\n- one",
      'Could you paste the error?',
      '```\nnpm run seed\n```',
      '- first point\n- second',
      '| a | b |\n|---|---|',
      `${'word '.repeat(40)}end.`,
      'Done.',
      '',
    ]) expect(outcomeOf({ title: 'paste it here', body })).toBeUndefined();
  });
});
