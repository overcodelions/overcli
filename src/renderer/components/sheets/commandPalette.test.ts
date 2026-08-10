import { describe, expect, it } from 'vitest';
import type { Conversation, Project, Workspace } from '@shared/types';
import type { Flow, FlowRun } from '@shared/flows/schema';
import {
  adjacentGroupStart,
  buildPaletteGroups,
  buildPaletteItems,
  flattenGroups,
  groupStartIndices,
  matchText,
  matchesScope,
  recencyBonus,
  scopeCounts,
  scoreItem,
  sectionFor,
  arrowStepFromQueryEdge,
  shortenPath,
  type PaletteCommand,
  type PaletteItem,
} from './commandPalette';

const NOW = 1_700_000_000_000;

function conv(id: string, name: string, opts: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name,
    createdAt: NOW - 60_000,
    totalCostUSD: 0,
    turnCount: 0,
    currentModel: 'claude',
    permissionMode: 'default',
    ...opts,
  };
}

function project(id: string, name: string, conversations: Conversation[] = []): Project {
  return { id, name, path: `/Users/me/git/${name}`, conversations };
}

function workspace(id: string, name: string, conversations: Conversation[] = []): Workspace {
  return {
    id,
    name,
    projectIds: ['p1'],
    rootPath: `/Users/me/.overcli/workspaces/${name}`,
    conversations,
    createdAt: NOW - 3_600_000,
  };
}

function flow(id: string, name: string, opts: Partial<Flow> = {}): Flow {
  return {
    id,
    name,
    input: 'user_prompt',
    participants: [],
    steps: [],
    source: 'user',
    filePath: `/Users/me/.overcli/flows/${id}.yaml`,
    ...opts,
  };
}

function run(id: string, opts: Partial<FlowRun> = {}): FlowRun {
  return {
    id,
    flowId: 'coverage',
    flowSnapshot: flow('coverage', 'Coverage gap report'),
    projectPath: '/Users/me/git/unifyr',
    userPrompt: 'Analyze test coverage gaps',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done', success: true },
    createdAt: NOW - 120_000,
    attempts: [],
    ...opts,
  } as FlowRun;
}

function command(id: string, title: string, keywords?: string[]): PaletteCommand {
  return { id, title, keywords, run: () => {} };
}

function emptyInput() {
  return {
    projects: [],
    workspaces: [],
    runs: [],
    flows: [],
    commands: [],
    runningIds: new Set<string>(),
    lastSelectedAt: {},
    lastOpenedAtByRun: {},
  };
}

function find(items: PaletteItem[], key: string): PaletteItem {
  const hit = items.find((i) => i.key === key);
  if (!hit) throw new Error(`no palette item ${key}; have ${items.map((i) => i.key).join(', ')}`);
  return hit;
}

