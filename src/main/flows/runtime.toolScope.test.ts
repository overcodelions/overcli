import { describe, expect, it } from 'vitest';
import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'run-scope' as UUID;

function flow(): Flow {
  return {
    id: 'tracker-flow',
    name: 'Tracker flow',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'Opus', backend: 'claude', model: 'claude-opus-5', kind: 'primary' }],
    steps: [
      {
        id: 'triage',
        participantId: 'primary',
        role: 'implementer',
        inputs: ['user_prompt'],
        tools: ['Read', 'mcp__atlassian__getJiraIssue', 'mcp__atlassian__createJiraIssue'],
        output: 'triage.md',
      },
    ],
    source: 'user',
    filePath: '/tmp/tracker.yaml',
  };
}

function harness(run: Partial<FlowRun>) {
  const sends: Array<{ permissionMode?: string; enabledTools?: string[]; mcpDeniedTools?: string[] }> = [];
  const answers: Array<[string, boolean]> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: (args: { permissionMode?: string; enabledTools?: string[]; mcpDeniedTools?: string[] }) => {
      sends.push({ permissionMode: args.permissionMode, enabledTools: args.enabledTools, mcpDeniedTools: args.mcpDeniedTools });
      return { ok: true as const };
    },
    respondPermission: (_c: string, requestId: string, approved: boolean) => answers.push([requestId, approved]),
  };
  const rt = new FlowRuntimeImpl(runner as never, () => {}, () => [], () => ({ backends: {} }) as unknown as AppSettings);
  rt.setToolScopes((id) => (id === 'forge' ? { atlassian: { mode: 'read' } } : undefined));
  const r: FlowRun = {
    id: RUN_ID,
    flowId: 'tracker-flow',
    flowSnapshot: flow(),
    projectPath: '/tmp/does-not-matter',
    userPrompt: 'triage the backlog',
    conversationIds: { primary: 'conv-1' as UUID },
    artifacts: {},
    state: { kind: 'paused', nextStepId: 'triage', reason: 'externalAction' },
    createdAt: Date.now(),
    attempts: [],
    workerId: 'forge' as UUID,
    workerName: 'Forge',
    ...run,
  };
  (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  const ask = (requestId: string, toolName: string) => {
    const ev = { timestamp: Date.now(), kind: { type: 'permissionRequest', info: { requestId, toolName, description: '', toolInput: '' } } };
    (rt as never as { observeEvent: (e: MainToRendererEvent) => void }).observeEvent({ type: 'stream', conversationId: 'conv-1' as UUID, events: [ev as never] });
    return (ev.kind.info as { decisionNote?: string }).decisionNote;
  };
  return { rt, sends, answers, ask };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('a worker’s tool scope on its runs', () => {
  it('holds for a worker trusted to act: no pre-approved writes, the approval check kept, writes refused', async () => {
    const h = harness({ allowExternalActions: true });
    expect(h.rt.resumeRun({ runId: RUN_ID }).ok).toBe(true);
    await flush();
    // Without the scope this worker would run with every prompt off.
    expect(h.sends[0].permissionMode).toBe('acceptEdits');
    expect(h.sends[0].enabledTools).toEqual(['Read', 'mcp__atlassian__getJiraIssue']);

    const note = h.ask('r-write', 'mcp__atlassian__createJiraIssue');
    h.ask('r-read', 'mcp__atlassian__searchJiraIssuesUsingJql');
    h.ask('r-shell', 'Bash');
    expect(h.answers).toEqual([['r-write', false], ['r-read', true], ['r-shell', true]]);
    expect(note).toBe('Refused: Forge may use atlassian read only, and createJiraIssue is outside that.');
  });

  it('refuses an out-of-scope call even on a step its manager approved', async () => {
    const h = harness({});
    h.rt.resumeRun({ runId: RUN_ID });
    await flush();
    h.ask('r-write', 'mcp__atlassian__createJiraIssue');
    h.ask('r-shell', 'Bash');
    // The approval covers the step, not the scope.
    expect(h.answers).toEqual([['r-write', false], ['r-shell', true]]);
  });

  it('lets a worker without the grant read its tools, and still refuses writes and other calls', async () => {
    const h = harness({ workerId: 'lena' as never, workerName: 'Lena', state: { kind: 'paused', nextStepId: 'triage', reason: 'needsInput' } as never });
    expect(h.rt.resumeRun({ runId: RUN_ID }).ok).toBe(true);
    await flush();
    const note = h.ask('r-read', 'mcp__acme-tracker__release_timeline');
    h.ask('r-write', 'mcp__acme-tracker__feature_update');
    h.ask('r-shell', 'Bash');
    expect(h.answers).toEqual([['r-read', true], ['r-write', false], ['r-shell', false]]);
    expect(note).toBe('Allowed: a tool call that only reads.');
  });
});
