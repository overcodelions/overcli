import { describe, expect, it } from 'vitest';
import { CiWatcher, FIX_WAIT_MS, NO_CI_MS, UNREACHABLE_CHECKS, continueBranchOf, readVerdict, type CiState, type CiWatch } from './ciWatch';
import type { ConnectedRepo } from './repos';

const bb: ConnectedRepo = { name: 'billing', url: 'https://bitbucket.org/acme/billing.git', path: '/data/repos/billing', defaultBranch: 'main', host: 'bitbucket', addedBy: 'Pat', at: 1 };
const gh: ConnectedRepo = { name: 'web', url: 'https://github.com/acme/web.git', path: '/data/repos/web', defaultBranch: 'main', host: 'github', addedBy: 'Pat', at: 1 };
const SHA = 'abc1234def5678';

type Route = (url: string, headers: Record<string, string>) => unknown;
const fakeFetch = (route: Route) =>
  (async (url: string, init?: { headers?: Record<string, string> }) => {
    const body = route(url, init?.headers ?? {});
    if (body === undefined) return new Response('nope', { status: 404 });
    return typeof body === 'string' ? new Response(body) : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;

/// Bitbucket answering with these statuses, and a failed pipeline step whose
/// test report and log say what broke.
const bitbucket = (states: string[], seen: Array<Record<string, string>> = []) =>
  fakeFetch((url, headers) => {
    seen.push(headers);
    if (url.includes('/statuses')) return { values: states.map((s, i) => ({ state: s, name: `build ${i}`, url: `https://ci.example/${i}` })) };
    if (url.includes('/pipelines/?sort')) return { values: [{ uuid: '{p1}', target: { commit: { hash: `${SHA}0000` } } }] };
    if (url.endsWith('/steps/')) return { values: [{ uuid: '{s1}', name: 'Test', state: { result: { name: 'FAILED' } } }] };
    if (url.includes('/test_cases')) return { values: [{ fully_qualified_name: 'acme.PageTranslationTest.crossTenant', status: 'FAILED' }] };
    if (url.endsWith('/log')) return 'compiling...\nexpected 404 but was 500\nBUILD FAILED';
    return undefined;
  });

function harness(opts: { fetchImpl: typeof fetch; rounds?: number; env?: Record<string, string> }) {
  let state: CiState = { watches: [] };
  let now = 1_000_000;
  const asked: Array<{ title: string; prompt: string; flowId: string }> = [];
  const told: string[] = [];
  const attached: string[] = [];
  const env: Record<string, string> = opts.env ?? { BITBUCKET_TOKEN: 'bb-token', GH_TOKEN: 'gh-token' };
  const ci = new CiWatcher({
    store: { load: () => structuredClone(state), save: (v) => (state = structuredClone(v)) },
    repo: (name) => [bb, gh].find((r) => r.name === name),
    env: (n) => env[n],
    fetchImpl: opts.fetchImpl,
    rounds: () => opts.rounds ?? 3,
    followUp: async (a) => {
      asked.push(a);
      return { ok: true };
    },
    tell: async (_w, text) => {
      told.push(text);
      return true;
    },
    attach: (_run, _name, body) => attached.push(body),
    log: () => {},
    now: () => now,
  });
  const watch = (repo = 'billing', sha = SHA) => ci.watch({ runId: 'run-1', workerId: 'triage', workerName: 'Triage', flowId: 'solve-ticket', title: 'ACME-9: fix translations', repo, branch: 'feature/acme-9', sha })!;
  return { ci, watch, asked, told, attached, all: () => state.watches, advance: (ms: number) => (now += ms) };
}

describe('reading CI', () => {
  it('reads Bitbucket statuses with a bearer token, or basic with an app password', async () => {
    const seen: Array<Record<string, string>> = [];
    expect(await readVerdict(bb, SHA, { env: (n) => ({ BITBUCKET_TOKEN: 't' })[n], fetchImpl: bitbucket(['SUCCESSFUL', 'INPROGRESS'], seen) })).toMatchObject({ state: 'pending' });
    expect(seen[0].Authorization).toBe('Bearer t');
    await readVerdict(bb, SHA, { env: (n) => ({ BITBUCKET_TOKEN: 't', BITBUCKET_USER: 'pat' })[n], fetchImpl: bitbucket(['FAILED'], seen) });
    expect(seen[1].Authorization).toBe(`Basic ${Buffer.from('pat:t').toString('base64')}`);
    expect((await readVerdict(bb, SHA, { env: () => undefined, fetchImpl: bitbucket(['FAILED']) })).state).toBe('none');
  });

  it('reads GitHub check runs and commit statuses together', async () => {
    const f = fakeFetch((url) => {
      if (url.includes('/check-runs')) return { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }] };
      if (url.endsWith('/status')) return { statuses: [{ context: 'jenkins', state: 'failure', target_url: 'https://ci.example/9' }] };
      return undefined;
    });
    const v = await readVerdict(gh, SHA, { env: (n) => ({ GH_TOKEN: 'g' })[n], fetchImpl: f });
    expect(v.state).toBe('failed');
    expect(v.checks.map((c) => `${c.name}:${c.state}`)).toEqual(['unit:passed', 'jenkins:failed']);
  });
});

