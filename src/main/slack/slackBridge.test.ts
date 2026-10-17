import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION, SlackBridge, type SlackBridgeDeps } from './slackBridge';
import type { SocketCtor, SocketLike } from './socketMode';
import type { SlackThread } from './threadStore';

const MANAGER = 'U0ACME01';
const TEAM = 'T0ACME';

function fakeSlack() {
  const calls: Array<{ method: string; body: any }> = [];
  let ts = 0;
  const fetchImpl = async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ method, body });
    const json: Record<string, unknown> =
      method === 'auth.test'
        ? { ok: true, team_id: TEAM, team: 'Acme', user_id: 'U0BOT' }
        : method === 'apps.connections.open'
          ? { ok: true, url: 'wss://acme.example/socket' }
          : method === 'conversations.open'
            ? { ok: true, channel: { id: 'D0ACME' } }
            : method === 'chat.postMessage'
              ? { ok: true, channel: body.channel, ts: `100.${++ts}` }
              : { ok: true };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  return { calls, fetchImpl };
}

class FakeSocket implements SocketLike {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w-ana',
    name: 'Ana',
    jobDescription: 'Writes the weekly product summary.',
    projectPath: '/repo',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 10,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    manager: { name: 'Pat', slackUserId: MANAGER },
    ...over,
  };
}

function pausedRun(reason: 'needsInput' | 'externalAction', over: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run-1',
    workerId: 'w-ana',
    workerName: 'Ana',
    userPrompt: 'Summarize the week',
    projectPath: '/repo',
    flowSnapshot: { name: 'Weekly', steps: [{ id: 'write', role: 'custom', inputs: [], output: 'summary.md' }] },
    artifacts: {},
    state: { kind: 'paused', nextStepId: 'write', reason },
    workerExchanges:
      reason === 'needsInput'
        ? [{ id: 'x1', stepId: 'write', participantId: 'p', askedAt: 1, question: 'Which segment is enterprise?', status: 'escalated', note: 'Ana: not in my notes' }]
        : [],
    ...over,
  } as unknown as FlowRun;
}

function harness(opts: { runs?: FlowRun[]; workers?: Worker[] } = {}) {
  const slack = fakeSlack();
  const runs = new Map((opts.runs ?? []).map((r) => [r.id, r]));
  let saved: SlackThread[] = [];
  const steers: Array<{ runId: string; text: string }> = [];
  const resumed: string[] = [];
  const rejected: string[] = [];
  const deps: SlackBridgeDeps = {
    tokens: () => ({ bot: 'xoxb-test', app: 'xapp-test' }),
    workers: () => opts.workers ?? [worker()],
    getRun: (id) => runs.get(id) ?? null,
    listRuns: () => [...runs.values()],
    steerRun: (a) => {
      steers.push(a);
      return { ok: true };
    },
    resumeRun: (a) => {
      resumed.push(a.runId);
      const r = runs.get(a.runId);
      if (r) r.state = { kind: 'running', currentStepId: 'write' };
      return { ok: true };
    },
    rejectRun: (id) => {
      rejected.push(id);
      return { ok: true };
    },
    store: { list: () => saved, save: (t) => (saved = structuredClone(t)) },
    log: () => {},
    fetchImpl: slack.fetchImpl as never,
    WebSocketCtor: FakeSocket as unknown as SocketCtor,
  };
  const bridge = new SlackBridge(deps);
  return { bridge, slack, runs, steers, resumed, rejected, saved: () => saved };
}

const reply = (text: string, over: Record<string, unknown> = {}) => ({
  type: 'events_api',
  envelope_id: 'e1',
  payload: {
    team_id: TEAM,
    event: { type: 'message', channel_type: 'im', channel: 'D0ACME', user: MANAGER, thread_ts: '100.1', text, ...over },
  },
});

