import { describe, expect, it } from 'vitest';
import { slackConversations, slackToMarkdown, threadMessages } from './conversations';
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
