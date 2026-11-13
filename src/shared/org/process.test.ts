import { describe, expect, it } from 'vitest';
import { accessOf, asksForOk, parseProcessAccess } from './process';

describe('process access', () => {
  it('treats a process with none as open to everyone', () => {
    expect(accessOf({})).toEqual({ who: 'everyone' });
  });

  it('reads an audience from the console, dropping what is malformed', () => {
    expect(parseProcessAccess({ who: 'private', people: [{ name: 'Riley' }] })).toEqual({ who: 'private' });
    expect(parseProcessAccess({ who: 'team', groups: [{ id: 'team:Product leads', name: 'Product leads' }, { id: '', name: 'x' }, 7] })).toEqual({
      who: 'team',
      groups: [{ id: 'team:Product leads', name: 'Product leads' }],
    });
    expect(parseProcessAccess({ who: 'people', people: [{ name: ' Riley ', slackUserId: 'U0RILEY' }, { name: '' }], groups: [] })).toEqual({
      who: 'people',
      people: [{ name: 'Riley', slackUserId: 'U0RILEY' }],
    });
    expect(parseProcessAccess({ who: 'team' })).toBe('Pick the team that can see and start it.');
    expect(parseProcessAccess({ who: 'people' })).toBe('Pick the people who can see and start it.');
    expect(typeof parseProcessAccess({ who: 'anyone' })).toBe('string');
  });
});

describe('a worker answer that stops for an OK', () => {
  it('reads asking for approval, and not finished work', () => {
    for (const r of [
      "I haven't created it yet because I need your approval first.",
      'Shall I create the ticket in ENG?',
      'Once you approve, I will open the ticket.',
      'Waiting for your go-ahead before I post it.',
      'For the next stage: after approval, the ticket key goes into the pack.',
    ]) expect(asksForOk(r), r).toBe(true);
    for (const r of ['Created ENG-7400 and linked the roadmap feature.', 'Approval rates went up 4% last month.', 'The approval flow ships in Q1.', '', undefined]) expect(asksForOk(r), String(r)).toBe(false);
  });
});
