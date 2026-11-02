import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { CiWatch } from './ciWatch';
import { continueBranchFor, type ContinueBranchDeps } from './continueBranch';
import { LANDED_ARTIFACT } from './landBranches';
import type { ConnectedRepo } from './repos';

const WS = '/data/workspaces/ws-acme';
const repo = (name: string): ConnectedRepo => ({ name, path: `/data/repos/${name}`, defaultBranch: 'main' }) as ConnectedRepo;
const API = repo('acme-api');
const WEB = repo('acme-web');

/// A workspace run that landed `body`, in a coordinator folder of its own.
function wsRun(over: Partial<FlowRun> & { landed?: string }): FlowRun {
  const { landed, ...rest } = over;
  return {
    id: 'run-1',
    workerId: 'w1',
    projectPath: '/data/coordinators/run-1',
    sourceProjectPath: WS,
    workspaceWorktrees: [{ name: 'acme-api', projectPath: API.path, worktreePath: '/wt/acme-api', branchName: 'feature/ACME-123' }],
    orchestrationItemTitle: 'ACME-123: Keep audit records per thread',
    userPrompt: 'Fix ACME-123',
    createdAt: 1,
    artifacts: landed ? { [LANDED_ARTIFACT]: { name: LANDED_ARTIFACT, kind: 'markdown', body: landed, producedByStepId: 'land', producedAt: 2 } } : {},
    ...rest,
  } as unknown as FlowRun;
}

function deps(over: Partial<ContinueBranchDeps> & { openBranches?: Record<string, string[]> } = {}): ContinueBranchDeps {
  const { openBranches = {}, ...rest } = over;
  return {
    repos: () => [API, WEB],
    workspaces: () => [{ rootPath: WS, repos: ['acme-api', 'acme-web'] }],
    runs: () => [],
    ciWatches: () => [],
    fixAskedOn: () => false,
    open: async (r, b) => (openBranches[r.name] ?? []).includes(b),
    ...rest,
  };
}

const LANDED = '- Opened a pull request for acme-api: https://git.acme.test/acme-api/pull-requests/7 (branch feature/ACME-123-keep-audit-records-ab12cd)\n- 1 other repo had no changes.';
const ask = (title: string, prompt = 'Fix the build') => ({ projectPath: WS, workerId: 'w1', title, prompt });

