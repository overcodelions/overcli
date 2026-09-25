import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/types';
import { HIRE_INTERVIEW_MAX_ROUNDS } from '../../shared/flows/worker';

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

    expect(result.ok && 'contract' in result).toBe(true);
    if (result.ok && 'contract' in result) expect(result.flowPlan).toEqual([{ flowId: 'existing-flow' }]);
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

    expect(result.ok && 'contract' in result).toBe(true);
    if (result.ok && 'contract' in result) {
      expect(result.flowPlan).toEqual([]);
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

  it('shows the drafter the crew it is naming alongside', async () => {
    // A name is an ADDRESS, not a label: the user says it out loud, and a
    // colleague delegating work retypes it exactly (`resolveHandoffTarget`),
    // so a collision reaches nobody. The drafter can only avoid one it has
    // been shown.
    mockQuery.mockReturnValueOnce(claudeStream(hireReply('existing-flow')));
    await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], crew: ['Prometheus', 'Cassandra'] },
      claudeDeps(),
    );
    const prompt = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(prompt).toContain('THE CREW ALREADY HIRED');
    expect(prompt).toContain('- Prometheus');
    expect(prompt).toContain('- Cassandra');
    expect(prompt).toContain('never reuse one');
  });

  it('says so rather than showing an empty list on the first hire', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(hireReply('existing-flow')));
    await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());
    const prompt = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(prompt).toContain('(nobody hired yet)');
  });

  it('asks for a name a person would answer to, not a job or a tool', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(hireReply('existing-flow')));
    await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());
    const prompt = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(prompt).toContain('a given name');
    // The two registers the roster actually drifted into, named so the
    // drafter refuses them by example rather than by category alone.
    expect(prompt).toContain('Test Coverage Warden');
    expect(prompt).toContain('Sweeper');
  });
});

describe('draftWorkerFromPrompt as a conversation', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLog.mockReset();
  });

  const QUESTIONS = '1. Which boards?\n2. Where should the reports go?';

  it('returns the drafter questions when an interview turn has no worker block', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(QUESTIONS));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], interview: true },
      claudeDeps(),
    );

    expect(result).toEqual({ ok: true, question: QUESTIONS });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0].options.systemPrompt).toContain('THIS IS A CONVERSATION');
  });

  it('returns structured questions with their options, and the lead-in as the text', async () => {
    const block = JSON.stringify({
      questions: [
        { question: 'Where should the drafts go?', options: ['Real drafts', 'A digest file'] },
        { question: 'Which mail accounts?' },
      ],
    });
    mockQuery.mockReturnValueOnce(claudeStream(`Two things first.\n<questions>\n${block}\n</questions>`));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], interview: true },
      claudeDeps(),
    );

    expect(result).toEqual({
      ok: true,
      question: 'Two things first.',
      questions: [
        { question: 'Where should the drafts go?', options: ['Real drafts', 'A digest file'] },
        { question: 'Which mail accounts?' },
      ],
    });
  });

  it('replays structured questions numbered, so the answers line up', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(QUESTIONS));

    await draftWorkerFromPrompt(
      {
        jobDescription: JOB,
        flows: [],
        projects: [],
        interview: true,
        conversation: [
          {
            role: 'assistant',
            text: 'Two things first.',
            questions: [{ question: 'Where should the drafts go?', options: ['Real drafts', 'A file'] }],
          },
          { role: 'user', text: 'Where should the drafts go?\n→ Real drafts' },
        ],
      },
      claudeDeps(),
    );

    expect(mockQuery.mock.calls[0][0].prompt).toContain(
      '1. Where should the drafts go? (Real drafts / A file)',
    );
  });

  it('does not tell a one-shot hire it may ask questions', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(hireReply()))
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());

    expect(mockQuery.mock.calls[0][0].options.systemPrompt).not.toContain('THIS IS A CONVERSATION');
    expect(mockQuery.mock.calls[0][0].prompt).toBe(`JOB DESCRIPTION:\n${JOB}`);
  });

  it('treats a malformed block as a failed draft, not as a question', async () => {
    mockQuery.mockReturnValueOnce(claudeStream('Here goes.\n<worker>{ not json }</worker>'));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], interview: true },
      claudeDeps(),
    );

    expect(result.ok).toBe(false);
  });

  it('replays the conversation and gives the flow designer the answers', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(hireReply('A weekly two-board report flow.')))
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    const result = await draftWorkerFromPrompt(
      {
        jobDescription: JOB,
        flows: [],
        projects: [],
        interview: true,
        conversation: [
          { role: 'assistant', text: QUESTIONS },
          { role: 'user', text: 'Post both to #sprint-reports.' },
        ],
      },
      claudeDeps(),
    );

    expect(result.ok && 'contract' in result).toBe(true);
    const hirePrompt = mockQuery.mock.calls[0][0].prompt as string;
    expect(hirePrompt).toContain('THE CONVERSATION SO FAR');
    expect(hirePrompt).toContain(QUESTIONS);
    expect(hirePrompt).toContain('#sprint-reports');
    const flowPrompt = mockQuery.mock.calls[1][0].prompt as string;
    expect(flowPrompt).toContain('#sprint-reports');
  });

  it('stops asking once the conversation has used up its rounds', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(hireReply()))
      .mockReturnValueOnce(claudeStream(VALID_YAML));
    const rounds = Array.from({ length: HIRE_INTERVIEW_MAX_ROUNDS }, (_, i) => [
      { role: 'assistant' as const, text: `Question ${i + 1}?` },
      { role: 'user' as const, text: `Answer ${i + 1}.` },
    ]).flat();

    await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], interview: true, conversation: rounds },
      claudeDeps(),
    );

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.systemPrompt).not.toContain('THIS IS A CONVERSATION');
    expect(call.prompt).toContain('DRAFT now');
  });

  it('forces a draft mid-conversation when interview is off', async () => {
    // "Draft it now": the drafter must not come back with more questions,
    // so a block-less reply is a parse failure rather than a question.
    mockQuery.mockReturnValueOnce(claudeStream(QUESTIONS));

    const result = await draftWorkerFromPrompt(
      {
        jobDescription: JOB,
        flows: [],
        projects: [],
        conversation: [{ role: 'assistant', text: QUESTIONS }],
      },
      claudeDeps(),
    );

    expect(result.ok).toBe(false);
    expect(mockQuery.mock.calls[0][0].prompt).toContain('DRAFT now');
  });
});

