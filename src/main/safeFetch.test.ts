import { afterEach, describe, expect, it } from 'vitest';
import { fetchesChecked, judgeFetch, judgeFetchResolved, noteSeen, seedOnce, setLookup, setSafeFetch, urlKey } from './safeFetch';

const on = (ownDomains: string[] = []) => setSafeFetch({ mode: () => 'safe', ownDomains: () => ownDomains });
const fetch = (key: string, url: string) => judgeFetch(key, { url, prompt: 'summarize' });

afterEach(() => {
  setSafeFetch(null);
  setLookup(null);
});

describe('safe fetches', () => {
  it('only checks on a server that asked for it', () => {
    expect(fetchesChecked()).toBe(false);
    on();
    expect(fetchesChecked()).toBe(true);
    setSafeFetch({ mode: () => 'any', ownDomains: () => [] });
    expect(fetchesChecked()).toBe(false);
  });

  it('opens what a run was shown, and nothing it wrote itself', () => {
    on();
    noteSeen('run-a', 'Results:\n1. [Pricing](https://vendor.example/pricing/) — plans\n2. https://news.example/a?id=7.');
    expect(fetch('run-a', 'https://vendor.example/pricing').allow).toBe(true);
    expect(fetch('run-a', 'http://vendor.example/pricing#plans').allow).toBe(true);
    expect(fetch('run-a', 'https://news.example/a?id=7').allow).toBe(true);
    // The same site with something added to the address is a new address.
    const leak = fetch('run-a', 'https://vendor.example/pricing?q=ACME-412+customer+list');
    expect(leak.allow).toBe(false);
    expect(leak.note).toContain('Search the web for it');
    // Another run's results are not this one's.
    expect(fetch('run-b', 'https://vendor.example/pricing').allow).toBe(false);
  });

  it('takes the ask as shown, once', () => {
    on();
    seedOnce('run-c', 'Read https://blog.example/post and sum it up');
    seedOnce('run-c', 'https://other.example/x');
    expect(fetch('run-c', 'https://blog.example/post').allow).toBe(true);
    expect(fetch('run-c', 'https://other.example/x').allow).toBe(false);
  });

  it("opens the org's own sites, and never the server's insides", () => {
    on(['acme.atlassian.net', 'wiki.acme.lan']);
    expect(fetch('k', 'https://acme.atlassian.net/browse/ACME-1?x=1').allow).toBe(true);
    expect(fetch('k', 'https://wiki.acme.lan/page').allow).toBe(true);
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/', 'http://127.0.0.1/', 'http://[::1]/', 'http://metadata.google.internal/', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'http://[::ffff:7f00:1]/']) {
      noteSeen('k', url);
      expect(fetch('k', url).allow).toBe(false);
    }
    for (const url of ['http://10.0.0.5/', 'http://192.168.1.1/admin', 'http://intranet/', 'http://build.acme.internal/', 'http://[::ffff:a00:5]/']) {
      noteSeen('k', url);
      expect(fetch('k', url)).toMatchObject({ allow: false, why: expect.stringContaining('private') });
    }
    expect(fetch('k', 'https://user:pw@vendor.example/').allow).toBe(false);
    expect(fetch('k', 'file:///etc/passwd').allow).toBe(false);
  });

  it('resolves a public name before trusting it, and refuses one that points inside', async () => {
    on(['wiki.acme.lan']);
    setLookup(async (host) => ({ 'vendor.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], 'rebind.example': ['93.184.216.34', '10.0.0.5'], 'meta.example': ['169.254.169.254'], 'wiki.acme.lan': ['10.1.1.1'] })[host] ?? Promise.reject(new Error('ENOTFOUND')));
    for (const url of ['https://vendor.example/a', 'https://rebind.example/a', 'https://meta.example/a', 'https://gone.example/a', 'http://93.184.216.34/a']) noteSeen('r', url);
    expect(await judgeFetchResolved(fetch('r', 'https://vendor.example/a'))).toMatchObject({ allow: true });
    expect(await judgeFetchResolved(fetch('r', 'https://rebind.example/a'))).toMatchObject({ allow: false, why: expect.stringContaining('10.0.0.5') });
    expect(await judgeFetchResolved(fetch('r', 'https://meta.example/a'))).toMatchObject({ allow: false, why: expect.stringContaining('169.254.169.254') });
    expect(await judgeFetchResolved(fetch('r', 'https://gone.example/a'))).toMatchObject({ allow: false, why: expect.stringContaining('resolved') });
    // An address is checked as written; the org's own sites are its own wherever they point.
    expect(fetch('r', 'http://93.184.216.34/a').lookup).toBeUndefined();
    expect(await judgeFetchResolved(fetch('r', 'https://wiki.acme.lan/page'))).toMatchObject({ allow: true });
    // A refusal is never resolved.
    expect(await judgeFetchResolved(fetch('r', 'https://own.example/made-up'))).toMatchObject({ allow: false });
  });

  it('compares addresses without scheme, fragment or trailing slash, keeping the query', () => {
    expect(urlKey('https://Vendor.example/a/?b=1#c')).toBe('vendor.example/a?b=1');
    expect(urlKey('http://vendor.example/')).toBe('vendor.example');
    expect(urlKey('ftp://x')).toBeNull();
  });
});