describe('continueBranchFor in a workspace', () => {
  it('continues the open branch an earlier run landed for the same ticket', async () => {
    const d = deps({ runs: () => [wsRun({ landed: LANDED })], openBranches: { 'acme-api': ['feature/ACME-123-keep-audit-records-ab12cd'] } });
    expect(await continueBranchFor(ask('ACME-123: Fix the test mocks so the build compiles'), d)).toBe('feature/ACME-123-keep-audit-records-ab12cd');
  });

  it('starts fresh once that branch is merged or gone', async () => {
    const d = deps({ runs: () => [wsRun({ landed: LANDED })], openBranches: {} });
    expect(await continueBranchFor(ask('ACME-123: Fix the test mocks'), d)).toBeNull();
  });

  it("doesn't follow a ticket the prompt only mentions", async () => {
    const d = deps({ runs: () => [wsRun({ landed: LANDED })], openBranches: { 'acme-api': ['feature/ACME-123-keep-audit-records-ab12cd'] } });
    expect(await continueBranchFor(ask('Fix the flaky build', 'Like ACME-123, fix the mocks'), d)).toBeNull();
  });

  it("doesn't build on another worker's branch, or another ticket's", async () => {
    const d = deps({
      runs: () => [wsRun({ landed: LANDED, workerId: 'w2' }), wsRun({ landed: LANDED, orchestrationItemTitle: 'ACME-999: Something else', userPrompt: 'ACME-999' })],
      openBranches: { 'acme-api': ['feature/ACME-123-keep-audit-records-ab12cd'] },
    });
    expect(await continueBranchFor(ask('ACME-123: Fix the test mocks'), d)).toBeNull();
  });

  it('takes the newest landed branch that is still open', async () => {
    const older = wsRun({ id: 'old', createdAt: 1, landed: '- Opened a pull request for acme-api: https://x/1 (branch feature/ACME-123-first)' });
    const newer = wsRun({ id: 'new', createdAt: 5, landed: '- Opened a pull request for acme-api: https://x/2 (branch feature/ACME-123-second)' });
    const d = deps({ runs: () => [older, newer], openBranches: { 'acme-api': ['feature/ACME-123-first', 'feature/ACME-123-second'] } });
    expect(await continueBranchFor(ask('ACME-123: Again'), d)).toBe('feature/ACME-123-second');
  });

  it("falls back to the CI watcher's record once the earlier run is pruned", async () => {
    const watch = { workerId: 'w1', repo: 'acme-api', branch: 'feature/ACME-123-keep-audit-records-ab12cd', title: 'ACME-123: Keep audit records per thread', startedAt: 3 } as CiWatch;
    const d = deps({ ciWatches: () => [watch], openBranches: { 'acme-api': [watch.branch] } });
    expect(await continueBranchFor(ask('ACME-123: Fix the test mocks'), d)).toBe(watch.branch);
  });

  it("ignores the watcher's record for a repo outside this workspace", async () => {
    const watch = { workerId: 'w1', repo: 'acme-other', branch: 'feature/ACME-123-x', title: 'ACME-123: X', startedAt: 3 } as CiWatch;
    const d = deps({ ciWatches: () => [watch], openBranches: { 'acme-api': [watch.branch] } });
    expect(await continueBranchFor(ask('ACME-123: Fix'), d)).toBeNull();
  });

  it('a reply to the CI DM, planned under the ticket, continues the red branch', async () => {
    // The reply starts a run titled for the ticket, with no marker: the
    // watcher's record of the red branch is what finds it.
    const red = { workerId: 'w1', repo: 'acme-api', branch: 'feature/ACME-123-keep-audit-records-ab12cd', title: 'ACME-123: Keep audit records per thread', startedAt: 3, status: 'gave-up', followedUp: true } as CiWatch;
    const d = deps({ ciWatches: () => [red], runs: () => [wsRun({ landed: LANDED })], openBranches: { 'acme-api': [red.branch] } });
    expect(await continueBranchFor(ask('ACME-123: Fix Session type mismatch so the build compiles', 'Continue that pull request; do not open a new one.'), d)).toBe(red.branch);
  });

  it('a CI fix with the marker continues its branch only when the watcher asked for it', async () => {
    const prompt = 'Fix CI [continue-branch: feature/ACME-5-x]';
    const open = { 'acme-web': ['feature/ACME-5-x'] };
    expect(await continueBranchFor(ask('Fix CI', prompt), deps({ openBranches: open }))).toBeNull();
    expect(await continueBranchFor(ask('Fix CI', prompt), deps({ openBranches: open, fixAskedOn: () => true }))).toBe('feature/ACME-5-x');
  });
});

describe('continueBranchFor in a repo', () => {
  it('continues the open branch an earlier repo run landed for the same ticket', async () => {
    const run = { ...wsRun({ landed: LANDED }), projectPath: API.path, sourceProjectPath: undefined, workspaceWorktrees: undefined } as unknown as FlowRun;
    const d = deps({ runs: () => [run], openBranches: { 'acme-api': ['feature/ACME-123-keep-audit-records-ab12cd'] } });
    expect(await continueBranchFor({ projectPath: API.path, workerId: 'w1', title: 'ACME-123: Follow up', prompt: '' }, d)).toBe('feature/ACME-123-keep-audit-records-ab12cd');
  });

  it("doesn't take a workspace run's branch for a repo run", async () => {
    const d = deps({ runs: () => [wsRun({ landed: LANDED, sourceProjectPath: API.path })], openBranches: { 'acme-api': ['feature/ACME-123-keep-audit-records-ab12cd'] } });
    expect(await continueBranchFor({ projectPath: API.path, workerId: 'w1', title: 'ACME-123: Follow up', prompt: '' }, d)).toBeNull();
  });
});