describe('matchText', () => {
  it('ranks exact over prefix over word-boundary over mid-word', () => {
    const exact = matchText('deploy', 'deploy')!.score;
    const prefix = matchText('deploy the thing', 'deploy')!.score;
    const boundary = matchText('run deploy now', 'deploy')!.score;
    const midWord = matchText('undeployed', 'deploy')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(midWord);
  });

  it('reports matched offsets for substring hits', () => {
    expect(matchText('run deploy now', 'deploy')!.positions).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('falls back to a subsequence match and ignores spaces in the query', () => {
    expect(matchText('Coverage gap report', 'cvggap')).not.toBeNull();
    expect(matchText('Coverage gap report', 'cov gap')).not.toBeNull();
    expect(matchText('Coverage gap report', 'zzz')).toBeNull();
  });

  it('scores a substring hit above a subsequence hit', () => {
    const substring = matchText('coverage report', 'coverage')!.score;
    const subsequence = matchText('coverage report', 'cvrge')!.score;
    expect(substring).toBeGreaterThan(subsequence);
  });

  it('prefers the shorter of two titles that both match at the front', () => {
    const short = matchText('deploy', 'dep')!.score;
    const long = matchText('deploy the whole staging environment', 'dep')!.score;
    expect(short).toBeGreaterThan(long);
  });
});

describe('buildPaletteItems', () => {
  it('indexes chats, agents, projects, workspaces, runs, flows and commands', () => {
    const chat = conv('c1', 'plain chat');
    const agent = conv('c2', 'agent chat', { worktreePath: '/wt/a', branchName: 'agent/x' });
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [project('p1', 'unifyr', [chat, agent])],
      workspaces: [workspace('w1', 'lions-nov')],
      runs: [run('r1')],
      flows: [flow('f1', 'Ship it')],
      commands: [command('settings', 'Settings')],
    });
    expect(find(items, 'conv:c1').kind).toBe('chat');
    expect(find(items, 'conv:c2').kind).toBe('agent');
    expect(find(items, 'project:p1').kind).toBe('project');
    expect(find(items, 'workspace:w1').kind).toBe('workspace');
    expect(find(items, 'run:r1').kind).toBe('run');
    expect(find(items, 'flow:user:f1').kind).toBe('flow');
    expect(find(items, 'command:settings').kind).toBe('command');
  });

  it('marks hidden conversations and archived runs as archived', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [project('p1', 'unifyr', [conv('c1', 'old thread', { hidden: true })])],
      runs: [run('r1', { state: { kind: 'archived' } })],
    });
    expect(find(items, 'conv:c1').archived).toBe(true);
    expect(find(items, 'conv:c1').status).toBe('archived');
    expect(find(items, 'run:r1').archived).toBe(true);
  });

  it('treats a run as running while one of its participants streams', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      runs: [run('r1', { conversationIds: { planner: 'c9' } })],
      runningIds: new Set(['c9']),
    });
    expect(find(items, 'run:r1').status).toBe('running');
  });

  it('maps flow run states to statuses', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      runs: [
        run('paused', { state: { kind: 'paused', nextStepId: 's', reason: 'failure' } }),
        run('watch', { state: { kind: 'watching', watch: { escalated: false } } as FlowRun['state'] }),
        run('bad', { state: { kind: 'done', success: false } }),
        run('stopped', { state: { kind: 'aborted' } }),
      ],
    });
    expect(find(items, 'run:paused').status).toBe('paused');
    expect(find(items, 'run:watch').status).toBe('watching');
    expect(find(items, 'run:bad').status).toBe('failed');
    expect(find(items, 'run:stopped').status).toBe('failed');
  });

  it('carries branch and session id as searchable keywords', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [
        project('p1', 'unifyr', [
          conv('c1', 'nameless', { branchName: 'feature/WOW-4962', sessionId: 'sess-abc' }),
        ]),
      ],
    });
    const item = find(items, 'conv:c1');
    expect(item.keywords).toContain('feature/WOW-4962');
    expect(item.keywords).toContain('sess-abc');
  });

  it('lights a project or workspace up while one of its chats streams', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [project('p1', 'unifyr', [conv('c1', 'chat')])],
      workspaces: [workspace('w1', 'lions-nov', [conv('c2', 'chat')])],
      runningIds: new Set(['c2']),
    });
    expect(find(items, 'project:p1').status).toBe('idle');
    expect(find(items, 'workspace:w1').status).toBe('running');
  });

  it('uses the last selected time when it is newer than the conversation activity', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [project('p1', 'unifyr', [conv('c1', 'chat', { lastPromptAt: NOW - 500_000 })])],
      lastSelectedAt: { c1: NOW },
    });
    expect(find(items, 'conv:c1').recency).toBe(NOW);
  });
});