function contractReply(extra: Record<string, unknown>, lead = 'My read.'): string {
  return `${lead}\n<worker>\n${JSON.stringify({
    name: 'Scribe',
    jobDescription: JOB,
    cadence: { kind: 'daily', time: '09:00', days: [1] },
    maxItemsPerShift: 1,
    budgetUSDPerMonth: 10,
    heartbeatModel: 'claude-haiku-4-5-20251001',
    ...extra,
  })}\n</worker>`;
}

describe('hiring a worker with several flows', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLog.mockReset();
  });

  it('drafts each requested flow, keeps existing ones, and returns them primary first', async () => {
    mockQuery
      .mockReturnValueOnce(
        claudeStream(
          contractReply({
            flows: [
              { flowRequest: 'Triage the inbox and draft replies.', when: 'new mail that needs an answer' },
              { flowId: 'existing-flow', when: 'anything else' },
              { flowRequest: 'Write the weekly digest.', when: 'the Friday digest' },
            ],
          }),
        ),
      )
      .mockReturnValueOnce(claudeStream(VALID_YAML))
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [{ id: 'existing-flow', name: 'Existing' }], projects: [] },
      claudeDeps(),
    );

    if (!result.ok || !('flowPlan' in result)) throw new Error('expected a contract');
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const [first, second, third] = result.flowPlan;
    // Both drafts slug to the same name; the second must not overwrite the first.
    expect(first.flow?.id).toBe('sprint-report');
    expect(second).toEqual({ flowId: 'existing-flow' });
    expect(third.flow?.id).toBe('sprint-report-2');
    expect(result.flowPlan.map((p) => p.flowId)).toEqual(['sprint-report', 'existing-flow', 'sprint-report-2']);
    // The planner routes by description, so a multi-flow hire writes "when" there.
    expect(first.flow?.description).toBe('new mail that needs an answer');
    expect(mockQuery.mock.calls[1][0].prompt).toContain('It handles: new mail that needs an answer');
  });

  it('never gives a drafted flow the id of a flow already in the library', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(contractReply({ flows: [{ flowRequest: 'A report.' }] })))
      .mockReturnValueOnce(claudeStream(VALID_YAML));
    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [{ id: 'sprint-report', name: 'Sprint Report' }], projects: [] },
      claudeDeps(),
    );
    if (!result.ok || !('flowPlan' in result)) throw new Error('expected a contract');
    expect(result.flowPlan[0].flowId).toBe('sprint-report-2');
  });

  it('keeps the flows that drafted when one fails, and says which failed', async () => {
    mockQuery
      .mockReturnValueOnce(
        claudeStream(contractReply({ flows: [{ flowRequest: 'One.' }, { flowRequest: 'Two.' }] })),
      )
      .mockReturnValueOnce(claudeStream(VALID_YAML))
      .mockReturnValueOnce(claudeStream('no yaml here at all'));
    const result = await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());
    if (!result.ok || !('flowPlan' in result)) throw new Error('expected a contract');
    expect(result.flowPlan).toHaveLength(1);
    expect(result.flowError).toBeTruthy();
  });
});

