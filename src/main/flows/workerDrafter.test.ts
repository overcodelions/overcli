import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/types';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

vi.mock('../health', () => ({
  probeBackendHealth: vi.fn(async () => ({ kind: 'ready' })),
  healthyBackends: vi.fn(async () => new Set(['claude', 'codex', 'gemini', 'copilot', 'ollama'])),
}));

import { draftWorkerFromPrompt } from './workerDrafter';
import type { DraftDeps } from './drafter';

function claudeDeps(): DraftDeps {
  return {
    settings: {
      preferredBackend: 'claude',
      disabledBackends: {},
      backendPaths: {},
      claudeTransport: 'sdk',
    } as unknown as AppSettings,
    runner: {} as DraftDeps['runner'],
  };
}

function claudeStream(text: string) {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    yield { type: 'result' };
  })();
}

const VALID_YAML = [
  'name: Sprint Report',
  'input: user_prompt',
  'steps:',
  '  - id: gather',
  '    model: { backend: claude, model: claude-sonnet-4-6 }',
  '    role: researcher',
  '    inputs: [user_prompt]',
  '    tools: [Read]',
  '    output: findings.md',
].join('\n');

/// The job description the user actually typed. The hire drafter paraphrases
/// it into `flowRequest`, and the paraphrase is where deliverable detail goes
/// missing — so these tests pin that the original text still reaches the flow
/// designer.
const JOB = [
  'Every Monday, report on two sprint boards. The team report should inspire the team —',
  'be visual, show trends. The PM report should be about process and todos, forward',
  'thinking for the next sprint.',
].join(' ');

function hireReply(flowRequest?: string): string {
  const contract: Record<string, unknown> = {
    name: 'Scribe',
    jobDescription: JOB,
    cadence: { kind: 'daily', time: '09:00', days: [1] },
    maxItemsPerShift: 1,
    budgetUSDPerMonth: 10,
    heartbeatModel: 'claude-haiku-4-5-20251001',
  };
  if (flowRequest) contract.flowRequest = flowRequest;
  return `Here is my read on the job.\n\n<worker>\n${JSON.stringify(contract)}\n</worker>`;
}

describe('draftWorkerFromPrompt', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("hands the flow designer the user's own words, not just the hire paraphrase", async () => {
    const paraphrase = 'A flow that reports on two Jira boards weekly.';
    mockQuery
      .mockReturnValueOnce(claudeStream(hireReply(paraphrase)))
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [] },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // The second turn is the flow draft. It must carry both the paraphrase
    // and the original — the paraphrase alone loses "visual", "trends", and
    // the two-audience split, and the flow gets designed without them.
    const flowPrompt = mockQuery.mock.calls[1][0].prompt as string;
    expect(flowPrompt).toContain(paraphrase);
    expect(flowPrompt).toContain(JOB);
    expect(flowPrompt).toContain("THE USER'S OWN DESCRIPTION OF THE JOB");
  });

  it('does not repeat the job description when the fallback already embeds it', async () => {
    // No flowRequest in the contract → flowRequestFromJob builds the request
    // out of the job description itself. Appending it again would hand the
    // designer the same text twice.
    mockQuery
      .mockReturnValueOnce(claudeStream(hireReply()))
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [] },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    const flowPrompt = mockQuery.mock.calls[1][0].prompt as string;
    expect(flowPrompt).toContain(JOB);
    expect(flowPrompt).not.toContain("THE USER'S OWN DESCRIPTION OF THE JOB");
    expect(flowPrompt.split(JOB).length - 1).toBe(1);
  });

  it('skips flow drafting entirely when the contract picks an existing flow', async () => {
    const contract = {
      name: 'Scribe',
      jobDescription: JOB,
      cadence: { kind: 'daily', time: '09:00', days: [1] },
      maxItemsPerShift: 1,
      budgetUSDPerMonth: 10,
      heartbeatModel: 'claude-haiku-4-5-20251001',
      flowId: 'existing-flow',
    };
    mockQuery.mockReturnValueOnce(
      claudeStream(`Reusing a flow.\n\n<worker>\n${JSON.stringify(contract)}\n</worker>`),
    );

    const result = await draftWorkerFromPrompt(
      {
        jobDescription: JOB,
        flows: [{ id: 'existing-flow', name: 'Existing Flow' }],
        projects: [],
      },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draftedFlow).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