describe('scoreItem', () => {
  const items = buildPaletteItems({
    ...emptyInput(),
    projects: [project('p1', 'unifyr', [conv('c1', 'unifyr rollout notes')])],
  });

  it('puts an exact project-name match above a chat that merely contains it', () => {
    const proj = scoreItem(find(items, 'project:p1'), 'unifyr', NOW)!;
    const chat = scoreItem(find(items, 'conv:c1'), 'unifyr', NOW)!;
    expect(proj.score).toBeGreaterThan(chat.score);
  });

  it('highlights only title matches, not keyword matches', () => {
    const byTitle = scoreItem(find(items, 'conv:c1'), 'rollout', NOW)!;
    expect(byTitle.positions.length).toBeGreaterThan(0);
    const byKeyword = scoreItem(find(items, 'conv:c1'), 'sess-none', NOW);
    expect(byKeyword).toBeNull();
  });

  it('returns null when nothing in the item matches', () => {
    expect(scoreItem(find(items, 'project:p1'), 'zqxj', NOW)).toBeNull();
  });

  it('penalises archived items but still lets an exact match through', () => {
    const both = buildPaletteItems({
      ...emptyInput(),
      projects: [
        project('p1', 'unifyr', [
          conv('live', 'release checklist'),
          conv('old', 'release checklist', { hidden: true }),
        ]),
      ],
    });
    const live = scoreItem(find(both, 'conv:live'), 'release checklist', NOW)!;
    const archived = scoreItem(find(both, 'conv:old'), 'release checklist', NOW)!;
    expect(archived.score).toBeLessThan(live.score);
    expect(archived.score).toBeGreaterThan(0);
  });

  it('boosts a running conversation over an identical idle one', () => {
    const two = buildPaletteItems({
      ...emptyInput(),
      projects: [project('p1', 'unifyr', [conv('a', 'build the thing'), conv('b', 'build the thing')])],
      runningIds: new Set(['a']),
    });
    const running = scoreItem(find(two, 'conv:a'), 'build', NOW)!;
    const idle = scoreItem(find(two, 'conv:b'), 'build', NOW)!;
    expect(running.score).toBeGreaterThan(idle.score);
  });
});

describe('recencyBonus', () => {
  it('decays through the tiers and bottoms out', () => {
    expect(recencyBonus(NOW, NOW - 1_000)).toBe(40);
    expect(recencyBonus(NOW, NOW - 30 * 60_000)).toBe(28);
    expect(recencyBonus(NOW, NOW - 5 * 3_600_000)).toBe(16);
    expect(recencyBonus(NOW, NOW - 3 * 24 * 3_600_000)).toBe(6);
    expect(recencyBonus(NOW, NOW - 30 * 24 * 3_600_000)).toBe(0);
  });

  it('gives nothing to items with no timeline', () => {
    expect(recencyBonus(NOW, 0)).toBe(0);
  });
});

describe('subtitle and keyword matching', () => {
  function bare(title: string, rest: Partial<PaletteItem> = {}): PaletteItem {
    return {
      key: 'x',
      kind: 'chat',
      title,
      status: 'idle',
      archived: false,
      recency: 0,
      target: { type: 'command', commandId: 'x' },
      ...rest,
    };
  }

  it('matches on the subtitle when the title has nothing', () => {
    const hit = scoreItem(bare('zzz', { subtitle: 'quarterly planning' }), 'quarterly', NOW);
    expect(hit).not.toBeNull();
    // No highlight: the offsets would point into the subtitle, not the title.
    expect(hit!.positions).toEqual([]);
  });

  it('ranks a title match above the same text in a subtitle or keyword', () => {
    const title = scoreItem(bare('quarterly planning'), 'quarterly', NOW)!.score;
    const keyword = scoreItem(bare('zzz', { keywords: ['quarterly planning'] }), 'quarterly', NOW)!
      .score;
    const subtitle = scoreItem(bare('zzz', { subtitle: 'quarterly planning' }), 'quarterly', NOW)!
      .score;
    expect(title).toBeGreaterThan(keyword);
    expect(keyword).toBeGreaterThan(subtitle);
  });
});

