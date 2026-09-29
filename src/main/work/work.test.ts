import { describe, expect, it } from 'vitest';

import { extractUserPrompt } from './promptIndex';
import { askFromStepPrompt, workLogEntryFor } from './workLog';
import { stepLabelFromPrompt } from './runTranscript';
import type { FlowRun } from '../../shared/flows/schema';

describe('extractUserPrompt', () => {
  it('reads a typed prompt with its cwd and time', () => {
    const line = JSON.stringify({
      type: 'user',
      cwd: '/code/acme',
      timestamp: '2026-09-24T10:00:00Z',
      message: { role: 'user', content: 'we need an MCP for developers' },
    });
    expect(extractUserPrompt(line)).toEqual({
      text: 'we need an MCP for developers',
      cwd: '/code/acme',
      at: Date.parse('2026-09-24T10:00:00Z'),
    });
  });

  it('joins text blocks and ignores tool results, meta lines and command wrappers', () => {
    const blocks = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } });
    expect(extractUserPrompt(blocks)?.text).toBe('a\nb');
    const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } });
    expect(extractUserPrompt(tool)).toBeNull();
    expect(extractUserPrompt(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } }))).toBeNull();
    expect(extractUserPrompt(JSON.stringify({ type: 'user', message: { content: '<command-name>/x</command-name>' } }))).toBeNull();
    expect(extractUserPrompt(JSON.stringify({ type: 'assistant', message: { content: 'x' } }))).toBeNull();
    expect(extractUserPrompt('not json "type":"user"')).toBeNull();
  });
});

describe('askFromStepPrompt', () => {
  it('pulls the ask out of a flow step banner', () => {
    expect(
      askFromStepPrompt(
        '[Attached file: /tmp/spec.md (SPEC.md)]  Overcli · Plan + Build · plan (planner) — Reveiw this spec - we need an MCP for deveopers. cust…  You are the PLANNER',
      ),
    ).toBe('Reveiw this spec - we need an MCP for deveopers. cust');
  });

  it('returns a plain prompt unchanged', () => {
    expect(askFromStepPrompt('just do the thing')).toBe('just do the thing');
  });
});

describe('workLogEntryFor', () => {
  const base = {
    id: 'r1',
    flowId: 'f',
    flowSnapshot: { name: 'Ticket → PR' },
    projectPath: '/wt/acme/x',
    sourceProjectPath: '/code/acme',
    worktreePath: '/wt/acme/x',
    userPrompt: 'Build the developer MCP\nwith details',
    conversationIds: {},
    artifacts: {},
    createdAt: 1,
    attempts: [{ stepId: 's', startedAt: 2, endedAt: 3 }],
    branchName: 'feat/developer-mcp',
    digest: { headline: 'MCP server shipped' },
  };

  it('logs a finished run with its ask, branch, owner and transcript cwd', () => {
    const e = workLogEntryFor({ ...base, state: { kind: 'done' } } as unknown as FlowRun);
    expect(e).toMatchObject({
      runId: 'r1',
      title: 'Build the developer MCP',
      ownerPath: '/code/acme',
      cwd: '/wt/acme/x',
      branchName: 'feat/developer-mcp',
      headline: 'MCP server shipped',
      at: 3,
      outcome: 'done',
    });
  });

  it('skips runs that are still going and marks aborted ones failed', () => {
    expect(workLogEntryFor({ ...base, state: { kind: 'running', currentStepId: 's' } } as unknown as FlowRun)).toBeNull();
    expect(workLogEntryFor({ ...base, state: { kind: 'aborted' } } as unknown as FlowRun)?.outcome).toBe('failed');
  });
});

describe('stepLabelFromPrompt', () => {
  it('names a step from the runtime banner', () => {
    expect(stepLabelFromPrompt('Overcli · Plan + Build · plan (planner) — Review this spec…  You are')).toBe('plan (planner)');
    expect(stepLabelFromPrompt('[Attached file: /a.md (A.md)]  Overcli · F · refactor (implementer) — x')).toBe('refactor (implementer)');
    expect(stepLabelFromPrompt('just a chat')).toBeNull();
  });
});
