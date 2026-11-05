import { describe, expect, it } from 'vitest';
import { FlowRuntimeImpl, pauseReasonBeforeStep, trialAllowsMcp } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'run-role' as UUID;

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
  const notes: string[] = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: (args: { permissionMode?: string; enabledTools?: string[]; mcpDeniedTools?: string[] }) => {
      sends.push({ permissionMode: args.permissionMode, enabledTools: args.enabledTools, mcpDeniedTools: args.mcpDeniedTools });
      return { ok: true as const };
    },
    respondPermission: (_c: string, requestId: string, approved: boolean, ...rest: unknown[]) => { answers.push([requestId, approved]); notes.push(String(rest[3] ?? '')); },
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
  return { rt, sends, answers, notes, ask };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const paused = { workerId: 'robin' as never, workerName: 'Robin', state: { kind: 'paused', nextStepId: 'triage', reason: 'needsInput' } as never };

describe('a worker’s role tools on its runs', () => {
  it('are allowed in a run that may use them, though no step lists them', async () => {
    const h = harness({ ...paused, roleTools: ['test-systems'], roleToolsCleared: true });
    expect(h.rt.resumeRun({ runId: RUN_ID }).ok).toBe(true);
    await flush();
    const note = h.ask('r-open', 'mcp__test-systems__open_system');
    h.ask('r-click', 'mcp__test-systems__browser_click');
    h.ask('r-other', 'mcp__acme-tracker__feature_update');
    expect(h.answers).toEqual([['r-open', true], ['r-click', true], ['r-other', false]]);
    expect(note).toBe('Allowed: a tool of its role, in a run that may use it.');
  });

  it('are refused, saying why, in a run that started on its own', async () => {
    const h = harness({ ...paused, roleTools: ['test-systems'] });
    h.rt.resumeRun({ runId: RUN_ID });
    await flush();
    h.ask('r-open', 'mcp__test-systems__open_system');
    h.ask('r-read', 'mcp__test-systems__list_systems');
    expect(h.answers).toEqual([['r-open', false], ['r-read', true]]);
    expect(h.notes[0]).toContain('one of this worker\'s role tools');
    expect(h.notes[0]).toContain('Always allow its role\'s tools');
  });

  it('change nothing for a run without a role', async () => {
    const h = harness({ ...paused });
    h.rt.resumeRun({ runId: RUN_ID });
    await flush();
    h.ask('r-open', 'mcp__test-systems__open_system');
    expect(h.answers).toEqual([['r-open', false]]);
    expect(h.notes[0]).toContain('not among the tools this work was given');
  });
});

describe('a worker’s messages through the server', () => {
  it('go in a run a person approved, and are refused in one that started on its own', async () => {
    const approved = harness({ ...paused, launchApproved: true });
    approved.rt.resumeRun({ runId: RUN_ID });
    await flush();
    const note = approved.ask('r-notify', 'mcp__overgo__notify');
    expect(approved.answers).toEqual([['r-notify', true]]);
    expect(note).toBe('Allowed: a message through the server, in a run that may send one.');

    const alone = harness({ ...paused });
    alone.rt.resumeRun({ runId: RUN_ID });
    await flush();
    alone.ask('r-notify', 'mcp__overgo__notify');
    expect(alone.answers).toEqual([['r-notify', false]]);
    expect(alone.notes[0]).toContain('Sending a message is an outside action');
  });
});


