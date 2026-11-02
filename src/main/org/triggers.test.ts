import { describe, expect, it, vi } from 'vitest';
import { itemsFrom } from './mcpDirect';
import { TriggerService, eventItem, type Deliverable, type WorkerTrigger } from './triggers';

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: { items?: unknown; paused?: boolean; reply?: string; fail?: string; owner?: boolean; quietMs?: number; launched?: number; reviewer?: boolean } = {}) {
  let triggers: WorkerTrigger[] = [];
  let deliverables: Deliverable[] = [];
  const asked: string[] = [];
  const startsFlags: boolean[] = [];
  const posts: string[] = [];
  const fullPosts: string[] = [];
  const postedAs: Array<string | undefined> = [];
  const calls: unknown[] = [];
  const reviews: Array<{ id: string; text: string; inThread?: string }> = [];
  let reply = opts.reply;
  const notices: string[] = [];
  let toolResult: unknown = opts.items ?? { issues: [{ key: 'ACME-1', fields: { summary: 'Export fails' } }] };
  let now = new Date(2026, 9, 20, 12).getTime();
  const svc = new TriggerService({
    ...(opts.quietMs ? { quietMs: opts.quietMs } : {}),
    store: { list: () => structuredClone(triggers), save: (all) => (triggers = structuredClone(all)) },
    deliverables: { list: () => structuredClone(deliverables), save: (all) => (deliverables = structuredClone(all)) },
    worker: (id) => (id === 'triage' ? { id, name: 'Triage', enabled: !opts.paused, avatarUrl: 'https://img.example/triage.png' } : null),
    ask: (_w, name, text, starts) => {
      asked.push(`${name}|${text}`);
      startsFlags.push(starts);
      return {
        ok: true,
        askId: `a${asked.length}`,
        done: Promise.resolve(opts.fail ? { ok: false as const, error: opts.fail } : { ok: true as const, reply: reply ?? 'Triaged. Fix in https://github.com/acme/app/pull/42', launched: opts.launched ?? 0 }),
      };
    },
    toolConfig: (name) => (name === 'jira' ? { command: 'npx' } : null),
    callTool: async (_c, _t, args) => {
      calls.push(args);
      return { ok: true, text: JSON.stringify(toolResult), json: toolResult };
    },
    slack: {
      post: async (channel, text, threadTs, as) => {
        postedAs.push(as && `${as.name}|${as.iconUrl}`);
        fullPosts.push(text);
        posts.push(`${channel}${threadTs ? '@' + threadTs : ''}:${text.split('\n')[0]}`);
        return true;
      },
      message: async () => ({ text: 'The export button does nothing', user: 'U0ACMEPAT' }),
      thread: async () => [
        { user: 'U1', text: 'how often does collateral get indexed?' },
        { name: 'Triage', text: 'Every 15 minutes, from the indexer schedule.' },
        { user: 'U1', text: 'and for partner uploads too?' },
      ],
      botUserId: () => 'U0ACMEBOT',
      dm: async (user, text) => {
        posts.push(`dm:${user}:${text}`);
        return true;
      },
    },
    ...(opts.owner
      ? {
          tellOwner: async (workerId: string, text: string) => {
            posts.push(`owner:${workerId}:${text.split('\n')[0]}`);
            return true;
          },
        }
      : {}),
    limitNotice: async (_w, triggerId, text) => {
      notices.push(`${triggerId}|${text.split('\n')[0]}`);
      return true;
    },
    review: async (_w, id, text, inThread) => {
      reviews.push({ id, text, ...(inThread ? { inThread: inThread.ts } : {}) });
      return opts.reviewer === false ? null : { channel: 'D0ACMEMGR', ts: inThread ? inThread.ts : `9.${reviews.length}` };
    },
    log: () => {},
    now: () => now,
  });
  return {
    svc,
    asked,
    startsFlags,
    posts,
    fullPosts,
    postedAs,
    calls,
    reviews,
    notices,
    setReply: (r: string) => (reply = r),
    deliverables: () => deliverables,
    triggers: () => triggers,
    setItems: (v: unknown) => (toolResult = v),
    advance: (ms: number) => (now += ms),
  };
}

const watch = (over: Partial<WorkerTrigger> = {}) => ({
  workerId: 'triage',
  name: 'New bugs',
  kind: 'watch' as const,
  enabled: true,
  instructions: 'Triage the ticket and say who owns it.',
  deliver: [{ kind: 'slack' as const, channel: 'C0ACMEENG' }, { kind: 'worker' as const, text: 'Comment your triage on the ticket.' }],
  maxPerDay: 50,
  watch: { server: 'jira', tool: 'search', args: { jql: 'x' }, everyMinutes: 15 },
  createdBy: 'Pat',
  ...over,
});

