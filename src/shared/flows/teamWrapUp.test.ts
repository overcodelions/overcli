import { describe, expect, it } from 'vitest';
import { parseWrapUp, splitOwner } from './teamWrapUp';
import { buildRoomWrapUpMessage } from './teamRoom';

describe('parseWrapUp', () => {
  it('reads the shape the prompt asks for: a bottom line, then three bullet lists', () => {
    const text = [
      'Cuts are probably needed, but nobody can prove it until the census is in. The freeze can start now.',
      '',
      '**Agreed:**',
      '- Treat the cuts as unproven until the census.',
      '- Show the saving as a range, not one number.',
      '',
      '**Still open:**',
      '- Which roles are actually filled? — payroll, by Dec 15',
      '- When does the Acme Link contract end?',
      '',
      '**Worth changing in the pack:**',
      '- Show 73% as an upper bound.',
      '- Split cash timing out from the run-rate.',
    ].join('\n');
    expect(parseWrapUp(text)).toEqual({
      bottomLine: 'Cuts are probably needed, but nobody can prove it until the census is in. The freeze can start now.',
      agreed: ['Treat the cuts as unproven until the census.', 'Show the saving as a range, not one number.'],
      open: ['Which roles are actually filled? — payroll, by Dec 15', 'When does the Acme Link contract end?'],
      changes: ['Show 73% as an upper bound.', 'Split cash timing out from the run-rate.'],
    });
  });

  it('reads the older one-paragraph shape, labels run together', () => {
    const text = '**Agreed:** the freeze starts now. **Still open:** who owns the census. **Worth changing in the pack:** state the range.';
    expect(parseWrapUp(text)).toEqual({
      bottomLine: '',
      agreed: ['the freeze starts now.'],
      open: ['who owns the census.'],
      changes: ['state the range.'],
    });
  });

  it('reads plain labels at line starts, with the label bolded outside the colon', () => {
    const text = 'Agreed: ship v2 first.\nStill open: pricing.\n**Worth changing in the pack**: add the risk table.';
    expect(parseWrapUp(text)).toMatchObject({
      agreed: ['ship v2 first.'],
      open: ['pricing.'],
      changes: ['add the risk table.'],
    });
  });

  it('reads headings and numbered lists, and joins a bullet that wraps', () => {
    const text = [
      '## Bottom line',
      'Same direction, less confidence.',
      '### Agreed',
      '1. Only the floor is safe',
      '   to commit to.',
      '2. The freeze stays.',
      '### Open questions',
      '* Who signs off?',
      '### Changes to the pack',
      '+ Add the rollout risk.',
    ].join('\n');
    expect(parseWrapUp(text)).toEqual({
      bottomLine: 'Same direction, less confidence.',
      agreed: ['Only the floor is safe to commit to.', 'The freeze stays.'],
      open: ['Who signs off?'],
      changes: ['Add the rollout risk.'],
    });
  });

  it('drops "None" and emphasis, and leaves out a section that is not there', () => {
    const text = 'We landed on **option B**.\n\n**Agreed:** _option B_ over A.\n**Still open:** None.';
    expect(parseWrapUp(text)).toEqual({ bottomLine: 'We landed on option B.', agreed: ['option B over A.'], open: [], changes: [] });
  });

  it('is null for text with no wrap-up labels, and ignores a bolded word that is not a label', () => {
    expect(parseWrapUp('Everyone **agreed** that the plan holds.')).toBeNull();
    expect(parseWrapUp('')).toBeNull();
    expect(parseWrapUp('The question still open: is it worth it? Nobody knows.')).toBeNull();
  });
});

describe('splitOwner', () => {
  it('splits who answers off an open item, after a dash or in brackets', () => {
    expect(splitOwner('Which roles are filled? — payroll, by Dec 15')).toEqual({ text: 'Which roles are filled?', who: 'payroll, by Dec 15' });
    expect(splitOwner('Who owns the census (ask finance this week)')).toEqual({ text: 'Who owns the census', who: 'ask finance this week' });
    expect(splitOwner('A plain question?')).toEqual({ text: 'A plain question?' });
  });
});

describe('buildRoomWrapUpMessage', () => {
  const exchange = [
    { id: '1', speaker: { kind: 'you' as const }, text: 'Is the plan safe?', at: 1, exchange: 0 },
    { id: '2', speaker: { kind: 'member' as const, workerId: 'w', name: 'Maya' }, text: 'Mostly.', at: 2, exchange: 0 },
  ];
  it('asks for a bottom line first, then the three lists the desk reads back', () => {
    const msg = buildRoomWrapUpMessage({ exchange });
    expect(msg).toContain('Maya: Mostly.');
    expect(msg).toMatch(/bottom line/i);
    expect(msg.indexOf('Agreed:')).toBeLessThan(msg.indexOf('Still open:'));
    expect(msg.indexOf('Still open:')).toBeLessThan(msg.indexOf('Worth changing in the pack:'));
    expect(msg).toMatch(/who answers it/i);
    expect(msg).toMatch(/by when/i);
  });

  it('round-trips: a reply in the asked-for shape parses into every part', () => {
    const msg = buildRoomWrapUpMessage({ exchange });
    // The example shape in the prompt, filled in, is what the parser reads.
    const shape = msg.slice(msg.indexOf('<example>') + '<example>'.length, msg.indexOf('</example>'));
    const parsed = parseWrapUp(shape);
    expect(parsed?.bottomLine).not.toBe('');
    expect(parsed?.agreed.length).toBeGreaterThan(0);
    expect(parsed?.open.length).toBeGreaterThan(0);
    expect(parsed?.changes.length).toBeGreaterThan(0);
  });
});
