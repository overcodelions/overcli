import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import type { OrgService, HireSummary } from '../org/orgService';
import { HIRE_APPROVE_ACTION, HIRE_ASK_TOOLS_ACTION, HIRE_CONFIRM_ACTION, JOIN_LETIN_ACTION, PROPOSALS_APPROVE_ACTION, PROPOSALS_SKIP_ACTION, SlackCommands, TEAM_APPROVE_ACTION, TEAM_MAKE_ACTION, HIRE_EDIT_ACTION, type SlackCommandsDeps } from './slackCommands';
import type { AccessService } from '../org/accessService';

const TEAM = 'T0ACME';
const PAT = 'U0ACMEPAT';

function fakeSlack() {
  const posts: Array<{ url: string; body: any }> = [];
  let ts = 0;
  const fetchImpl = async (url: string, init: RequestInit) => {
    const raw = String(init.body ?? '{}');
    // Read methods send a form, everything else JSON.
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    posts.push({ url, body });
    const method = url.split('/').pop()?.split('?')[0];
    const json =
      method === 'conversations.open'
        ? { ok: true, channel: { id: 'D0PAT' } }
        : method === 'conversations.history'
          ? { ok: true, messages: [{ text: 'Pricing has questions about "Review Q4 pricing"', user: 'B0BOT' }] }
        : method === 'chat.postMessage'
          ? { ok: true, channel: body.channel, ts: `200.${++ts}` }
          : { ok: true };
    return new Response(JSON.stringify(json));
  };
  return { posts, fetchImpl };
}

function harness(org: Partial<OrgService>, access?: Partial<AccessService>, deps: Partial<SlackCommandsDeps> = {}) {
  const slack = fakeSlack();
  const cmds = new SlackCommands({
    org: org as OrgService,
    ...(access ? { access: access as AccessService } : {}),
    policy: () => DEFAULT_ORG_POLICY,
    botToken: () => 'xoxb-test',
    teamId: () => TEAM,
    log: () => {},
    fetchImpl: slack.fetchImpl as never,
    ...deps,
  });
  return { cmds, posts: slack.posts };
}

const slash = (command: string, text: string, over: Record<string, unknown> = {}) => ({
  command,
  text,
  user_id: PAT,
  user_name: 'pat',
  team_id: TEAM,
  response_url: 'https://hooks.slack.com/commands/T0ACME/1/abc',
  ...over,
});

describe('/worker', () => {
  it('lists the workers the caller can see, ephemerally', async () => {
    const seen: string[] = [];
    const { cmds, posts } = harness({
      listWorkers: (c) => {
        seen.push(c.slackUserId!);
        return [{ id: 'w', name: 'Ana', tagline: 'weekly summaries', enabled: true, visibility: 'org', budgetUSDPerMonth: 20, spentThisMonthUSD: 3, waiting: 1 } as never];
      },
    });
    await cmds.onSlash(slash('/worker', ''));
    expect(seen).toEqual([PAT]);
    expect(posts[0].url).toBe('https://hooks.slack.com/commands/T0ACME/1/abc');
    expect(posts[0].body.response_type).toBe('ephemeral');
    expect(JSON.stringify(posts[0].body.blocks)).toContain('Ana');
  });

  it('never posts to a response_url outside Slack', async () => {
    const { cmds, posts } = harness({ listWorkers: () => [] });
    await cmds.onSlash(slash('/worker', '', { response_url: 'https://attacker.example/steal' }));
    expect(posts).toEqual([]);
  });

  it('ignores another workspace', async () => {
    const { cmds, posts } = harness({ listWorkers: () => [] });
    await cmds.onSlash(slash('/worker', '', { team_id: 'T0OTHER' }));
    expect(posts).toEqual([]);
  });

  it('resolves multi-word names and pauses', async () => {
    const paused: string[] = [];
    const { cmds, posts } = harness({
      resolve: (_c, name) => (name.toLowerCase() === 'ana lee' ? ({ id: 'w', name: 'Ana Lee' } as never) : null),
      setPaused: (_c, id) => {
        paused.push(id);
        return { ok: true, name: 'Ana Lee' };
      },
    });
    await cmds.onSlash(slash('/worker', 'Ana Lee pause'));
    expect(paused).toEqual(['w']);
    expect(posts[0].body.text).toBe('Ana Lee is paused.');
  });

  it('opens a form to change a worker for its manager, saves it with the same rules, and turns others away', async () => {
    const updates: unknown[] = [];
    const trusts: string[] = [];
    const worker = (youManage: boolean) => ({ ok: true, jobDescription: 'Reads the board.', recent: [], worker: { id: 'w', name: 'Ana Lee', youManage, budgetUSDPerMonth: 30, visibility: 'private', schedule: 'Weekdays at 9am', answersAtOnce: 3, trust: 'probation' } }) as never;
    const mine = harness({
      resolve: (_c, name) => (name.toLowerCase() === 'ana lee' ? ({ id: 'w', name: 'Ana Lee' } as never) : null),
      getWorker: () => worker(true),
      whoami: () => ({ admin: false }) as never,
      setTrust: (_c, _id, t) => {
        trusts.push(t);
        return { ok: true, name: 'Ana Lee', trust: t };
      },
      update: (_c, id, patch) => {
        updates.push([id, patch]);
        return { ok: true, worker: { name: 'Ana Lee' } } as never;
      },
    });
    await mine.cmds.onSlash(slash('/worker', 'Ana Lee edit', { trigger_id: 'trig' }));
    const opened = mine.posts.find((x) => x.url.endsWith('views.open'));
    expect(opened?.body.trigger_id).toBe('trig');
    expect(JSON.stringify(opened?.body.view)).toContain('Reads the board.');
    // Not an admin: no "on its own" to pick.
    expect(JSON.stringify(opened?.body.view)).toContain('Trusted: starts its own work');
    expect(JSON.stringify(opened?.body.view)).not.toContain('On its own');
    const view = opened!.body.view as { callback_id: string; private_metadata: string };
    await mine.cmds.onViewSubmit({
      user: { id: PAT }, team: { id: TEAM },
      view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: {
        job: { v: { value: 'Reads the board, and the roadmap.' } },
        schedule: { v: { selected_option: { value: 'asked' } } },
        budget: { v: { value: '40' } },
        visibility: { v: { selected_option: { value: 'org' } } },
        atonce: { v: { selected_option: { value: '2' } } },
        trust: { v: { selected_option: { value: 'trusted' } } },
      } } },
    });
    expect(updates).toEqual([['w', { jobDescription: 'Reads the board, and the roadmap.', cadence: null, budgetUSDPerMonth: 40, visibility: 'org', answersAtOnce: 2 }]]);
    expect(trusts).toEqual(['trusted']);

    const theirs = harness({ resolve: (_c, name) => (name.toLowerCase() === 'ana lee' ? ({ id: 'w', name: 'Ana Lee' } as never) : null), getWorker: () => worker(false) });
    await theirs.cmds.onSlash(slash('/worker', 'Ana Lee edit', { trigger_id: 'trig' }));
    expect(theirs.posts.some((x) => x.url.endsWith('views.open'))).toBe(false);
    expect(theirs.posts[0].body.text).toContain("Only Ana Lee's manager or an admin");
  });

  it('rewrites a job from a change said in words, and saves it only when accepted', async () => {
    const updates: unknown[] = [];
    const asks: Array<[string, string | undefined]> = [];
    const { cmds, posts } = harness({
      getWorker: () => ({ ok: true, jobDescription: 'Reads the board.', recent: [], worker: { id: 'w', name: 'Ana Lee', youManage: true, budgetUSDPerMonth: 30, visibility: 'private', schedule: 'Weekdays at 9am', answersAtOnce: 3, trust: 'trusted' } }) as never,
      suggestJob: async (_c, _id, ask, job) => {
        asks.push([ask, job]);
        return { ok: true, name: 'Ana Lee', job: 'Reads the board and the roadmap.' };
      },
      update: (_c, id, patch) => {
        updates.push([id, patch]);
        return { ok: true, worker: { name: 'Ana Lee' } } as never;
      },
    });
    await cmds.onViewSubmit({
      user: { id: PAT }, team: { id: TEAM },
      view: { callback_id: 'overcli_worker_edit', private_metadata: JSON.stringify({ id: 'w', channel: '', ts: '' }), state: { values: {
        job: { v: { value: 'Reads the board.' } },
        ask: { v: { value: 'also the roadmap' } },
        budget: { v: { value: '30' } },
        visibility: { v: { selected_option: { value: 'private' } } },
        atonce: { v: { selected_option: { value: '3' } } },
        trust: { v: { selected_option: { value: 'trusted' } } },
      } } },
    });
    // Nothing moved but the job, and that waits to be read.
    expect(updates).toEqual([]);
    expect(asks).toEqual([['also the roadmap', 'Reads the board.']]);
    const shown = JSON.stringify(posts.map((x) => x.body));
    expect(shown).toContain('Reads the board and the roadmap.');
    const use = /"action_id":"overcli_job_use","value":"([^"]+)"/.exec(shown)!;
    await cmds.onAction({ user: { id: PAT }, team: { id: TEAM }, actions: [{ action_id: 'overcli_job_use', value: use[1] }], channel: { id: 'D1' }, message: { ts: '1.0' } });
    expect(updates).toEqual([['w', { jobDescription: 'Reads the board and the roadmap.' }]]);
  });

  it('takes "Name, question" as an ask', async () => {
    const asked: string[] = [];
    const { cmds } = harness({
      resolve: (_c, name) => (name.toLowerCase() === 'vantage' ? ({ id: 'w', name: 'Vantage' } as never) : null),
      ask: async (_c, _id, text) => {
        asked.push(text);
        return { ok: true, reply: 'Plenty.' } as never;
      },
    });
    await cmds.onSlash(slash('/worker', 'vantage, what do you know about acme'));
    expect(asked).toEqual(['what do you know about acme']);
  });

  it('asks through the front door in the DM thread it opens, so the work it starts is followed there', async () => {
    const asked: string[] = [];
    const door: unknown[][] = [];
    const { cmds, posts } = harness(
      {
        resolve: (_c, name) => (name.toLowerCase() === 'vantage' ? ({ id: 'w', name: 'Vantage' } as never) : null),
        ask: async (_c, _id, text) => {
          asked.push(text);
          return { ok: true, reply: 'Plenty.' } as never;
        },
      },
      undefined,
      {
        askInThread: async (...args) => {
          door.push(args);
          return true;
        },
      },
    );
    await cmds.onSlash(slash('/worker', 'vantage, fix the export'));
    const root = posts.find((p) => p.url.endsWith('chat.postMessage'))!;
    expect(door).toEqual([['D0PAT', root.body.ts ?? '200.1', PAT, 'w', 'fix the export']]);
    expect(asked).toEqual([]);
    // Nothing more from here: the door answers in the thread.
    expect(posts.filter((p) => p.url.endsWith('chat.postMessage'))).toHaveLength(1);
  });
});