describe('watch triggers', () => {
  it('fires a backlog over the next polls instead of dropping it', async () => {
    const h = harness();
    const made = h.svc.create(watch());
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    h.setItems({ issues: Array.from({ length: 25 }, (_, i) => ({ key: `ACME-${i + 10}`, fields: { summary: `Bug ${i}` } })) });
    await h.svc.poll(made.trigger.id);
    expect(h.asked).toHaveLength(10);
    await h.svc.poll(made.trigger.id);
    expect(h.asked).toHaveLength(20);
  });

  it('skips what is already there, then acts once on each new item and delivers it', async () => {
    const h = harness();
    const made = h.svc.create(watch());
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    expect(h.asked).toEqual([]);
    h.setItems({ issues: [{ key: 'ACME-1', fields: { summary: 'Export fails' } }, { key: 'ACME-2', fields: { summary: 'Login loops' } }] });
    await h.svc.poll(made.trigger.id);
    await h.svc.poll(made.trigger.id);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('Title (untrusted): ACME-2: Login loops');
    expect(h.asked[0]).toContain("When it's done: Comment your triage on the ticket.");
    await tick();
    const d = h.deliverables()[0];
    expect(d).toMatchObject({ status: 'delivered', title: 'ACME-2: Login loops', links: ['https://github.com/acme/app/pull/42'] });
    expect(d.deliveredTo).toEqual(['Slack #C0ACMEENG', 'Comment your triage on the ticket.']);
    expect(h.posts[0]).toBe('C0ACMEENG:*Triage* handled _ACME-2: Login loops_');
    expect(h.svc.stats('triage', 0)).toMatchObject({ handled: 1, failed: 0 });
  });

  it('sends what the worker found, once the work it started is done, where its first answer went', async () => {
    const h = harness({ owner: true, reply: "I'm not launching a solve run; an investigation will find the cause." });
    const made = h.svc.create(watch());
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    h.setItems({ issues: [{ key: 'ACME-2', fields: { summary: 'Login loops' } }] });
    await h.svc.poll(made.trigger.id);
    await tick();
    await tick();
    const before = h.posts.length;
    await h.svc.handedBack('a1', { ok: true, reply: 'Cause: the session token expires after 60 s. Fix: refresh it. Report: https://acme.example/report' });
    expect(h.posts.slice(before)).toEqual(['C0ACMEENG:*Triage* finished _ACME-2: Login loops_', 'owner:triage:*Triage* finished _ACME-2: Login loops_']);
    const d = h.deliverables()[0];
    expect(d.result).toContain("I'm not launching");
    expect(d.result).toContain('token expires after 60 s');
    expect(d.links).toContain('https://acme.example/report');
    // An ask no trigger made, or a write-up that failed: nothing posted, or its manager hears.
    await h.svc.handedBack('zz', { ok: true, reply: 'x' });
    await h.svc.handedBack('a1', { ok: false, error: 'Out of turns' });
    expect(h.posts.slice(before + 2)).toEqual(["owner:triage:*Triage* finished the work for _ACME-2: Login loops_ but couldn't write up what it found: Out of turns"]);
  });

  it("tells the worker's manager what it did, or that it could not finish", async () => {
    for (const fail of [undefined, 'Out of turns']) {
      const h = harness({ owner: true, ...(fail ? { fail } : {}) });
      const made = h.svc.create(watch());
      if (!made.ok) throw new Error(made.error);
      await h.svc.poll(made.trigger.id);
      h.setItems({ issues: [{ key: 'ACME-2', fields: { summary: 'Login loops' } }] });
      await h.svc.poll(made.trigger.id);
      await tick();
      await tick();
      const told = h.posts.filter((p) => p.startsWith('owner:'));
      expect(told).toEqual([fail ? 'owner:triage:*Triage* could not finish _ACME-2: Login loops_ from _New bugs_: Out of turns' : 'owner:triage:*Triage* handled _ACME-2: Login loops_']);
      if (!fail) expect(h.deliverables()[0].deliveredTo).toContain('its manager');
    }
  });

  it('says when its tool is missing, and keeps to its daily limit', async () => {
    const h = harness();
    const missing = h.svc.create(watch({ watch: { server: 'crm', tool: 'deals', args: {}, everyMinutes: 15 } }));
    if (!missing.ok) throw new Error(missing.error);
    await h.svc.poll(missing.trigger.id);
    expect(h.triggers()[0].lastError).toMatch(/crm isn't installed/);

    const capped = h.svc.create(watch({ maxPerDay: 1 }));
    if (!capped.ok) throw new Error(capped.error);
    await h.svc.poll(capped.trigger.id);
    h.setItems({ issues: [{ key: 'ACME-1' }, { key: 'ACME-5' }, { key: 'ACME-6' }] });
    await h.svc.poll(capped.trigger.id);
    expect(h.asked).toHaveLength(1);
    expect(h.deliverables().filter((d) => d.status === 'skipped')[0].error).toMatch(/today's limit/);
  });

  it('refuses a watch that checks too often, and skips events for a paused worker', async () => {
    expect(harness().svc.create(watch({ watch: { server: 'jira', tool: 's', args: {}, everyMinutes: 1 } })).ok).toBe(false);
    const h = harness({ paused: true });
    const made = h.svc.create(watch());
    if (!made.ok) throw new Error(made.error);
    h.svc.fire(made.trigger, { id: 'x', title: 'X', data: {} });
    expect(h.asked).toEqual([]);
    expect(h.deliverables()[0]).toMatchObject({ status: 'skipped', error: 'Triage is paused.' });
  });
});

describe('a trigger let start on its own', () => {
  it('says so when it hands the worker an event, and is off unless set', () => {
    const h = harness();
    const off = h.svc.create(watch());
    const on = h.svc.create(watch({ name: 'Bugs, hands-off', startsOnItsOwn: true }));
    if (!off.ok || !on.ok) throw new Error('not made');
    h.svc.fire(off.trigger, { id: 'a', title: 'A', data: {} });
    h.svc.fire(on.trigger, { id: 'b', title: 'B', data: {} });
    expect(h.startsFlags).toEqual([false, true]);
  });
});

describe('webhook triggers', () => {
  it('takes events only with the secret, once each', async () => {
    const h = harness();
    const made = h.svc.create({ ...watch(), kind: 'webhook', watch: undefined });
    if (!made.ok || !made.token) throw new Error('no token');
    expect(JSON.stringify(h.triggers())).not.toContain(made.token);
    expect(h.svc.webhook(made.trigger.id, 'wrong-token-wrong-token-wrong', {})).toMatchObject({ ok: false, status: 404 });
    const body = { webhookEvent: 'jira:issue_created', issue: { key: 'ACME-9', fields: { summary: 'Crash on save' } } };
    expect(h.svc.webhook(made.trigger.id, made.token, body).ok).toBe(true);
    expect(h.svc.webhook(made.trigger.id, made.token, body)).toMatchObject({ ok: true, duplicate: true });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('Title (untrusted): ACME-9: Crash on save');
  });
});

describe('slack triggers', () => {
  it('acts on a reaction in its channel, with the message, and replies in the thread', async () => {
    const h = harness({ reply: 'Filed ACME-10.' });
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'reaction', reaction: 'bug' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'reaction_added', reaction: 'eyes', item: { channel: 'C0ACMESUP', ts: '1.1' } });
    await h.svc.slackEvent({ type: 'reaction_added', reaction: 'bug', item: { channel: 'C0OTHER01', ts: '1.1' } });
    await h.svc.slackEvent({ type: 'reaction_added', reaction: 'bug', item: { channel: 'C0ACMESUP', ts: '1.1' } });
    await h.svc.slackEvent({ type: 'reaction_added', reaction: 'bug', item: { channel: 'C0ACMESUP', ts: '1.1' } });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('The export button does nothing');
    await tick();
    expect(h.posts).toEqual(['C0ACMESUP@1.1:Filed ACME-10.']);
    expect(h.postedAs).toEqual(['Triage|https://img.example/triage.png']);
  });

  it('waits for someone to stop typing, then takes their messages as one', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ reply: 'Answered.', quietMs: 5000 });
      const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message', contains: 'index' }, deliver: [{ kind: 'thread' }] });
      if (!made.ok) throw new Error(made.error);
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '4.1', text: 'how often does collateral get indexed?' })).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      // Part of the burst, though it doesn't say "index".
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '4.2', text: 'and how long till search finds it' })).toBe(true);
      // Someone else, not saying it: not for this trigger.
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U2', ts: '4.3', text: 'lunch is here' })).toBe(false);
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.asked).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]).toContain('how often does collateral get indexed?');
      expect(h.asked[0]).toContain('and how long till search finds it');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.posts).toEqual(['C0ACMESUP@4.1:Answered.']);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('listening in a channel', () => {
    const listen = (instructions = '') => ({ ...watch(), instructions, kind: 'slack' as const, watch: undefined, slack: { channel: 'C0ACMESUP', on: 'listen' as const }, deliver: [] });

    it('needs no instructions, and always answers in the thread', () => {
      const h = harness();
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      expect(made.trigger.deliver).toEqual([{ kind: 'thread' }]);
      const changed = h.svc.update(made.trigger.id, { deliver: [{ kind: 'dm', slackUserId: 'U0ACMEPAT' }] });
      if (!changed.ok) throw new Error(changed.error);
      expect(changed.trigger.deliver).toEqual([{ kind: 'dm', slackUserId: 'U0ACMEPAT' }, { kind: 'thread' }]);
    });

    it('tells the worker to answer only what it can, with the manager’s extras after', async () => {
      const h = harness({ reply: 'Every 15 minutes, from the indexer schedule.' });
      const made = h.svc.create(listen('For setup questions, link the docs page too.'));
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'how often does collateral get indexed?' });
      await tick();
      expect(h.asked[0]).toContain('|You are listening in this Slack channel, not taking part in it.');
      expect(h.asked[0]).toContain('Also: For setup questions, link the docs page too.');
      expect(h.asked[0]).toContain('how often does collateral get indexed?');
      expect(h.posts).toEqual(['C0ACMESUP@6.1:Every 15 minutes, from the indexer schedule.']);
    });

    it('hears a follow-up in a thread it answered in, with the thread so far, and answers there', async () => {
      const h = harness({ reply: 'Yes, partner uploads too.' });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'how often does collateral get indexed?' });
      await tick();
      expect(h.triggers()[0].threads).toEqual(['C0ACMESUP:6.1']);
      expect(h.asked[0]).not.toContain('a reply in a Slack thread you already answered in');
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.3', thread_ts: '6.1', text: 'and for partner uploads too?' })).toBe(true);
      await tick();
      expect(h.asked).toHaveLength(2);
      expect(h.asked[1]).toContain('a reply in a Slack thread you already answered in');
      expect(h.asked[1]).toContain('"from": "Triage"');
      expect(h.asked[1]).toContain('and for partner uploads too?');
      expect(h.posts).toEqual(['C0ACMESUP@6.1:Yes, partner uploads too.', 'C0ACMESUP@6.1:Yes, partner uploads too.']);
      // The same reply delivered twice is taken once.
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.3', thread_ts: '6.1', text: 'and for partner uploads too?' });
      await tick();
      expect(h.asked).toHaveLength(2);
    });

    it('posts the finished work in the thread too, when its first answer only said it was looking', async () => {
      const h = harness({ reply: "I'm sending one read-only code run to find where the templates live.", launched: 1 });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'where is the deal approved email template?' });
      await tick();
      expect(h.deliverables()[0].thread).toEqual({ channel: 'C0ACMESUP', ts: '6.1' });
      await h.svc.handedBack('a1', { ok: true, reply: 'The approve and decline emails are fixed HTML files in the deal service.' });
      expect(h.posts).toEqual([
        "C0ACMESUP@6.1:I'm sending one read-only code run to find where the templates live.",
        'C0ACMESUP@6.1:The approve and decline emails are fixed HTML files in the deal service.',
      ]);
      expect(h.deliverables()[0].result).not.toContain('Working on it');
      expect(h.deliverables()[0].deliveredTo).toContain('the Slack thread');
      expect(h.triggers()[0].threads).toEqual(['C0ACMESUP:6.1']);
    });

    it('says it is working when it started a run, and says so in the thread if the run fails', async () => {
      const h = harness({ reply: 'Looking in the code.', launched: 1 });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'where is the template?' });
      await tick();
      expect(h.posts).toEqual(['C0ACMESUP@6.1:Looking in the code.']);
      expect(h.fullPosts[0]).toContain("⏳ Working on it. I'll post the answer in this thread");
      await h.svc.handedBack('a1', { ok: false, error: 'Out of turns' });
      expect(h.posts[1]).toMatch(/^C0ACMESUP@6\.1:_I couldn't finish looking into this/);
    });

    it('adds no working note when it answered straight away', async () => {
      const h = harness({ reply: 'Every 15 minutes.' });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'how often?' });
      await tick();
      expect(h.asked).toHaveLength(1);
      expect(h.posts).toEqual(['C0ACMESUP@6.1:Every 15 minutes.']);
      expect(h.fullPosts[0]).not.toContain('Working on it');
    });

    it('stays out of threads it has not answered in, and of ones it passed on', async () => {
      const h = harness({ reply: 'PASS' });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.2', thread_ts: '8.1', text: 'any update?' })).toBe(false);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '9.1', text: 'lunch is here' });
      await tick();
      expect(h.triggers()[0].threads).toBeUndefined();
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U2', ts: '9.2', thread_ts: '9.1', text: 'thanks!' })).toBe(false);
      expect(h.asked).toHaveLength(1);
    });

    it('leaves a follow-up that @-mentions the bot to the front door', async () => {
      const h = harness({ reply: 'Every 15 minutes.' });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'how often does collateral get indexed?' });
      await tick();
      expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.2', thread_ts: '6.1', text: '<@U0ACMEBOT> and partners?' })).toBe(false);
    });

    it('waits for a pause in a follow-up too, then answers in the thread, apart from top-level messages', async () => {
      vi.useFakeTimers();
      try {
        const h = harness({ reply: 'Yes.', quietMs: 5000 });
        const made = h.svc.create(listen());
        if (!made.ok) throw new Error(made.error);
        await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.1', text: 'how often does collateral get indexed?' });
        await vi.advanceTimersByTimeAsync(6000);
        expect(h.posts).toEqual(['C0ACMESUP@6.1:Yes.']);
        await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.4', thread_ts: '6.1', text: 'and partner uploads' });
        await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '6.5', thread_ts: '6.1', text: 'too?' });
        // The same person, top level: its own question, not part of the follow-up.
        await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '7.1', text: 'who owns billing?' });
        await vi.advanceTimersByTimeAsync(6000);
        expect(h.asked).toHaveLength(3);
        const followUp = h.asked.find((a) => a.includes('and partner uploads'))!;
        expect(followUp).toContain('too?');
        expect(followUp).not.toContain('who owns billing?');
        expect([...h.posts].sort()).toEqual(['C0ACMESUP@6.1:Yes.', 'C0ACMESUP@6.1:Yes.', 'C0ACMESUP@7.1:Yes.']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('posts nothing on what it passes', async () => {
      const h = harness({ reply: 'PASS' });
      const made = h.svc.create(listen());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '7.1', text: 'lunch is here' });
      await tick();
      expect(h.asked).toHaveLength(1);
      expect(h.posts).toEqual([]);
    });
  });

  describe('the daily limit', () => {
    const channel = () => ({ ...watch(), kind: 'slack' as const, watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' as const }, deliver: [{ kind: 'thread' as const }], maxPerDay: 1 });
    const say = (h: ReturnType<typeof harness>, ts: string, text: string) => h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts, text });

    it('tells its manager once a day, and what it skips doesn’t count', async () => {
      const h = harness({ reply: 'Answered.' });
      const made = h.svc.create(channel());
      if (!made.ok) throw new Error(made.error);
      await say(h, '9.1', 'first question');
      await say(h, '9.2', 'second question');
      await say(h, '9.3', 'third question');
      await tick();
      expect(h.asked).toHaveLength(1);
      expect(h.notices).toEqual([`${made.trigger.id}|*Triage* hit _New bugs_'s limit of 1 today, so it's skipping new ones until midnight. The first it skipped: _second question_.`]);
      // Raised to 2: the two skipped didn't use it up, so the next one runs.
      h.svc.update(made.trigger.id, { maxPerDay: 2 });
      await say(h, '9.4', 'fourth question');
      await tick();
      expect(h.asked).toHaveLength(2);
    });

    it('tries what it skipped when its manager says so, once', async () => {
      const h = harness({ reply: 'Answered.' });
      const made = h.svc.create(channel());
      if (!made.ok) throw new Error(made.error);
      await say(h, '9.5', 'first question');
      await say(h, '9.6', 'where do I change the partner email?');
      await tick();
      expect(h.svc.retrySkipped(made.trigger.id)).toBe(1);
      await tick();
      expect(h.asked).toHaveLength(2);
      expect(h.asked[1]).toContain('where do I change the partner email?');
      // Into the thread it came from.
      expect(h.posts).toContain('C0ACMESUP@9.6:Answered.');
      expect(h.svc.retrySkipped(made.trigger.id)).toBe(0);
    });
  });

  describe('test mode', () => {
    const rehearsing = () => ({ ...watch(), instructions: '', kind: 'slack' as const, watch: undefined, slack: { channel: 'C0ACMESUP', on: 'listen' as const }, deliver: [], rehearse: true });

    it('holds each answer for its manager, and posts it to the thread once they say so', async () => {
      const h = harness({ reply: 'Every 15 minutes.', owner: true });
      const made = h.svc.create(rehearsing());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.1', text: 'how often does collateral get indexed?' });
      await tick();
      expect(h.posts).toEqual([]);
      expect(h.reviews).toHaveLength(1);
      expect(h.reviews[0].text).toContain('Every 15 minutes.');
      const held = h.deliverables().find((d) => d.id === h.reviews[0].id)!;
      expect(held.status).toBe('held');

      expect(await h.svc.release(held.id)).toEqual({ ok: true });
      // Into the thread it came from, and its manager isn't told a second time.
      expect(h.posts).toEqual(['C0ACMESUP@8.1:Every 15 minutes.']);
      expect(h.deliverables().find((d) => d.id === held.id)!.status).toBe('delivered');
      // A second press does nothing.
      expect(await h.svc.release(held.id)).toEqual({ ok: false, error: 'That answer was already posted or set aside.' });
      expect(h.posts).toHaveLength(1);
    });

    it('sets an answer aside when its manager says not to post it', async () => {
      const h = harness({ reply: 'Every 15 minutes.' });
      const made = h.svc.create(rehearsing());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.2', text: 'how often?' });
      await tick();
      expect(h.svc.drop(h.reviews[0].id)).toBe(true);
      expect(h.deliverables().find((d) => d.id === h.reviews[0].id)!.status).toBe('skipped');
      expect((await h.svc.release(h.reviews[0].id)).ok).toBe(false);
      expect(h.posts).toEqual([]);
    });

    it('tells its manager what it stayed quiet on', async () => {
      const h = harness({ reply: 'PASS', owner: true });
      const made = h.svc.create(rehearsing());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.3', text: 'lunch is here' });
      await tick();
      expect(h.reviews).toEqual([]);
      expect(h.posts).toEqual(['owner:triage:_Test mode · New bugs:_ *Triage* would stay quiet on _lunch is here_.']);
    });

    it('rewrites the answer from its manager’s reply under the card, and posts the latest', async () => {
      const h = harness({ reply: 'Collateral is indexed every 15 minutes by the scheduled indexer job, which also picks up partner uploads.' });
      const made = h.svc.create(rehearsing());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.5', text: 'how often does collateral get indexed?' });
      await tick();
      const held = h.svc.heldIn('D0ACMEMGR', '9.1');
      expect(held?.id).toBe(h.reviews[0].id);
      // A reply under some other DM message isn't a revision.
      expect(h.svc.heldIn('D0ACMEMGR', '1.0')).toBeUndefined();

      h.setReply('Every 15 minutes.');
      await h.svc.revise(held!.id, 'make it one line');
      const prompt = h.asked[h.asked.length - 1];
      expect(prompt).toContain('how often does collateral get indexed?');
      expect(prompt).toContain('Your answer so far:\nCollateral is indexed every 15 minutes');
      expect(prompt).toContain('Your manager says:\nmake it one line');
      // The new draft goes under the first card, which still takes replies.
      expect(h.reviews[1]).toMatchObject({ id: held!.id, inThread: '9.1' });
      expect(h.reviews[1].text).toContain('Every 15 minutes.');
      expect(h.svc.heldIn('D0ACMEMGR', '9.1')?.result).toBe('Every 15 minutes.');

      expect(await h.svc.release(held!.id)).toEqual({ ok: true });
      expect(h.posts).toEqual(['C0ACMESUP@8.5:Every 15 minutes.']);
    });

    it('sets the answer aside when its manager says it shouldn’t answer', async () => {
      const h = harness({ reply: 'Every 15 minutes.' });
      const made = h.svc.create(rehearsing());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.6', text: 'how often?' });
      await tick();
      h.setReply('PASS');
      await h.svc.revise(h.reviews[0].id, 'leave this one, the indexer team owns it');
      expect(h.deliverables().find((d) => d.id === h.reviews[0].id)!.status).toBe('skipped');
      expect(h.posts).toEqual(["D0ACMEMGR@9.1:_Understood: I won't answer this one. Nothing was posted._"]);
    });

    it('fails rather than posting when there is no one to check with', async () => {
      const h = harness({ reply: 'Every 15 minutes.', reviewer: false });
      const made = h.svc.create(rehearsing());
      if (!made.ok) throw new Error(made.error);
      await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', user: 'U1', ts: '8.4', text: 'how often?' });
      await tick();
      expect(h.posts).toEqual([]);
      expect(h.deliverables()[0].status).toBe('failed');
      expect(h.deliverables()[0].error).toContain('no one to check it with');
    });
  });

  it('posts what the worker wrote in Slack\'s markup, not raw Markdown', async () => {
    const h = harness({ reply: '- **Searched:** the `main.py` fix & its repo' });
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '5.1', text: 'the export is broken' });
    await tick();
    expect(h.posts).toEqual(['C0ACMESUP@5.1:• *Searched:* the `main.py` fix &amp; its repo']);
  });

  it('shows the address behind a link whose words could pass for another', async () => {
    const h = harness({ reply: 'Reset it at [https://login.acme.test](https://acme-login.evil.test/reset), see [acme.test](https://acme.test/docs).' });
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '5.2', text: 'how do I reset my password?' });
    await tick();
    expect(h.posts).toEqual(['C0ACMESUP@5.2:Reset it at https://login.acme.test (<https://acme-login.evil.test/reset>), see <https://acme.test/docs|acme.test>.']);
  });

  it('posts nothing when the worker passes, and says so on the deliverable', async () => {
    const h = harness({ reply: ' **PASS.** ' });
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '3.1', text: 'lunch is here' });
    await tick();
    expect(h.asked[0]).toContain('reply with only PASS');
    expect(h.posts).toEqual([]);
    expect(h.deliverables()[0]).toMatchObject({ status: 'skipped', error: 'Triage passed: nothing worth saying.' });
  });

  it.each(['PASS — just chatter', 'pass: an announcement', 'PASS - already answered', 'PASS. Nothing to add', 'PASS: all 12 checks green'])('passes on "%s" too', async (reply) => {
    const h = harness({ reply });
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '3.1', text: 'lunch is here' });
    await tick();
    expect(h.posts).toEqual([]);
  });

  it.each(['Passed the export through the new parser: ACME-10.', 'Password reset is broken: filed ACME-11.', 'Pass. All 12 smoke checks are green on staging.', 'Pass: all 12 smoke checks are green on staging.'])('still posts "%s"', async (reply) => {
    const h = harness({ reply });
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '3.1', text: 'the export is broken' });
    await tick();
    expect(h.posts).toHaveLength(1);
  });

  it('leaves a message that @-mentions the bot to the front door', async () => {
    const h = harness();
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!made.ok) throw new Error(made.error);
    expect(await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '4.1', text: '<@U0ACMEBOT> who owns billing?' })).toBe(false);
    expect(h.asked).toHaveLength(0);
  });

  it('makes no new mention triggers: the front door answers those', () => {
    const h = harness();
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'mention' }, deliver: [{ kind: 'thread' }] });
    expect(made).toMatchObject({ ok: false });
    const message = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message' }, deliver: [{ kind: 'thread' }] });
    if (!message.ok) throw new Error(message.error);
    expect(h.svc.update(message.trigger.id, { slack: { channel: 'C0ACMESUP', on: 'mention' } })).toMatchObject({ ok: false });
    expect(h.svc.update(message.trigger.id, { name: 'Renamed' })).toMatchObject({ ok: true });
  });

  it('reads new messages only, not thread replies or bots', async () => {
    const h = harness();
    const made = h.svc.create({ ...watch(), kind: 'slack', watch: undefined, slack: { channel: 'C0ACMESUP', on: 'message', contains: 'broken' }, deliver: [] });
    if (!made.ok) throw new Error(made.error);
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '2.1', text: 'all good' });
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '2.2', thread_ts: '2.0', text: 'broken again' });
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '2.3', bot_id: 'B1', text: 'broken' });
    await h.svc.slackEvent({ type: 'message', channel: 'C0ACMESUP', ts: '2.4', text: 'Checkout is broken' });
    expect(h.asked).toHaveLength(1);
  });
});

