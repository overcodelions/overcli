import { describe, expect, it } from 'vitest';
import { slackConversations, slackStats, slackToMarkdown, threadMessages } from './conversations';
import type { DoorLog } from './frontDoor';

const PAT: DoorLog = { key: 'D0PAT:1.0', channel: 'D0PAT', threadTs: '1.0', user: 'U0PAT', by: 'Pat', text: 'whats next on the roadmap', at: 1_000, dm: true, outcome: 'Asked Product Team' };
const SAM: DoorLog = { ...PAT, key: 'D0SAM:2.0', channel: 'D0SAM', threadTs: '2.0', user: 'U0SAM', by: 'Sam', text: 'who owns billing?' };

describe('the Slack page', () => {
  it('shows each person what they asked, and an admin everyone', () => {
    const c = slackConversations({ log: () => [PAT, SAM], botToken: () => 'xoxb', admin: (caller) => caller.admin });
    expect(c.list({ name: 'Pat', slackUserId: 'U0PAT', admin: false }).conversations.map((x) => x.by)).toEqual(['Pat']);
    expect(c.list({ name: 'Ada', slackUserId: 'U0ADA', admin: true }).conversations.map((x) => x.by)).toEqual(['Pat', 'Sam']);
    expect(c.list({ name: 'Ada', admin: false }).conversations).toEqual([]);
  });

  it('says what kind of outcome each was, and who it went to', () => {
    const c = slackConversations({ log: () => [{ ...PAT, kind: 'handed', who: 'Product Team', team: true }, SAM], botToken: () => 'xoxb', admin: () => true });
    const [pat, sam] = c.list({ name: 'Ada', admin: true }).conversations;
    expect(pat).toMatchObject({ kind: 'handed', who: 'Product Team', team: true });
    expect(sam).not.toHaveProperty('kind');
    expect(sam).not.toHaveProperty('who');
  });

  it('gives a page at a time, and says when there are more', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...PAT, key: `D0PAT:${i}.0`, text: `q${i}` }));
    const c = slackConversations({ log: () => many, botToken: () => 'xoxb', admin: () => false });
    const pat = { name: 'Pat', slackUserId: 'U0PAT', admin: false };
    expect(c.list(pat)).toMatchObject({ more: true });
    expect(c.list(pat).conversations).toHaveLength(25);
    expect(c.list(pat, 50)).toMatchObject({ more: false });
    expect(c.list(pat, 50).conversations).toHaveLength(30);
  });

  it('refuses a thread the caller may not see', async () => {
    const c = slackConversations({ log: () => [SAM], botToken: () => 'xoxb', admin: () => false });
    expect(await c.thread({ name: 'Pat', slackUserId: 'U0PAT', admin: false }, SAM.key)).toEqual({ ok: false, error: 'No conversation with that id that you can see.' });
  });

  it('reads a thread as who said what, in plain words', () => {
    const names = (id: string) => ({ U0PAT: 'Pat' })[id];
    expect(slackToMarkdown('See <https://acme.example/x|the plan> and <@U0PAT> &amp; <@U0ZZZ>', names)).toBe('See [the plan](https://acme.example/x) and @Pat & @U0ZZZ');
    expect(slackToMarkdown('*Funds Claims* is first.\n• *Why:* _two_ reasons\n:white_check_mark: done', names)).toBe('**Funds Claims** is first.\n- **Why:** *two* reasons\n✅ done');
    expect(threadMessages([
      { ts: '1.0', user: 'U0PAT', text: 'whats next' },
      { ts: '2.5', bot_id: 'B1', username: 'Product Team', text: 'Reporting first.' },
      { ts: '3.0', bot_id: 'B1', text: 'Checking…' },
      { ts: '4.0', bot_id: 'B1', username: 'Product Team', text: ':hourglass_flowing_sand: *Product Team* is on it' },
    ], PAT, names)).toEqual([
      { at: 1000, bot: false, note: false, from: 'Pat', text: 'whats next' },
      { at: 2500, bot: true, note: false, from: 'Product Team', text: 'Reporting first.' },
      { at: 3000, bot: true, note: true, from: 'overgo', text: 'Checking…' },
      { at: 4000, bot: true, note: true, from: 'Product Team', text: '⏳ **Product Team** is on it' },
    ]);
  });
});

describe('the Slack page\'s counts', () => {
  const NOW = Date.UTC(2026, 9, 22, 12);
  const rows = [
    { day: '2026-10-22', user: 'U0PAT', by: 'Pat', messages: 5, started: 2, dm: 5 },
    { day: '2026-10-20', user: 'U0PAT', by: 'Pat', messages: 1, started: 1, dm: 0 },
    { day: '2026-10-21', user: 'U0SAM', by: 'Sam', messages: 9, started: 3, dm: 1 },
    { day: '2026-09-01', user: 'U0SAM', by: 'Sam', messages: 50, started: 10, dm: 0 },
  ];
  const outcomes = { '2026-10-22': { answered: 2, 'asked-who': 1 }, '2026-10-21': { handed: 3 }, '2026-09-01': { handed: 40 } };

  it('ranks who asked most over the stretch, with what came of it', () => {
    const s = slackStats(rows, outcomes, NOW, () => true, true, { days: 7 });
    expect(s.people.map((p) => [p.by, p.messages, p.started])).toEqual([['Sam', 9, 3], ['Pat', 6, 3]]);
    expect(s.messages).toBe(15);
    expect(s.askers).toBe(2);
    expect(s.outcomes).toEqual({ answered: 2, 'asked-who': 1, handed: 3 });
    expect(s.daily).toHaveLength(7);
    expect(s.daily.at(-1)).toEqual({ day: '2026-10-22', messages: 5, started: 2, askers: 1 });
  });

  it('pages, searches and sorts a long list on the server, with totals over everyone', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ day: '2026-10-22', user: `U${i}`, by: `Person ${i}`, messages: i, started: 1, dm: i % 2 }));
    const page = slackStats(many, {}, NOW, () => true, true, { days: 7, offset: 50, limit: 50 });
    expect(page.people).toHaveLength(50);
    expect(page.people[0].by).toBe('Person 1149');
    expect(page.peopleTotal).toBe(1200);
    expect(page.askers).toBe(1200);
    const found = slackStats(many, {}, NOW, () => true, true, { days: 7, q: 'person 119', sort: 'name' });
    expect(found.people.map((p) => p.by)).toEqual(['Person 119', 'Person 1190', 'Person 1191', 'Person 1192', 'Person 1193', 'Person 1194', 'Person 1195', 'Person 1196', 'Person 1197', 'Person 1198', 'Person 1199']);
    expect(found.messages).toBe(many.reduce((n, p) => n + p.messages, 0));
    expect(slackStats(many, {}, NOW, () => true, true, { days: 0, limit: 0 })).toMatchObject({ days: 180, people: [], peopleTotal: 1200 });
  });

  it('shows anyone but an admin only their own counts', () => {
    const c = slackConversations({ log: () => [], stats: () => ({ days: rows, outcomes }), botToken: () => 'xoxb', admin: (caller) => caller.admin, now: () => NOW });
    const pat = c.stats({ name: 'Pat', slackUserId: 'U0PAT', admin: false }, { days: 7 }).stats;
    expect(pat.people.map((p) => p.by)).toEqual(['Pat']);
    expect(pat.outcomes).toEqual({});
    expect(c.stats({ name: 'Ada', admin: true }, { days: 90 }).stats.people.map((p) => p.by)).toEqual(['Sam', 'Pat']);
  });
});
