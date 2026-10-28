import { describe, expect, it } from 'vitest';
import { describe as describeLanded, landedBranches } from './landBranches';
import { openPullRequest } from './prOpen';
import type { ConnectedRepo } from './repos';

const bb: ConnectedRepo = { name: 'billing', url: 'https://bitbucket.org/acme/billing.git', path: '/r/billing', defaultBranch: 'master', host: 'bitbucket', addedBy: 'Pat', at: 1 };
const gh: ConnectedRepo = { name: 'web', url: 'https://github.com/acme/web.git', path: '/r/web', defaultBranch: 'main', host: 'github', addedBy: 'Pat', at: 1 };
const env = (n: string) => ({ BITBUCKET_TOKEN: 'bb', GH_TOKEN: 'gh' })[n];

type Call = { url: string; method: string; body?: Record<string, unknown> };
function host(answer: (c: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    const c: Call = { url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) };
    calls.push(c);
    const a = answer(c);
    return new Response(a.json === undefined ? '' : JSON.stringify(a.json), { status: a.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('opening the pull request for a pushed branch', () => {
  it('opens a Bitbucket draft with the worker\'s title and description', async () => {
    const h = host(() => ({ status: 201, json: { links: { html: { href: 'https://bitbucket.org/acme/billing/pull-requests/7' } } } }));
    const res = await openPullRequest(bb, { branch: 'feature/acme-9', title: 'Fix totals', body: 'Why and how.', draft: true }, { env, fetchImpl: h.fetchImpl });
    expect(res).toEqual({ ok: true, url: 'https://bitbucket.org/acme/billing/pull-requests/7' });
    expect(h.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.bitbucket.org/2.0/repositories/acme/billing/pullrequests' });
    expect(h.calls[0].body).toMatchObject({ title: 'Fix totals', description: 'Why and how.', draft: true, source: { branch: { name: 'feature/acme-9' } }, destination: { branch: { name: 'master' } } });
  });

  it('hands back the one already open for the branch instead of a second', async () => {
    const h = host((c) => (c.method === 'POST' ? { status: 400, json: { error: { message: 'There are no changes to be pulled' } } } : { status: 200, json: { values: [{ links: { html: { href: 'https://bitbucket.org/acme/billing/pull-requests/3' } } }] } }));
    expect(await openPullRequest(bb, { branch: 'feature/acme-9', title: 't', body: '', draft: true }, { env, fetchImpl: h.fetchImpl })).toEqual({ ok: true, url: 'https://bitbucket.org/acme/billing/pull-requests/3', existed: true });
    expect(decodeURIComponent(h.calls[1].url)).toContain('source.branch.name="feature/acme-9" AND state="OPEN"');
  });

  it("doesn't look up a branch whose name would change the query", async () => {
    const h = host((c) => (c.method === 'POST' ? { status: 400, json: { error: { message: 'no' } } } : { status: 200, json: { values: [{ links: { html: { href: 'https://bitbucket.org/acme/billing/pull-requests/1' } } }] } }));
    const res = await openPullRequest(bb, { branch: 'x" OR source.branch.name!="', title: 't', body: '', draft: true }, { env, fetchImpl: h.fetchImpl });
    expect(res.ok).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it('opens on GitHub, and says what the token lacks when refused', async () => {
    const ok = host(() => ({ status: 201, json: { html_url: 'https://github.com/acme/web/pull/12' } }));
    expect(await openPullRequest(gh, { branch: 'agent/x', title: 't', body: 'b', draft: false }, { env, fetchImpl: ok.fetchImpl })).toEqual({ ok: true, url: 'https://github.com/acme/web/pull/12' });
    expect(ok.calls[0].body).toMatchObject({ head: 'agent/x', base: 'main', draft: false });
    const refused = host((c) => (c.method === 'POST' ? { status: 403, json: { message: 'Resource not accessible by integration' } } : { status: 200, json: [] }));
    const res = await openPullRequest(gh, { branch: 'agent/x', title: 't', body: 'b', draft: true }, { env, fetchImpl: refused.fetchImpl });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Pull requests: Read and write') });
    expect(await openPullRequest(bb, { branch: 'b', title: 't', body: '', draft: true }, { env: () => undefined })).toMatchObject({ ok: false });
  });

  it('says on the run that it opened one, and still names the branch for follow-ups', () => {
    const text = describeLanded([
      { repo: 'billing', branch: 'feature/acme-9', url: 'https://bitbucket.org/acme/billing/pull-requests/7', pr: 'draft' },
      { repo: 'web', branch: 'agent/y', url: 'https://github.com/acme/web/compare/main...agent/y', prError: 'GitHub said 403.' },
    ]);
    expect(text).toContain('Opened a draft pull request for billing: https://bitbucket.org/acme/billing/pull-requests/7 (branch feature/acme-9)');
    expect(text).toContain("it couldn't be opened for you: GitHub said 403.");
    expect(landedBranches(text)).toEqual(['feature/acme-9', 'agent/y']);
  });
});
