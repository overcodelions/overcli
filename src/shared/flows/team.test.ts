import { describe, expect, it } from 'vitest';
import type { Flow } from './schema';
import { validateFlow } from './validation';
import { buildPackUpdateMessage, parseRouteReply } from './teamRoom';
import {
  buildMemberStagePrompt,
  buildTeamPlanMessage,
  describeTeamCheckpoints,
  describeTeamTaskStatus,
  folderForPrompt,
  shareBudget,
  parsePackReply,
  resolveTaskFileRef,
  parsePlanReply,
  renameIfTaken,
  checkStepOf,
  resolveMember,
  safeTeamFileName,
  stageFileName,
  validateTeam,
  type TeamTask,
  teamPieceFlow,
  teamPieceFlowId,
} from './team';

const roster = [
  { workerId: 'w-maya', name: 'Maya', role: 'Market analyst' },
  { workerId: 'w-ade', name: 'Ade', role: 'Software architect' },
  { workerId: 'w-rook', name: 'Rook', role: 'Challenger' },
];

const plan = (body: object) => `Here is the plan.\n<team_plan>\n${JSON.stringify(body)}\n</team_plan>`;

describe('parsePlanReply', () => {
  it('reads a plan, resolving members by name and role', () => {
    const reply = parsePlanReply(
      plan({
        title: 'Proposal',
        note: 'Market first.',
        deliverables: ['PROPOSAL.md'],
        stages: [
          { kind: 'contribute', title: 'Market', assignments: [{ member: 'maya', ask: 'Size it' }] },
          { kind: 'challenge', title: 'Attack', assignments: [{ member: 'Challenger', ask: 'Object' }] },
          { kind: 'synthesize', title: 'Pack', ask: 'Write it' },
        ],
      }),
      roster,
      { allowQuestions: false },
    );
    expect(reply.kind).toBe('plan');
    if (reply.kind !== 'plan') return;
    expect(reply.title).toBe('Proposal');
    expect(reply.stages.map((s) => s.kind)).toEqual(['contribute', 'challenge', 'synthesize']);
    expect(reply.stages[0].assignments[0]).toMatchObject({ workerId: 'w-maya', workerName: 'Maya', status: 'pending' });
    expect(reply.stages[1].assignments[0].workerId).toBe('w-rook');
  });

  it('always ends in exactly one synthesize', () => {
    const reply = parsePlanReply(
      plan({
        stages: [
          { kind: 'synthesize', title: 'Early', ask: 'x' },
          { kind: 'contribute', title: 'Work', assignments: [{ member: 'Ade', ask: 'Design' }] },
        ],
      }),
      roster,
      { allowQuestions: false },
    );
    if (reply.kind !== 'plan') throw new Error(reply.kind);
    expect(reply.stages.map((s) => s.kind)).toEqual(['draft', 'contribute', 'synthesize']);
  });

  it('refuses a member who is not on the team', () => {
    const reply = parsePlanReply(
      plan({ stages: [{ kind: 'contribute', title: 'W', assignments: [{ member: 'Zed', ask: 'x' }] }] }),
      roster,
      { allowQuestions: false },
    );
    expect(reply).toMatchObject({ kind: 'error' });
    if (reply.kind === 'error') expect(reply.error).toContain('Zed');
  });

  it('refuses a plan that gives the members nothing to do', () => {
    const reply = parsePlanReply(plan({ stages: [{ kind: 'draft', title: 'D', ask: 'x' }] }), roster, {
      allowQuestions: false,
    });
    expect(reply.kind).toBe('error');
  });

  it('reads questions only when they are allowed', () => {
    const text = 'A few things first.\n<team_questions>["Who is it for?", "Any limits?"]</team_questions>';
    expect(parsePlanReply(text, roster, { allowQuestions: true })).toEqual({
      kind: 'questions',
      questions: ['Who is it for?', 'Any limits?'],
      note: 'A few things first.',
    });
    expect(parsePlanReply(text, roster, { allowQuestions: false }).kind).toBe('error');
  });

  it('salvages fenced JSON', () => {
    const text = '<team_plan>\n```json\n{"stages":[{"kind":"contribute","title":"W","assignments":[{"member":"Ade","ask":"x"}]}]}\n```\n</team_plan>';
    expect(parsePlanReply(text, roster, { allowQuestions: false }).kind).toBe('plan');
  });
});