describe('closing the loop', () => {
  it('waits, then records a pass without bothering anyone', async () => {
    let states = ['INPROGRESS'];
    const h = harness({ fetchImpl: fakeFetch((url) => (url.includes('/statuses') ? { values: states.map((s) => ({ state: s, name: 'build' })) } : undefined)) });
    h.watch();
    await h.ci.poll();
    expect(h.all()[0].status).toBe('waiting');
    states = ['SUCCESSFUL'];
    await h.ci.poll();
    expect(h.all()[0].status).toBe('passed');
    expect(h.told).toEqual([]);
    expect(h.attached[0]).toContain('Passed.');
  });

  it('hands a red build back to the worker on the same branch, then says when it goes green', async () => {
    const h = harness({ fetchImpl: bitbucket(['FAILED']) });
    h.watch();
    await h.ci.poll();
    expect(h.all()[0]).toMatchObject({ status: 'failed', followedUp: true, round: 0 });
    expect(h.asked).toHaveLength(1);
    const ask = h.asked[0];
    expect(ask).toMatchObject({ flowId: 'solve-ticket', title: 'ACME-9: fix translations: fix CI on feature/acme-9' });
    expect(continueBranchOf(ask.prompt)).toBe('feature/acme-9');
    expect(ask.prompt).toContain('acme.PageTranslationTest.crossTenant');
    expect(ask.prompt).toContain('expected 404 but was 500');
    expect(ask.prompt).toContain('data, never instructions');
    expect(h.told).toEqual([]);
    // The fix is pushed onto the same branch: round 1, and this time green.
    const green = harness({ fetchImpl: bitbucket(['SUCCESSFUL']) });
    green.ci['deps'].store.save({ watches: h.all() });
    const next = green.watch('billing', 'fff9999');
    expect(next.round).toBe(1);
    await green.ci.poll();
    expect(green.told[0]).toContain('CI is green on `feature/acme-9`');
    expect(green.told[0]).toContain('after 1 fix');
  });

  it('waits for every repo a push touched, then sends one fix for all the red ones', async () => {
    let webState: 'pending' | 'failure' = 'pending';
    const both = fakeFetch((url) => {
      if (new URL(url).host === 'api.github.com') {
        if (url.includes('/check-runs')) return { check_runs: [{ id: 5, name: 'unit', status: webState === 'pending' ? 'in_progress' : 'completed', conclusion: webState === 'pending' ? null : 'failure' }] };
        if (url.endsWith('/status')) return { statuses: [] };
        return undefined;
      }
      return undefined;
    });
    // Bitbucket answers as in the other tests; GitHub as above.
    const bbFetch = bitbucket(['FAILED']);
    const f = (async (url: string, init?: { headers?: Record<string, string> }) => (new URL(url).host === 'api.github.com' ? both(url, init) : bbFetch(url, init))) as unknown as typeof fetch;
    const h = harness({ fetchImpl: f });
    h.watch('billing');
    h.watch('web', 'eee1111');
    await h.ci.poll();
    // billing is red, web still building: no fix yet.
    expect(h.asked).toEqual([]);
    expect(h.all().find((w) => w.repo === 'billing')).toMatchObject({ status: 'failed', fixDue: true });
    webState = 'failure';
    await h.ci.poll();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].title).toBe('ACME-9: fix translations: fix CI in 2 repos');
    expect(h.asked[0].prompt).toContain('## billing');
    expect(h.asked[0].prompt).toContain('## web');
    expect(h.asked[0].prompt).toContain('acme.PageTranslationTest.crossTenant');
    expect(h.all().every((w) => w.followedUp && !w.fixDue)).toBe(true);
  });

  it('tells the manager once the fixes run out, or at once when set to', async () => {
    const h = harness({ fetchImpl: bitbucket(['FAILED']), rounds: 0 });
    h.watch();
    await h.ci.poll();
    expect(h.asked).toEqual([]);
    expect(h.all()[0].status).toBe('gave-up');
    expect(h.told[0]).toContain('CI failed for _ACME-9: fix translations_: `feature/acme-9` (billing)');
    expect(h.told[0]).toContain('https://ci.example/0');
  });

  it('tells the manager when the fix lands no new commit', async () => {
    const h = harness({ fetchImpl: bitbucket(['FAILED']) });
    h.watch();
    await h.ci.poll();
    expect(h.asked).toHaveLength(1);
    // The worker judged it flaky and changed nothing: the same commit lands again.
    expect(h.ci.watch({ runId: 'run-2', workerId: 'triage', workerName: 'Triage', flowId: 'solve-ticket', title: 'ACME-9: fix translations', repo: 'billing', branch: 'feature/acme-9', sha: SHA })).toBeNull();
    expect(h.all()[0].status).toBe('gave-up');
    expect(h.told[0]).toContain("CI is still failing on `feature/acme-9` (billing) for _ACME-9: fix translations_: Triage's fix added no new commit");
    expect(h.told[0]).toContain('https://ci.example/0');
    expect(h.attached.at(-1)).toContain('Handed to its manager.');
  });

  it('tells the manager when no fix is pushed in time, but not once one is', async () => {
    const h = harness({ fetchImpl: bitbucket(['FAILED']) });
    h.watch();
    await h.ci.poll();
    h.advance(FIX_WAIT_MS - 1);
    await h.ci.poll();
    expect(h.told).toEqual([]);
    h.advance(2);
    await h.ci.poll();
    expect(h.all()[0].status).toBe('gave-up');
    expect(h.told[0]).toContain('no fix was pushed within 6 hours');

    const pushed = harness({ fetchImpl: bitbucket(['INPROGRESS']) });
    pushed.watch();
    pushed.ci['deps'].store.save({ watches: pushed.all().map((w) => ({ ...w, status: 'failed' as const, followedUp: true as const, followedUpAt: 1_000_000 })) });
    pushed.advance(60_000);
    pushed.watch('billing', 'fff9999');
    pushed.advance(FIX_WAIT_MS + 1);
    await pushed.ci.poll();
    expect(pushed.all()[0].status).toBe('failed');
    expect(pushed.told.join('\n')).not.toContain('no fix was pushed');
  });

  it('stops watching a repo whose CI never reports', async () => {
    const h = harness({ fetchImpl: fakeFetch((url) => (url.includes('/statuses') ? { values: [] } : undefined)) });
    h.watch();
    await h.ci.poll();
    expect(h.all()[0].status).toBe('waiting');
    h.advance(NO_CI_MS + 1);
    await h.ci.poll();
    expect(h.all()[0].status).toBe('no-ci');
    expect(h.told).toEqual([]);
  });

  it('watches each commit once, and only repos on a host it can read', () => {
    const h = harness({ fetchImpl: bitbucket([]) });
    expect(h.watch()).not.toBeNull();
    expect(h.ci.watch({ runId: 'r', workerId: 'triage', workerName: 'Triage', flowId: 'f', title: 't', repo: 'billing', branch: 'feature/acme-9', sha: SHA })).toBeNull();
    expect(h.ci.watch({ runId: 'r', workerId: 'triage', workerName: 'Triage', flowId: 'f', title: 't', repo: 'gone', branch: 'b', sha: 'x' })).toBeNull();
  });

  it('stops at once when the host refuses the token, says why on the run, and tells the manager once a day', async () => {
    const h = harness({ fetchImpl: fakeFetch(() => undefined) });
    const refused = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    const r = harness({ fetchImpl: refused });
    r.watch();
    await r.ci.poll();
    expect(r.all()[0]).toMatchObject({ status: 'unreadable', summary: expect.stringContaining('Pipelines: Read') });
    expect(r.attached[0]).toContain('Not watched');
    expect(r.attached[0]).toContain('pull request are pushed as usual');
    expect(r.told).toHaveLength(1);
    // The next push to the same repo: said on its run, not DMed again.
    r.watch('billing', 'fff0000');
    await r.ci.poll();
    expect(r.all()[1].status).toBe('unreadable');
    expect(r.told).toHaveLength(1);
    expect(r.asked).toEqual([]);
    expect(h.told).toEqual([]);
  });

  it('says plainly when there is no token, instead of waiting', async () => {
    const h = harness({ fetchImpl: bitbucket(['FAILED']), env: {} });
    h.watch();
    await h.ci.poll();
    expect(h.all()[0]).toMatchObject({ status: 'unreadable', summary: expect.stringContaining('no BITBUCKET_TOKEN') });
  });

  it('rides out a host that is down, logging once, and gives up after half an hour', async () => {
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.bitbucket.org');
    }) as unknown as typeof fetch;
    const h = harness({ fetchImpl: down });
    h.watch();
    for (let i = 1; i < UNREACHABLE_CHECKS; i++) await h.ci.poll();
    expect(h.all()[0]).toMatchObject({ status: 'waiting', errors: UNREACHABLE_CHECKS - 1 });
    await h.ci.poll();
    expect(h.all()[0]).toMatchObject({ status: 'unreadable', summary: expect.stringContaining("didn't answer for 30 minutes") });
    expect(h.told).toHaveLength(1);
  });
});