describe('/hire', () => {
  it('interviews in a DM thread, then offers a Hire button that hires', async () => {
    const questions: HireSummary = { hireId: 'h1', status: 'drafted', requestedBy: 'pat', questions: ['Which product area?'] };
    const contract: HireSummary = {
      hireId: 'h1',
      status: 'drafted',
      requestedBy: 'pat',
      contract: { name: 'Ana', jobDescription: 'Weekly product summary.', budgetUSDPerMonth: 30, flows: ['Weekly'], connectors: [], cadence: null, schedule: 'When asked' },
    };
    const drafts: unknown[] = [];
    const { cmds, posts } = harness({
      draftHire: async (_c, args) => {
        drafts.push(args);
        return { ok: true, hire: args.hireId ? contract : questions };
      },
      confirmHire: () => ({ ok: true, hired: { name: 'Ana' } as never, hire: contract }),
    });
    await cmds.onSlash(slash('/hire', 'Watch usage and send me a weekly summary'));
    // A working note at once, in the thread, then the questions in its place.
    const working = posts.filter((p) => p.url.endsWith('chat.postMessage')).pop()!;
    expect(JSON.stringify(working.body.blocks)).toContain('about half a minute');
    const threadTs = working.body.thread_ts;
    const asked = posts.filter((p) => p.url.endsWith('chat.update')).pop()!;
    expect(JSON.stringify(asked.body.blocks)).toContain('Which product area?');

    const handled = await cmds.onThreadReply({ channel: 'D0PAT', thread_ts: threadTs, user: PAT, text: 'Checkout' }, TEAM);
    expect(handled).toBe(true);
    expect(drafts[1]).toMatchObject({ hireId: 'h1', answer: 'Checkout' });
    expect(JSON.stringify(posts.filter((p) => p.url.endsWith('chat.postMessage')).pop()!.body.blocks)).toContain('Got it.');
    const offer = posts.filter((p) => p.url.endsWith('chat.update')).pop()!;
    expect(JSON.stringify(offer.body.blocks)).toContain(HIRE_CONFIRM_ACTION);
    const updatesBefore = posts.filter((p) => p.url.endsWith('chat.update')).length;

    await cmds.onAction({
      user: { id: PAT, name: 'pat' },
      team: { id: TEAM },
      actions: [{ action_id: HIRE_CONFIRM_ACTION, value: 'h1' }],
      channel: { id: 'D0PAT' },
      message: { ts: offer.body.ts },
    });
    const update = posts.filter((p) => p.url.endsWith('chat.update'))[updatesBefore];
    expect(update.body.text).toMatch(/Hired Ana/);
  });

  it('says which tools the server lacks, and asks an admin with a button', async () => {
    const offer = { hireId: 'h3', status: 'drafted', requestedBy: 'Pat', contract: { name: 'Ana', jobDescription: 'Reads the board.', budgetUSDPerMonth: 20, flows: [], connectors: [], cadence: null, schedule: 'When asked', wantedTools: [{ name: 'Acme Tracker', why: 'reads the sprint board', inCatalog: false }] } } as HireSummary;
    const asked: string[] = [];
    const { cmds, posts } = harness({
      askForTools: (_c, id) => {
        asked.push(id);
        return { ok: true, asked: ['U0ACMEADMIN'], hire: { ...offer, contract: { ...offer.contract!, toolsAsked: true } } };
      },
      summarize: () => offer as never,
    });
    const blocks = JSON.stringify((cmds as any).offerBlocks(offer));
    expect(blocks).toContain('Acme Tracker');
    expect(blocks).toContain(HIRE_ASK_TOOLS_ACTION);
    await cmds.onAction({ user: { id: PAT, name: 'pat' }, team: { id: TEAM }, actions: [{ action_id: HIRE_ASK_TOOLS_ACTION, value: 'h3' }], channel: { id: 'D0PAT' }, message: { ts: '1.1' } });
    expect(asked).toEqual(['h3']);
    const redrawn = posts.filter((p) => p.url.endsWith('chat.update')).pop()!;
    expect(JSON.stringify(redrawn.body.blocks)).not.toContain(HIRE_ASK_TOOLS_ACTION);
    expect(posts.filter((p) => p.url.endsWith('chat.postMessage')).pop()!.body.text).toContain('<@U0ACMEADMIN>');

    cmds.notifyToolsWanted({ id: 'h3', status: 'drafted', createdAt: 0, requestedBy: { name: 'Pat', slackUserId: PAT }, jobDescription: 'x', conversation: [], options: {} }, offer.contract!.wantedTools!, ['U0ACMEADMIN']);
    await new Promise((r) => setTimeout(r, 0));
    const dm = JSON.stringify(posts.filter((p) => p.url.endsWith('chat.postMessage')).pop()!.body.blocks);
    expect(dm).toContain('Tool request');
    expect(dm).toContain('reads the sprint board');
  });

  it('leaves threads it did not start alone', async () => {
    const { cmds } = harness({});
    expect(await cmds.onThreadReply({ channel: 'D0PAT', thread_ts: '1.0', user: PAT, text: 'hi' }, TEAM)).toBe(false);
  });

  it('asks approvers with buttons that decide the hire', async () => {
    const decided: Array<[string, boolean]> = [];
    const { cmds, posts } = harness({
      decideHire: (_c, id, approve) => {
        decided.push([id, approve]);
        return { ok: true, hired: { name: 'Ana' } as never };
      },
      summarize: () =>
        ({ contract: { name: 'Ana', jobDescription: 'Reads the board.', budgetUSDPerMonth: 500, connectors: ['acme-crm'], schedule: 'Weekdays at 9am' } }) as never,
    });
    cmds.notifyApprovers(
      {
        id: 'h2',
        status: 'awaitingApproval',
        createdAt: 0,
        requestedBy: { name: 'Pat', slackUserId: PAT },
        jobDescription: 'x',
        conversation: [],
        options: {},
        reasons: ['Over allowance.'],
      },
      ['U0ACMEBOSS'],
    );
    await new Promise((r) => setTimeout(r, 0));
    const ask = posts.find((p) => p.url.endsWith('chat.postMessage'))!;
    expect(JSON.stringify(ask.body.blocks)).toContain(HIRE_APPROVE_ACTION);
    // A published worker has no draft; the approver still sees what it costs.
    expect(JSON.stringify(ask.body.blocks)).toContain('$500/month');
    expect(JSON.stringify(ask.body.blocks)).toContain('acme-crm');
    await cmds.onAction({
      user: { id: 'U0ACMEBOSS', name: 'bo' },
      team: { id: TEAM },
      actions: [{ action_id: HIRE_APPROVE_ACTION, value: 'h2' }],
      channel: { id: 'D0BOSS' },
      message: { ts: '1.1' },
    });
    expect(decided).toEqual([['h2', true]]);
  });
});