describe('resolveMember', () => {
  it('matches a decorated name', () => {
    expect(resolveMember('Maya (market analyst)', roster)).toBe('w-maya');
    expect(resolveMember('nobody', roster)).toBeNull();
  });
});

describe('parsePackReply', () => {
  it('reads the summary and every file', () => {
    const pack = parsePackReply(
      '<summary>Build it.</summary>\n<file name="PROPOSAL.md">\n# PR\n</file>\n<file name="../../etc/PLAN">\nscope\n</file>',
    );
    expect(pack.summary).toBe('Build it.');
    expect(pack.files).toEqual([
      { name: 'PROPOSAL.md', body: '# PR\n' },
      { name: 'PLAN.md', body: 'scope\n' },
    ]);
  });

  it('keeps a reply that ignored the format as report.md', () => {
    const pack = parsePackReply('# Report\n\nThe verdict is yes.');
    expect(pack.files.map((f) => f.name)).toEqual(['report.md']);
    expect(pack.summary).toBe('The verdict is yes.');
  });

  it('does not let two files share a name', () => {
    const pack = parsePackReply('<file name="a.md">x</file><file name="a.md">y</file>');
    expect(pack.files.map((f) => f.name)).toEqual(['a.md', 'a-2.md']);
  });
});

describe('file names', () => {
  it('makes model-supplied names safe', () => {
    expect(safeTeamFileName('../.hidden')).toBe('hidden.md');
    expect(safeTeamFileName('report: final?.md')).toBe('report- final-.md');
    expect(safeTeamFileName('')).toBe('document.md');
  });

  it('orders stage files by stage', () => {
    expect(stageFileName(0, 'Customer & market', 'Maya')).toBe('01-customer-market-maya.md');
  });
});

describe('resolveTaskFileRef', () => {
  const names = [
    'brief.md',
    'pack/DESIGNS.md',
    'pack-v1/DESIGNS.md',
    'files/lena/designs/00-index.html',
    'files/lena/designs/04-acme-partner-collateral.html',
    'files/lena/report.md',
    'files/mira/report.md',
  ];
  it('finds a file by the name its author knew it by', () => {
    expect(resolveTaskFileRef(names, 'brief.md')).toBe('brief.md');
    expect(resolveTaskFileRef(names, 'designs/00-index.html')).toBe('files/lena/designs/00-index.html');
    expect(resolveTaskFileRef(names, '04-acme-partner-collateral.html:12')).toBe('files/lena/designs/04-acme-partner-collateral.html');
    expect(resolveTaskFileRef(names, 'DESIGNS.md')).toBe('pack/DESIGNS.md');
  });
  it('refuses to guess between two members\u2019 files of the same name', () => {
    expect(resolveTaskFileRef(names, 'report.md')).toBeNull();
    expect(resolveTaskFileRef(names, 'lena/report.md')).toBe('files/lena/report.md');
    expect(resolveTaskFileRef(names, 'nope.md')).toBeNull();
  });
});

describe('validateTeam', () => {
  const workers = [
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'ann' },
  ];
  const base = { name: 'T', budgetUSDPerTask: 10 };
  it('needs two distinct, known, distinctly named members and a budget', () => {
    expect(validateTeam({ ...base, members: [{ workerId: 'a', role: '' }] }, workers)).toMatch(/two members/);
    expect(validateTeam({ ...base, members: [{ workerId: 'a', role: '' }, { workerId: 'z', role: '' }] }, workers)).toMatch(/no longer/);
    expect(validateTeam({ ...base, members: [{ workerId: 'a', role: '' }, { workerId: 'c', role: '' }] }, workers)).toMatch(/share a name/);
    expect(validateTeam({ ...base, budgetUSDPerTask: 0, members: [{ workerId: 'a', role: '' }, { workerId: 'b', role: '' }] }, workers)).toMatch(/budget/);
    expect(validateTeam({ ...base, members: [{ workerId: 'a', role: '' }, { workerId: 'b', role: '' }] }, workers)).toBeNull();
  });
});

