import { describe, expect, it } from 'vitest';
import { FileLinks, fileHeaders } from './fileLinks';

const pat = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

describe('FileLinks', () => {
  it('redeems a link for an hour, then forgets it', () => {
    let now = 1_000;
    const links = new FileLinks(() => now);
    const id = links.issue({ caller: pat, runId: 'r1', name: 'reports/acme.html' });
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(links.redeem(id)).toEqual({ caller: pat, runId: 'r1', name: 'reports/acme.html' });
    now += 60 * 60 * 1000;
    expect(links.redeem(id)).toBeNull();
    expect(links.redeem('not-a-link-at-all-000000')).toBeNull();
  });

  it('opens a link only in a browser whose cookie names the person it was made for', () => {
    const links = new FileLinks();
    const sam = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };
    const id = links.issue({ caller: pat, runId: 'r1', name: 'reports/acme.html' });
    const patCookie = links.cookieFor(pat, false).split(';')[0];
    expect(links.open(id, patCookie)).toEqual({ ok: true, link: { caller: pat, runId: 'r1', name: 'reports/acme.html' } });
    expect(links.open(id, `theme=dark; ${patCookie}; other=1`).ok).toBe(true);
    // Forwarded to Sam: Sam's browser carries Sam's cookie, or none.
    expect(links.open(id, links.cookieFor(sam, false).split(';')[0])).toEqual({ ok: false, why: 'elsewhere' });
    expect(links.open(id, undefined)).toEqual({ ok: false, why: 'elsewhere' });
    expect(links.open('not-a-link-at-all-000000', patCookie)).toEqual({ ok: false, why: 'expired' });
    // Another server's key never matches this one's.
    expect(new FileLinks().keyFor(pat)).not.toBe(links.keyFor(pat));
    expect(links.cookieFor(pat, true)).toMatch(/; Secure$/);
  });
});

describe('fileHeaders', () => {
  it('sends HTML sandboxed, and anything unknown as plain text', () => {
    const page = fileHeaders('reports/acme.html', false);
    expect(page['Content-Type']).toMatch(/^text\/html/);
    expect(page['Content-Security-Policy']).toMatch(/^sandbox allow-scripts/);
    expect(page['Content-Security-Policy']).not.toMatch(/allow-same-origin/);
    expect(fileHeaders('chart.svg', false)['Content-Type']).toMatch(/^text\/plain/);
    expect(fileHeaders('reports/a b".csv', true)['Content-Disposition']).toBe('attachment; filename="a_b_.csv"');
  });
});
