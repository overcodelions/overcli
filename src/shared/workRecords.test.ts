import { describe, expect, it } from 'vitest';

import type { Conversation } from './types';
import type { FlowRun } from './flows/schema';
import type { Orchestration } from './flows/orchestration';
import {
  buildWorkRecords,
  extractTicket,
  gitSummary,
  repoSummary,
  searchWorkRecords,
  titleFromPrompt,
  transcriptHitsByRecord,
  type WorkLogEntry,
  type WorkPlace,
} from './workRecords';

const DAY = 24 * 60 * 60 * 1000;

function conv(p: Partial<Conversation> & { id: string; name: string }): Conversation {
  return {
    createdAt: 1_000,
    totalCostUSD: 0,
    turnCount: 3,
    currentModel: 'x',
    permissionMode: 'default',
    ...p,
  } as Conversation;
}

function run(p: Partial<FlowRun> & { id: string }): FlowRun {
  return {
    flowId: 'ticket-to-pr',
    flowSnapshot: { name: 'Ticket → PR' },
    projectPath: '/code/acme',
    userPrompt: 'Build the thing',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done' },
    createdAt: 2_000,
    attempts: [],
    ...p,
  } as unknown as FlowRun;
}

const acme: WorkPlace = { path: '/code/acme', name: 'acme', conversations: [] };