describe('team tasks in Slack', () => {
  const task = (over: Record<string, unknown>) =>
    ({
      id: 't1',
      teamId: 'team-1',
      teamName: 'Pricing',
      brief: 'Review Q4 pricing',
      requestedBy: { name: 'Pat', slackUserId: PAT },
      status: 'questions',
      questions: ['Which regions?', 'Which plans?'],
      stages: [],
      stageIndex: 0,
      spentUSD: 0,
      budgetUSD: 40,
      ...over,
    }) as never;

  describe('asked for in a channel thread', () => {
    const slackThread = { channel: 'C0ACME', threadTs: '100.1' };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const sent = (posts: Array<{ url: string; body: any }>) => posts.filter((p) => p.url.endsWith('chat.postMessage'));

    it('asks there, and takes anyone’s reply in the thread as the answers', async () => {
      const answered: unknown[] = [];
      const { cmds, posts } = harness({
        answerTeamFromThread: (c, id, thread, answers) => {
          answered.push([c.slackUserId, id, thread, answers]);
          return { ok: true, answered: true };
        },
      });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread }) });
      await settle();
      expect(sent(posts)).toHaveLength(1);
      expect(sent(posts)[0].body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1' });
      expect(JSON.stringify(sent(posts)[0].body.blocks)).toContain('Anyone here can answer');

      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: 'U0ACMESAM', text: '1. US\n2. Team' }, TEAM)).toBe(true);
      expect(answered).toEqual([['U0ACMESAM', 't1', slackThread, ['US', 'Team']]]);
      // Answered once: the next message there is just people talking.
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: 'U0ACMESAM', text: 'and one more thing' }, TEAM)).toBe(false);
      expect(answered).toHaveLength(1);
    });

    it('leaves people talking to each other alone, and other threads and workspaces too', async () => {
      const answerTeamFromThread = vi.fn(() => ({ ok: true as const, answered: true }));
      const { cmds } = harness({ answerTeamFromThread });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread }) });
      await settle();
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: '<@U0ACMESAM> what do you think?' }, TEAM)).toBe(true);
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '999.9', user: PAT, text: 'US' }, TEAM)).toBe(false);
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'US' }, 'T0OTHER')).toBe(false);
      expect(answerTeamFromThread).not.toHaveBeenCalled();
    });

    it('hands the reply back when the questions have moved on', async () => {
      const { cmds, posts } = harness({ answerTeamFromThread: () => ({ ok: true, answered: false }) });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread }) });
      await settle();
      const before = sent(posts).length;
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'US' }, TEAM)).toBe(false);
      expect(sent(posts)).toHaveLength(before);
    });

    it('posts the plan there, naming who has to approve it', async () => {
      const { cmds, posts } = harness({});
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread, status: 'proposed', stages: [{ title: 'Gather', assignments: [] }] }) });
      await settle();
      const plan = sent(posts)[0];
      expect(plan.body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1' });
      expect(JSON.stringify(plan.body.blocks)).toContain(`<@${PAT}>`);
      expect(JSON.stringify(plan.body.blocks)).toContain('Only the person who asked');
    });

    it('posts the conversation there once, each under its speaker’s name and picture, and not what people said', async () => {
      const { cmds, posts } = harness({ pictureOf: (id: string) => `https://acme.example/${id}.png` } as never);
      const at = Date.now() + 1000;
      const room = (...messages: unknown[]) => ({ messages });
      const you = { id: 'm1', speaker: { kind: 'you' }, text: 'What about pricing?', at, exchange: 0 };
      const lena = { id: 'm2', speaker: { kind: 'member', workerId: 'w-lena', name: 'Lena' }, text: 'Pricing looks fine.', at, exchange: 0 };
      const lead = { id: 'm3', speaker: { kind: 'coordinator' }, text: 'Agreed.', at, exchange: 0 };
      const broke = { id: 'm4', speaker: { kind: 'member', workerId: 'w-sam', name: 'Sam' }, text: 'Turn failed', at, exchange: 0, failed: true };
      const old = { id: 'm0', speaker: { kind: 'coordinator' }, text: 'From before a restart', at: 1, exchange: 0 };
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread, status: 'done', room: room(old, you, lena) }) });
      await settle();
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread, status: 'done', room: room(old, you, lena, lead, broke) }) });
      await settle();
      await settle();
      const said = sent(posts).filter((p) => p.body.username);
      expect(said.map((p) => [p.body.username, p.body.text])).toEqual([['Lena', 'Pricing looks fine.'], ['Pricing', 'Agreed.']]);
      expect(said[0].body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1' });
      expect(said[0].body.icon_url).toContain('w-lena');
      expect(said[1].body.icon_url).toContain('team-1');
    });

    describe('while the work runs', () => {
      const piece = (over: Record<string, unknown>) => ({ workerId: 'w-lena', workerName: 'Lena', ask: 'Research', status: 'running', runId: 'run-1', ...over });
      const running = (assignments: unknown[], over: Record<string, unknown> = {}) => task({ slackThread, status: 'running', updatedAt: Date.now(), stages: [{ title: 'Gather evidence', status: 'running', assignments }], ...over });
      const says = (posts: Array<{ url: string; body: any }>) => sent(posts).filter((p) => p.body.username === 'Lena');
      const deps = (over: Record<string, unknown> = {}) => ({ pieceLook: () => ({ said: 'Found three competitors.', last: { text: 'Ran curl https://secret.acme.example', at: Date.now() } }), ...over });
      const setUp = (d: Record<string, unknown> = deps()) => harness({ pictureOf: (id: string) => `https://acme.example/${id}.png` } as never, undefined, d as never);

      it('has each member say what it did under its own name and picture, once', async () => {
        const { cmds, posts } = setUp();
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})]) });
        await settle();
        expect(says(posts)).toHaveLength(0);
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done' })]) });
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done' })]) });
        await settle();
        await settle();
        expect(says(posts)).toHaveLength(1);
        expect(says(posts)[0].body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1', text: 'Found three competitors.' });
        expect(says(posts)[0].body.icon_url).toContain('w-lena');
        expect(JSON.stringify(says(posts)[0].body.blocks)).toContain('Stage 1 · Gather evidence');
      });

      it('says so when a piece fails, and again for a retry that finishes', async () => {
        const { cmds, posts } = setUp();
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})]) });
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'failed', error: 'The run failed.' })]) });
        await settle();
        await settle();
        expect(says(posts)[0].body.text).toContain("couldn't finish this: The run failed.");
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done', runId: 'run-2' })]) });
        await settle();
        await settle();
        expect(says(posts)).toHaveLength(2);
        expect(says(posts)[1].body.text).toBe('Found three competitors.');
      });

      it('falls back on its file, then a plain line', async () => {
        const withFile = setUp({ pieceLook: () => null, teamFile: () => Buffer.from('# Report\n\nOffline mode matters.') });
        withFile.cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})]) });
        withFile.cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done', file: 'lena.md' })]) });
        await settle();
        await settle();
        expect(says(withFile.posts)[0].body.text).toBe('Offline mode matters.');
        const bare = setUp({ pieceLook: () => null });
        bare.cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})]) });
        bare.cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done' })]) });
        await settle();
        await settle();
        expect(says(bare.posts)[0].body.text).toBe('My part is done.');
      });

      it('doesn’t repeat pieces already over after a restart', async () => {
        const { cmds, posts } = setUp();
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done' })]) });
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done' })]) });
        await settle();
        await settle();
        expect(says(posts)).toHaveLength(0);
      });

      it('keeps a run’s raw last step off the card in a channel, but not in a DM', async () => {
        const inChannel = setUp();
        inChannel.cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})]) });
        await settle();
        expect(JSON.stringify(sent(inChannel.posts))).not.toContain('secret.acme.example');
        const inDm = setUp();
        inDm.cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})], { slackThread: undefined }) });
        await settle();
        expect(JSON.stringify(sent(inDm.posts))).toContain('secret.acme.example');
      });

      it('stays out of the channel and quiet in a DM task', async () => {
        const { cmds, posts } = setUp();
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({})], { slackThread: undefined }) });
        cmds.onEvent({ type: 'teamTaskUpdate', task: running([piece({ status: 'done' })], { slackThread: undefined }) });
        await settle();
        await settle();
        expect(says(posts)).toHaveLength(0);
      });
    });

    it('keeps a task with no thread out of any channel', async () => {
      const { cmds, posts } = harness({});
      const lena = { id: 'm2', speaker: { kind: 'member', workerId: 'w-lena', name: 'Lena' }, text: 'Pricing looks fine.', at: Date.now() + 1000, exchange: 0 };
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ status: 'done', room: { messages: [lena] } }) });
      await settle();
      expect(sent(posts).filter((p) => p.body.text === 'Pricing looks fine.')).toHaveLength(0);
    });

    it('answers under the team’s name and picture, not overgo’s', async () => {
      const { cmds, posts } = harness({
        pictureOf: (id: string) => `https://acme.example/${id}.png`,
        teamTaskInThread: (() => ({ id: 't1', teamId: 'team-1', teamName: 'Pricing', status: 'questions' })) as never,
        answerTeamFromThread: () => ({ ok: true, answered: true }),
      } as never);
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread }) });
      await settle();
      await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'US' }, TEAM);
      expect(sent(posts).at(-1)!.body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1', username: 'Pricing', text: expect.stringContaining('planning with that') });
      expect(sent(posts).at(-1)!.body.icon_url).toContain('team-1');
    });

    it('takes “nevermind” as stopping the task, not as an answer', async () => {
      const decided: unknown[] = [];
      const answerTeamFromThread = vi.fn(() => ({ ok: true as const, answered: true }));
      const { cmds, posts } = harness({
        answerTeamFromThread,
        teamTaskInThread: (() => ({ id: 't1', teamId: 'team-1', teamName: 'Pricing', status: 'questions' })) as never,
        decideTeamTask: (_c, id, action) => { decided.push([id, action]); return { ok: true }; },
      });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread }) });
      await settle();
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'Nevermind.' }, TEAM)).toBe(true);
      expect(decided).toEqual([['t1', { kind: 'cancel' }]]);
      expect(answerTeamFromThread).not.toHaveBeenCalled();
      expect(sent(posts).at(-1)!.body.text).toContain('Stopped.');
    });

    it('only takes it as stopping from someone who may, and not when it’s part of an answer', async () => {
      const decided: unknown[] = [];
      const answered: unknown[] = [];
      const { cmds, posts } = harness({
        answerTeamFromThread: (_c, _id, _t, a) => { answered.push(a); return { ok: true, answered: true }; },
        teamTaskInThread: (() => ({ id: 't1', teamId: 'team-1', teamName: 'Pricing', status: 'questions' })) as never,
        decideTeamTask: (_c, id, action) => { decided.push([id, action]); return { ok: false, error: 'Only the person who asked for this task, or an admin, can steer it.' }; },
      });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread }) });
      await settle();
      await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: 'U0ACMESAM', text: 'stop' }, TEAM);
      expect(sent(posts).at(-1)!.body.text).toContain('Only the person who asked');
      // Still asking: a refused stop leaves the questions open.
      await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'Stop selling the old plan' }, TEAM);
      expect(answered).toEqual([['Stop selling the old plan']]);
    });

    it('stops a running task on the word while it works, but not one already delivered', async () => {
      const decide = vi.fn(() => ({ ok: true as const }));
      const talk = vi.fn(() => ({ ok: true as const, heard: true }));
      let status = 'running';
      const { cmds } = harness({
        teamTaskInThread: (() => ({ id: 't1', teamId: 'team-1', teamName: 'Pricing', status })) as never,
        decideTeamTask: decide,
        talkInTeamThread: talk,
      });
      await cmds.talkInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'cancel the task' }, TEAM);
      expect(decide).toHaveBeenCalledWith(expect.anything(), 't1', { kind: 'cancel' });
      expect(talk).not.toHaveBeenCalled();
      decide.mockClear();
      status = 'done';
      await cmds.talkInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'stop' }, TEAM);
      expect(decide).not.toHaveBeenCalled();
      expect(talk).toHaveBeenCalled();
    });

    it('tells whoever gave feedback while the team works that it was heard', async () => {
      let replanned = false;
      const { cmds, posts } = harness({
        teamTaskInThread: (() => ({ id: 't1' })) as never,
        talkInTeamThread: () => ({ ok: true, heard: true, noted: true, ...(replanned ? { replanned: true } : {}) }),
      });
      const reply = { channel: 'C0ACME', thread_ts: '100.1', user: 'U0ACMESAM', text: 'Customers care most about the UK.' };
      expect(await cmds.talkInThread(reply, TEAM)).toBe(true);
      expect(sent(posts).at(-1)!.body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1', text: expect.stringContaining('work it starts next') });
      replanned = true;
      expect(await cmds.talkInThread(reply, TEAM)).toBe(true);
      expect(sent(posts).at(-1)!.body.text).toContain('changing the plan');
    });

    it('keeps files sent as an answer to the team’s questions, and names them in the answer', async () => {
      const saved: unknown[] = [];
      const answered: string[][] = [];
      const { cmds } = harness(
        {
          teamTaskInThread: (() => undefined) as never,
          addTeamFiles: ((id: string, files: Array<{ label: string }>) => (saved.push([id, files.map((f) => f.label)]), { ok: true, names: files.map((f) => `attachments/${f.label}`) })) as never,
          answerTeamFromThread: ((_c: unknown, _t: unknown, _th: unknown, answers: string[]) => (answered.push(answers), { ok: true, answered: true })) as never,
        },
        undefined,
        { fetchImpl: (async (url: string) => (String(url).includes('files.slack.com') ? new Response('pdf', { headers: { 'content-type': 'application/pdf' } }) : new Response(JSON.stringify({ ok: true, ts: '1.1', channel: 'C0ACME' }), { headers: { 'content-type': 'application/json' } }))) as never },
      );
      (cmds as unknown as { teamThreads: Map<string, string> }).teamThreads.set('C0ACME:100.1', 't1');
      const files = [{ id: 'F1', name: 'gap.pdf', mimetype: 'application/pdf', size: 3, url_private: 'https://files.slack.com/gap.pdf' }];
      expect(await cmds.answerInThread({ channel: 'C0ACME', thread_ts: '100.1', user: PAT, text: 'Here they are.', files }, TEAM)).toBe(true);
      expect(saved).toEqual([['t1', ['gap.pdf']]]);
      expect(answered[0].join(' ')).toContain('attachments/gap.pdf');
      expect(answered[0].join(' ')).toContain('Here they are.');
    });

    it('takes a reply under a task’s DM card to the team, and gives the task that thread', async () => {
      const linked: unknown[] = [];
      const talked: unknown[] = [];
      let thread: { channel: string; threadTs: string } | undefined;
      const { cmds } = harness(
        {
          teamTaskInThread: (() => (thread ? { id: 't1' } : undefined)) as never,
          linkTeamThread: ((id: string, t: { channel: string; threadTs: string }) => (linked.push([id, t]), (thread = t), { ok: true })) as never,
          talkInTeamThread: (_c, _t, text) => (talked.push(text), { ok: true, heard: true }),
        },
        undefined,
        { teamCards: { load: () => ({ t1: { channel: 'D0ACME', ts: '200.1', told: 0, at: 1 } }), save: () => {} } },
      );
      const reply = { channel: 'D0ACME', thread_ts: '200.1', user: PAT, text: 'Cut the routing rules.' };
      expect(await cmds.onThreadReply(reply, TEAM)).toBe(true);
      expect(linked).toEqual([['t1', { channel: 'D0ACME', threadTs: '200.1' }]]);
      expect(talked).toEqual(['Cut the routing rules.']);
      // Already its thread: no second link.
      expect(await cmds.onThreadReply(reply, TEAM)).toBe(true);
      expect(linked).toHaveLength(1);
      expect(talked).toHaveLength(2);
      // Under something else in the same DM: not the team's.
      expect(await cmds.onThreadReply({ ...reply, thread_ts: '999.9' }, TEAM)).toBe(false);
    });

    it('sends a reply to the team once it can talk, and leaves it when it can’t', async () => {
      const talked: unknown[] = [];
      let heard = true;
      const { cmds, posts } = harness({
        teamTaskInThread: ((t: { threadTs: string }) => (t.threadTs === '100.1' ? { id: 't1' } : undefined)) as never,
        talkInTeamThread: (c, _t, text) => {
          talked.push([c.slackUserId, text]);
          return { ok: true, heard };
        },
      });
      const reply = { channel: 'C0ACME', thread_ts: '100.1', user: 'U0ACMESAM', text: 'Can we also cover Team?' };
      expect(await cmds.talkInThread(reply, TEAM)).toBe(true);
      expect(talked).toEqual([['U0ACMESAM', 'Can we also cover Team?']]);
      expect(await cmds.talkInThread({ ...reply, text: `<@${PAT}> thoughts?` }, TEAM)).toBe(true);
      expect(await cmds.talkInThread({ ...reply, thread_ts: '999.9' }, TEAM)).toBe(false);
      expect(talked).toHaveLength(1);
      heard = false;
      expect(await cmds.talkInThread(reply, TEAM)).toBe(false);
      expect(sent(posts)).toHaveLength(0);
    });

    it('keeps its progress in the thread, not hanging off the card', async () => {
      const { cmds, posts } = harness({});
      const stage = (status: string) => ({ title: 'Gather', status, assignments: [] });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread, status: 'running', stages: [stage('running')], updatedAt: 1 }) });
      await settle();
      expect(sent(posts)[0].body).toMatchObject({ channel: 'C0ACME', thread_ts: '100.1' });
      cmds.onEvent({ type: 'teamTaskUpdate', task: task({ slackThread, status: 'failed', stages: [stage('done')], updatedAt: 2 }) });
      await settle();
      const notes = sent(posts).slice(1);
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) expect(n.body.thread_ts).toBe('100.1');
    });
  });

  it('keeps a task with no thread in the requester’s DMs', async () => {
    const { cmds, posts } = harness({});
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({ status: 'proposed', stages: [{ title: 'Gather' }] }) });
    await new Promise((r) => setTimeout(r, 0));
    const plan = posts.filter((p) => p.url.endsWith('chat.postMessage'))[0];
    expect(plan.body.channel).not.toBe('C0ACME');
    expect(plan.body.thread_ts).toBeUndefined();
    expect(JSON.stringify(plan.body.blocks)).not.toContain(`<@${PAT}>`);
  });

  it('asks the requester the questions once, and takes a numbered reply as the answers', async () => {
    const decided: unknown[] = [];
    const { cmds, posts } = harness({
      decideTeamTask: (_c, id, action) => {
        decided.push([id, action]);
        return { ok: true };
      },
    });
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({}) });
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({}) });
    await new Promise((r) => setTimeout(r, 0));
    const asks = posts.filter((p) => p.url.endsWith('chat.postMessage'));
    expect(asks).toHaveLength(1);
    expect(JSON.stringify(asks[0].body.blocks)).toContain('Which regions?');
    await cmds.onThreadReply({ channel: 'D0PAT', thread_ts: asks[0].body.ts ?? '200.1', user: PAT, text: '1. US and UK\n2. Team and Business' }, TEAM);
    expect(decided).toEqual([['t1', { kind: 'answer', answers: ['US and UK', 'Team and Business'] }]]);
  });

  it('says a finished pack plainly, and never says "finished" again for an old task after a restart', async () => {
    const now = Date.now();
    const pack = { summary: 'C1 first (§6).', files: ['pack/PLAN.md'] };
    const { cmds, posts } = harness({}, undefined, { plainPack: async () => 'The MDF Programs pilot comes first.', now: () => now });
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({ id: 't-new', status: 'done', pack, finishedAt: now - 60_000 }) });
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({ id: 't-old', status: 'done', pack, finishedAt: now - 2 * 24 * 3_600_000 }) });
    await new Promise((r) => setTimeout(r, 0));
    const dms = posts.filter((p) => p.url.endsWith('chat.postMessage')).map((p) => JSON.stringify(p.body.blocks));
    expect(dms.filter((b) => b.includes('finished'))).toHaveLength(1);
    expect(dms.find((b) => b.includes('finished'))).toContain('The MDF Programs pilot comes first.');
    expect(dms.join()).not.toContain('C1 first');
  });

  it('opens a Change it form for an offer, and redraws the offer when it’s saved', async () => {
    const offer = { hireId: 'h1', status: 'drafted', requestedBy: 'Pat', contract: { name: 'Ana', jobDescription: 'Writes summaries.', budgetUSDPerMonth: 30, flows: [], connectors: [], cadence: null, schedule: 'when asked', visibility: 'private' } };
    const edits: unknown[] = [];
    const { cmds, posts } = harness({
      listHires: () => [offer as never],
      tools: () => ({ ok: true, tools: [{ name: 'jira' }], missing: [], canEdit: false, signIn: false }) as never,
      listWorkers: () => [],
      editHire: (_c, id, patch) => {
        edits.push([id, patch]);
        return { ok: true, hire: { ...offer, contract: { ...offer.contract, name: 'Iris', visibility: 'org' } } as never };
      },
    });
    await cmds.onAction({ user: { id: PAT }, team: { id: TEAM }, trigger_id: 'trig-1', actions: [{ action_id: HIRE_EDIT_ACTION, value: 'h1' }], channel: { id: 'D0PAT' }, message: { ts: '1.1' } });
    const opened = posts.find((p) => p.url.endsWith('views.open'))!;
    expect(opened.body.trigger_id).toBe('trig-1');
    expect(JSON.stringify(opened.body.view)).toContain('jira');
    const view = opened.body.view;
    await cmds.onViewSubmit({
      type: 'view_submission',
      user: { id: PAT },
      team: { id: TEAM },
      view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { name: { v: { value: 'Iris' } }, budget: { v: { value: '30' } }, visibility: { v: { selected_option: { value: 'org' } } }, tools: { v: { selected_options: [] } } } } },
    });
    expect(edits).toEqual([['h1', { name: 'Iris', budgetUSDPerMonth: 30, visibility: 'org', mcpServers: [] }]]);
    const updated = posts.find((p) => p.url.endsWith('chat.update'))!;
    expect(updated.body).toMatchObject({ channel: 'D0PAT', ts: '1.1' });
    expect(JSON.stringify(updated.body.blocks)).toContain('everyone in the org');
  });

  it('makes a team from /team new once its asker presses Make the team', async () => {
    const made: unknown[] = [];
    const { cmds, posts } = harness({
      suggestTeam: async () => ({
        ok: true,
        name: 'Product',
        purpose: 'Writes PR/FAQs',
        note: 'Vantage drafts, Lena speaks for customers.',
        members: [
          { workerId: 'w-v', name: 'Vantage', role: 'Drafts the press release' },
          { workerId: 'w-l', name: 'Lena', role: 'Writes the customer FAQ' },
        ],
        gaps: [],
      }),
      makeTeamWithHires: async (_c, input) => {
        made.push(input);
        return { ok: true, team: { id: 'team-9', name: 'Product' }, hired: [], waiting: [], failed: [] };
      },
    });
    await cmds.onSlash(slash('/team', 'new writes PR/FAQs for new features'));
    const offer = posts.filter((p) => p.url.endsWith('chat.update')).find((p) => JSON.stringify(p.body.blocks ?? []).includes(TEAM_MAKE_ACTION))!;
    expect(JSON.stringify(offer.body.blocks)).toContain('Drafts the press release');
    const id = JSON.parse(JSON.stringify(offer.body.blocks)).find((b: { type: string }) => b.type === 'actions').elements[0].value;
    // Someone else's click does nothing.
    await cmds.onAction({ user: { id: 'U0OTHER' }, team: { id: TEAM }, actions: [{ action_id: TEAM_MAKE_ACTION, value: id }], channel: { id: 'D0PAT' }, message: { ts: '1.1' } });
    expect(made).toEqual([]);
    await cmds.onAction({ user: { id: PAT }, team: { id: TEAM }, actions: [{ action_id: TEAM_MAKE_ACTION, value: id }], channel: { id: 'D0PAT' }, message: { ts: '1.1' } });
    expect(made).toEqual([
      {
        name: 'Product',
        purpose: 'Writes PR/FAQs',
        budgetUSDPerTask: 50,
        checkpoints: { askFirst: true, reviewBeforeChallenge: false, finalReview: true, approveRoomWork: true },
        members: [{ workerId: 'w-v', role: 'Drafts the press release' }, { workerId: 'w-l', role: 'Writes the customer FAQ' }],
        hires: [],
      },
    ]);
  });

  it('still takes the answers in a question thread it lost track of, by what the thread says', async () => {
    const decided: unknown[] = [];
    const { cmds } = harness({
      teamTasks: () => [{ id: 't1', teamName: 'Pricing', status: 'questions', waitingOnYou: true } as never],
      decideTeamTask: (_c, id, action) => {
        decided.push([id, action]);
        return { ok: true };
      },
    });
    // No question was posted by this process: as after a restart.
    const took = await cmds.onThreadReply({ channel: 'D0PAT', thread_ts: '150.1', user: PAT, text: 'US and UK only' }, TEAM);
    expect(took).toBe(true);
    expect(decided).toEqual([['t1', { kind: 'answer', answers: ['US and UK only'] }]]);
  });

  it('offers the plan with an Approve button that approves it', async () => {
    const decided: unknown[] = [];
    const { cmds, posts } = harness({
      decideTeamTask: (_c, id, action) => {
        decided.push([id, action]);
        return { ok: true };
      },
    });
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({ status: 'proposed', planNote: 'Three stages.', stages: [{ title: 'Gather' }] }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.stringify(posts.find((p) => p.url.endsWith('chat.postMessage'))!.body.blocks)).toContain(TEAM_APPROVE_ACTION);
    await cmds.onAction({ user: { id: PAT }, team: { id: TEAM }, actions: [{ action_id: TEAM_APPROVE_ACTION, value: 't1' }], channel: { id: 'D0PAT' }, message: { ts: '1.1' } });
    expect(decided).toEqual([['t1', { kind: 'approve' }]]);
  });

  it('posts a team’s messages under the team’s own name and picture', async () => {
    const { cmds, posts } = harness({ pictureOf: (id: string) => (id === 'team-1' ? 'https://img.acme.example/pricing.png' : undefined) } as Partial<OrgService>);
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({ status: 'proposed', planNote: 'Three stages.', stages: [{ title: 'Gather' }] }) });
    await new Promise((r) => setTimeout(r, 0));
    const dms = posts.filter((p) => p.url.endsWith('chat.postMessage'));
    expect(dms.length).toBeGreaterThan(0);
    for (const dm of dms) expect(dm.body).toMatchObject({ username: 'Pricing', icon_url: 'https://img.acme.example/pricing.png' });
  });

  it('says nothing about tasks nobody asked for through the org', async () => {
    const { cmds, posts } = harness({});
    cmds.onEvent({ type: 'teamTaskUpdate', task: task({ requestedBy: undefined }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]);
  });
});

