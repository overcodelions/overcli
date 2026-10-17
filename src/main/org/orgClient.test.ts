import { describe, expect, it } from 'vitest';
import { normalizeOrgUrl } from './orgClient';

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