describe('sectionFor', () => {
  it('routes by status first, then kind, with archived winning outright', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [
        project('p1', 'unifyr', [
          conv('a', 'busy'),
          conv('b', 'quiet'),
          conv('c', 'put away', { hidden: true }),
        ]),
      ],
      flows: [flow('f1', 'Ship it')],
      commands: [command('settings', 'Settings')],
      runningIds: new Set(['a']),
    });
    expect(sectionFor(find(items, 'conv:a'))).toBe('active');
    expect(sectionFor(find(items, 'conv:b'))).toBe('recent');
    expect(sectionFor(find(items, 'conv:c'))).toBe('archived');
    expect(sectionFor(find(items, 'project:p1'))).toBe('places');
    expect(sectionFor(find(items, 'flow:user:f1'))).toBe('flows');
    expect(sectionFor(find(items, 'command:settings'))).toBe('actions');
  });
});

describe('matchesScope', () => {
  const items = buildPaletteItems({
    ...emptyInput(),
    projects: [project('p1', 'unifyr', [conv('c1', 'chat'), conv('c2', 'agent', { worktreePath: '/wt' })])],
    runs: [run('r1')],
    flows: [flow('f1', 'Ship it')],
    commands: [command('settings', 'Settings')],
  });

  it('groups chats with agents and runs with flows', () => {
    expect(matchesScope(find(items, 'conv:c1'), 'chats')).toBe(true);
    expect(matchesScope(find(items, 'conv:c2'), 'chats')).toBe(true);
    expect(matchesScope(find(items, 'run:r1'), 'flows')).toBe(true);
    expect(matchesScope(find(items, 'flow:user:f1'), 'flows')).toBe(true);
    expect(matchesScope(find(items, 'project:p1'), 'places')).toBe(true);
    expect(matchesScope(find(items, 'command:settings'), 'actions')).toBe(true);
    expect(matchesScope(find(items, 'command:settings'), 'chats')).toBe(false);
  });
});

describe('buildPaletteGroups', () => {
  const items = buildPaletteItems({
    ...emptyInput(),
    projects: [
      project('p1', 'unifyr', [
        conv('busy', 'shipping the release', { lastPromptAt: NOW - 1_000 }),
        conv('quiet', 'old notes', { lastPromptAt: NOW - 200_000 }),
        conv('gone', 'archived release notes', { hidden: true }),
      ]),
    ],
    flows: [flow('f1', 'Release checklist')],
    commands: [command('settings', 'Settings', ['preferences'])],
    runningIds: new Set(['busy']),
  });

  it('hides archived rows at rest and orders sections for browsing', () => {
    const groups = buildPaletteGroups(items, '', 'all', NOW);
    expect(groups.map((g) => g.section)).toEqual(['active', 'recent', 'places', 'flows', 'actions']);
    expect(flattenGroups(groups).some((r) => r.item.archived)).toBe(false);
  });

  it('sorts by recency at rest, newest first', () => {
    const groups = buildPaletteGroups(items, '', 'all', NOW);
    const recent = groups.find((g) => g.section === 'recent')!;
    expect(recent.items[0]!.item.title).toBe('old notes');
  });

  it('surfaces archived rows as soon as there is a query', () => {
    const titles = flattenGroups(buildPaletteGroups(items, 'archived release', 'all', NOW)).map(
      (r) => r.item.title,
    );
    expect(titles).toContain('archived release notes');
  });

  it('shows archived rows with no query under the archived scope', () => {
    const groups = buildPaletteGroups(items, '', 'archived', NOW);
    expect(groups.map((g) => g.section)).toEqual(['archived']);
    expect(groups[0]!.items).toHaveLength(1);
  });

  it('orders sections by their best hit when searching', () => {
    const groups = buildPaletteGroups(items, 'settings', 'all', NOW);
    expect(groups[0]!.section).toBe('actions');
  });

  it('finds a command by keyword as well as by title', () => {
    const titles = flattenGroups(buildPaletteGroups(items, 'preferences', 'all', NOW)).map(
      (r) => r.item.title,
    );
    expect(titles).toEqual(['Settings']);
  });

  it('restricts results to the active scope', () => {
    const groups = buildPaletteGroups(items, '', 'places', NOW);
    expect(groups.map((g) => g.section)).toEqual(['places']);
  });

  it('reports the pre-cap total per section', () => {
    const many = buildPaletteItems({
      ...emptyInput(),
      projects: [
        project(
          'p1',
          'unifyr',
          Array.from({ length: 20 }, (_, i) => conv(`c${i}`, `thread ${i}`)),
        ),
      ],
    });
    const recent = buildPaletteGroups(many, '', 'all', NOW).find((g) => g.section === 'recent')!;
    expect(recent.total).toBe(20);
    expect(recent.items.length).toBeLessThan(20);
  });
});

