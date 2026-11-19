import { describe, expect, it } from 'vitest';
import { orgTuning, type OrgTuningRun, type OrgTuningWorker } from './orgTuning';

const NOW = 100 * 86_400_000;
const DAY = 86_400_000;

const worker = (id: string, over: Partial<OrgTuningWorker> = {}): OrgTuningWorker => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  managerKey: 'U0PAT',
  tools: [],
  roleToolsAlways: false,
  alwaysAllow: [],
  ...over,
});

let n = 0;
const run = (workerId: string, over: Partial<OrgTuningRun> = {}): OrgTuningRun => ({
  id: `r${++n}`,
  workerId,
  flowId: 'fix',
  createdAt: NOW - DAY,
  ranSteps: ['plan'],
  stepLabels: { plan: 'Plan', push: 'Push' },
  flowName: 'Fix',
  ...over,
});

const base = { now: NOW, cleared: [] as string[], installed: ['test-systems', 'acme-tracker'] };

describe('org tuning: workers people ask for but cannot use', () => {
  const miss = (user: string, by: string, daysAgo = 1) => ({ workerId: 'mek', user, by, at: NOW - daysAgo * DAY });

  it('suggests sharing a worker with whoever keeps asking for it', () => {
    const s = orgTuning({ ...base, runs: [], workers: [worker('mek')], missed: [miss('U0EMM', 'Emm'), miss('U0EMM', 'Emm'), miss('U0EMM', 'Emm'), miss('U0ONE', 'Once')] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ title: 'Share Mek with Emm', apply: 'Share Mek with Emm', runs: 3, unit: 'asks', action: { kind: 'shareWorker', workerId: 'mek', people: ['U0EMM'] } });
  });

  it('leaves out a single ask, old asks, and retired workers', () => {
    expect(orgTuning({ ...base, runs: [], workers: [worker('mek')], missed: [miss('U0EMM', 'Emm')] })).toEqual([]);
    expect(orgTuning({ ...base, runs: [], workers: [worker('mek')], missed: [miss('U0EMM', 'Emm', 40), miss('U0EMM', 'Emm', 41)] })).toEqual([]);
    expect(orgTuning({ ...base, runs: [], workers: [], missed: [miss('U0EMM', 'Emm'), miss('U0EMM', 'Emm')] })).toEqual([]);
  });
});

describe('org tuning', () => {
  it('suggests giving a refused tool to the workers that lack it', () => {
    const s = orgTuning({
      ...base,
      workers: [worker('pilot'), worker('mek', { tools: ['test-systems'], roleToolsAlways: true })],
      runs: [
        run('pilot', { refusedTools: ['mcp__test-systems__open_system', 'mcp__test-systems__browser_take_screenshot'] }),
        run('pilot', { refusedTools: ['mcp__test-systems__open_system'] }),
        run('mek', { refusedTools: ['mcp__test-systems__open_system'] }),
      ],
    });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'give:test-systems', runs: 2, workers: ['Pilot'], action: { kind: 'giveTool', tool: 'test-systems', workerIds: ['pilot'] } });
    expect(s[0].why).toContain('2 runs by Pilot were refused test-systems');
  });

  it('suggests letting any manager give it when several managers’ workers need it', () => {
    const s = orgTuning({
      ...base,
      workers: [worker('pilot'), worker('scout', { managerKey: 'U0SAM' })],
      runs: [run('pilot', { refusedTools: ['mcp__test-systems__open_system'] }), run('scout', { refusedTools: ['mcp__test-systems__open_system'] })],
    });
    expect(s.map((x) => x.id)).toEqual(['give:test-systems', 'clear:test-systems']);
    // Already cleared: no rule to change.
    expect(orgTuning({ ...base, cleared: ['test-systems'], workers: [worker('pilot'), worker('scout', { managerKey: 'U0SAM' })], runs: [run('pilot', { refusedTools: ['mcp__test-systems__x'] }), run('scout', { refusedTools: ['mcp__test-systems__x'] })] }).map((x) => x.id)).toEqual(['give:test-systems']);
  });

  it('suggests letting a worker use the tools it has, when it was refused one in a run it started alone', () => {
    const s = orgTuning({ ...base, workers: [worker('pilot', { tools: ['test-systems'] })], runs: [run('pilot', { refusedTools: ['mcp__test-systems__open_system'], refusedHeld: ['test-systems'] })] });
    expect(s[0].action).toEqual({ kind: 'useOwnTools', workerIds: ['pilot'] });
    // Refused back when it lacked it, and given since: nothing left to fix.
    expect(orgTuning({ ...base, workers: [worker('pilot', { tools: ['test-systems'] })], runs: [run('pilot', { refusedTools: ['mcp__test-systems__open_system'] })] })).toEqual([]);
  });

  it('leaves out tools not installed, old runs, built-in tools and retired workers', () => {
    const s = orgTuning({
      ...base,
      workers: [worker('pilot')],
      runs: [
        run('pilot', { refusedTools: ['mcp__unknown__x', 'Write', 'Bash'] }),
        run('pilot', { refusedTools: ['mcp__test-systems__x'], createdAt: NOW - 40 * DAY }),
        run('gone', { refusedTools: ['mcp__test-systems__x'] }),
      ],
    });
    expect(s).toEqual([]);
  });

  it('suggests always allowing a step that stops for an OK every run and is always approved', () => {
    const paused = (ran: boolean) => run('pilot', { pausedSteps: [{ stepId: 'push', reason: 'externalAction', at: NOW - DAY }], ranSteps: ran ? ['plan', 'push'] : ['plan'] });
    const s = orgTuning({ ...base, workers: [worker('pilot')], runs: [paused(true), paused(true), paused(true), paused(true)] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ title: 'Let Pilot run “Push” without asking', action: { kind: 'alwaysAllowStep', workerId: 'pilot', key: 'fix/push' } });
    expect(s[0].why).toContain('approved every time');

    // Too few, too often turned down, already allowed, or a checkpoint: nothing.
    expect(orgTuning({ ...base, workers: [worker('pilot')], runs: [paused(true), paused(true)] })).toEqual([]);
    expect(orgTuning({ ...base, workers: [worker('pilot')], runs: [paused(true), paused(false), paused(false), paused(true)] })).toEqual([]);
    expect(orgTuning({ ...base, workers: [worker('pilot', { alwaysAllow: ['fix/push'] })], runs: [paused(true), paused(true), paused(true)] })).toEqual([]);
    const checkpoint = run('pilot', { pausedSteps: [{ stepId: 'push', reason: 'preStep', at: 0 }], ranSteps: ['push'] });
    expect(orgTuning({ ...base, workers: [worker('pilot')], runs: [checkpoint, checkpoint, checkpoint] })).toEqual([]);
  });
});

