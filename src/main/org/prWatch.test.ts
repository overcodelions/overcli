import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectedRepo } from './repos';
import { changesIn, gitConflicted, markTold, MAX_COMMENT_ROUNDS, MAX_WAKES_PER_DAY, OWN_MARK, prHostFor, PrWatcher, QUIET_MS, wakeText, wantsOf, type BuildState, type OpenPr, type PrHost, type PrWatchState } from './prWatch';

const REPO = { name: 'acme-web', url: 'https://bitbucket.org/acme/acme-web.git', host: 'bitbucket', defaultBranch: 'main', path: '/data/repos/acme-web' } as ConnectedRepo;
const pr = (over: Partial<OpenPr> = {}): OpenPr => ({ id: '42', url: 'https://bitbucket.org/acme/acme-web/pull-requests/42', title: 'Sort by date', branch: 'feature/ACME-9-sort', head: 'abc123', updatedAt: 't1', draft: false, author: ['Dana Reviewer', 'dana'], ...over });
const MIN = 60_000;

/// A host whose answers the test sets, counting what it was asked.
function fakeHost(s: { prs: OpenPr[]; base?: string; conflicted?: boolean; build?: BuildState; comments?: number }) {
  const asked = { conflicted: 0, build: 0, comments: 0 };
  const host: PrHost = {
    open: async () => s.prs,
    defaultHead: async () => s.base ?? 'base1',
    conflicted: async () => (asked.conflicted++, s.conflicted ?? false),
    build: async () => (asked.build++, s.build ?? 'passed'),
    comments: async () => (asked.comments++, s.comments ?? 0),
  };
  return { host, asked, s };
}
const notOurs = () => false;

/// Looks at the repo at a time, carrying what it remembers.
async function watch(f: ReturnType<typeof fakeHost>, at: number, before?: Parameters<typeof changesIn>[2], ownPush: Parameters<typeof changesIn>[3] = notOurs, wants?: Parameters<typeof changesIn>[5]) {
  const got = await changesIn(REPO, f.host, before, ownPush, at, wants);
  // Handed to the worker straight away, as the watcher does when it's free.
  for (const c of got!.changes) markTold(got!.now, c.pr.id, at);
  return { changes: got!.changes, now: got!.now };
}

describe('changesIn', () => {
  it('waits for the builds to finish and the pull request to go quiet, then tells it once', async () => {
    const f = fakeHost({ prs: [pr()], build: 'pending' });
    let t = 0;
    let seen = await watch(f, t);
    f.s.build = 'failed';
    seen = await watch(f, (t += 2 * MIN), seen.now);
    expect(seen.changes).toEqual([]);
    seen = await watch(f, (t += QUIET_MS), seen.now);
    expect(seen.changes.map((c) => c.what)).toEqual([['its build failed']]);
    seen = await watch(f, (t += QUIET_MS), seen.now);
    expect(seen.changes).toEqual([]);
  });

  it('says nothing while a build is still running, however quiet it is', async () => {
    const f = fakeHost({ prs: [pr()], conflicted: true, build: 'pending' });
    const seen = await watch(f, 0);
    expect((await watch(f, 60 * MIN, seen.now)).changes).toEqual([]);
  });

  it('tells a conflict and a red build together, and neither once a later push fixed them', async () => {
    const both = fakeHost({ prs: [pr()], conflicted: true, build: 'failed' });
    const one = await watch(both, 0);
    expect((await watch(both, QUIET_MS, one.now)).changes[0].what).toEqual(['conflicts with main', 'its build failed']);

    const fixed = fakeHost({ prs: [pr()], conflicted: true, build: 'failed' });
    let seen = await watch(fixed, 0);
    fixed.s.prs = [pr({ head: 'def456', updatedAt: 't2' })];
    fixed.s.conflicted = false;
    fixed.s.build = 'passed';
    seen = await watch(fixed, 2 * MIN, seen.now);
    expect((await watch(fixed, 2 * MIN + QUIET_MS, seen.now)).changes).toEqual([]);
  });

  it('stops after a few wakes a day for one pull request, so its own pushes can’t loop it', async () => {
    const f = fakeHost({ prs: [pr()], build: 'failed' });
    let t = 0;
    let seen = await watch(f, t);
    let wakes = 0;
    for (let i = 0; i < MAX_WAKES_PER_DAY + 2; i++) {
      seen = await watch(f, (t += QUIET_MS), seen.now);
      wakes += seen.changes.length;
      // A new commit, red again.
      f.s.prs = [pr({ head: `h${i}`, updatedAt: `u${i}` })];
      seen = await watch(f, (t += MIN), seen.now);
    }
    expect(wakes).toBe(MAX_WAKES_PER_DAY);
  });

  it('asks the host nothing more about a pull request that didn’t move, until its target does', async () => {
    const f = fakeHost({ prs: [pr()] });
    const one = await watch(f, 0);
    const before = { ...f.asked };
    await watch(f, MIN, one.now);
    expect(f.asked).toEqual(before);
    // main moved: a pull request that merged cleanly may not any more.
    f.s.base = 'base2';
    f.s.conflicted = true;
    const moved = await watch(f, 2 * MIN, one.now);
    expect(moved.changes).toEqual([]);
    expect((await watch(f, 2 * MIN + QUIET_MS, moved.now)).changes[0].what).toEqual(['conflicts with main']);
  });

  it('leaves a red build on a commit the server pushed to the CI watcher, and skips drafts', async () => {
    const own = fakeHost({ prs: [pr()], build: 'failed' });
    const mine = (_r: ConnectedRepo, branch: string, head: string) => branch === 'feature/ACME-9-sort' && head === 'abc123';
    const seen = await watch(own, 0, undefined, mine);
    expect((await watch(own, QUIET_MS, seen.now, mine)).changes).toEqual([]);
    const draft = fakeHost({ prs: [pr({ draft: true })], conflicted: true });
    const d = await watch(draft, 0);
    expect((await watch(draft, QUIET_MS, d.now)).changes).toEqual([]);
  });
});

