import { describe, expect, it } from 'vitest';
import { dialable, normalizeOrgUrl, unreachable } from './orgClient';

describe('normalizeOrgUrl', () => {
  it('keeps https and trims to the origin', () => {
    expect(normalizeOrgUrl('https://overcli.acme.example:7420/console')).toEqual({ ok: true, url: 'https://overcli.acme.example:7420' });
  });
  it('allows plain http only to this machine', () => {
    expect(normalizeOrgUrl('http://127.0.0.1:7420')).toEqual({ ok: true, url: 'http://127.0.0.1:7420' });
    expect(normalizeOrgUrl('http://overcli.acme.example').ok).toBe(false);
    expect(normalizeOrgUrl('not a url').ok).toBe(false);
  });
});

describe('dialable', () => {
  it('connects to IPv4 for localhost, where overcli serve listens', () => {
    expect(dialable('http://localhost:7420')).toBe('http://127.0.0.1:7420');
    expect(dialable('https://overcli.acme.example:7420')).toBe('https://overcli.acme.example:7420');
  });
});

describe('unreachable', () => {
  it('says what to do when nothing answers', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(unreachable('http://localhost:7420', refused)).toContain('Is overcli serve running there?');
    expect(unreachable('http://localhost:7420', new TypeError('fetch failed'))).toBe('Could not reach the org server at http://localhost:7420.');
  });
});
