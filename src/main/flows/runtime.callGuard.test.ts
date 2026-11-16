import { describe, expect, it } from 'vitest';
import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';
import { prTargetsOf, repliesCallAllowed } from '../org/prReplies';
import type { Orchestration } from '../../shared/flows/orchestration';

const RUN_ID = 'run-guard' as UUID;
const POST = 'mcp__bitbucket__bb_post';
const GET = 'mcp__bitbucket__bb_get';

function flow(): Flow {
  return {
    id: 'org-pr-replies-bitbucket',
    name: 'Pull request replies',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'Sonnet', backend: 'claude', model: 'claude-sonnet-5-5', kind: 'primary' }],
    steps: [{ id: 'pr-replies', participantId: 'primary', role: 'custom', effect: 'external', inputs: ['user_prompt'], tools: [GET, POST], output: 'pr-replies.md' }],
    source: 'user',
    filePath: '/tmp/replies.yaml',
  };
}

/// The orchestrator's batches by id, as `orchestrator.get` would give them.
type Batches = Map<string, Pick<Orchestration, 'origin'>>;

/// A replies batch as workerEngine.followUp parks it: its pull requests in its origin.
const repliesBatch = (prTargets?: Array<{ owner: string; repo: string; number: number }>): Pick<Orchestration, 'origin'> => ({
  origin: { kind: 'worker', workerId: 'fixer' as UUID, workerName: 'Fixer', task: 'errand', followUp: 'replies', ...(prTargets ? { prTargets } : {}) },
});

function harness(batches: Batches | null) {
  const answers: Array<[string, boolean]> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: () => ({ ok: true as const }),
    respondPermission: (_c: string, requestId: string, approved: boolean) => answers.push([requestId, approved]),
  };
  const rt = new FlowRuntimeImpl(runner as never, () => {}, () => [], () => ({ backends: {} }) as unknown as AppSettings);
  // Wired as engines.ts wires it: the run's batch, looked up by id.
  if (batches) rt.setCallGuard((call) => repliesCallAllowed(call, (id) => prTargetsOf(batches.get(id))));
  const r: FlowRun = {
    id: RUN_ID,
    flowId: 'org-pr-replies-bitbucket',
    flowSnapshot: flow(),
    projectPath: '/tmp/does-not-matter',
    userPrompt: 'reply on PR 42',
    conversationIds: { primary: 'conv-1' as UUID },
    artifacts: {},
    state: { kind: 'running', currentStepId: 'pr-replies' } as never,
    createdAt: Date.now(),
    attempts: [],
    workerId: 'fixer' as UUID,
    workerName: 'Fixer',
    externalActionRunGrant: ['step:pr-replies'],
    parentOrchestrationId: 'orch-guard' as UUID,
  };
  (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  (rt as never as { convIdToRun: Map<string, UUID> }).convIdToRun.set('conv-1', RUN_ID);
  const ask = (requestId: string, toolName: string, input: unknown) => {
    const ev = { timestamp: Date.now(), kind: { type: 'permissionRequest', info: { requestId, toolName, description: '', toolInput: JSON.stringify(input) } } };
    (rt as never as { observeEvent: (e: MainToRendererEvent) => void }).observeEvent({ type: 'stream', conversationId: 'conv-1' as UUID, events: [ev as never] });
    return (ev.kind.info as { decisionNote?: string }).decisionNote;
  };
  return { answers, ask };
}

const PR = '/repositories/acme/web/pullrequests/42';

describe('the replies step’s generic POST', () => {
  it('posts a comment or a reply ahead, and sends approve, merge or decline to a person', () => {
    const h = harness(new Map([['orch-guard', repliesBatch([{ owner: 'acme', repo: 'web', number: 42 }])]]));
    h.ask('comment', POST, { path: `${PR}/comments`, body: { content: { raw: 'Fixed in abc123.' } } });
    h.ask('reply', POST, { path: `${PR}/comments`, body: { parent: { id: 9 }, content: { raw: 'Fixed.' } } });
    h.ask('read', GET, { path: `${PR}/comments` });
    const note = h.ask('approve', POST, { path: `${PR}/approve` });
    h.ask('merge', POST, { path: `${PR}/merge` });
    h.ask('decline', POST, { path: `${PR}/decline` });
    h.ask('sneak', POST, { path: `${PR}/comments/../merge` });
    h.ask('elsewhere', POST, { path: '/repositories/acme/web/pullrequests/43/comments' });
    expect(h.answers).toEqual([
      ['comment', true],
      ['reply', true],
      ['read', true],
      ['approve', false],
      ['merge', false],
      ['decline', false],
      ['sneak', false],
      ['elsewhere', false],
    ]);
    expect(note).toBe(`Denied automatically: this step may use ${POST} only to post a pull request comment.`);
  });

  it('still posts after a restart, from the batch as it was saved', () => {
    const before: Batches = new Map([['orch-guard', repliesBatch([{ owner: 'acme', repo: 'web', number: 42 }])]]);
    // What the store writes and reads back on boot (orchestrationsStore: JSON.stringify, JSON.parse).
    const reloaded: Batches = new Map(Object.entries(JSON.parse(JSON.stringify(Object.fromEntries(before))) as Record<string, Pick<Orchestration, 'origin'>>));
    // A new runtime and a new guard, with nothing carried over in memory.
    const h = harness(reloaded);
    h.ask('comment', POST, { path: `${PR}/comments`, body: { content: { raw: 'Fixed.' } } });
    h.ask('merge', POST, { path: `${PR}/merge` });
    expect(h.answers).toEqual([
      ['comment', true],
      ['merge', false],
    ]);
  });

  it('refuses every post when its batch saved no pull requests, or is gone', () => {
    for (const batches of [new Map([['orch-guard', repliesBatch()]]), new Map()] as Batches[]) {
      const h = harness(batches);
      h.ask('comment', POST, { path: `${PR}/comments` });
      h.ask('read', GET, { path: `${PR}/comments` });
      expect(h.answers).toEqual([
        ['comment', false],
        ['read', true],
      ]);
    }
  });

  it('without a guard, leaves the grant to decide as before', () => {
    const h = harness(null);
    h.ask('approve', POST, { path: `${PR}/approve` });
    expect(h.answers).toEqual([['approve', true]]);
  });
});