describe('SlackBridge outbound', () => {
  it('DMs the manager as the worker when a run needs input', async () => {
    const h = harness({ runs: [pausedRun('needsInput')] });
    await h.bridge.start();
    const post = h.slack.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.body.channel).toBe('D0ACME');
    expect(post.body.username).toBe('Ana');
    expect(JSON.stringify(post.body.blocks)).toContain('Which segment is enterprise?');
    expect(h.saved()).toHaveLength(1);
    expect(h.saved()[0]).toMatchObject({ kind: 'question', runId: 'run-1', exchangeId: 'x1' });
  });

  it('posts once per pause, however many updates arrive', async () => {
    const run = pausedRun('needsInput');
    const h = harness({ runs: [run] });
    await h.bridge.start();
    await Promise.all([h.bridge.onRunUpdate(run), h.bridge.onRunUpdate(run)]);
    expect(h.slack.calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
  });

  it('says nothing for a worker with no Slack manager anywhere up the chain', async () => {
    const h = harness({ runs: [pausedRun('needsInput')], workers: [worker({ manager: undefined })] });
    await h.bridge.start();
    expect(h.slack.calls.some((c) => c.method === 'chat.postMessage')).toBe(false);
  });

  it('reaches the boss worker\'s manager when the owner has none', async () => {
    const h = harness({
      runs: [pausedRun('needsInput')],
      workers: [worker({ manager: undefined, reportsTo: 'w-chief' }), worker({ id: 'w-chief', name: 'Clara' })],
    });
    await h.bridge.start();
    expect(h.slack.calls.find((c) => c.method === 'conversations.open')!.body.users).toBe(MANAGER);
  });

  it('escapes run text so it cannot ping a channel', async () => {
    const run = pausedRun('needsInput');
    run.workerExchanges![0].question = 'Tell <!channel> about it';
    const h = harness({ runs: [run] });
    await h.bridge.start();
    const post = h.slack.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(JSON.stringify(post.body.blocks)).not.toContain('<!channel>');
  });

  it('closes the thread when the question is answered at the desk', async () => {
    const run = pausedRun('needsInput');
    const h = harness({ runs: [run] });
    await h.bridge.start();
    run.state = { kind: 'running', currentStepId: 'write' };
    await h.bridge.onRunUpdate(run);
    expect(h.saved()[0].resolution).toBe('elsewhere');
    const last = h.slack.calls.filter((c) => c.method === 'chat.postMessage').pop()!;
    expect(last.body.thread_ts).toBe('100.1');
  });
});

describe('SlackBridge inbound', () => {
  it('turns the manager\'s thread reply into a steer and a resume', async () => {
    const h = harness({ runs: [pausedRun('needsInput')] });
    await h.bridge.start();
    await h.bridge.onEnvelope(reply('Over 500 seats.'));
    expect(h.steers[0]).toMatchObject({ runId: 'run-1' });
    expect(h.steers[0].text).toContain('Over 500 seats.');
    expect(h.resumed).toEqual(['run-1']);
    expect(h.saved()[0].resolution).toBe('answered');
  });

  it('ignores anyone who is not the manager', async () => {
    const h = harness({ runs: [pausedRun('needsInput')] });
    await h.bridge.start();
    await h.bridge.onEnvelope(reply('do something else', { user: 'U0INTRUDER' }));
    expect(h.steers).toEqual([]);
  });

  it('ignores another workspace, bots and edits', async () => {
    const h = harness({ runs: [pausedRun('needsInput')] });
    await h.bridge.start();
    await h.bridge.onEnvelope({ ...reply('x'), payload: { ...reply('x').payload, team_id: 'T0OTHER' } });
    await h.bridge.onEnvelope(reply('x', { bot_id: 'B1' }));
    await h.bridge.onEnvelope(reply('x', { subtype: 'message_changed' }));
    expect(h.steers).toEqual([]);
  });

  it('approves from the button', async () => {
    const h = harness({ runs: [pausedRun('externalAction')] });
    await h.bridge.start();
    const id = h.saved()[0].id;
    await h.bridge.onEnvelope({
      type: 'interactive',
      envelope_id: 'e2',
      payload: { type: 'block_actions', user: { id: MANAGER }, team: { id: TEAM }, actions: [{ action_id: SLACK_APPROVE_ACTION, value: id }] },
    });
    expect(h.resumed).toEqual(['run-1']);
    expect(h.saved()[0].resolution).toBe('approved');
    expect(h.slack.calls.some((c) => c.method === 'chat.update')).toBe(true);
  });

  it('rejects from the button, and only for the manager', async () => {
    const h = harness({ runs: [pausedRun('externalAction')] });
    await h.bridge.start();
    const id = h.saved()[0].id;
    const press = (user: string) =>
      h.bridge.onEnvelope({
        type: 'interactive',
        envelope_id: 'e3',
        payload: { type: 'block_actions', user: { id: user }, team: { id: TEAM }, actions: [{ action_id: SLACK_REJECT_ACTION, value: id }] },
      });
    await press('U0INTRUDER');
    expect(h.rejected).toEqual([]);
    await press(MANAGER);
    expect(h.rejected).toEqual(['run-1']);
  });

  it('does not treat a reply on an approval as approval', async () => {
    const h = harness({ runs: [pausedRun('externalAction')] });
    await h.bridge.start();
    await h.bridge.onEnvelope(reply('yes go ahead'));
    expect(h.resumed).toEqual([]);
    expect(h.steers).toEqual([]);
  });

  it('acks every envelope on the socket', async () => {
    const h = harness();
    await h.bridge.start();
    await new Promise((r) => setTimeout(r, 0));
    const socket = FakeSocket.last!;
    socket.onmessage!({ data: JSON.stringify({ type: 'hello' }) });
    socket.onmessage!({ data: JSON.stringify(reply('hi')) });
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'e1' })]);
    expect(h.bridge.getStatus().connected).toBe(true);
  });
});
