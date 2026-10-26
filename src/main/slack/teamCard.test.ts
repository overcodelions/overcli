import { describe, expect, it } from 'vitest';
import type { TeamTask } from '../../shared/flows/team';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import type { OrgService } from '../org/orgService';
import { SlackCommands, type TeamCardRef } from './slackCommands';
import { TEAM_ACCEPT_ACTION, TEAM_PIECE_APPROVE_ACTION, bar, stageNote, teamCard, took } from './teamCard';

const T0 = 1_000_000;
const PAT = 'U0ACMEPAT';

function task(over: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    teamId: 'team-1',
    teamName: 'Roadmap <!channel> Council',
    brief: 'Review the roadmap',
    title: 'Acme Q1 roadmap review',
    requestedBy: { name: 'Pat', slackUserId: PAT },
    status: 'running',
    createdAt: T0,
    updatedAt: T0,
    stageIndex: 1,
    spentUSD: 10.5,
    budgetUSD: 1000,
    folder: '/data/team-files/t1',
    files: [],
    stages: [
      { kind: 'contribute', title: 'Gather the roadmap', status: 'done', startedAt: T0, finishedAt: T0 + 120_000, assignments: [{ workerId: 'w-forge', workerName: 'Forge', ask: 'x', status: 'done', file: 'a.md' }] },
      { kind: 'contribute', title: 'HTML roadmap report', status: 'running', assignments: [{ workerId: 'w-hugo', workerName: 'Hugo', ask: 'x', status: 'paused', runId: 'run-hugo' }] },
      { kind: 'contribute', title: 'Final pack', status: 'pending', assignments: [] },
    ],
    ...over,
  } as TeamTask;
}

