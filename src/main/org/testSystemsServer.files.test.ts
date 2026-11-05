import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findHealth, readSystemsFile } from './testSystemsServer';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-systems-file-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const billing = { id: 'billing', name: 'Billing', url: 'https://staging.billing.acme.dev', signIn: { kind: 'none' } };

function write(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

describe('the apps file the tool reads at every open', () => {
  it('gives the apps in it', () => {
    expect(readSystemsFile(write('ok.json', JSON.stringify({ version: 1, systems: [billing] })))).toEqual([billing]);
  });

  it('gives none for a missing, broken, other-version or shapeless file', () => {
    expect(readSystemsFile(path.join(dir, 'nope.json'))).toEqual([]);
    expect(readSystemsFile(write('broken.json', '{ "version": 1, '))).toEqual([]);
    expect(readSystemsFile(write('v2.json', JSON.stringify({ version: 2, systems: [billing] })))).toEqual([]);
    expect(readSystemsFile(write('shape.json', JSON.stringify({ version: 1, systems: { billing } })))).toEqual([]);
  });
});

describe('finding an app’s health check', () => {
  const answering = (ok: Record<string, number>, seen: string[] = []) =>
    (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      const status = ok[new URL(u).pathname];
      if (status === undefined) throw new Error('ECONNREFUSED');
      return new Response(null, { status });
    }) as typeof fetch;

  it('takes the first usual path that answers 2xx', async () => {
    const seen: string[] = [];
    expect(await findHealth('https://staging.billing.acme.dev', answering({ '/health': 404, '/healthz': 302, '/api/health': 200, '/status': 200 }, seen))).toBe('/api/health');
    expect(seen).toEqual(['https://staging.billing.acme.dev/health', 'https://staging.billing.acme.dev/healthz', 'https://staging.billing.acme.dev/api/health']);
  });

  it('gives none when nothing answers, without throwing', async () => {
    expect(await findHealth('https://staging.billing.acme.dev', answering({ '/health': 500 }))).toBeUndefined();
  });
});
