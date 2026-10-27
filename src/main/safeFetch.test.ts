import { afterEach, describe, expect, it } from 'vitest';
import { fetchesChecked, judgeFetch, noteSeen, seedOnce, setSafeFetch, urlKey } from './safeFetch';

const on = (ownDomains: string[] = []) => setSafeFetch({ mode: () => 'safe', ownDomains: () => ownDomains });
const fetch = (key: string, url: string) => judgeFetch(key, { url, prompt: 'summarize' });

afterEach(() => setSafeFetch(null));

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

  it('compares addresses without scheme, fragment or trailing slash, keeping the query', () => {
    expect(urlKey('https://Vendor.example/a/?b=1#c')).toBe('vendor.example/a?b=1');
    expect(urlKey('http://vendor.example/')).toBe('vendor.example');
    expect(urlKey('ftp://x')).toBeNull();
  });
});