describe('buildWorkRecords', () => {
  it('moves a run up when you talk to one of its steps', () => {
    const records = buildWorkRecords({
      places: [acme],
      runs: [
        run({ id: 'old', createdAt: 1 * DAY, attempts: [{ stepId: 's', startedAt: 1 * DAY, endedAt: 1 * DAY }] as never, lastUserTurnAt: 9 * DAY }),
        run({ id: 'new', createdAt: 5 * DAY, attempts: [{ stepId: 's', startedAt: 5 * DAY, endedAt: 5 * DAY }] as never }),
      ],
      log: [],
      orchestrations: [],
      prsByRepo: {},
    });
    expect(records.map((r) => r.runs[0].id)).toEqual(['old', 'new']);
    expect(records[0].updatedAt).toBe(9 * DAY);
  });

  it('joins a run, its follow-up chat and the PR on the same branch into one record', () => {
    const records = buildWorkRecords({
      places: [
        {
          ...acme,
          conversations: [
            conv({ id: 'c1', name: 'fix mcp server launch', branchName: 'feat/developer-mcp', createdAt: 5 * DAY }),
          ],
        },
      ],
      runs: [
        run({
          id: 'r1',
          userPrompt: 'Expose runs over MCP for developer tools',
          branchName: 'feat/developer-mcp',
          worktreePath: '/wt/acme/dev-mcp',
          sourceProjectPath: '/code/acme',
          createdAt: 3 * DAY,
        }),
      ],
      log: [],
      orchestrations: [],
      prsByRepo: {
        '/code/acme': [
          { number: 45, url: 'u', state: 'MERGED', title: 'Developer MCP server', headRefName: 'feat/developer-mcp' },
        ],
      },
    });
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.title).toBe('Developer MCP server');
    expect(r.status).toBe('merged');
    expect(r.runs.map((x) => x.id)).toEqual(['r1']);
    expect(r.chats.map((x) => x.id)).toEqual(['c1']);
    expect(r.startedAt).toBe(3 * DAY);
  });

  it('keeps a chat with no branch as a record of its own, and skips empty chats', () => {
    const records = buildWorkRecords({
      places: [
        {
          ...acme,
          conversations: [conv({ id: 'a', name: 'one' }), conv({ id: 'b', name: 'two' }), conv({ id: 'e', name: 'empty', turnCount: 0 })],
        },
      ],
      runs: [],
      log: [],
      orchestrations: [],
      prsByRepo: {},
    });
    expect(records.map((r) => r.key).sort()).toEqual(['chat:a', 'chat:b']);
    expect(records.every((r) => r.kind === 'chat' && r.status === 'chat')).toBe(true);
  });

  it('never links work through a trunk branch', () => {
    const records = buildWorkRecords({
      places: [{ ...acme, conversations: [conv({ id: 'a', name: 'x', branchName: 'main' }), conv({ id: 'b', name: 'y', branchName: 'main' })] }],
      runs: [],
      log: [],
      orchestrations: [],
      prsByRepo: {},
    });
    expect(records).toHaveLength(2);
  });

  it('hides a run’s participant chats behind the run', () => {
    const records = buildWorkRecords({
      places: [{ ...acme, conversations: [conv({ id: 'p1', name: 'planner', hidden: true })] }],
      runs: [run({ id: 'r1', conversationIds: { planner: 'p1' } })],
      log: [],
      orchestrations: [],
      prsByRepo: {},
    });
    expect(records).toHaveLength(1);
    expect(records[0].chats).toEqual([]);
  });

  it('falls back to the work log for runs that were evicted, preferring the live run when both exist', () => {
    const log: WorkLogEntry[] = [
      { runId: 'gone', flowName: 'Plan + Build', title: 'we need an MCP for deveopers', prompt: 'we need an MCP for deveopers', ownerPath: '/code/acme', at: 9, outcome: 'done', backfilled: true },
      { runId: 'r1', flowName: 'stale', title: 'stale', prompt: 'stale', ownerPath: '/code/acme', at: 1, outcome: 'done' },
    ];
    const records = buildWorkRecords({ places: [acme], runs: [run({ id: 'r1' })], log, orchestrations: [], prsByRepo: {} });
    const gone = records.find((r) => r.key === 'run:gone');
    expect(gone?.runs[0].retained).toBe(false);
    expect(gone?.title).toBe('we need an MCP for deveopers');
    expect(records.find((r) => r.key === 'run:r1')?.runs[0].flowName).toBe('Ticket → PR');
  });

  it('puts a batch item’s run under the batch, titled by the item', () => {
    const orchestration = {
      id: 'o1',
      title: 'Nightly',
      projectPath: '/code/acme',
      maxConcurrent: 1,
      items: [{ candidate: { id: 'k', title: 'Tidy labels', prompt: 'tidy the labels' }, flowId: 'f', status: 'done', runId: 'r1' }],
      origin: { kind: 'worker', workerId: 'w', workerName: 'Prometheus' },
      createdAt: 0,
    } as unknown as Orchestration;
    const [r] = buildWorkRecords({ places: [acme], runs: [run({ id: 'r1' })], log: [], orchestrations: [orchestration], prsByRepo: {} });
    expect(r.kind).toBe('batch');
    expect(r.title).toBe('Tidy labels');
    expect(r.jobs).toEqual([{ orchestrationId: 'o1', title: 'Nightly', workerName: 'Prometheus' }]);
  });

  it('finds a workspace PR in a member repo', () => {
    const ws: WorkPlace = { path: '/ws/acme', name: 'acme ws', memberPaths: ['/code/api'], conversations: [conv({ id: 'c', name: 'x', branchName: 'feat/a' })] };
    const [r] = buildWorkRecords({
      places: [ws],
      runs: [],
      log: [],
      orchestrations: [],
      prsByRepo: { '/code/api': [{ number: 7, url: 'u', state: 'OPEN', title: 'A', headRefName: 'feat/a' }] },
    });
    expect(r.pr?.number).toBe(7);
    expect(r.status).toBe('pr-open');
  });
});