describe('/overcli join', () => {
  it('asks to join under the person\'s real name from Slack', async () => {
    const asked: unknown[] = [];
    const { cmds, posts } = harness({}, {
      baseUrl: () => 'https://overcli.acme.example',
      requestJoin: async (person) => {
        asked.push(person);
        return { ok: true, outcome: 'asked' as const };
      },
    });
    await cmds.onSlash(slash('/overcli', 'join'));
    expect(asked).toEqual([{ slackUserId: PAT, name: 'pat' }]);
    expect(posts.at(-1)!.body.text).toMatch(/An admin will let you in/);
  });

  it('lets someone in from the admin\'s button', async () => {
    const decided: unknown[] = [];
    const { cmds, posts } = harness({}, {
      baseUrl: () => 'https://overcli.acme.example',
      decideRequest: async (_c, id, approve, base) => {
        decided.push([id, approve, base]);
        return { ok: true, sentInSlack: true };
      },
    });
    await cmds.onAction({ user: { id: 'U0ACMEBOSS' }, team: { id: TEAM }, actions: [{ action_id: JOIN_LETIN_ACTION, value: 'r1' }], channel: { id: 'D0BOSS' }, message: { ts: '1.1' } });
    expect(decided).toEqual([['r1', true, 'https://overcli.acme.example']]);
    expect(posts.find((p) => p.url.endsWith('chat.update'))!.body.text).toMatch(/Let in/);
  });
});

