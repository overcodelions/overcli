import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/types';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));
const { mockLog } = vi.hoisted(() => ({ mockLog: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

vi.mock('../health', () => ({
  probeBackendHealth: vi.fn(async () => ({ kind: 'ready' })),
  healthyBackends: vi.fn(async () => new Set(['claude', 'codex', 'gemini', 'copilot', 'ollama'])),
}));
vi.mock('../diagnostics', () => ({ log: mockLog }));

import { draftWorkerFromPrompt, reviseWorkerFromPrompt } from './workerDrafter';
import type { DraftDeps } from './drafter';

function claudeDeps(backend: 'claude' | 'copilot' | 'gemini' | 'codex' = 'claude', reply = ''): DraftDeps {
  return {
    settings: {
      preferredBackend: backend,
      disabledBackends: {},
      backendPaths: {},
      claudeTransport: backend === 'claude' ? 'sdk' : 'cli',
    } as unknown as AppSettings,
    runner: { oneShot: vi.fn(async () => ({ ok: true, text: reply })) } as unknown as DraftDeps['runner'],
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
    mockLog.mockReset();
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

  it('says why the hire came back without a flow instead of dropping it', async () => {
    // The flow half failed; the contract half is still reviewable. Silently
    // returning it left the review screen on an empty flow picker with no
    // explanation of what went wrong.
    mockQuery
      .mockReturnValueOnce(claudeStream(hireReply('A weekly sprint report flow.')))
      .mockReturnValueOnce(claudeStream('sorry, I cannot write that'));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [] },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draftedFlow).toBeUndefined();
      expect(result.contract.name).toBe('Scribe');
      expect(result.flowError).toMatch(/unparseable YAML|validation/i);
    }
    expect(mockLog).toHaveBeenCalledWith(
      'warn',
      'workers.hire',
      expect.stringContaining('Flow draft for worker "Scribe" failed'),
    );
  });

  it('reports Claude authentication output directly', async () => {
    mockQuery.mockReturnValueOnce(claudeStream('Not logged in · Please run /login'));
    const result = await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not signed in') });
    expect(result).not.toEqual({ ok: false, error: expect.stringContaining('no parseable worker contract') });
  });

  it('does not mistake /auth in a valid worker contract for sign-out', async () => {
    const deps = claudeDeps(
      'gemini',
      hireReply('Use /auth as the endpoint in the requested flow.'),
    );
    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [] },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['copilot', 'Copilot login required'],
    ['gemini', 'Select an auth method at /auth'],
    ['codex', 'Authentication required: run codex login'],
  ] as const)('reports %s authentication output directly', async (backend, reply) => {
    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [] },
      claudeDeps(backend, reply),
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not signed in') });
    expect(result).not.toEqual({ ok: false, error: expect.stringContaining('no parseable worker contract') });
  });

  it('logs and returns a normalized bounded excerpt for malformed output', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(`bad\n\t${'x'.repeat(600)}`));
    const result = await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`Reply: bad ${'x'.repeat(496)}`);
    expect(mockLog).toHaveBeenCalledWith('warn', 'workers.hire', expect.stringContaining('Reply: bad '));
  });

  it('puts a syntactically valid worker example in the system prompt', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(hireReply('existing-flow')));
    await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [{ id: 'existing-flow', name: 'Existing' }], projects: [] },
      claudeDeps(),
    );
    const prompt = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    const block = prompt.match(/<worker>\n([\s\S]*?)\n<\/worker>/)?.[1];
    expect(block).toBeTruthy();
    expect(() => JSON.parse(block!)).not.toThrow();
  });
});

