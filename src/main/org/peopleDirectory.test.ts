import { describe, expect, it } from 'vitest';
import { buildPeopleDirectory } from './peopleDirectory';

describe('buildPeopleDirectory', () => {
  it('folds every name a person was recorded under into one entry, by their Slack name', () => {
    const people = buildPeopleDirectory({
      seen: [
        { name: 'samr', slackUserId: 'U0ACMESAM' },
        { name: 'Sam Rivera', slackUserId: 'U0ACMESAM' },
        { email: 'sam@acme.example', slackUserId: 'U0ACMESAM' },
        { name: '<@U0ACMESAM>' },
        { name: 'Sam browser' },
      ],
      slack: [{ id: 'U0ACMESAM', name: 'Sam Rivera', handle: 'samr' }],
    });
    expect(people).toEqual([{ id: 'U0ACMESAM', name: 'Sam Rivera', slackUserId: 'U0ACMESAM', handle: 'samr', email: 'sam@acme.example', aliases: ['samr', 'Sam browser'] }]);
  });

  it('prefers a full name over a handle when Slack has not said', () => {
    const [p] = buildPeopleDirectory({ seen: [{ name: 'dana', slackUserId: 'U0ACMEDANA' }, { name: 'Dana Okafor', slackUserId: 'U0ACMEDANA' }] });
    expect(p).toMatchObject({ name: 'Dana Okafor', aliases: ['dana'] });
  });

  it('joins a device-named or first-name sign-in to the one person it points to', () => {
    const people = buildPeopleDirectory({
      seen: [{ name: 'Lena Park', slackUserId: 'U0ACMELENA' }, { name: "Lena's laptop" }, { name: 'lena' }],
    });
    expect(people).toEqual([{ id: 'U0ACMELENA', name: 'Lena Park', slackUserId: 'U0ACMELENA', aliases: ["Lena's laptop", 'lena'] }]);
  });

  it('keeps someone known only by name as their own person, and an ambiguous first name apart', () => {
    const people = buildPeopleDirectory({
      seen: [{ name: 'Alex Ito', slackUserId: 'U0ACMEALX1' }, { name: 'Alex Moreno', slackUserId: 'U0ACMEALX2' }, { name: 'Alex' }, { name: 'Robin browser' }, { name: 'Robin' }],
    });
    expect(people.map((p) => [p.id, p.name, p.aliases ?? []])).toEqual([
      ['name:Alex', 'Alex', []],
      ['U0ACMEALX1', 'Alex Ito', []],
      ['U0ACMEALX2', 'Alex Moreno', []],
      ['name:Robin', 'Robin', ['Robin browser']],
    ]);
  });

  it('leaves out ids nobody has named, and the system’s own callers', () => {
    expect(buildPeopleDirectory({ seen: [{ slackUserId: 'U0ACMENOBODY' }, { name: 'overgo' }, { name: 'U0ACMEBARE' }] })).toEqual([]);
  });
});
