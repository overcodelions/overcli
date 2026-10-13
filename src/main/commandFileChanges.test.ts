import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { StreamEvent } from '../shared/types';
import {
  CommandChangeStore,
  CommandChangeTracker,
  diffTrees,
  snapshotTree,
  type TreeSnapshot,
} from './commandFileChanges';

let repo: string;
let dataDir: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-cmdchanges-')));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-cmdchanges-data-'));
  git('init', '-q');
  git('config', 'user.email', 'dev@acme.test');
  git('config', 'user.name', 'Acme Dev');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'gone.ts'), 'bye\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('snapshotTree + diffTrees', () => {
  it('sees edits, new files and deletions, and skips ignored files', async () => {
    const before = (await snapshotTree(repo))!;
    fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(repo, 'new.ts'), 'hello\n');
    fs.rmSync(path.join(repo, 'gone.ts'));
    fs.mkdirSync(path.join(repo, 'dist'));
    fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'built\n');
    const after = (await snapshotTree(repo))!;

    const changes = await diffTrees(repo, before.tree, after.tree);
    const byPath = Object.fromEntries(changes.map((c) => [c.relPath, c]));
    expect(Object.keys(byPath).sort()).toEqual(['app.ts', 'gone.ts', 'new.ts']);
    expect(byPath['app.ts']).toMatchObject({ status: 'modified', additions: 2, deletions: 1, path: path.join(repo, 'app.ts') });
    expect(byPath['app.ts'].patch).toContain('+TWO');
    expect(byPath['new.ts'].status).toBe('added');
    expect(byPath['gone.ts'].status).toBe('deleted');
  });

  it('leaves the real index alone', async () => {
    fs.writeFileSync(path.join(repo, 'untracked.ts'), 'x\n');
    await snapshotTree(repo);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    expect(status).toContain('?? untracked.ts');
  });

  it('is null outside a repo', async () => {
    expect(await snapshotTree(dataDir)).toBeNull();
  });
});

function assistant(id: string, name: string): StreamEvent {
  return {
    id: `a-${id}`,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: { type: 'assistant', info: { model: null, text: '', toolUses: [{ id, name, inputJSON: '{}' }], thinking: [] } },
  };
}

function result(id: string): StreamEvent {
  return {
    id: `r-${id}`,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: { type: 'toolResult', results: [{ id, content: '', isError: false }] },
  };
}

describe('CommandChangeTracker', () => {
  function tracker() {
    const updates: StreamEvent[] = [];
    const store = new CommandChangeStore(() => dataDir);
    const t = new CommandChangeTracker((_c, ev) => updates.push(ev), store);
    return { t, updates, store };
  }

  it('attaches what a shell command changed to its result, and persists it', async () => {
    const { t, updates } = tracker();
    t.beginTurn('c1', repo);
    t.observe('c1', [assistant('tu1', 'Bash')]);
    await t.idle('c1');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nchanged\nthree\n');
    t.observe('c1', [result('tu1')]);
    await t.idle('c1');

    expect(updates).toHaveLength(1);
    const ev = updates[0];
    expect(ev.id).toBe('r-tu1');
    if (ev.kind.type !== 'toolResult') throw new Error('expected a tool result');
    expect(ev.kind.results[0].fileChanges?.map((c) => c.relPath)).toEqual(['app.ts']);

    // A reopened transcript gets them back from disk.
    const fresh = new CommandChangeStore(() => dataDir);
    const [replayed] = fresh.apply('c1', [result('tu1')]);
    if (replayed.kind.type !== 'toolResult') throw new Error('expected a tool result');
    expect(replayed.kind.results[0].fileChanges?.[0].relPath).toBe('app.ts');
  });

  it("does not blame a command for an Edit that ran before it", async () => {
    const { t, updates } = tracker();
    t.beginTurn('c1', repo);
    t.observe('c1', [assistant('e1', 'Edit')]);
    fs.writeFileSync(path.join(repo, 'app.ts'), 'edited by Edit\n');
    t.observe('c1', [result('e1')]);
    t.observe('c1', [assistant('b1', 'Bash')]);
    await t.idle('c1');
    t.observe('c1', [result('b1')]);
    await t.idle('c1');
    expect(updates).toHaveLength(0);
  });

  it('ignores its own re-sent result', async () => {
    const snaps: TreeSnapshot[] = [{ root: repo, tree: 'a' }, { root: repo, tree: 'b' }];
    const updates: StreamEvent[] = [];
    let calls = 0;
    const t = new CommandChangeTracker(
      (_c, ev) => updates.push(ev),
      new CommandChangeStore(() => dataDir),
      async () => snaps[Math.min(calls++, 1)],
      async () => [{ path: '/x', relPath: 'x', status: 'modified', additions: 1, deletions: 0 }],
    );
    t.beginTurn('c1', repo);
    t.observe('c1', [assistant('tu1', 'Bash'), result('tu1')]);
    await t.idle('c1');
    t.observe('c1', updates);
    await t.idle('c1');
    expect(updates).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