describe('section jumping', () => {
  const items = buildPaletteItems({
    ...emptyInput(),
    projects: [project('p1', 'unifyr', [conv('busy', 'shipping'), conv('quiet', 'notes')])],
    commands: [command('settings', 'Settings'), command('about', 'About')],
    runningIds: new Set(['busy']),
  });
  const groups = buildPaletteGroups(items, '', 'all', NOW);
  const starts = groupStartIndices(groups);

  it('indexes the first row of each section in the flattened list', () => {
    // active(1) · recent(1) · places(1) · actions(2)
    expect(starts).toEqual([0, 1, 2, 3]);
    expect(flattenGroups(groups)).toHaveLength(5);
  });

  it('steps to the adjacent section, including from mid-section', () => {
    expect(adjacentGroupStart(starts, 0, 1)).toBe(1);
    // Row 4 is the second Action; back goes to Places, not the top of Actions.
    expect(adjacentGroupStart(starts, 4, -1)).toBe(2);
  });

  it('clamps at both ends instead of wrapping', () => {
    expect(adjacentGroupStart(starts, 0, -1)).toBe(0);
    expect(adjacentGroupStart(starts, 4, 1)).toBe(3);
  });

  it('has nowhere to go with no sections', () => {
    expect(adjacentGroupStart([], 0, 1)).toBeNull();
  });
});

describe('arrowStepFromQueryEdge', () => {
  it('takes both arrows when the query is empty', () => {
    expect(arrowStepFromQueryEdge('ArrowLeft', 0, 0, 0)).toBe(-1);
    expect(arrowStepFromQueryEdge('ArrowRight', 0, 0, 0)).toBe(1);
  });

  it('leaves the caret alone mid-query', () => {
    expect(arrowStepFromQueryEdge('ArrowLeft', 3, 3, 5)).toBeNull();
    expect(arrowStepFromQueryEdge('ArrowRight', 3, 3, 5)).toBeNull();
  });

  it('steps once the caret runs out of query in that direction', () => {
    expect(arrowStepFromQueryEdge('ArrowLeft', 0, 0, 5)).toBe(-1);
    expect(arrowStepFromQueryEdge('ArrowRight', 5, 5, 5)).toBe(1);
  });

  it('treats an active selection as text navigation', () => {
    expect(arrowStepFromQueryEdge('ArrowRight', 2, 5, 5)).toBeNull();
    expect(arrowStepFromQueryEdge('ArrowLeft', 0, 3, 5)).toBeNull();
  });

  it('ignores keys that are not left or right', () => {
    expect(arrowStepFromQueryEdge('ArrowUp', 0, 0, 0)).toBeNull();
    expect(arrowStepFromQueryEdge('a', 0, 0, 0)).toBeNull();
  });
});

describe('scopeCounts', () => {
  it('counts what each chip would show, excluding archived rows at rest', () => {
    const items = buildPaletteItems({
      ...emptyInput(),
      projects: [project('p1', 'unifyr', [conv('c1', 'chat'), conv('c2', 'gone', { hidden: true })])],
      commands: [command('settings', 'Settings')],
    });
    const resting = scopeCounts(items, '', NOW);
    expect(resting.chats).toBe(1);
    expect(resting.archived).toBe(1);
    expect(resting.places).toBe(1);
    expect(resting.actions).toBe(1);
    expect(resting.all).toBe(3);
  });
});

describe('shortenPath', () => {
  it('collapses the home directory', () => {
    expect(shortenPath('/Users/me/git/overcli')).toBe('~/git/overcli');
    expect(shortenPath('/opt/src')).toBe('/opt/src');
  });
});
