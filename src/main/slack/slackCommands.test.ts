import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import type { OrgService, HireSummary } from '../org/orgService';
import { HIRE_APPROVE_ACTION, HIRE_CONFIRM_ACTION, JOIN_LETIN_ACTION, PROPOSALS_APPROVE_ACTION, PROPOSALS_SKIP_ACTION, SlackCommands, TEAM_APPROVE_ACTION } from './slackCommands';
import type { AccessService } from '../org/accessService';

const TEAM = 'T0ACME';
const PAT = 'U0ACMEPAT';

function fakeSlack() {
  const posts: Array<{ url: string; body: any }> = [];
  let ts = 0;
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    posts.push({ url, body });
    const method = url.split('/').pop();
    const json =
      method === 'conversations.open'
        ? { ok: true, channel: { id: 'D0PAT' } }
        : method === 'chat.postMessage'
          ? { ok: true, channel: body.channel, ts: `200.${++ts}` }
          : { ok: true };
    return new Response(JSON.stringify(json));
  };
  return { posts, fetchImpl };
}

function harness(org: Partial<OrgService>, access?: Partial<AccessService>) {
  const slack = fakeSlack();
  const cmds = new SlackCommands({
    org: org as OrgService,
    ...(access ? { access: access as AccessService } : {}),
    policy: () => DEFAULT_ORG_POLICY,
    botToken: () => 'xoxb-test',
    teamId: () => TEAM,
    log: () => {},
    fetchImpl: slack.fetchImpl as never,
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
    const asked = posts.filter((p) => p.url.endsWith('chat.postMessage')).pop()!;
    expect(JSON.stringify(asked.body.blocks)).toContain('Which product area?');
    const threadTs = asked.body.thread_ts;

    const handled = await cmds.onThreadReply({ channel: 'D0PAT', thread_ts: threadTs, user: PAT, text: 'Checkout' }, TEAM);
    expect(handled).toBe(true);
    expect(drafts[1]).toMatchObject({ hireId: 'h1', answer: 'Checkout' });
    const offer = posts.filter((p) => p.url.endsWith('chat.postMessage')).pop()!;
    expect(JSON.stringify(offer.body.blocks)).toContain(HIRE_CONFIRM_ACTION);

    await cmds.onAction({
      user: { id: PAT, name: 'pat' },
      team: { id: TEAM },
      actions: [{ action_id: HIRE_CONFIRM_ACTION, value: 'h1' }],
      channel: { id: 'D0PAT' },
      message: { ts: offer.body.thread_ts },
    });
    const update = posts.find((p) => p.url.endsWith('chat.update'))!;
    expect(update.body.text).toMatch(/Hired Ana/);
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