describe('reviseWorkerFromPrompt', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLog.mockReset();
  });

  function revisionReply(flowInstruction: string): string {
    return [
      'Adding the execution half.',
      '',
      '<revision>',
      JSON.stringify({ jobDescription: null, flowInstruction }),
      '</revision>',
    ].join('\n');
  }

  it('drafts a flow from scratch when the worker has none yet', async () => {
    // The recovery path for a hire whose flow draft failed: the AI box is
    // the only way back to a flow, so a flow instruction with no existing
    // flow must reach the DESIGNER rather than being dropped.
    mockQuery
      .mockReturnValueOnce(claudeStream(revisionReply('Gather the sprint data, then write it up.')))
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    const result = await reviseWorkerFromPrompt(
      { jobDescription: JOB, instruction: 'give this worker a flow' },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow?.name).toBe('Sprint Report');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0].prompt as string).toContain('Gather the sprint data');
  });

  it('tells the reviser that a flowInstruction designs a whole flow when there is none', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(revisionReply('Add a review step.')));
    mockQuery.mockReturnValueOnce(claudeStream(VALID_YAML));

    await reviseWorkerFromPrompt(
      { jobDescription: JOB, instruction: 'add a review step' },
      claudeDeps(),
    );

    expect(mockQuery.mock.calls[0][0].prompt as string).toContain('NO FLOW yet');
  });

  it('keeps the revision usable when the from-scratch flow draft fails', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(revisionReply('Write the sprint report.')))
      .mockReturnValueOnce(claudeStream('nope'));

    const result = await reviseWorkerFromPrompt(
      { jobDescription: JOB, instruction: 'give this worker a flow' },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow).toBeUndefined();
      expect(result.note).toContain('could not be drafted automatically');
      expect(result.note).toContain('Write the sprint report.');
    }
    expect(mockLog).toHaveBeenCalledWith(
      'warn',
      'workers.revise',
      expect.stringContaining('New flow draft failed'),
    );
  });
});

/// Files the user attached ride BOTH turns of a hire, and take the runner
/// path even when the SDK transport is on — the SDK call sends a plain string
/// prompt with nowhere to put them, so taking it would drop them silently.
describe('attachments', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLog.mockReset();
  });

  const SPEC = {
    id: 'a1',
    mimeType: 'application/pdf',
    dataBase64: 'x',
    label: 'spec.pdf',
  };

  it('sends a hire attachment to the contract turn and the flow draft', async () => {
    const deps = claudeDeps();
    const oneShot = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: hireReply('A weekly report flow.') })
      .mockResolvedValueOnce({ ok: true, text: VALID_YAML });
    deps.runner = { oneShot } as unknown as DraftDeps['runner'];

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], attachments: [SPEC] },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled(); // never the SDK path
    expect(oneShot).toHaveBeenCalledTimes(2);
    expect(oneShot.mock.calls[0][0].attachments).toEqual([SPEC]);
    expect(oneShot.mock.calls[1][0].attachments).toEqual([SPEC]);
    // Named in the prompt too, so the model treats them as source material
    // rather than as stray files it happened to be handed.
    expect(oneShot.mock.calls[0][0].prompt).toContain('spec.pdf');
  });

  it('sends a revision attachment to the routing turn and the flow edit', async () => {
    const deps = claudeDeps();
    const revision = JSON.stringify({
      jobDescription: null,
      flowInstruction: 'Format the report like the attached example.',
    });
    const oneShot = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: `Changed the flow.\n<revision>${revision}</revision>` })
      .mockResolvedValueOnce({ ok: true, text: VALID_YAML });
    deps.runner = { oneShot } as unknown as DraftDeps['runner'];

    const result = await reviseWorkerFromPrompt(
      {
        jobDescription: JOB,
        instruction: 'Make the report look like this.',
        flow: {
          id: 'sprint-report',
          name: 'Sprint Report',
          input: 'user_prompt',
          participants: [],
          steps: [],
          source: 'user',
          filePath: '',
        } as never,
        attachments: [SPEC],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(oneShot).toHaveBeenCalledTimes(2);
    expect(oneShot.mock.calls[0][0].attachments).toEqual([SPEC]);
    expect(oneShot.mock.calls[1][0].attachments).toEqual([SPEC]);
  });
});
