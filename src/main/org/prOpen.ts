// Opening the pull request for a branch the server pushed, through the git
// host's API, with the title and description the worker's last step wrote.
// A draft by default, so a person still decides it's ready for review; the
// Repos page can say "link only" (the way it was) or "open for review".
//
// Already open for that branch (a fix pushed onto it): that one's link is
// handed back, never a second pull request.

import { authFor, slugOf } from './ciWatch';
import type { ConnectedRepo } from './repos';

export type PrMode = 'link' | 'draft' | 'open';
export const PR_MODES: readonly PrMode[] = ['link', 'draft', 'open'];
export const DEFAULT_PR_MODE: PrMode = 'draft';

export type Opened = { ok: true; url: string; existed?: true } | { ok: false; error: string };

const BB = 'https://api.bitbucket.org/2.0/repositories';
const GH = 'https://api.github.com/repos';

function scopeHint(host: 'bitbucket' | 'github', status: number): string {
  if (status !== 401 && status !== 403) return '';
  return host === 'bitbucket'
    ? ' The token needs Pull requests: Write (Setup → Secrets, BITBUCKET_TOKEN).'
    : ' The token needs Pull requests: Read and write (Setup → Secrets, GH_TOKEN).';
}

async function said(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string }; message?: string; errors?: Array<{ message?: string }> };
    return j.error?.message ?? j.errors?.[0]?.message ?? j.message ?? '';
  } catch {
    return '';
  }
}

export async function openPullRequest(
  repo: ConnectedRepo,
  pr: { branch: string; title: string; body: string; draft: boolean },
  deps: { env(name: string): string | undefined; fetchImpl?: typeof fetch },
): Promise<Opened> {
  const slug = slugOf(repo);
  const auth = authFor(repo, deps.env);
  if (!slug) return { ok: false, error: 'Only Bitbucket and GitHub repos can have their pull requests opened for them.' };
  if (!auth) return { ok: false, error: 'There is no token for this repo’s host.' };
  const f = deps.fetchImpl ?? fetch;
  const headers = { ...auth, Accept: 'application/json', 'Content-Type': 'application/json' };
  const title = pr.title.slice(0, 250);
  if (slug.host === 'bitbucket') {
    const base = `${BB}/${slug.owner}/${slug.name}/pullrequests`;
    // One already open from this branch: that's the one, as it is. Asked
    // first, because a second create for the same branch edits the open
    // one, putting this run's title and description over its own. A branch
    // name with a quote in it would change the query, so it isn't looked up.
    const q = encodeURIComponent(`source.branch.name="${pr.branch}" AND state="OPEN"`);
    const found = /["\\]/.test(pr.branch) ? null : await f(`${base}?q=${q}`, { headers }).then((r) => (r.ok ? (r.json() as Promise<{ values?: Array<{ links?: { html?: { href?: string } } }> }>) : null)).catch(() => null);
    const href = found?.values?.[0]?.links?.html?.href;
    if (href) return { ok: true, url: href, existed: true };
    const res = await f(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, description: pr.body, source: { branch: { name: pr.branch } }, destination: { branch: { name: repo.defaultBranch } }, close_source_branch: true, draft: pr.draft }),
    });
    if (res.ok) {
      const j = (await res.json()) as { links?: { html?: { href?: string } } };
      if (j.links?.html?.href) return { ok: true, url: j.links.html.href };
    }
    const why = res.ok ? '' : await said(res);
    return { ok: false, error: `Bitbucket said ${res.status}${why ? `: ${why}` : ''}.${scopeHint('bitbucket', res.status)}` };
  }
  const gh = { ...headers, 'X-GitHub-Api-Version': '2022-11-28' };
  const res = await f(`${GH}/${slug.owner}/${slug.name}/pulls`, { method: 'POST', headers: gh, body: JSON.stringify({ title, body: pr.body, head: pr.branch, base: repo.defaultBranch, draft: pr.draft }) });
  if (res.ok) {
    const j = (await res.json()) as { html_url?: string };
    if (j.html_url) return { ok: true, url: j.html_url };
  }
  const why = res.ok ? '' : await said(res);
  const found = await f(`${GH}/${slug.owner}/${slug.name}/pulls?state=open&head=${encodeURIComponent(`${slug.owner}:${pr.branch}`)}`, { headers: gh })
    .then((r) => (r.ok ? (r.json() as Promise<Array<{ html_url?: string }>>) : null))
    .catch(() => null);
  if (found?.[0]?.html_url) return { ok: true, url: found[0].html_url, existed: true };
  return { ok: false, error: `GitHub said ${res.status}${why ? `: ${why}` : ''}.${scopeHint('github', res.status)}` };
}