describe('the team card', () => {
  const look = (runId: string) => (runId === 'run-hugo' ? { reaches: ['may change Jira (create issue)', 'runs shell commands'], last: { text: 'Read scores.md', at: T0 + 70 * 60_000 } } : null);

  it('leads with four facts, folds finished stages, and gives the current one its words and button', () => {
    const c = teamCard(task(), { now: T0 + 72 * 60_000, consoleUrl: 'https://overcli.acme.example', look });
    const json = JSON.stringify(c.blocks);
    expect(json).toContain('"*Progress*\\n▰▰▰▱▱▱▱▱▱▱  2 of 3"');
    expect(json).toContain('"*Needs you*\\n🟡 Hugo’s step"');
    expect(json).toContain('"*Spent*\\n$10.50 of $1,000"');
    expect(json).toContain('"*Running for*\\n1h 12m"');
    expect(json).toContain('✅  *Stage 1 done*\\nGather the roadmap');
    expect(json).toContain('🟡  *2 · HTML roadmap report*\\n*Hugo* wants to change Jira (create issue), run shell commands. Waiting for your OK.');
    expect(json).toContain('"value":"t1:run-hugo"');
    expect(json).toContain(TEAM_PIECE_APPROVE_ACTION);
    expect(json).toContain('Last: Read scores.md · 2m ago');
    expect(json).toContain('⚪  Next: 3 · Final pack');
    expect(json).toContain('https://overcli.acme.example/#teamtask/t1');
    expect(json).not.toContain('⬜');
    // A header is plain text, which Slack never reads as a mention; the rest
    // is markup, and escaped.
    expect(JSON.stringify(c.blocks.slice(1))).not.toContain('<!channel>');
  });

  it('turns green when done: what it came to, then the summary', () => {
    const done = task({ status: 'done', finishedAt: T0 + 3_600_000, stageIndex: 3, pack: { summary: 'Ship the partner AI bundle first.', files: ['report.html', 'scores.md'] }, stages: task().stages.map((s) => ({ ...s, status: 'done', assignments: s.assignments.map((a) => ({ ...a, status: 'done' })) })) });
    const json = JSON.stringify(teamCard(done, { now: T0 + 4_000_000 }).blocks);
    expect(json).toContain('✅  Roadmap');
    expect(json).toContain('"*Done*\\n▰▰▰▰▰▰▰▰▰▰  3 of 3"');
    expect(json).toContain('"*Took*\\n1h 0m"');
    expect(json).toContain('"*Files*\\nreport.html and 1 more"');
    expect(json).toContain('Ship the partner AI bundle first.');
    expect(json).not.toContain('Next:');
  });

  it('shows a pack held for review as finished, with Accept', () => {
    const review = task({ status: 'review', stageIndex: 3, pack: { summary: '**Verdict:** a catch-up quarter.', files: ['pack/report.html'] }, stages: task().stages.map((s) => ({ ...s, status: 'done' })) });
    const json = JSON.stringify(teamCard(review, { now: T0 + 60_000 }).blocks);
    expect(json).toContain('"*Ready for your review*\\n▰▰▰▰▰▰▰▰▰▰  3 of 3"');
    expect(json).toContain('*Verdict:* a catch-up quarter.');
    expect(json).toContain(TEAM_ACCEPT_ACTION);
    expect(json).not.toContain('Next:');
  });

  it('says how long, how far and what a stage came to in a few words', () => {
    expect(took(40_000)).toBe('40s');
    expect(took(4 * 60_000)).toBe('4m');
    expect(bar(0, 3)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(stageNote(task(), 0)).toBe('✅ Stage done · *1. Gather the roadmap* · Forge · 1 file, 2m');
  });
});

describe('the card in Slack', () => {
  function setup() {
    const calls: Array<{ method: string; body: any }> = [];
    let now = T0;
    let ts = 0;
    let stored: Record<string, TeamCardRef> = {};
    const decided: unknown[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const method = url.split('/').pop()!;
      const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      const json = method === 'conversations.open' ? { ok: true, channel: { id: 'D0PAT' } } : method === 'chat.postMessage' ? { ok: true, channel: 'D0PAT', ts: `400.${++ts}` } : { ok: true };
      return new Response(JSON.stringify(json));
    };
    const cmds = new SlackCommands({
      org: { decideRun: (...a: unknown[]) => (decided.push(a), { ok: true }), decideTeamTask: () => ({ ok: true }) } as unknown as OrgService,
      policy: () => DEFAULT_ORG_POLICY,
      botToken: () => 'xoxb-test',
      teamId: () => 'T0ACME',
      log: () => {},
      fetchImpl: fetchImpl as never,
      now: () => now,
      teamCards: { load: () => stored, save: (all) => (stored = structuredClone(all)) },
      teamFile: (_t, name) => (name === 'pack/report.html' ? Buffer.from('<html>report</html>') : null),
    });
    const settle = () => new Promise((r) => setTimeout(r, 10));
    return { cmds, calls, settle, decided, later: (ms: number) => (now += ms), stored: () => stored };
  }

  it('posts the card once, then edits it and tells the thread each stage that ends', async () => {
    const s = setup();
    const first = task({ stageIndex: 0, stages: task().stages.map((x, i) => (i === 0 ? { ...x, status: 'running' as const } : x)) });
    s.cmds.onEvent({ type: 'teamTaskUpdate', task: first });
    await s.settle();
    expect(s.calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(s.stored().t1).toMatchObject({ channel: 'D0PAT', ts: '400.1', told: 0 });

    s.later(5000);
    s.cmds.onEvent({ type: 'teamTaskUpdate', task: task({ updatedAt: T0 + 5000 }) });
    await s.settle();
    expect(s.calls.filter((c) => c.method === 'chat.update')).toHaveLength(1);
    const notes = s.calls.filter((c) => c.method === 'chat.postMessage').slice(1);
    expect(notes.map((c) => [c.body.thread_ts, c.body.text])).toEqual([['400.1', '✅ Stage done · *1. Gather the roadmap* · Forge · 1 file, 2m']]);
    expect(s.stored().t1.told).toBe(1);
  });

  it('attaches the pack once, when it is held for review and again when accepted', async () => {
    const s = setup();
    const review = task({ status: 'review', stageIndex: 3, pack: { summary: 'Done.', files: ['pack/report.html', 'pack/notes.txt'] }, stages: task().stages.map((x) => ({ ...x, status: 'done' })) });
    s.cmds.onEvent({ type: 'teamTaskUpdate', task: review });
    await s.settle();
    s.later(5000);
    s.cmds.onEvent({ type: 'teamTaskUpdate', task: { ...review, status: 'done', updatedAt: T0 + 5000 } });
    await s.settle();
    const asked = s.calls.filter((c) => c.method === 'files.getUploadURLExternal');
    expect(asked).toHaveLength(1);
    expect(s.stored().t1).toMatchObject({ attached: true, done: true });
  });

  it('says a pack is ready for review as a reply shown in the conversation, with Accept', async () => {
    const s = setup();
    s.cmds.onEvent({ type: 'teamTaskUpdate', task: task() });
    await s.settle();
    s.later(5000);
    const review = task({ status: 'review', stageIndex: 3, updatedAt: T0 + 5000, pack: { summary: '**Verdict:** go.', files: ['pack/report.html'] }, stages: task().stages.map((x) => ({ ...x, status: 'done' })) });
    s.cmds.onEvent({ type: 'teamTaskUpdate', task: review });
    await s.settle();
    const notice = s.calls.find((c) => c.method === 'chat.postMessage' && c.body.reply_broadcast);
    expect(notice?.body).toMatchObject({ thread_ts: '400.1', reply_broadcast: true });
    expect(JSON.stringify(notice?.body.blocks)).toContain(TEAM_ACCEPT_ACTION);
    expect(JSON.stringify(notice?.body.blocks)).toContain('*Verdict:* go.');
  });

  it('takes the Accept button away once it is pressed, in the thread and the conversation alike', async () => {
    const s = setup();
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Holding it for your review.' } }, { type: 'actions', elements: [{ type: 'button', action_id: TEAM_ACCEPT_ACTION, value: 't1' }] }];
    await s.cmds.onAction({ user: { id: PAT }, team: { id: 'T0ACME' }, actions: [{ action_id: TEAM_ACCEPT_ACTION, value: 't1' }], channel: { id: 'D0PAT' }, message: { ts: '400.9', thread_ts: '400.1', blocks } });
    const update = s.calls.find((c) => c.method === 'chat.update');
    expect(update?.body).toMatchObject({ channel: 'D0PAT', ts: '400.9' });
    const json = JSON.stringify(update?.body.blocks);
    expect(json).not.toContain(TEAM_ACCEPT_ACTION);
    expect(json).toContain('Holding it for your review.');
    expect(json).toMatch(/Accepted by <@|Already accepted/);
  });

  it('approves a waiting piece from the card', async () => {
    const s = setup();
    await s.cmds.onAction({ user: { id: PAT }, team: { id: 'T0ACME' }, actions: [{ action_id: TEAM_PIECE_APPROVE_ACTION, value: 't1:run-hugo' }], channel: { id: 'D0PAT' }, message: { ts: '400.1' } });
    expect(s.decided).toEqual([[expect.objectContaining({ slackUserId: PAT }), 'run-hugo', true]]);
  });
});
