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
  handoffSteps,
  orderHandoffByPlan,
  shareBudget,
  parsePackReply,
  parsePackUpdate,
  applyPackUpdate,
  resolveTaskFileRef,
  parsePlanReply,
  renameIfTaken,
  checkStepOf,
  resolveMember,
  safeTeamFileName,
  stageFileName,
  validateTeam,
  type TeamStage,
  type TeamTask,
  teamPieceFlow,
  teamPieceFlowId,
  sourceFlowIdOfPiece,
  withStepTools,
  rolloverReason,
  continuationLines,
  TEAM_ROLLOVER_AGE_MS,
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

describe('pack updates', () => {
  const pack = [
    { name: 'PLAN.md', body: '# Plan\n\n| Lever | Saving |\n| A | $1k |\n| B | $2k |\n' },
    { name: 'REPORT.html', body: '<h1>Report</h1><p>Old verdict.</p>' },
    { name: 'NOTES.md', body: 'notes\n' },
  ];

  it('reads edits, whole files and drops, and turns no stray text into a document', () => {
    const u = parsePackUpdate(
      '<summary>Swapped the director.</summary>\n<edit name="PLAN.md"><find>| A | $1k |</find><replace>| A | $3k |</replace></edit>\n<drop name="NOTES.md"/>\n<file name="NEW.md">new</file>',
    );
    expect(u).toEqual({
      summary: 'Swapped the director.',
      edits: [{ name: 'PLAN.md', find: '| A | $1k |', replace: '| A | $3k |' }],
      drops: ['NOTES.md'],
      files: [{ name: 'NEW.md', body: 'new\n' }],
      includes: [],
    });
    expect(parsePackUpdate('<summary>S</summary><include name="Report.html" from="files/eli/report.html"/>').includes).toEqual([
      { name: 'Report.html', from: 'files/eli/report.html' },
    ]);
    expect(parsePackUpdate('<summary>Nothing moved.</summary>\nAll good otherwise.').files).toEqual([]);
  });

  it('carries over what it does not name, and changes only what it does', () => {
    const next = applyPackUpdate(pack, {
      files: [{ name: 'NEW.md', body: 'new\n' }],
      edits: [
        { name: 'PLAN.md', find: '| A | $1k |', replace: '| A | $3k |' },
        { name: 'report.html', find: '\n<p>Old verdict.</p>\n', replace: '\n<p>New verdict.</p>\n' },
      ],
      drops: ['NOTES.md'],
    });
    expect(next.files.map((f) => f.name)).toEqual(['PLAN.md', 'REPORT.html', 'NEW.md']);
    expect(next.files[0].body).toContain('| A | $3k |\n| B | $2k |');
    expect(next.files[1].body).toBe('<h1>Report</h1><p>New verdict.</p>');
    expect(next.changed).toEqual(['PLAN.md', 'REPORT.html', 'NEW.md']);
    expect(next.failed).toEqual([]);
  });

  it('does not guess at an edit it cannot place', () => {
    const next = applyPackUpdate(pack, {
      files: [],
      edits: [
        { name: 'PLAN.md', find: '| C | $9k |', replace: 'x' },
        { name: 'PLAN.md', find: '|', replace: 'x' },
        { name: 'GONE.md', find: 'a', replace: 'b' },
      ],
      drops: [],
    });
    expect(next.changed).toEqual([]);
    expect(next.failed.map((f) => f.why)).toEqual([
      'the text it replaces was not found',
      'the text it replaces appears more than once',
      'no document by that name',
    ]);
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

  it('reads includes of files members made, and drops a retyped copy of the same name', () => {
    const pack = parsePackReply('<summary>S</summary><include name="Report.html" from="files/hugo/roadmap/report.html"/><file name="Report.html">retyped</file><file name="log.md">x</file>');
    expect(pack.includes).toEqual([{ name: 'Report.html', from: 'files/hugo/roadmap/report.html' }]);
    expect(pack.files.map((f) => f.name)).toEqual(['log.md']);
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
  it('hands the coordinator how the team works, above its own habits', () => {
    const args = { teamName: 'T', roster: [], brief: 'Write the PRFAQ', budgetUSD: 10, allowQuestions: false };
    expect(buildTeamPlanMessage(args)).not.toContain('HOW THIS TEAM WORKS');
    const msg = buildTeamPlanMessage({ ...args, guidance: '  When the ask is a PRFAQ, Hugo goes first.  ' });
    expect(msg).toContain('HOW THIS TEAM WORKS (from the people who run it: follow it over your own habits.');
    expect(msg).toContain('\nWhen the ask is a PRFAQ, Hugo goes first.\n');
    expect(msg.indexOf('HOW THIS TEAM WORKS')).toBeLessThan(msg.indexOf('THE BRIEF'));
  });
  it('offers questions only on the first pass', () => {
    const args = { teamName: 'T', roster: [], brief: 'Do it', budgetUSD: 10 };
    expect(buildTeamPlanMessage({ ...args, allowQuestions: true })).toContain('If there is any, ask now');
    expect(buildTeamPlanMessage({ ...args, allowQuestions: false })).toContain('Do not ask questions now');
  });

  it('keeps a question’s default when it went unanswered', () => {
    const piece = { teamName: 'T', stageNumber: 1, stageCount: 2, stage: { kind: 'contribute' as const, title: 'Draft' }, role: 'Writer', ask: 'Draft it', teammates: [], folder: '/tmp/f', files: [], budget: 5 };
    const task = { brief: 'Write a PR/FAQ', questions: ['Who is it for? (I’ll assume enterprise buyers.)', 'Launch date?'], answers: ['', 'March'] } as TeamTask;
    const prompt = buildMemberStagePrompt({ ...piece, task });
    expect(prompt).toContain('Who is it for? (I’ll assume enterprise buyers.) → (no answer: the default in the question stands)');
    expect(prompt).toContain('Launch date? → March');
    // Before anyone answers, nothing is claimed as clarified.
    expect(buildMemberStagePrompt({ ...piece, task: { ...task, answers: undefined } })).not.toContain('WHAT THE USER CLARIFIED');
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

  it('tells a member working in code to commit on the branch it was given, and nowhere else', () => {
    const base = {
      teamName: 'T',
      task: { brief: 'Add tests' } as TeamTask,
      stageNumber: 2,
      stageCount: 3,
      stage: { kind: 'contribute' as const, title: 'Write tests' },
      role: 'Engineer',
      ask: 'Write the tests',
      teammates: [],
      folder: '/tmp/task',
      files: [],
      budget: 1000,
    };
    const prompt = buildMemberStagePrompt({ ...base, code: { branch: 'team/add-tests' } });
    expect(prompt).toContain('one git branch, team/add-tests');
    expect(prompt).toContain('Do NOT create, switch to or rename branches');
    expect(prompt).toContain('Do NOT push or open pull requests');
    expect(buildMemberStagePrompt(base)).not.toContain('THE CODE');
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

  it('reads who builds on whom, among members on the work only', () => {
    const reply = parseRouteReply(
      `<work>${JSON.stringify({
        title: 'x',
        assign: [
          { name: 'Mira', ask: 'Compile', after: ['lena', 'Zed', 'Mira'] },
          { name: 'Lena', ask: 'Research', after: [] },
        ],
      })}</work>`,
      members,
    );
    expect(reply).toEqual({
      kind: 'work',
      work: {
        title: 'x',
        assign: [
          { workerId: 'mira', name: 'Mira', ask: 'Compile', after: ['lena'] },
          { workerId: 'lena', name: 'Lena', ask: 'Research', after: [] },
        ],
      },
    });
  });

  it('reads a request to change the pack as the coordinator\'s to do', () => {
    expect(parseRouteReply('<pack>Put Eli\'s report and action page in the pack.</pack>', members)).toEqual({
      kind: 'pack',
      ask: "Put Eli's report and action page in the pack.",
    });
  });

  it('falls back to routing when there is no usable work block', () => {
    expect(parseRouteReply('<route>["Mira"]</route>', members)).toEqual({ kind: 'route', workerIds: ['mira'] });
    expect(parseRouteReply('<work>{not json</work><route>[]</route>', members)).toEqual({ kind: 'route', workerIds: [] });
    expect(parseRouteReply(`<work>${JSON.stringify({ title: 'x', assign: [{ name: 'Zed', ask: 'y' }] })}</work>`, members)).toMatchObject({ kind: 'route' });
  });
});

describe('handoffSteps', () => {
  const ids = (steps: Array<Array<{ workerId: string }>>) => steps.map((st) => st.map((a) => a.workerId));

  it('runs members side by side unless one builds on another', () => {
    expect(ids(handoffSteps([{ workerId: 'a' }, { workerId: 'b' }]))).toEqual([['a', 'b']]);
    expect(
      ids(handoffSteps([{ workerId: 'c', after: ['a', 'b'] }, { workerId: 'a' }, { workerId: 'b' }, { workerId: 'd', after: ['c'] }])),
    ).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('ignores names not on the work, and runs a loop together rather than never', () => {
    expect(ids(handoffSteps([{ workerId: 'a', after: ['gone'] }]))).toEqual([['a']]);
    expect(ids(handoffSteps([{ workerId: 'x' }, { workerId: 'a', after: ['b'] }, { workerId: 'b', after: ['a'] }]))).toEqual([['x'], ['a', 'b']]);
  });
});

describe('orderHandoffByPlan', () => {
  const stage = (kind: TeamStage['kind'], ...workerIds: string[]): Pick<TeamStage, 'kind' | 'assignments' | 'fromRoom'> => ({
    kind,
    assignments: workerIds.map((workerId) => ({ workerId, workerName: workerId, ask: '', status: 'done' as const })),
  });
  const plan = [stage('contribute', 'r1', 'r2'), stage('synthesize'), stage('contribute', 'comp'), stage('challenge', 'r1')];

  it('puts the one the plan ran later after those it ran earlier', () => {
    expect(orderHandoffByPlan(plan, [{ workerId: 'comp' }, { workerId: 'r1' }])).toEqual([
      { workerId: 'comp', after: ['r1'] },
      { workerId: 'r1' },
    ]);
    // Researchers from the same stage stay side by side; someone not in the plan is not ordered.
    expect(orderHandoffByPlan(plan, [{ workerId: 'r1' }, { workerId: 'r2' }, { workerId: 'new' }])).toEqual([
      { workerId: 'r1' },
      { workerId: 'r2' },
      { workerId: 'new' },
    ]);
  });

  it('keeps any order the coordinator gave, even "independent"', () => {
    const given = [{ workerId: 'comp', after: [] }, { workerId: 'r1' }];
    expect(orderHandoffByPlan(plan, given)).toBe(given);
  });
});

describe('describeTeamCheckpoints', () => {
  it('always includes approving the plan, and only the checkpoints that are on', () => {
    expect(
      describeTeamCheckpoints({ askFirst: false, reviewBeforeChallenge: false, finalReview: false, approveRoomWork: false }),
    ).toEqual(['You approve the plan']);
    // Follow-up work is held unless the team turned that off.
    expect(describeTeamCheckpoints({ askFirst: true, reviewBeforeChallenge: true, finalReview: true })).toEqual([
      'May ask questions first',
      'you approve the plan',
      'you read the draft before each challenge',
      'you review the pack',
      'you start follow-up work',
    ]);
  });
});

describe('buildPackUpdateMessage', () => {
  it('tells the coordinator the version it is writing, and not to count stages', () => {
    const msg = buildPackUpdateMessage({ teamName: 'T', taskTitle: 'X', brief: 'b', pack: [], conversation: [], version: 5 });
    expect(msg).toContain('VERSION 5 of the pack');
    expect(msg).toContain('Do not state stage numbers');
    expect(msg).not.toContain('PICKED FROM THE TEAM');
  });

  it('lists the wrap-up changes you picked, and says to leave the others out', () => {
    const msg = buildPackUpdateMessage({
      teamName: 'T', taskTitle: 'X', brief: 'b', pack: [], conversation: [], version: 2,
      changes: ['Show the saving as a range.', 'Split cash timing out.'],
    });
    expect(msg).toContain("THE CHANGES THE USER PICKED FROM THE TEAM'S WRAP-UP\n- Show the saving as a range.\n- Split cash timing out.");
    expect(msg).toMatch(/not on this\nlist, the user chose not to make it/);
  });
});

describe('sourceFlowIdOfPiece / withStepTools', () => {
  it('finds the member flow a piece came from', () => {
    expect(sourceFlowIdOfPiece(teamPieceFlowId('budget'))).toBe('budget');
    expect(sourceFlowIdOfPiece(teamPieceFlowId('budget', { check: true }))).toBe('budget');
    expect(sourceFlowIdOfPiece(teamPieceFlowId('budget', { readOnly: true }))).toBe('budget');
    expect(sourceFlowIdOfPiece('budget')).toBe('budget');
  });

  it('makes a piece that only reads from a flow that can do more, so it never asks', () => {
    const f = {
      id: 'ops', name: 'Ops', input: 'user_prompt', source: 'user',
      participants: [{ id: 'p', backend: 'claude', model: 'claude-sonnet-5-5', name: 'Sonnet' }],
      steps: [{ id: 'work', participantId: 'p', role: 'custom', inputs: ['user_prompt'], output: 'out.md', effect: 'external',
        tools: ['Read', 'Bash', 'WebFetch', 'Bash(git log:*)', 'mcp__tracker__search_issues', 'mcp__tracker__create_issue'] }],
    } as unknown as Parameters<typeof teamPieceFlow>[0];
    const piece = teamPieceFlow(f, { readOnly: true });
    expect(piece.id).toBe('team-piece-read-ops');
    expect(piece.steps).toHaveLength(1);
    expect(piece.steps[0].effect).toBe('local');
    expect(piece.steps[0].tools.sort()).toEqual(['Bash(git log:*)', 'Edit', 'Read', 'WebSearch', 'Write', 'mcp__tracker__search_issues'].sort());
  });

  it('adds only missing tools, to the first step', () => {
    const f = { id: 'f', steps: [{ id: 'a', tools: ['Read'] }, { id: 'b', tools: ['Grep'] }] } as unknown as Parameters<typeof withStepTools>[0];
    const next = withStepTools(f, ['Read', 'Bash'])!;
    expect(next.steps.map((st) => st.tools)).toEqual([['Read', 'Bash'], ['Grep']]);
    expect(withStepTools(next, ['Bash'])).toBeNull();
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
    // Skipped when the piece only wrote notes: nothing to test, nothing to approve.
    expect(piece.steps[1].onlyIfChanged).toBe(true);
    expect(piece.steps[0].onlyIfChanged).toBeUndefined();
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

describe('a direct answer from the coordinator', () => {
  it('is read when allowed, and refused when a plan was required', async () => {
    const { parsePlanReply } = await import('./team');
    expect(parsePlanReply('<team_answer>Next is acme exports.</team_answer>', [], { allowQuestions: true, allowAnswer: true })).toEqual({ kind: 'answer', answer: 'Next is acme exports.' });
    expect(parsePlanReply('<team_answer>x</team_answer>', [], { allowQuestions: true }).kind).toBe('error');
    const q = parsePlanReply('<team_questions>["a?","b?","c?"]</team_questions>', [], { allowQuestions: true, maxQuestions: 2 });
    expect(q.kind === 'questions' && q.questions).toEqual(['a?', 'b?']);
  });
});

describe('rolloverReason', () => {
  const follow = (title: string, at = 0) => ({
    kind: 'contribute' as const,
    title,
    assignments: [],
    status: 'done' as const,
    startedAt: at,
    fromRoom: { messageId: 'm', exchange: 0 },
  });
  const base = {
    status: 'done' as const,
    pack: { summary: '', files: [], version: 6 },
    stages: [{ kind: 'synthesize' as const, title: 'Pack', assignments: [], status: 'done' as const, startedAt: 0 }],
  };

  it('stays quiet for a short task', () => {
    expect(rolloverReason({ ...base, stages: [...base.stages, follow('A'), follow('B')] }, 1000)).toBeNull();
  });

  it('speaks up after many follow-ups', () => {
    const stages = [...base.stages, ...'ABCDEFGH'.split('').map((t) => follow(t))];
    expect(rolloverReason({ ...base, stages }, 1000)).toEqual({
      title: 'This task has had 8 follow-ups since the plan',
      detail: 'Each new stage rereads a longer history. Starting fresh from Pack v6 keeps the next ask quick and its plan readable.',
    });
  });

  it('speaks up when the same follow-up runs three times in a row', () => {
    const stages = [...base.stages, follow('Re-review the workbook'), follow('re-review the workbook '), follow('Re-review the workbook')];
    expect(rolloverReason({ ...base, stages }, 1000)?.detail).toMatch(/^“Re-review the workbook” has run 3 times in a row\./);
  });

  it('speaks up after a day', () => {
    expect(rolloverReason({ ...base, stages: [...base.stages, follow('A')] }, TEAM_ROLLOVER_AGE_MS)?.detail).toMatch(/over a day/);
  });

  it('never while work runs, before a pack, or once continued', () => {
    const stages = [...base.stages, ...'ABCDEFGH'.split('').map((t) => follow(t))];
    expect(rolloverReason({ ...base, stages, status: 'running' }, 0)).toBeNull();
    expect(rolloverReason({ ...base, stages, pack: undefined }, 0)).toBeNull();
    expect(rolloverReason({ ...base, stages, continuedAs: { taskId: 't2', at: 0 } }, 0)).toBeNull();
    expect(rolloverReason({ ...base, stages, room: { messages: [], busy: { speaker: 'Maya', since: 0 } } }, 0)).toBeNull();
  });
});

describe('continuationLines', () => {
  it('points the planner at the earlier pack and what it left open', () => {
    expect(continuationLines(undefined)).toEqual([]);
    const lines = continuationLines({ taskId: 't1', title: 'Plan', packVersion: 3, stages: 9, open: ['Rank QA'], conversation: false });
    expect(lines.join('\n')).toContain('THIS CONTINUES AN EARLIER TASK: "Plan" (9 stages, pack v3).');
    expect(lines).toContain('- Rank QA');
    expect(lines.join('\n')).not.toContain('conversation.md');
  });
});