describe('searchWorkRecords', () => {
  const records = buildWorkRecords({
    places: [{ ...acme, conversations: [conv({ id: 'a', name: 'Developer MCP server' }), conv({ id: 'b', name: 'Handoff inbox' })] }],
    runs: [],
    log: [],
    orchestrations: [],
    prsByRepo: {},
  });

  it('needs every word, in any field and any order', () => {
    expect(searchWorkRecords(records, 'mcp developer').map((m) => m.record.key)).toEqual(['chat:a']);
    expect(searchWorkRecords(records, 'mcp inbox')).toEqual([]);
  });

  it('marks the hit for the snippet', () => {
    const [m] = searchWorkRecords(records, 'inbox');
    expect(m.snippet?.hit.toLowerCase()).toBe('inbox');
  });

  it('includes records whose typed prompts matched even when the names do not', () => {
    const withSession = buildWorkRecords({
      places: [{ ...acme, conversations: [conv({ id: 'z', name: 'untitled', sessionId: 's1' })] }],
      runs: [],
      log: [],
      orchestrations: [],
      prsByRepo: {},
    });
    const hits = transcriptHitsByRecord(withSession, [{ sessionId: 's1', cwd: '/code/acme', snippet: 'we need an MCP for developers', at: 1 }]);
    const found = searchWorkRecords(withSession, 'mcp', hits);
    expect(found).toHaveLength(1);
    expect(found[0].fromTranscript).toBe(true);
  });

  it('maps a coordinator transcript to its run by the run id in the cwd', () => {
    const recs = buildWorkRecords({
      places: [acme],
      runs: [],
      log: [{ runId: 'cca8', flowName: 'F', title: 't', prompt: 'p', ownerPath: '/code/acme', at: 1, outcome: 'done' }],
      orchestrations: [],
      prsByRepo: {},
    });
    const hits = transcriptHitsByRecord(recs, [{ sessionId: 'x', cwd: '/data/coordinators/cca8', snippet: 'mcp', at: 1 }]);
    expect(hits.get('run:cca8')).toBeDefined();
  });
});

describe('helpers', () => {
  it('titleFromPrompt skips attachment lines and caps length', () => {
    expect(titleFromPrompt('[Attached file: a.md]\nReview this spec')).toBe('Review this spec');
    expect(titleFromPrompt('x'.repeat(200)).length).toBe(90);
  });

  it('extractTicket finds Jira keys, issue URLs and closing keywords, but not branch prefixes', () => {
    expect(extractTicket('feature/devops-6949-rename')).toBe('DEVOPS-6949');
    expect(extractTicket(undefined, 'see https://github.com/acme/app/issues/531')).toBe('#531');
    expect(extractTicket(undefined, 'this closes #12')).toBe('#12');
    expect(extractTicket(undefined, 'Fix ACME-42 today')).toBe('ACME-42');
    expect(extractTicket('feat/v2-thing', 'fix-1 later')).toBeUndefined();
    // Prose in lower case, and counters that look like keys, are not tickets.
    expect(extractTicket(undefined, 'verify all 17 shift-25 findings', 'SHIFT-26 report')).toBeUndefined();
  });
});

describe('git status', () => {
  it('a chat in the main checkout joins the branch the checkout was on', () => {
    const records = buildWorkRecords({
      places: [{ ...acme, conversations: [conv({ id: 'a', name: 'x', baseBranch: 'feat/a' }), conv({ id: 'b', name: 'y', baseBranch: 'main' })] }],
      runs: [],
      log: [],
      orchestrations: [],
      prsByRepo: { '/code/acme': [{ number: 9, url: 'u', state: 'MERGED', title: 'A', headRefName: 'feat/a' }] },
    });
    const a = records.find((r) => r.chats.some((c) => c.id === 'a'));
    expect(a?.pr?.number).toBe(9);
    expect(records.find((r) => r.chats.some((c) => c.id === 'b'))?.branch).toBeUndefined();
  });

  it('marks a branch landed when its own commits are in the trunk, not when it was never committed to', () => {
    const base = { local: true, remote: true, trunk: 'main', ahead: 0, behind: 0, unpushed: 0, inTrunk: true };
    const build = (lastCommitAt: number) =>
      buildWorkRecords({
        places: [{ ...acme, conversations: [conv({ id: 'a', name: 'x', branchName: 'feat/a', createdAt: 10 * DAY })] }],
        runs: [],
        log: [],
        orchestrations: [],
        prsByRepo: {},
        branchStatus: { '/code/acme::feat/a': { ...base, lastCommitAt } },
      })[0];
    expect(build(11 * DAY).status).toBe('landed');
    expect(build(2 * DAY).status).toBe('chat');
  });

  it('summarises where a branch stands', () => {
    const g = { local: true, remote: false, trunk: 'main', ahead: 3, behind: 0, unpushed: 0, inTrunk: false };
    expect(gitSummary(g)).toBe('not pushed · 3 ahead of main');
    expect(gitSummary({ ...g, remote: true, unpushed: 1 })).toBe('1 unpushed · 3 ahead of main');
    expect(gitSummary({ ...g, remote: true, ahead: 0, inTrunk: true })).toBe('in main');
    expect(gitSummary({ ...g, local: false, remote: false })).toBe('branch deleted');
    // Landed: whether the branch itself was pushed no longer matters.
    expect(gitSummary({ ...g, ahead: 0, inTrunk: true, cutOnly: false })).toBe('in main');
    expect(gitSummary({ ...g, ahead: 0, inTrunk: true, cutOnly: false, squashMerged: true })).toBe('squash-merged into main');
    // Pushed, then deleted on the remote after its PR merged — not "not pushed".
    expect(gitSummary({ ...g, remoteGone: true })).toBe('deleted on remote · 3 ahead of main');
    expect(repoSummary({ repoGit: [
      { repo: '/r/a', branch: 'b', status: { ...g, remoteGone: true } },
      { repo: '/r/b', branch: 'b', status: { ...g, remote: true } },
    ] })).toBe('2 repos · 2 pushed');
  });
});