describe('whose pull requests', () => {
  it('fixes everyone\u2019s builds and conflicts by default, and nobody\u2019s review comments', () => {
    expect(wantsOf({}, pr())).toEqual({ fixes: true, comments: false });
  });

  it('narrows to the people named, matched however the host names them', () => {
    expect(wantsOf({ authors: ['DANA'] }, pr())).toEqual({ fixes: true, comments: false });
    expect(wantsOf({ authors: ['Sam'] }, pr())).toEqual({ fixes: false, comments: false });
    expect(wantsOf({ commentAuthors: ['Dana Reviewer'] }, pr())).toEqual({ fixes: true, comments: true });
    // Comments only where it works on the pull request at all.
    expect(wantsOf({ authors: ['Sam'], commentAuthors: ['dana'] }, pr())).toEqual({ fixes: false, comments: false });
  });

  it('leaves a pull request it doesn\u2019t work on unasked and unremembered', async () => {
    const f = fakeHost({ prs: [pr()], conflicted: true });
    const seen = await watch(f, 0, undefined, notOurs, () => ({ fixes: false, comments: false }));
    expect(seen.now.prs).toEqual({});
    expect(f.asked).toEqual({ conflicted: 0, build: 0, comments: 0 });
  });

  it('counts new review comments only where it fixes them, once things settle', async () => {
    const f = fakeHost({ prs: [pr()], comments: 2 });
    const both = () => ({ fixes: true, comments: true });
    let seen = await watch(f, 0, undefined, notOurs, both);
    f.s.prs = [pr({ updatedAt: 't2' })];
    f.s.comments = 4;
    seen = await watch(f, MIN, seen.now, notOurs, both);
    expect(seen.changes).toEqual([]);
    seen = await watch(f, MIN + QUIET_MS, seen.now, notOurs, both);
    expect(seen.changes[0].what).toEqual(['2 new review comments']);
    // Without comments wanted, they never come up.
    const g = fakeHost({ prs: [pr()], comments: 2 });
    let other = await watch(g, 0);
    g.s.prs = [pr({ updatedAt: 't2' })];
    g.s.comments = 5;
    other = await watch(g, MIN, other.now);
    expect((await watch(g, MIN + QUIET_MS, other.now)).changes).toEqual([]);
    expect(g.asked.comments).toBe(0);
  });

  it('stops raising review comments on a pull request after a few rounds, for good, but not its conflicts', async () => {
    const f = fakeHost({ prs: [pr()], comments: 0 });
    const both = () => ({ fixes: true, comments: true });
    let t = 0;
    let seen = await watch(f, t, undefined, notOurs, both);
    let rounds = 0;
    // Each push draws one more AI review comment, days apart so the daily cap never bites.
    for (let i = 1; i <= MAX_COMMENT_ROUNDS + 2; i++) {
      f.s.prs = [pr({ head: `h${i}`, updatedAt: `u${i}` })];
      f.s.comments = i;
      seen = await watch(f, (t += 2 * 24 * 60 * MIN), seen.now, notOurs, both);
      seen = await watch(f, (t += QUIET_MS), seen.now, notOurs, both);
      rounds += seen.changes.length;
    }
    expect(rounds).toBe(MAX_COMMENT_ROUNDS);
    // A conflict still comes through.
    f.s.base = 'base2';
    f.s.conflicted = true;
    seen = await watch(f, (t += MIN), seen.now, notOurs, both);
    expect((await watch(f, t + QUIET_MS, seen.now, notOurs, both)).changes[0].what).toEqual(['conflicts with main']);
  });

  it('wakes a worker only for its own people\u2019s pull requests and comments', async () => {
    const f = fakeHost({ prs: [pr(), pr({ id: '43', author: ['Sam'] })], conflicted: true, comments: 1 });
    let state: PrWatchState = { repos: {} };
    let t = 0;
    const woken: string[] = [];
    const w = new PrWatcher({
      store: { load: () => state, save: (v) => (state = v) },
      watchers: () => [{ workerId: 'mario', repos: [REPO], authors: ['dana'], commentAuthors: ['dana'] }],
      host: () => f.host,
      ownPush: notOurs,
      wake: async (_id, text) => woken.push(text),
      log: () => {},
      now: () => t,
    });
    await w.poll();
    t += QUIET_MS;
    await w.poll();
    expect(woken).toHaveLength(1);
    expect(woken[0]).toContain('PR #42');
    expect(woken[0]).not.toContain('PR #43');
  });
});