describe('proposed work in Slack', () => {
  const batch = (statuses: string[]) =>
    ({
      id: 'b1',
      createdAt: 0,
      origin: { kind: 'worker', workerId: 'triage', workerName: 'Triage', task: 'shift' },
      items: statuses.map((status, i) => ({ status, candidate: { id: `c${i}`, title: `Fix <!channel> ticket ${i}` } })),
    }) as never;
  const proposals = [{ batchId: 'b1', workerId: 'triage', workerName: 'Triage', at: 0, task: 'shift', items: [{ candidateId: 'c0', title: 'x' }, { candidateId: 'c1', title: 'y' }] }];

  it('DMs the manager once per run, escaped, with Approve all and Skip', async () => {
    const { cmds, posts } = harness({ managerSlackId: () => PAT });
    cmds.onEvent({ type: 'orchestrationUpdate', orchestration: batch(['proposed', 'proposed']) });
    cmds.onEvent({ type: 'orchestrationUpdate', orchestration: batch(['proposed', 'proposed']) });
    await new Promise((r) => setTimeout(r, 0));
    const dms = posts.filter((p) => p.url.endsWith('chat.postMessage'));
    expect(dms).toHaveLength(1);
    const blocks = JSON.stringify(dms[0].body.blocks);
    expect(blocks).toContain('Approve all');
    expect(blocks).toContain(PROPOSALS_SKIP_ACTION);
    expect(blocks).not.toContain('<!channel>');
  });

  it('asks for the OK in the thread the work was asked for in, when the asker approves it', async () => {
    const { cmds, posts } = harness({ managerSlackId: () => PAT, slackThreadFor: () => ({ channel: 'D0REQ', threadTs: '70.1', slackUserId: PAT }) } as Partial<OrgService>);
    cmds.onEvent({ type: 'orchestrationUpdate', orchestration: batch(['proposed']) });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.some((p) => p.url.endsWith('conversations.open'))).toBe(false);
    expect(posts.find((p) => p.url.endsWith('chat.postMessage'))!.body).toMatchObject({ channel: 'D0REQ', thread_ts: '70.1' });
  });

  it('stays quiet for a run with nothing proposed, or a worker with no manager in Slack', async () => {
    const { cmds, posts } = harness({ managerSlackId: () => undefined });
    cmds.onEvent({ type: 'orchestrationUpdate', orchestration: batch(['proposed']) });
    const quiet = harness({ managerSlackId: () => PAT });
    quiet.cmds.onEvent({ type: 'orchestrationUpdate', orchestration: batch(['queued', 'done']) });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]);
    expect(quiet.posts).toEqual([]);
  });

  it('approves everything from the button, and skips everything from Skip', async () => {
    const decided: unknown[] = [];
    const org = {
      proposals: () => proposals as never,
      decideProposal: async (_c: unknown, id: string, d: unknown) => {
        decided.push([id, d]);
        return { ok: true as const, queued: 2, skipped: 0 };
      },
    };
    const { cmds, posts } = harness(org);
    await cmds.onAction({ user: { id: PAT }, team: { id: TEAM }, actions: [{ action_id: PROPOSALS_APPROVE_ACTION, value: 'b1' }], channel: { id: 'D0PAT' }, message: { ts: '1.1' } });
    await cmds.onAction({ user: { id: PAT }, team: { id: TEAM }, actions: [{ action_id: PROPOSALS_SKIP_ACTION, value: 'b1' }], channel: { id: 'D0PAT' }, message: { ts: '1.2' } });
    expect(decided).toEqual([
      ['b1', { approve: 'all' }],
      ['b1', { approve: [], skip: ['c0', 'c1'] }],
    ]);
    expect(posts.filter((p) => p.url.endsWith('chat.update'))[0].body.text).toMatch(/Approved by .*2 started/);
  });
});

