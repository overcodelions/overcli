import { describe, expect, it } from 'vitest';
import { checkShortName, resolveShortNames, suggestShortName, usedShortName } from './shortName';

describe('short names', () => {
  it('offers initials when there are enough words', () => {
    expect(suggestShortName('Launch review board')).toBe('lrb');
    expect(suggestShortName('Pricing Desk')).toBe('pd');
    expect(suggestShortName('Bugs')).toBe('');
    // "Ask the team" would be "att": fine. "Bug Under Grid" would be "bug": too common.
    expect(suggestShortName('Bug Under Grid')).toBe('');
    // Initials that spell an order a message would start with are no short name.
    expect(suggestShortName('Support Escalation Engineering')).toBe('');
    expect(suggestShortName('Analytics Data Desk')).toBe('');
  });

  it('takes a few letters, numbers and dashes, never a common first word', () => {
    expect(checkShortName('lrb')).toBeNull();
    expect(checkShortName('q4-plan')).toBeNull();
    expect(checkShortName('d')).toMatch(/between 2/);
    expect(checkShortName('two words')).toMatch(/no spaces/);
    expect(checkShortName('bug')).toMatch(/too common/);
    expect(checkShortName('see')).toMatch(/too common/);
    expect(checkShortName('add')).toMatch(/too common/);
    expect(checkShortName('the')).toMatch(/too common/);
  });

  it('gives each its initials while free, the older first, and keeps the ones people set', () => {
    const names = resolveShortNames([
      { id: 'a', name: 'Launch review board' },
      { id: 'b', name: 'Legal risk brief' },
      { id: 'c', name: 'Pricing Desk', shortName: 'pd' },
      { id: 'd', name: 'Bugs' },
      { id: 'e', name: 'Ops Runbook', },
      { id: 'f', name: 'Other Releases', shortName: 'or' },
    ]);
    expect(names.get('a')).toBe('lrb');
    expect(names.has('b')).toBe(false);
    expect(names.get('c')).toBe('pd');
    expect(names.has('d')).toBe(false);
    expect(names.has('e')).toBe(false);
    expect(names.get('f')).toBe('or');
  });

  it('knows when a message already started with it', () => {
    expect(usedShortName('lrb let customers export', 'lrb')).toBe(true);
    expect(usedShortName('LRB: export', 'lrb')).toBe(true);
    expect(usedShortName('lrbx export', 'lrb')).toBe(false);
    expect(usedShortName('Launch review board: export', 'lrb')).toBe(false);
    expect(usedShortName('anything', undefined)).toBe(false);
  });
});
