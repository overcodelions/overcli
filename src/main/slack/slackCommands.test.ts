import { describe, expect, it } from 'vitest';
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