describe('hiring with a wrap-up', () => {
  beforeEach(() => mockQuery.mockReset());

  it('drafts the wrap-up beside the routes but returns it apart from them', async () => {
    mockQuery
      .mockReturnValueOnce(
        claudeStream(
          contractReply({
            flows: [{ flowId: 'existing-flow' }],
            wrapUp: { flowRequest: 'Combine the trip notes into one weekly plan.' },
          }),
        ),
      )
      .mockReturnValueOnce(claudeStream(VALID_YAML));
    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [{ id: 'existing-flow', name: 'Existing' }], projects: [] },
      claudeDeps(),
    );
    if (!result.ok || !('flowPlan' in result)) throw new Error('expected a contract');
    expect(result.flowPlan).toEqual([{ flowId: 'existing-flow' }]);
    expect(result.wrapUp?.flow?.id).toBe('sprint-report');
    const wrapPrompt = mockQuery.mock.calls[1][0].prompt as string;
    expect(wrapPrompt).toContain("This is the worker's WRAP-UP flow");
    expect(mockQuery.mock.calls[0][0].options.systemPrompt).toContain('WRAP-UP: optional');
  });

  it('tells the route flows to produce their piece and leave delivery to the wrap-up', async () => {
    mockQuery
      .mockReturnValueOnce(
        claudeStream(
          contractReply({
            flows: [{ flowRequest: 'Research one trip.' }],
            wrapUp: { flowRequest: 'Combine into one plan and DM it.' },
          }),
        ),
      )
      .mockReturnValueOnce(claudeStream(VALID_YAML))
      .mockReturnValueOnce(claudeStream(VALID_YAML));
    await draftWorkerFromPrompt({ jobDescription: JOB, flows: [], projects: [] }, claudeDeps());
    const prompts = mockQuery.mock.calls.slice(1).map((c) => c[0].prompt as string);
    const route = prompts.find((p) => p.includes('Research one trip.'))!;
    const wrap = prompts.find((p) => p.includes('Combine into one plan'))!;
    expect(route).toContain('do NOT send, post, email or publish it');
    expect(wrap).not.toContain('do NOT send, post, email or publish it');
    expect(mockQuery.mock.calls[0][0].options.systemPrompt).toContain('the wrap-up owns delivery');
  });

  it('keeps the example contract valid JSON with the wrap-up in it', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(contractReply({ flowId: 'existing-flow' })));
    await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [{ id: 'existing-flow', name: 'Existing' }], projects: [] },
      claudeDeps(),
    );
    const prompt = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(() => JSON.parse(prompt.match(/<worker>\n([\s\S]*?)\n<\/worker>/)![1])).not.toThrow();
  });
});