describe('a step that reaches outside only through its role’s tools', () => {
  const step = (tools: string[], extra: Record<string, unknown> = {}) =>
    ({ id: 'post-and-notify', role: 'implementer', tools, output: 'post_report.md', systemPromptOverride: 'Post the results as a comment on the Jira ticket.', ...extra }) as never;
  const run = (over: Record<string, unknown> = {}) => ({ workerId: 'robin', allowExternalActions: false, externalActionRunGrant: [], roleTools: ['atlassian', 'test-systems'], roleToolsCleared: true, ...over }) as never;

  it('starts without asking when every outside tool is its role’s, in a run that may use them', () => {
    expect(pauseReasonBeforeStep(run(), step(['Read', 'Write', 'mcp__atlassian__jira_add_comment', 'mcp__atlassian__jira_update_issue']))).toBeNull();
    expect(pauseReasonBeforeStep(run(), step(['mcp__test-systems__open_system', 'mcp__test-systems__browser_click']))).toBeNull();
  });

  it('still asks for the shell, a tool outside its role, a shipping step, or a run that may not use them', () => {
    expect(pauseReasonBeforeStep(run(), step(['mcp__atlassian__jira_add_comment', 'Bash(curl:*)']))).toBe('externalAction');
    expect(pauseReasonBeforeStep(run(), step(['mcp__zendesk__create_ticket']))).toBe('externalAction');
    expect(pauseReasonBeforeStep(run(), step(['mcp__atlassian__jira_add_comment'], { role: 'shipper' }))).toBe('externalAction');
    expect(pauseReasonBeforeStep(run({ roleToolsCleared: false }), step(['mcp__atlassian__jira_add_comment']))).toBe('externalAction');
    expect(pauseReasonBeforeStep(run({ roleTools: [] }), step(['mcp__atlassian__jira_add_comment']))).toBe('externalAction');
  });
});

describe('a test run', () => {
  const trial = { ...paused, trial: true, readsOnly: true };

  it('knows the app under test and tools that read from anything else', () => {
    expect(trialAllowsMcp('mcp__test-systems__browser_click')).toBe(true);
    expect(trialAllowsMcp('mcp__atlassian__getJiraIssue')).toBe(true);
    expect(trialAllowsMcp('mcp__atlassian__createJiraIssue')).toBe(false);
    expect(trialAllowsMcp('mcp__overgo__notify')).toBe(false);
    expect(trialAllowsMcp('mcp__atlassian')).toBe(false);
  });

  it('approves no outside write ahead, and asks about every call', async () => {
    const h = harness(trial);
    h.rt.resumeRun({ runId: RUN_ID });
    await flush();
    expect(h.sends[0].permissionMode).toBe('acceptEdits');
    expect(h.sends[0].enabledTools).toContain('mcp__atlassian__getJiraIssue');
    expect(h.sends[0].enabledTools).not.toContain('mcp__atlassian__createJiraIssue');
  });

  it('holds back writes and keeps them to show, whatever its worker is trusted with', async () => {
    for (const trust of [{}, { allowExternalActions: true }, { roleTools: ['atlassian'], roleToolsCleared: true, launchApproved: true }]) {
      const h = harness({ ...trial, ...trust });
      h.rt.resumeRun({ runId: RUN_ID });
      await flush();
      h.ask('write', 'mcp__atlassian__createJiraIssue');
      h.ask('message', 'mcp__overgo__notify');
      expect(h.answers).toEqual([['write', false], ['message', false]]);
      expect(h.notes[0]).toContain('this is a test run');
      const run = (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.get(RUN_ID)!;
      expect(run.trialHeld?.map((x) => x.tool)).toEqual(['mcp__atlassian__createJiraIssue', 'mcp__overgo__notify']);
    }
  });

  it('lets it read and use the app under test', async () => {
    const h = harness(trial);
    h.rt.resumeRun({ runId: RUN_ID });
    await flush();
    h.ask('read', 'mcp__atlassian__getJiraIssue');
    h.ask('app', 'mcp__test-systems__browser_click');
    expect(h.answers).toEqual([['read', true], ['app', true]]);
  });

  it('doesn’t stop for approval, since nothing outside can change', () => {
    const step = { id: 's', role: 'custom', tools: ['mcp__atlassian__createJiraIssue'], output: 'a.md', effect: 'external', pauseBefore: true } as never;
    const base = { workerId: 'w' as never, allowExternalActions: false, externalActionRunGrant: [] };
    expect(pauseReasonBeforeStep(base, step)).toBe('externalAction');
    expect(pauseReasonBeforeStep({ ...base, trial: true }, step)).toBeNull();
  });
});