describe('prompts', () => {
  it('offers questions only on the first pass', () => {
    const args = { teamName: 'T', roster: [], brief: 'Do it', budgetUSD: 10 };
    expect(buildTeamPlanMessage({ ...args, allowQuestions: true })).toContain('You may ask up to');
    expect(buildTeamPlanMessage({ ...args, allowQuestions: false })).toContain('Do not ask questions now');
  });

  it('gives a challenger the challenge brief and the folder', () => {
    const prompt = buildMemberStagePrompt({
      teamName: 'T',
      task: { brief: 'Build teams' } as TeamTask,
      stageNumber: 3,
      stageCount: 5,
      stage: { kind: 'challenge', title: 'Attack' },
      role: 'Challenger',
      ask: 'Object to the draft',
      teammates: [{ name: 'Ade', role: 'Architect' }],
      folder: '/tmp/task',
      files: [{ name: '02-draft.md', author: 'Coordinator', body: 'The draft' }],
      budget: 1000,
    });
    expect(prompt).toContain('ATTACK the case');
    expect(prompt).toContain('=== 02-draft.md (by Coordinator) ===');
    expect(prompt).toContain('/tmp/task');
  });

  it('cuts a long file and says where the rest is', () => {
    const out = folderForPrompt([{ name: 'a.md', author: 'A', body: 'x'.repeat(2000) }], 500, '/f');
    expect(out).toContain('[… 1,500 more characters cut to fit; the full file is /f/a.md]');
  });

  it('never points the coordinator at a file it cannot open', () => {
    const out = folderForPrompt([{ name: 'a.md', author: 'A', body: 'x'.repeat(2000) }], 500, '/f', { pointToFiles: false });
    expect(out).toContain('[… 1,500 more characters cut to fit]');
    expect(out).not.toContain('/f/a.md');
  });

  it('keeps short files whole and gives the rest to long ones', () => {
    expect(shareBudget([25, 155, 5], 100)).toEqual([25, 70, 5]);
    expect(shareBudget([10, 10], 100)).toEqual([10, 10]);
    expect(shareBudget([300, 300], 100)).toEqual([50, 50]);
  });

  it('describes a running task by stage', () => {
    expect(
      describeTeamTaskStatus({
        status: 'running',
        stageIndex: 1,
        stages: [{}, {}, {}] as TeamTask['stages'],
      }),
    ).toBe('Stage 2 of 3');
  });
});

describe('parseRouteReply', () => {
  const members = [
    { workerId: 'lena', name: 'Lena' },
    { workerId: 'mira', name: 'Mira' },
  ];

  it('reads work to hand off, keeping only members of the team', () => {
    const reply = parseRouteReply(
      `<work>${JSON.stringify({ title: 'Redo D-01', assign: [{ name: 'lena', ask: 'Redraw it' }, { name: 'Zed', ask: 'x' }] })}</work>`,
      members,
    );
    expect(reply).toEqual({ kind: 'work', work: { title: 'Redo D-01', assign: [{ workerId: 'lena', name: 'Lena', ask: 'Redraw it' }] } });
  });

  it('falls back to routing when there is no usable work block', () => {
    expect(parseRouteReply('<route>["Mira"]</route>', members)).toEqual({ kind: 'route', workerIds: ['mira'] });
    expect(parseRouteReply('<work>{not json</work><route>[]</route>', members)).toEqual({ kind: 'route', workerIds: [] });
    expect(parseRouteReply(`<work>${JSON.stringify({ title: 'x', assign: [{ name: 'Zed', ask: 'y' }] })}</work>`, members)).toMatchObject({ kind: 'route' });
  });
});

describe('describeTeamCheckpoints', () => {
  it('always includes approving the plan, and only the checkpoints that are on', () => {
    expect(describeTeamCheckpoints({ askFirst: false, reviewBeforeChallenge: false, finalReview: false })).toEqual([
      'You approve the plan',
    ]);
    expect(describeTeamCheckpoints({ askFirst: true, reviewBeforeChallenge: true, finalReview: true })).toEqual([
      'May ask questions first',
      'you approve the plan',
      'you read the draft before each challenge',
      'you review the pack',
    ]);
  });
});