describe('reading a tool’s answer', () => {
  it('finds the list and names each item', () => {
    const items = itemsFrom({ text: '', json: { total: 2, issues: [{ key: 'ACME-1', fields: { summary: 'A' } }, { id: 7, title: 'B', html_url: 'https://x.example/7' }] } });
    expect(items.map((i) => [i.id, i.title, i.url])).toEqual([
      ['ACME-1', 'ACME-1: A', undefined],
      ['7', 'B', 'https://x.example/7'],
    ]);
    expect(itemsFrom({ text: 'Build is green', json: null })).toHaveLength(1);
  });

  it('names CloudWatch alarms and treats one that goes off again as new', () => {
    const alarm = { alarm_name: 'acme-api-5xx', state_value: 'ALARM', state_updated_timestamp: '2026-10-20T09:00:00Z', state_reason: 'Threshold crossed' };
    const first = itemsFrom({ text: '', json: { metric_alarms: [alarm], composite_alarms: [] } });
    expect(first[0].title).toBe('acme-api-5xx');
    expect(itemsFrom({ text: '', json: { metric_alarms: [alarm], composite_alarms: [] } })[0].id).toBe(first[0].id);
    const again = itemsFrom({ text: '', json: { metric_alarms: [{ ...alarm, state_updated_timestamp: '2026-10-20T14:30:00Z' }], composite_alarms: [] } });
    expect(again[0].id).not.toBe(first[0].id);
  });

  it('names posted events from GitHub and Jira', () => {
    expect(eventItem({ action: 'opened', pull_request: { number: 12, title: 'Fix export', html_url: 'https://github.com/acme/app/pull/12' } })).toMatchObject({ title: 'PR #12: Fix export', url: 'https://github.com/acme/app/pull/12' });
    expect(eventItem({ webhookEvent: 'jira:issue_created', issue: { key: 'ACME-3', fields: { summary: 'Slow' } } })).toMatchObject({ id: 'jira:issue_created:ACME-3', title: 'ACME-3: Slow' });
  });
});

