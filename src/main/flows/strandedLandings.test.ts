// Real-git test for the stranded-landing audit.
//
// No `../git` mock, for the same reason runtime.realGit.test.ts has none: the
// claims here are about what git itself reports — that `merge-base
// --is-ancestor` exits 1 for diverged work and 128 for a missing object, that
// `merge-tree --write-tree` exits 1 on conflict, and that a cherry-picked
// commit merges to base's own tree. A mock could only repeat those
// assumptions back.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Orchestration, OrchestrationItem } from '../../shared/flows/orchestration';
import { auditWorkerLandings, parseConflictFiles } from './strandedLandings';

let root: string;
let repo: string;
const sha: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(name: string, body: string, msg: string): string {
  writeFileSync(join(repo, name), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'overcli-stranded-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { cwd: root });
  git(repo, 'config', 'user.email', 'flows@overcli.test');
  git(repo, 'config', 'user.name', 'Overcli Test');
  commitFile('shared.txt', 'line one\n', 'base');

  // Merged: a shift whose branch was actually merged (fast-forward).
  git(repo, 'checkout', '-qb', 'prometheus/merged');
  sha.merged = commitFile('merged.txt', 'merged\n', 'shift: merged work');
  git(repo, 'checkout', '-q', 'master');
  git(repo, 'merge', '-q', '--ff-only', 'prometheus/merged');

  // Clean: committed on its own branch, never merged, touches nothing base did.
  git(repo, 'checkout', '-qb', 'prometheus/clean');
  sha.clean = commitFile('clean.txt', 'clean\n', 'shift: clean work');
  git(repo, 'checkout', '-q', 'master');

  // Conflicts: edits the line base later edits differently.
  git(repo, 'checkout', '-qb', 'prometheus/conflict');
  sha.conflict = commitFile('shared.txt', 'line one, the shift version\n', 'shift: conflicting work');
  git(repo, 'checkout', '-q', 'master');
  commitFile('shared.txt', 'line one, the base version\n', 'base moves on');

  // Absorbed: never merged as a commit, but cherry-picked into base — the
  // squash/cherry-pick shape an ancestry-only check would misreport.
  git(repo, 'checkout', '-qb', 'prometheus/absorbed');
  sha.absorbed = commitFile('absorbed.txt', 'absorbed\n', 'shift: absorbed work');
  git(repo, 'checkout', '-q', 'master');
  // Base must move first: cherry-picking onto the commit's own parent in the
  // same second reproduces the identical SHA, which would be a plain merge.
  commitFile('unrelated.txt', 'unrelated\n', 'base moves on again');
  git(repo, 'cherry-pick', sha.absorbed);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function item(title: string, over: Partial<OrchestrationItem> = {}): OrchestrationItem {
  return {
    candidate: { id: title, title, prompt: title },
    flowId: 'flow',
    status: 'done',
    finishedAt: Date.UTC(2026, 9, 14),
    ...over,
  };
}

function workerBatch(items: OrchestrationItem[], over: Partial<Orchestration> = {}): Orchestration {
  return {
    id: 'b1',
    title: 'Nightly shift',
    projectPath: repo,
    maxConcurrent: 1,
    items,
    createdAt: 1,
    origin: { kind: 'worker', workerId: 'w1', workerName: 'Prometheus' },
    ...over,
  };
}

describe('auditWorkerLandings (real git)', () => {
  it('does not report an item whose headSha is an ancestor of base', async () => {
    const audit = await auditWorkerLandings([workerBatch([item('merged', { headSha: sha.merged })])]);
    expect(audit.stranded).toEqual([]);
    expect(audit.merged.map((m) => m.itemTitle)).toEqual(['merged']);
  });

  it('reports a diverged commit as stranded and still cleanly landable', async () => {
    const audit = await auditWorkerLandings([
      workerBatch([item('clean', { headSha: sha.clean, branchName: 'prometheus/clean' })]),
    ]);
    expect(audit.stranded).toHaveLength(1);
    const s = audit.stranded[0];
    expect(s).toMatchObject({
      workerId: 'w1',
      workerName: 'Prometheus',
      orchestrationId: 'b1',
      batchTitle: 'Nightly shift',
      itemTitle: 'clean',
      headSha: sha.clean,
      branchName: 'prometheus/clean',
      finishedAt: Date.UTC(2026, 9, 14),
      projectPath: repo,
      baseBranch: 'master',
      landability: 'clean',
      branchResolves: true,
    });
    // master gained since the fork: two "base moves on" commits and the cherry-pick.
    expect(s.baseAdvance).toBe(3);
  });

  it('marks stranded work that no longer merges as conflicts', async () => {
    const audit = await auditWorkerLandings([workerBatch([item('conflict', { headSha: sha.conflict })])]);
    expect(audit.stranded.map((s) => [s.itemTitle, s.landability])).toEqual([['conflict', 'conflicts']]);
    expect(audit.stranded[0].conflictFiles).toEqual(['shared.txt']);
  });

  it('counts cherry-picked work as absorbed, not stranded', async () => {
    const audit = await auditWorkerLandings([workerBatch([item('absorbed', { headSha: sha.absorbed })])]);
    expect(audit.stranded).toEqual([]);
    expect(audit.absorbed.map((a) => a.itemTitle)).toEqual(['absorbed']);
  });

  it('skips a done item with no headSha, and ignores items that are not done', async () => {
    const audit = await auditWorkerLandings([
      workerBatch([
        item('no sha'),
        item('failed', { status: 'failed', headSha: sha.clean }),
        item('running', { status: 'running', headSha: sha.clean }),
      ]),
    ]);
    expect(audit.skippedNoSha).toBe(1);
    expect(audit.stranded).toEqual([]);
    expect(audit.merged).toEqual([]);
  });

  it('ignores a non-worker-origin orchestration', async () => {
    const stranded = [item('clean', { headSha: sha.clean })];
    const audit = await auditWorkerLandings([
      workerBatch(stranded, {
        origin: { kind: 'schedule', scheduleId: 's1', scheduleName: 'Nightly schedule' },
      }),
      workerBatch(stranded, { origin: undefined }),
    ]);
    expect(audit).toEqual({ stranded: [], absorbed: [], merged: [], unresolvable: [], skippedNoSha: 0 });
  });

  it('reports a missing commit as unresolvable, separately from stranded', async () => {
    const audit = await auditWorkerLandings([
      workerBatch([item('gone', { headSha: 'deadbeef'.repeat(5) })]),
    ]);
    expect(audit.stranded).toEqual([]);
    expect(audit.unresolvable).toHaveLength(1);
    expect(audit.unresolvable[0].reason).not.toBe('');
  });

  it("prefers the item's recorded base over whatever is checked out", async () => {
    // With prometheus/clean checked out, detectBaseBranch says "prometheus/clean"
    // and the clean shift reads as merged — wrong. The recorded base is right.
    git(repo, 'checkout', '-q', 'prometheus/clean');
    try {
      const detected = await auditWorkerLandings([workerBatch([item('clean', { headSha: sha.clean })])]);
      expect(detected.merged).toHaveLength(1);

      const recorded = await auditWorkerLandings([
        workerBatch([item('clean', { headSha: sha.clean, baseBranch: 'master' })]),
      ]);
      expect(recorded.stranded.map((s) => s.baseBranch)).toEqual(['master']);

      const batchLevel = await auditWorkerLandings([
        workerBatch([item('clean', { headSha: sha.clean })], { baseBranch: 'master' }),
      ]);
      expect(batchLevel.stranded).toHaveLength(1);
    } finally {
      git(repo, 'checkout', '-q', 'master');
    }
  });
});

describe('parseConflictFiles', () => {
  it('reads the paths between the tree id and the blank line, once each', () => {
    expect(parseConflictFiles('abc123\nf\ng\nf\n\nAuto-merging f\nCONFLICT (content): Merge conflict in f\n')).toEqual(['f', 'g']);
    expect(parseConflictFiles('abc123\n')).toEqual([]);
  });
});