describe('buildPackUpdateMessage', () => {
  it('tells the coordinator the version it is writing, and not to count stages', () => {
    const msg = buildPackUpdateMessage({ teamName: 'T', taskTitle: 'X', brief: 'b', pack: [], conversation: [], version: 5 });
    expect(msg).toContain('VERSION 5 of the pack');
    expect(msg).toContain('Do not state stage numbers');
  });
});

describe('teamPieceFlow', () => {
  const pipeline: Flow = {
    id: 'tech-spec',
    name: 'Tech Spec Generator',
    input: 'user_prompt',
    participants: [
      { id: 'fast', name: 'Sonnet', backend: 'claude', model: 'claude-sonnet-5-5' },
      { id: 'primary', name: 'Opus', backend: 'claude', model: 'claude-opus-5-5' },
    ],
    steps: [
      { id: 'read-code', participantId: 'primary', role: 'code-reader', inputs: ['user_prompt'], tools: ['Read', 'Grep', 'Bash'], output: 'survey.md' },
      {
        id: 'draft', participantId: 'primary', role: 'custom', systemPromptOverride: 'Draft.', inputs: ['survey.md'], tools: ['Read', 'WebFetch'], output: 'spec.md',
        rebound: { critic: { backend: 'claude', model: 'claude-opus-5-5' }, mode: 'collab', maxIters: 3 } as Flow['steps'][number]['rebound'],
        pauseBefore: true,
      },
      { id: 'polish', participantId: 'fast', role: 'editor', inputs: ['spec.md'], tools: ['Read'], output: 'final.md' },
    ],
    source: 'user',
    filePath: '/flows/tech-spec.yaml',
  };

  it("keeps the member's main model and tools, adds writing, and drops the pipeline", () => {
    const piece = teamPieceFlow(pipeline);
    expect(piece.id).toBe(teamPieceFlowId('tech-spec'));
    expect(piece.steps).toHaveLength(1);
    expect(piece.participants).toEqual([pipeline.participants[1]]);
    const [step] = piece.steps;
    expect(step.participantId).toBe('primary');
    expect(step.tools).toEqual(['Read', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit']);
    // Its steps run on the runtime default, so the piece does too.
    expect(step.permissionMode).toBeUndefined();
    expect(step.inputs).toEqual(['user_prompt']);
    expect(step.rebound).toBeUndefined();
    expect(step.pauseBefore).toBeUndefined();
    expect(step.effect).toBe('local');
  });

  it('stays careful only when every step of the member flow is', () => {
    const careful: Flow = {
      ...pipeline,
      steps: pipeline.steps.map((st) => ({ ...st, permissionMode: 'acceptEdits' as const })),
    };
    expect(teamPieceFlow(careful).steps[0].permissionMode).toBe('acceptEdits');
    const oneBypass: Flow = {
      ...careful,
      steps: careful.steps.map((st, i) => (i === 1 ? { ...st, permissionMode: 'bypassPermissions' as const } : st)),
    };
    expect(teamPieceFlow(oneBypass).steps[0].permissionMode).toBeUndefined();
  });

  it('passes flow validation', () => {
    expect(validateFlow(teamPieceFlow(pipeline))).toEqual({ ok: true, errors: [] });
  });

  it('adds no Claude tool names to another backend', () => {
    const codex: Flow = {
      ...pipeline,
      participants: [{ id: 'primary', name: 'Codex', backend: 'codex', model: 'gpt-5' }],
      steps: [{ ...pipeline.steps[0] }],
    };
    expect(teamPieceFlow(codex).steps[0].tools).toEqual(['Read', 'Grep', 'Bash']);
  });
});

describe('renameIfTaken', () => {
  const draft = {
    name: 'Theo',
    tagline: "Theo keeps the site current",
    jobDescription: 'Theo updates the website. Theodore is someone else.',
    errandStarters: ['Theo, update the release notes'],
  };

  it('keeps a name nobody has', () => {
    expect(renameIfTaken(draft, ['Kwabena', 'Oksana'])).toBe(draft);
  });

  it('picks an unused name and carries it through its own words', () => {
    const out = renameIfTaken(draft, ['theo', 'Ada']);
    expect(out.name).toBe('Bram');
    expect(out.tagline).toBe('Bram keeps the site current');
    expect(out.jobDescription).toBe('Bram updates the website. Theodore is someone else.');
    expect(out.errandStarters).toEqual(['Bram, update the release notes']);
  });
});

describe('checked team pieces', () => {
  const flow: Flow = {
    id: 'ship',
    name: 'Ship',
    input: 'user_prompt',
    participants: [
      { id: 'dev', name: 'Dev', backend: 'claude', model: 'claude-sonnet-5-5' },
      { id: 'qa', name: 'QA', backend: 'claude', model: 'claude-haiku-4-5' },
    ],
    steps: [
      { id: 'build', participantId: 'dev', role: 'implementer', inputs: ['user_prompt'], tools: ['Read', 'Edit'], output: 'build.md' },
      { id: 'run-tests', participantId: 'qa', role: 'custom', inputs: ['build.md'], tools: ['Bash'], output: 'tests.md' },
    ],
    source: 'user',
    filePath: '',
  };

  it("finds the member's own check step", () => {
    expect(checkStepOf(flow)?.id).toBe('run-tests');
    expect(checkStepOf({ ...flow, steps: [flow.steps[0]] })).toBeNull();
  });

  it('keeps it after the piece when asked, ending with the piece', () => {
    const piece = teamPieceFlow(flow, { check: true });
    expect(piece.id).toBe('team-piece-checked-ship');
    expect(piece.steps.map((s) => [s.id, s.participantId, s.output])).toEqual([
      ['piece', 'dev', 'piece.md'],
      ['check', 'qa', 'checked.md'],
    ]);
    expect(piece.steps[1].inputs).toEqual(['user_prompt', 'piece.md']);
    expect(piece.steps[1].tools).toContain('Bash');
    expect(validateFlow(piece).errors).toEqual([]);
    // Not asked, or nothing to keep: one step, as before.
    expect(teamPieceFlow(flow).steps).toHaveLength(1);
    expect(teamPieceFlow({ ...flow, steps: [flow.steps[0]] }, { check: true }).id).toBe('team-piece-ship');
  });

  it('reads a full-job assignment from the plan', () => {
    const reply = parsePlanReply(
      plan({ stages: [{ kind: 'contribute', title: 'Profile', assignments: [{ member: 'Maya', ask: 'Do the profile', full: true }] }] }),
      roster,
      { allowQuestions: false },
    );
    if (reply.kind !== 'plan') throw new Error(reply.kind);
    expect(reply.stages[0].assignments[0].full).toBe(true);
  });
});

describe('a pack summary taken from the reply itself', () => {
  it('leaves no tag behind, even one split by another', () => {
    const { summary } = parsePackReply('Done. <scr<x>ipt>alert(1)</script> Shipped the fix.');
    expect(summary).not.toMatch(/[<>]/);
    expect(summary).toContain('Shipped the fix.');
  });
});

describe('a piece from a flow that acts outside the machine', () => {
  const base: Flow = {
    id: 'design',
    name: 'Design',
    input: 'user_prompt',
    participants: [{ id: 'd', name: 'Designer', backend: 'claude', model: 'claude-sonnet-5-5' }],
    steps: [
      { id: 'survey', participantId: 'd', role: 'custom', inputs: ['user_prompt'], tools: ['Read'], effect: 'local', output: 'survey.md' },
      { id: 'design', participantId: 'd', role: 'custom', inputs: ['survey.md'], tools: ['Write', 'Artifact'], effect: 'external', output: 'design.md' },
    ],
    source: 'user',
    filePath: '',
  };

  it('keeps its tools, and is external like the flow', () => {
    const [step] = teamPieceFlow(base).steps;
    expect(step.tools).toContain('Artifact');
    expect(step.effect).toBe('external');
  });

  it('stays local when nothing in the flow is external', () => {
    const local = { ...base, steps: base.steps.map((s) => ({ ...s, effect: 'local' as const, tools: ['Read', 'Write'] })) };
    expect(teamPieceFlow(local).steps[0].effect).toBe('local');
  });
});