describe('answers to console questions', () => {
  const ask = (over: Record<string, unknown>) =>
    ({ id: 'a1', workerId: 'w', workerName: 'Triage', by: 'Pat', slackUserId: PAT, text: 'How many open bugs?', at: 0, status: 'answered', reply: 'Twelve.', via: 'console', doneAt: 60_000, ...over }) as never;

  it('follows the asker to Slack when it took a while, and only then', async () => {
    const { cmds, posts } = harness({});
    cmds.askAnswered(ask({}));
    cmds.askAnswered(ask({ doneAt: 5_000 }));
    cmds.askAnswered(ask({ via: 'slack' }));
    await new Promise((r) => setTimeout(r, 0));
    const dms = posts.filter((p) => p.url.endsWith('chat.postMessage'));
    expect(dms).toHaveLength(1);
    expect(JSON.stringify(dms[0].body.blocks)).toContain('Twelve.');
  });
});

describe('a finished shift in Slack', () => {
  const NOW = 1_000_000_000;
  const shift = (status: string, finishedAt = NOW - 60_000) =>
    ({
      id: 'b2',
      createdAt: 0,
      origin: { kind: 'worker', workerId: 'scout', workerName: 'Scout', task: 'shift' },
      items: [{ status, finishedAt, candidate: { id: 'c0', title: 'Weekly acme report' } }],
    }) as never;
  const progress = {
    done: true,
    items: [{ title: 'Weekly acme report', status: 'done', runId: 'r1' }],
    files: [
      { name: 'review.md', body: 'Verdict: PASS.' },
      { name: 'reports/acme-weekly.html', sourcePath: '/data/coordinators/r1/reports/acme-weekly.html' },
      { name: 'reports/acme-weekly.tsx', sourcePath: '/data/coordinators/r1/reports/acme-weekly.tsx' },
    ],
    links: [],
  };

  function setup(over: Partial<OrgService> = {}) {
    const calls: Array<{ method: string; body: string }> = [];
    let ts = 0;
    const fetchImpl = async (url: string, init: RequestInit) => {
      const method = url.split('/').pop() ?? url;
      calls.push({ method, body: typeof init.body === 'string' ? init.body : '<bytes>' });
      const json =
        method === 'conversations.open'
          ? { ok: true, channel: { id: 'D0PAT' } }
          : method === 'chat.postMessage'
            ? { ok: true, channel: 'D0PAT', ts: `300.${++ts}` }
            : method === 'files.getUploadURLExternal'
              ? { ok: true, upload_url: 'https://files.slack.example/up', file_id: `F${++ts}` }
              : { ok: true };
      return new Response(JSON.stringify(json));
    };
    const cmds = new SlackCommands({
      org: { managerSlackId: () => PAT, errandProgress: () => progress, ...over } as unknown as OrgService,
      policy: () => DEFAULT_ORG_POLICY,
      botToken: () => 'xoxb-test',
      teamId: () => TEAM,
      log: () => {},
      fetchImpl: fetchImpl as never,
      readFile: (p) => Buffer.from(`bytes of ${p}`),
      libraryUrl: () => 'https://overcli.acme.example',
      now: () => NOW,
    });
    const settle = () => new Promise((r) => setTimeout(r, 10));
    return { cmds, calls, settle };
  }

  it('DMs the manager once, with the answer and the report it wrote in the thread', async () => {
    const { cmds, calls, settle } = setup();
    cmds.onEvent({ type: 'orchestrationUpdate', orchestration: shift('done') });
    cmds.onEvent({ type: 'orchestrationUpdate', orchestration: shift('done') });
    await settle();
    const posts = calls.filter((c) => c.method === 'chat.postMessage').map((c) => JSON.parse(c.body));
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[0].blocks)).toMatch(/Scout\* finished:\\n✓ Weekly acme report/);
    expect(posts[1]).toMatchObject({ thread_ts: '300.1', text: '*Scout:* Verdict: PASS.' });
    const done = calls.filter((c) => c.method === 'files.completeUploadExternal').map((c) => JSON.parse(c.body));
    // The page goes up; source code stays in the Library.
    expect(done.map((d) => d.thread_ts)).toEqual(['300.1']);
    expect(calls.filter((c) => c.method === 'files.getUploadURLExternal').map((c) => new URLSearchParams(c.body).get('filename'))).toEqual(['acme-weekly.html']);
  });

  it('stays quiet while it runs, for an old shift replayed after a restart, and with no manager in Slack', async () => {
    const running = setup({ errandProgress: () => ({ ...progress, done: false }) });
    running.cmds.onEvent({ type: 'orchestrationUpdate', orchestration: shift('running') });
    const old = setup();
    old.cmds.onEvent({ type: 'orchestrationUpdate', orchestration: shift('done', NOW - 2 * 60 * 60_000) });
    const nobody = setup({ managerSlackId: () => undefined });
    nobody.cmds.onEvent({ type: 'orchestrationUpdate', orchestration: shift('done') });
    await Promise.all([running.settle(), old.settle(), nobody.settle()]);
    expect([...running.calls, ...old.calls, ...nobody.calls]).toEqual([]);
  });
});