describe('watching tracked tickets for a change', () => {
  const issues = (a: string, b: string) => ({ issues: [{ key: 'ACME-1', fields: { summary: 'Export fails', status: { name: a } } }, { key: 'ACME-2', fields: { summary: 'Slow login', status: { name: b } } }] });
  const tracker = (over: Partial<WorkerTrigger> = {}) =>
    watch({
      name: 'My tickets',
      instructions: '',
      notifyOnly: true,
      deliver: [{ kind: 'dm', slackUserId: 'U0ACMEPAT' }],
      watch: { server: 'jira', tool: 'search', args: { jql: 'key in ({{ids}})' }, everyMinutes: 15, changes: 'fields.status.name', tracked: ['ACME-1', 'ACME-2'] },
      ...over,
    });

  it('says plainly when a tracked ticket changes, with no worker turn, and nothing on the first look', async () => {
    const h = harness({ items: issues('To do', 'In review') });
    const made = h.svc.create(tracker());
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    expect(h.calls[0]).toEqual({ jql: 'key in (ACME-1, ACME-2)' });
    expect(h.posts).toEqual([]);
    h.setItems(issues('To do', 'Done'));
    await h.svc.poll(made.trigger.id);
    await tick();
    expect(h.asked).toEqual([]);
    expect(h.posts).toEqual(['dm:U0ACMEPAT:*ACME-2: Slow login* moved from _In review_ to *Done*']);
    // Unchanged since: quiet.
    await h.svc.poll(made.trigger.id);
    await tick();
    expect(h.posts).toHaveLength(1);
  });

  it('escapes ticket text so a title cannot plant a mention', async () => {
    const h = harness({ items: issues('To do', 'In review') });
    const made = h.svc.create(tracker());
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    h.setItems({ issues: [{ key: 'ACME-1', fields: { summary: 'Export fails', status: { name: 'To do' } } }, { key: 'ACME-2', fields: { summary: '<!channel> look', status: { name: 'Done' } } }] });
    await h.svc.poll(made.trigger.id);
    await tick();
    expect(h.posts).toEqual(['dm:U0ACMEPAT:*ACME-2: &lt;!channel&gt; look* moved from _In review_ to *Done*']);
  });

  it('links the ticket over http or https, and a link cannot break out of itself', async () => {
    const h = harness({ items: issues('To do', 'In review') });
    const made = h.svc.create(tracker());
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    h.setItems({ issues: [{ key: 'ACME-1', url: 'http://tracker.acme.test/browse/ACME-1', fields: { summary: 'Export fails', status: { name: 'Done' } } }, { key: 'ACME-2', url: 'https://tracker.acme.test/browse/ACME-2>|<!here', fields: { summary: 'Slow login', status: { name: 'Done' } } }] });
    await h.svc.poll(made.trigger.id);
    await tick();
    expect(h.posts).toEqual([
      'dm:U0ACMEPAT:*ACME-1: Export fails* moved from _To do_ to *Done* · <http://tracker.acme.test/browse/ACME-1|open it>',
      'dm:U0ACMEPAT:*ACME-2: Slow login* moved from _In review_ to *Done* · <https://tracker.acme.test/browse/ACME-2!here|open it>',
    ]);
  });

  it('hands a change to the worker when it should do more than say so', async () => {
    const h = harness({ items: issues('To do', 'In review') });
    const made = h.svc.create(tracker({ notifyOnly: false, instructions: 'Summarise what changed in the comments.' }));
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    h.setItems(issues('In progress', 'In review'));
    await h.svc.poll(made.trigger.id);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('a change to an item you track');
    expect(h.asked[0]).toContain('moved from To do to In progress');
  });

  it('tracks one more ticket without announcing where it already stands', async () => {
    const h = harness({ items: issues('To do', 'In review') });
    const made = h.svc.create(tracker({ watch: { server: 'jira', tool: 'search', args: { jql: 'key in ({{ids}})' }, everyMinutes: 15, changes: 'fields.status.name', tracked: ['ACME-1'] } }));
    if (!made.ok) throw new Error(made.error);
    await h.svc.poll(made.trigger.id);
    expect(h.svc.track(made.trigger.id, 'ACME-2', true)).toEqual({ ok: true, tracked: ['ACME-1', 'ACME-2'] });
    await h.svc.poll(made.trigger.id);
    await tick();
    expect(h.posts).toEqual([]);
    expect(h.svc.track(made.trigger.id, 'not a ticket id!', true)).toMatchObject({ ok: false });
  });
});