describe('org tuning: a tool its job names that no step uses', () => {
  const gather = { id: 'gather', tools: ['Read', 'mcp__acme-tracker__get_issue'], text: 'Read every open ticket in the tracker.' };
  const rank = { id: 'rank', tools: ['Read', 'Write'], text: 'Rank what gather found.' };
  const ranker = (over: Partial<OrgTuningWorker> = {}) =>
    worker('oscar', {
      tools: ['acme-tracker', 'overapi-roadboard'],
      job: 'Rank the review queue. For each ticket, find its linked Roadboard feature and its insight count.',
      flows: [{ name: 'Queue ranking', steps: [gather, rank] }],
      ...over,
    });
  const runs = [run('oscar', { createdAt: NOW - 2 * DAY }), run('oscar', { createdAt: NOW - DAY })];

  it('says so when the job names it, by name or by its last word, and no step lists or mentions it', () => {
    const s = orgTuning({ ...base, runs, workers: [ranker()] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      id: 'unused:oscar:overapi-roadboard',
      title: 'Oscar’s job uses overapi-roadboard, but no step of its flow does',
      apply: 'Change Oscar’s flow',
      runs: 2,
      lastAt: NOW - DAY,
      action: { kind: 'tuneFlow', workerId: 'oscar', tool: 'overapi-roadboard', ask: expect.stringContaining('Add overapi-roadboard to the step') },
    });
    expect(s[0].why).toContain('“Queue ranking”');
  });

  it('goes away once a step lists it, by tool or by server, or says to use it', () => {
    const listed = (tools: string[]) => ranker({ flows: [{ name: 'Queue ranking', steps: [{ ...gather, tools: [...gather.tools, ...tools] }, rank] }] });
    expect(orgTuning({ ...base, runs, workers: [listed(['mcp__overapi-roadboard__feature_get'])] })).toEqual([]);
    expect(orgTuning({ ...base, runs, workers: [listed(['mcp__overapi-roadboard'])] })).toEqual([]);
    expect(orgTuning({ ...base, runs, workers: [ranker({ flows: [{ name: 'Queue ranking', steps: [{ ...gather, text: 'Then read each Roadboard feature.' }, rank] }] })] })).toEqual([]);
  });

  it('still says so when only a step that reads files names it', () => {
    const s = orgTuning({ ...base, runs, workers: [ranker({ flows: [{ name: 'Queue ranking', steps: [gather, { ...rank, text: 'Rank by Roadboard insight count.' }] }] })] });
    expect(s.map((x) => x.id)).toEqual(['unused:oscar:overapi-roadboard']);
  });

  it('stays quiet for a tool the job never names, a step that may use any tool, or a worker with no runs', () => {
    expect(orgTuning({ ...base, runs, workers: [ranker({ job: 'Rank the review queue.' })] })).toEqual([]);
    expect(orgTuning({ ...base, runs, workers: [ranker({ flows: [{ name: 'Queue ranking', steps: [gather, { id: 'rank', text: 'Rank.' }] }] })] })).toEqual([]);
    expect(orgTuning({ ...base, runs: [], workers: [ranker()] })).toEqual([]);
  });

  it('doesn’t take a short or common last word for the tool', () => {
    expect(orgTuning({ ...base, runs, workers: [ranker({ tools: ['acme-tracker', 'team-db'], job: 'Use the db for counts.' })] })).toEqual([]);
  });
});