describe('repos a piece of work touched', () => {
  const status = (p: Partial<import('./workRecords').BranchStatus>) => ({
    local: true, remote: true, trunk: 'main', ahead: 0, behind: 0, unpushed: 0, inTrunk: false, ...p,
  });
  const ws: WorkPlace = { path: '/ws/acme', name: 'acme ws', memberPaths: ['/code/api', '/code/web', '/code/docs'], conversations: [] };
  const wsRun = run({
    id: 'r1',
    projectPath: '/data/coordinators/r1',
    sourceProjectPath: '/ws/acme',
    userPrompt: 'ACME-42 fix the login',
    createdAt: 5 * DAY,
    workspaceWorktrees: [
      { name: 'api', projectPath: '/code/api', worktreePath: '/wt/api', branchName: 'feature/ACME-42' },
      { name: 'web', projectPath: '/code/web', worktreePath: '/wt/web', branchName: 'feature/ACME-42' },
      { name: 'docs', projectPath: '/code/docs', worktreePath: '/wt/docs', branchName: 'feature/ACME-42' },
    ],
  } as never);

  it('keeps only the member repos the run committed to', () => {
    const [r] = buildWorkRecords({
      places: [ws],
      runs: [wsRun],
      log: [],
      orchestrations: [],
      prsByRepo: {},
      branchStatus: {
        '/code/api::feature/ACME-42': status({ ahead: 2, lastCommitAt: 6 * DAY }),
        '/code/web::feature/ACME-42': status({ local: true, remote: false, ahead: 1 }),
        // Cut but never committed to: its tip is on the trunk's own line.
        '/code/docs::feature/ACME-42': status({ inTrunk: true, cutOnly: true, lastCommitAt: 9 * DAY }),
      },
    });
    expect(r.repoBranches).toHaveLength(3);
    expect(r.repoGit.map((g) => g.repo).sort()).toEqual(['/code/api', '/code/web']);
    expect(repoSummary(r)).toBe('2 repos · 1 pushed · 1 not pushed');
  });

  it('pulls in branches named for the ticket and lands the record when they are all in the trunk', () => {
    const [r] = buildWorkRecords({
      places: [{ ...ws, conversations: [conv({ id: 'c', name: 'ACME-42 follow-up' })] }],
      runs: [],
      log: [],
      orchestrations: [],
      prsByRepo: {},
      ticketBranches: { 'ACME-42': [{ repo: '/code/api', branch: 'feature/acme-42-hotfix' }] },
      branchStatus: { '/code/api::feature/acme-42-hotfix': status({ inTrunk: true, cutOnly: false, lastCommitAt: 1 }) },
    });
    expect(r.repoGit.map((g) => g.branch)).toEqual(['feature/acme-42-hotfix']);
    expect(r.status).toBe('landed');
  });
});

describe('uncommitted work and empty branches', () => {
  it('counts a worktree with uncommitted changes, and says an empty branch has no commits', () => {
    const g = { local: true, remote: false, trunk: 'main', ahead: 0, behind: 0, unpushed: 0, inTrunk: true, cutOnly: true };
    expect(gitSummary(g)).toBe('no commits yet');
    expect(gitSummary({ ...g, uncommitted: 3 })).toBe('3 uncommitted files');
    expect(gitSummary({ ...g, cutOnly: false, remote: true })).toBe('in main');
  });
});
