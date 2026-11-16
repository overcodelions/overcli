import { describe, expect, it } from 'vitest';
import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';
import { repliesCallAllowed } from '../org/prReplies';

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

function harness(guard: boolean) {
  const answers: Array<[string, boolean]> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: () => ({ ok: true as const }),
    respondPermission: (_c: string, requestId: string, approved: boolean) => answers.push([requestId, approved]),
  };
  const rt = new FlowRuntimeImpl(runner as never, () => {}, () => [], () => ({ backends: {} }) as unknown as AppSettings);
  if (guard) rt.setCallGuard(repliesCallAllowed);
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
    const h = harness(true);
    h.ask('comment', POST, { path: `${PR}/comments`, body: { content: { raw: 'Fixed in abc123.' } } });
    h.ask('reply', POST, { path: `${PR}/comments`, body: { parent: { id: 9 }, content: { raw: 'Fixed.' } } });
    h.ask('read', GET, { path: `${PR}/comments` });
    const note = h.ask('approve', POST, { path: `${PR}/approve` });
    h.ask('merge', POST, { path: `${PR}/merge` });
    h.ask('decline', POST, { path: `${PR}/decline` });
    h.ask('sneak', POST, { path: `${PR}/comments/../merge` });
    expect(h.answers).toEqual([
      ['comment', true],
      ['reply', true],
      ['read', true],
      ['approve', false],
      ['merge', false],
      ['decline', false],
      ['sneak', false],
    ]);
    expect(note).toBe(`Denied automatically: this step may use ${POST} only to post a pull request comment.`);
  });

  it('without a guard, leaves the grant to decide as before', () => {
    const h = harness(false);
    h.ask('approve', POST, { path: `${PR}/approve` });
    expect(h.answers).toEqual([['approve', true]]);
  });
});