describe('following a tracked ticket', () => {
  const issues = (a: string) => ({ issues: [{ key: 'ACME-1', fields: { summary: 'Export fails', status: { name: a } } }] });

  it('tracks it and DMs each follower when it moves, once even if the watch already DMs them', async () => {
    const h = harness({ items: issues('To do') });
    const made = h.svc.create(watch({ name: 'Moves', instructions: '', notifyOnly: true, deliver: [{ kind: 'dm', slackUserId: 'U0ACMEPAT' }], watch: { server: 'jira', tool: 'search', args: { jql: 'key in ({{ids}})' }, everyMinutes: 15, changes: 'fields.status.name', tracked: [] } }));
    if (!made.ok) throw new Error(made.error);
    expect(h.svc.follow(made.trigger.id, 'ACME-1', 'U0ACMESAM', true)).toEqual({ ok: true, followers: 1 });
    expect(h.svc.follow(made.trigger.id, 'ACME-1', 'U0ACMEPAT', true)).toEqual({ ok: true, followers: 2 });
    expect(h.triggers()[0].watch?.tracked).toEqual(['ACME-1']);
    await h.svc.poll(made.trigger.id);
    h.setItems(issues('Done'));
    await h.svc.poll(made.trigger.id);
    await tick();
    expect(h.posts.sort()).toEqual(['dm:U0ACMEPAT:*ACME-1: Export fails* moved from _To do_ to *Done*', 'dm:U0ACMESAM:*ACME-1: Export fails* moved from _To do_ to *Done*']);
    // Stopping leaves it tracked for the others.
    expect(h.svc.follow(made.trigger.id, 'ACME-1', 'U0ACMESAM', false)).toEqual({ ok: true, followers: 1 });
    expect(h.triggers()[0].watch?.tracked).toEqual(['ACME-1']);
  });
});
