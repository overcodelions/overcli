import { describe, expect, it } from 'vitest';
import { makeNotifyPerson, type NotifyPersonDeps } from './notifyPerson';
import type { SlackPerson, SlackPost } from './slackApi';

const people: SlackPerson[] = [
  { id: 'U0ACMEPAT', name: 'Pat Lee', handle: 'pat' },
  { id: 'U0ACMEPAM', name: 'Pam Ortiz', handle: 'pam' },
  { id: 'U0ACMEBOB', name: 'Bob Stone', handle: 'bobby' },
];

function harness(over: Partial<NotifyPersonDeps> = {}) {
  const posts: SlackPost[] = [];
  const audits: string[] = [];
  const notify = makeNotifyPerson({
    botToken: () => 'xoxb-acme',
    teamId: () => 'T0ACME',
    workerFor: (conv) => (conv === 'conv-robin' ? { id: 'w-robin', name: 'Robin', avatarUrl: 'https://acme.dev/robin.png' } : undefined),
    managerSlackId: (id) => (id === 'w-robin' ? 'U0ACMEBOSS' : null),
    listPeople: async () => ({ ok: true, data: people }),
    postMessage: async (_bot, post) => {
      posts.push(post);
      return { ok: true, data: { channel: post.channel, ts: '1.2' } };
    },
    audit: (e) => audits.push(e.what),
    ...over,
  });
  const send = (to: string, message = 'BILL-123 passed QA') => notify({ conversationId: 'conv-robin', to, message });
  return { notify, send, posts, audits };
}

describe('a worker telling someone through the server', () => {
  it('messages its manager, posting as the worker, and records it', async () => {
    const h = harness();
    expect(await h.send('my manager')).toEqual({ ok: true, sentTo: 'your manager' });
    expect(h.posts).toEqual([{ channel: 'U0ACMEBOSS', text: 'BILL-123 passed QA', username: 'Robin', iconUrl: 'https://acme.dev/robin.png' }]);
    expect(h.audits).toEqual(['Robin messaged your manager in Slack: “BILL-123 passed QA”']);
    expect((await h.send('Manager')).ok).toBe(true);
  });

  it('says so when the manager isn’t linked to Slack', async () => {
    const h = harness({ managerSlackId: () => null });
    const res = await h.send('manager');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('manager isn’t linked') });
    expect(h.posts).toEqual([]);
  });

  it('takes a member id or a channel id as given, with or without an @', async () => {
    const h = harness();
    expect(await h.send('@U0ACMEPAT')).toEqual({ ok: true, sentTo: '<@U0ACMEPAT>' });
    expect(await h.send('C0ACMEQA1')).toEqual({ ok: true, sentTo: '<#C0ACMEQA1>' });
    expect(h.posts.map((p) => p.channel)).toEqual(['U0ACMEPAT', 'C0ACMEQA1']);
  });

  it('asks for a channel’s id, not its name', async () => {
    const h = harness();
    expect(await h.send('#qa')).toMatchObject({ ok: false, error: expect.stringContaining('starts with C') });
    expect(h.posts).toEqual([]);
  });

  it('finds a person by full name or handle in any case, then by the start of a name', async () => {
    const h = harness();
    expect(await h.send('pat lee')).toEqual({ ok: true, sentTo: 'Pat Lee' });
    expect(await h.send('BOBBY')).toEqual({ ok: true, sentTo: 'Bob Stone' });
    expect(await h.send('Bob')).toEqual({ ok: true, sentTo: 'Bob Stone' });
    expect(h.posts.map((p) => p.channel)).toEqual(['U0ACMEPAT', 'U0ACMEBOB', 'U0ACMEBOB']);
  });

  it('sends nothing when a name matches more than one person, or nobody', async () => {
    const h = harness();
    expect(await h.send('Pa')).toMatchObject({ ok: false, error: expect.stringContaining('Pat Lee, Pam Ortiz') });
    expect(await h.send('Zed')).toMatchObject({ ok: false, error: 'Nobody in Slack is called “Zed”.' });
    expect(h.posts).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('says so when the people list can’t be read', async () => {
    const h = harness({ listPeople: async () => ({ ok: false, error: 'missing_scope' }) });
    expect(await h.send('Pat')).toMatchObject({ ok: false, error: expect.stringContaining('member id') });
  });

  it('sends nothing for a run that isn’t a worker’s, or with Slack not connected', async () => {
    const h = harness();
    expect(await h.notify({ conversationId: 'conv-someone', to: 'manager', message: 'hi' })).toMatchObject({ ok: false, error: 'Only a worker’s run may send messages.' });
    expect(await harness({ botToken: () => null }).send('manager')).toMatchObject({ ok: false, error: expect.stringContaining('isn’t connected') });
    expect(await harness({ teamId: () => '' }).send('manager')).toMatchObject({ ok: false, error: expect.stringContaining('isn’t connected') });
    expect(h.posts).toEqual([]);
  });

  it('falls back to posting as the app, the worker’s name in front, when it can’t post under another name', async () => {
    const posts: SlackPost[] = [];
    const h = harness({
      postMessage: async (_bot, post) => {
        posts.push(post);
        return post.username ? { ok: false, error: 'missing_scope' } : { ok: true, data: {} };
      },
    });
    expect((await h.send('U0ACMEPAT', 'done')).ok).toBe(true);
    expect(posts[1]).toEqual({ channel: 'U0ACMEPAT', text: '*Robin:* done' });
  });

  it('passes on Slack’s refusal and records nothing', async () => {
    const h = harness({ postMessage: async () => ({ ok: false, error: 'not_in_channel' }) });
    expect(await h.send('C0ACMEQA1')).toMatchObject({ ok: false, error: expect.stringContaining('not_in_channel') });
    expect(h.audits).toEqual([]);
  });

  it('keeps the audit line to one short line', async () => {
    const h = harness();
    await h.send('manager', 'line one\n\nline   two ' + 'x'.repeat(200));
    expect(h.audits[0]).toContain('“line one line two x');
    expect(h.audits[0].length).toBeLessThan(200);
  });
});