describe('the worker list in Slack', () => {
  const w = (name: string, managerSlackUserId?: string) => ({ id: name, name, tagline: 'does acme things', manager: managerSlackUserId ?? 'Me', managerSlackUserId, spentThisMonthUSD: 1, budgetUSDPerMonth: 47.43996, enabled: true, waiting: 0 });

  it('puts yours first, and says why an admin sees everyone else’s', async () => {
    const { cmds, posts } = harness({ listWorkers: () => [w('Forge', PAT), w('Marta'), w('Vantage', PAT)] } as never);
    const admin = { ...DEFAULT_ORG_POLICY, admins: [PAT] };
    (cmds as unknown as { deps: { policy: () => typeof admin } }).deps.policy = () => admin;
    await cmds.onSlash(slash('/worker', ''));
    const blocks = JSON.stringify(posts.at(-1)!.body.blocks);
    expect(blocks).toMatch(/\*Yours\*\\n• \*Forge\*.*• \*Vantage\*/);
    expect(blocks).toMatch(/Everyone else’s\*\\n• \*Marta\*/);
    expect(blocks).toContain('because you’re an admin');
    expect(blocks).toContain('$1 of $47.44/mo');
  });
});

describe('answers after a restart', () => {
  it('DMs the asker an answer the server asked again, wherever it was first asked', async () => {
    const { cmds, posts } = harness({});
    cmds.askAnswered({ id: 'a1', workerId: 'scout', workerName: 'Scout', by: 'Pat', slackUserId: PAT, text: 'who moved first?', at: 0, doneAt: 1, status: 'answered', via: 'slack', reply: 'Acme.', resumed: true });
    cmds.askAnswered({ id: 'a2', workerId: 'scout', workerName: 'Scout', by: 'Pat', slackUserId: PAT, text: 'who moved first?', at: 0, doneAt: 1, status: 'answered', via: 'slack', reply: 'Acme.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.filter((p) => p.url.endsWith('chat.postMessage'))).toHaveLength(1);
  });
});
