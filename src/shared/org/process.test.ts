import { describe, expect, it } from 'vitest';
import { accessOf, parseProcessAccess } from './process';

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