describe('PrWatcher', () => {
  it('hands a busy worker nothing, and a free one a task\u2019s worth at a time, longest-waiting first', async () => {
    const prs = ['3', '1', '4', '2', '5'].map((id) => pr({ id, updatedAt: `t${id}` }));
    const f = fakeHost({ prs, conflicted: true });
    let state: PrWatchState = { repos: {} };
    let t = 0;
    let busy = false;
    const woken: string[] = [];
    const w = new PrWatcher({
      store: { load: () => state, save: (v) => (state = v) },
      watchers: () => [{ workerId: 'mario', repos: [REPO], perWake: 2 }],
      host: () => f.host,
      ownPush: notOurs,
      wake: async (_id, text) => woken.push(text),
      busy: () => busy,
      log: () => {},
      now: () => t,
    });
    await w.poll();
    t += QUIET_MS;
    busy = true;
    await w.poll();
    expect(woken).toEqual([]);
    busy = false;
    await w.poll();
    await w.poll();
    await w.poll();
    await w.poll();
    const handed = woken.map((text) => [...text.matchAll(/PR #(\d)/g)].map((m) => m[1]));
    expect(handed).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });

  it('keeps what it couldn\u2019t hand over for the next check', async () => {
    const f = fakeHost({ prs: [pr()], conflicted: true });
    let state: PrWatchState = { repos: {} };
    let t = 0;
    let fail = true;
    const woken: string[] = [];
    const w = new PrWatcher({
      store: { load: () => state, save: (v) => (state = v) },
      watchers: () => [{ workerId: 'mario', repos: [REPO] }],
      host: () => f.host,
      ownPush: notOurs,
      wake: async (_id, text) => {
        if (fail) throw new Error('busy desk');
        woken.push(text);
      },
      log: () => {},
      now: () => t,
    });
    await w.poll();
    t += QUIET_MS;
    await w.poll();
    expect(woken).toEqual([]);
    fail = false;
    await w.poll();
    expect(woken).toHaveLength(1);
  });

  it('wakes each worker once, with the pull requests in its own places', async () => {
    const f = fakeHost({ prs: [pr()], conflicted: true });
    let state: PrWatchState = { repos: {} };
    let t = 0;
    const woken: Array<[string, string]> = [];
    const w = new PrWatcher({
      store: { load: () => state, save: (v) => (state = v) },
      watchers: () => [{ workerId: 'mario', repos: [REPO] }, { workerId: 'other', repos: [] }],
      host: () => f.host,
      ownPush: notOurs,
      wake: async (id, text) => woken.push([id, text]),
      log: () => {},
      now: () => t,
    });
    await w.poll();
    expect(woken).toEqual([]);
    t += QUIET_MS;
    await w.poll();
    expect(woken.map(([id]) => id)).toEqual(['mario']);
    expect(woken[0][1]).toContain('acme-web PR #42 "Sort by date"');
    expect(woken[0][1]).toContain('conflicts with main');
    t += QUIET_MS;
    await w.poll();
    expect(woken).toHaveLength(1);
  });

  it('checks nothing when no worker looks after pull requests', async () => {
    const f = fakeHost({ prs: [pr()] });
    const w = new PrWatcher({ store: { load: () => ({ repos: {} }), save: () => {} }, watchers: () => [], host: () => f.host, ownPush: notOurs, wake: async () => {}, log: () => {} });
    await w.poll();
    expect(f.asked).toEqual({ conflicted: 0, build: 0, comments: 0 });
  });
});

describe('the hosts', () => {
  const respond = (routes: Array<[RegExp, unknown]>) =>
    (async (url: string) => {
      const hit = routes.find(([re]) => re.test(String(url)));
      return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('{}', { status: 404 });
    }) as typeof fetch;
  const env = (n: string) => ({ BITBUCKET_TOKEN: 't', GH_TOKEN: 't' })[n];

  it('reads Bitbucket: the build from the head commit’s statuses, and where the pull request merges into', async () => {
    const host = prHostFor(REPO, {
      env,
      fetchImpl: respond([
        [/pullrequests\?state=OPEN/, { values: [{ id: 42, title: 'Sort', updated_on: 't1', links: { html: { href: 'u' } }, source: { branch: { name: 'b' }, commit: { hash: 'abc' } }, destination: { branch: { name: 'release' } } }] }],
        [/statuses/, { values: [{ state: 'SUCCESSFUL' }, { state: 'FAILED' }] }],
      ]),
    })!;
    const [one] = (await host.open())!;
    expect(one).toMatchObject({ id: '42', branch: 'b', head: 'abc', target: 'release' });
    // No git given: conflicts can't be told.
    expect(await host.conflicted(one)).toBeUndefined();
    expect(await host.build(one)).toBe('failed');
  });

  it('reads who opened a pull request, and never counts a comment the worker posted', async () => {
    const host = prHostFor(REPO, {
      env,
      fetchImpl: respond([
        [/pullrequests\?state=OPEN/, { values: [{ id: 42, title: 'Sort', updated_on: 't1', author: { display_name: 'Dana Reviewer', nickname: 'dana' }, source: { branch: { name: 'b' }, commit: { hash: 'abc' } } }] }],
        [/comments/, { values: [{ content: { raw: 'Rename this' } }, { content: { raw: `Fixed in abc.\n${OWN_MARK}` } }, { parent: { id: 1 }, content: { raw: 'ok' } }, { deleted: true }] }],
      ]),
    })!;
    const [one] = (await host.open())!;
    expect(one.author).toEqual(['Dana Reviewer', 'dana']);
    expect(await host.comments(one)).toBe(1);
  });

  it('reads GitHub: a running check is pending', async () => {
    const repo = { ...REPO, url: 'https://github.com/acme/acme-web.git', host: 'github' } as ConnectedRepo;
    const host = prHostFor(repo, {
      env,
      fetchImpl: respond([
        [/pulls\?state=open/, [{ number: 7, title: 'Sort', html_url: 'u', updated_at: 't1', head: { ref: 'b', sha: 'abc' } }]],
        [/check-runs/, { check_runs: [{ status: 'in_progress', conclusion: null }] }],
      ]),
    })!;
    const [one] = (await host.open())!;
    expect(await host.build(one)).toBe('pending');
  });
});

describe('wakeText', () => {
  it('names each pull request, its link and what changed', () => {
    expect(wakeText([{ repo: 'acme-web', pr: pr(), what: ['its build failed'] }])).toContain('(https://bitbucket.org/acme/acme-web/pull-requests/42), branch feature/ACME-9-sort: its build failed');
  });
});

describe('gitConflicted', () => {
  const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.email=t@acme.test', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[], cwd: string) =>
    new Promise<{ code: number; stdout: string }>((resolve) =>
      execFile('git', args, { cwd }, (err, stdout) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0, stdout: String(stdout) })),
    );

  it('tells a pull request that no longer merges from one that does, from the host as it is now', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-conflict-'));
    try {
      git(['init', '-q', '--bare', '-b', 'main', 'remote.git'], root);
      git(['clone', '-q', 'remote.git', 'author'], root);
      const a = path.join(root, 'author');
      git(['checkout', '-q', '-b', 'main'], a);
      fs.writeFileSync(path.join(a, 'app.txt'), 'hello\n');
      git(['add', '-A'], a);
      git(['commit', '-qm', 'init'], a);
      git(['push', '-q', 'origin', 'main'], a);
      // The server's clone, from before any of the pull requests.
      git(['clone', '-q', 'remote.git', 'server'], root);
      for (const [branch, file] of [['feature/ACME-1-same-line', 'app.txt'], ['feature/ACME-2-elsewhere', 'other.txt']]) {
        git(['switch', '-q', '-c', branch, 'main'], a);
        fs.writeFileSync(path.join(a, file), `from ${branch}\n`);
        git(['add', '-A'], a);
        git(['commit', '-qm', branch], a);
        git(['push', '-q', 'origin', branch], a);
      }
      git(['switch', '-q', 'main'], a);
      fs.writeFileSync(path.join(a, 'app.txt'), 'hello from main\n');
      git(['commit', '-qam', 'main moves'], a);
      git(['push', '-q', 'origin', 'main'], a);
      const repo = { ...REPO, path: path.join(root, 'server') };
      expect(await gitConflicted(repo, { branch: 'feature/ACME-1-same-line', head: '' }, run)).toBe(true);
      expect(await gitConflicted(repo, { branch: 'feature/ACME-2-elsewhere', head: '' }, run)).toBe(false);
      expect(await gitConflicted(repo, { branch: 'feature/gone', head: '' }, run)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