describe('hiring with the configured MCP servers', () => {
  beforeEach(() => mockQuery.mockReset());

  it('lists the servers, keeps the example valid JSON, and parses the choice', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(contractReply({ flowId: 'existing-flow', mcpServers: ['linear'] })));
    const result = await draftWorkerFromPrompt(
      {
        jobDescription: JOB,
        flows: [{ id: 'existing-flow', name: 'Existing' }],
        projects: [],
        mcpServers: ['Linear', 'Sentry'],
      },
      claudeDeps(),
    );
    const prompt = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(prompt).toContain('MCP SERVERS THE USER HAS');
    expect(prompt).toContain('  - Sentry');
    expect(() => JSON.parse(prompt.match(/<worker>\n([\s\S]*?)\n<\/worker>/)![1])).not.toThrow();
    if (!result.ok || !('contract' in result)) throw new Error('expected a contract');
    expect(result.contract.mcpServers).toEqual(['Linear']);
  });

  it('says nothing about servers when the list is unknown', async () => {
    mockQuery.mockReturnValueOnce(claudeStream(contractReply({ flowId: 'existing-flow' })));
    await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [{ id: 'existing-flow', name: 'Existing' }], projects: [] },
      claudeDeps(),
    );
    expect(mockQuery.mock.calls[0][0].options.systemPrompt).not.toContain('MCP SERVERS');
  });
});

describe('granting the scoped servers', () => {
  beforeEach(() => mockQuery.mockReset());

  it('warns when a scoped server is not granted to any step of the new flows', async () => {
    mockQuery
      .mockReturnValueOnce(
        claudeStream(contractReply({ flows: [{ flowRequest: 'A report.' }], mcpServers: ['claude.ai Gmail'] })),
      )
      .mockReturnValueOnce(claudeStream(VALID_YAML));
    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], mcpServers: ['claude.ai Gmail'] },
      claudeDeps(),
    );
    if (!result.ok || !('contract' in result)) throw new Error('expected a contract');
    expect(result.summary).toContain('no step in this worker\'s new flows is allowed to use claude.ai Gmail');
  });

  it('says nothing when a step lists one of the server tools', async () => {
    const granted = VALID_YAML.replace('tools: [Read]', 'tools: [Read, mcp__claude_ai_Gmail__search_threads]');
    mockQuery
      .mockReturnValueOnce(
        claudeStream(contractReply({ flows: [{ flowRequest: 'A report.' }], mcpServers: ['claude.ai Gmail'] })),
      )
      .mockReturnValueOnce(claudeStream(granted));
    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], mcpServers: ['claude.ai Gmail'] },
      claudeDeps(),
    );
    if (!result.ok || !('contract' in result)) throw new Error('expected a contract');
    expect(result.summary).not.toContain('Heads up');
  });
});

describe('checking the draft before flows are designed', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLog.mockReset();
  });

  it('applies the check, and designs the flow from the checked request', async () => {
    mockQuery
      .mockReturnValueOnce(claudeStream(contractReply({ flows: [{ flowRequest: 'Report on the boards.' }] })))
      .mockReturnValueOnce(
        claudeStream(
          contractReply(
            { flows: [{ flowRequest: 'Report on the boards and post both to #sprint-reports.' }] },
            'Added the channel the user named.',
          ),
        ),
      )
      .mockReturnValueOnce(claudeStream(VALID_YAML));

    const result = await draftWorkerFromPrompt(
      { jobDescription: JOB, flows: [], projects: [], polish: true },
      claudeDeps(),
    );

    if (!result.ok || !('contract' in result)) throw new Error('expected a contract');
    expect(mockQuery.mock.calls[1][0].options.systemPrompt).toContain('THIS TURN IS A REVIEW');
    expect(mockQuery.mock.calls[1][0].options.systemPrompt).toContain('A wrap-up fits the job');
    expect(mockQuery.mock.calls[1][0].prompt).toContain('THE DRAFT CONTRACT');
    expect(mockQuery.mock.calls[2][0].prompt).toContain('#sprint-reports');
    expect(result.summary).toContain('Added the channel the user named.');
  });

  it('keeps the draft when the check has nothing to fix or returns garbage', async () => {
    for (const checkReply of ['Nothing to fix.\n' + contractReply({}).split('\n').slice(1).join('\n'), 'oops']) {
      mockQuery.mockReset();
      mockQuery
        .mockReturnValueOnce(claudeStream(contractReply({ flowId: 'existing-flow' })))
        .mockReturnValueOnce(claudeStream(checkReply));
      const result = await draftWorkerFromPrompt(
        { jobDescription: JOB, flows: [{ id: 'existing-flow', name: 'Existing' }], projects: [], polish: true },
        claudeDeps(),
      );
      if (!result.ok || !('contract' in result)) throw new Error('expected a contract');
      expect(result.summary).toBe('My read.');
      expect(result.flowPlan).toEqual([{ flowId: 'existing-flow' }]);
    }
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
