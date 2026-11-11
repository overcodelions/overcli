import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApisInbox, type PushOutcome } from './overapiInbox';
import type { ApiPush } from '../shared/overapiProject';

let dir: string;
let events: string[];

function envelope(id: string, name: string, createdAt = '2026-01-02T03:04:05.000Z') {
  return {
    version: 1,
    kind: 'overapi-project',
    id,
    createdAt,
    env: 'staging',
    secrets: ['ACME_TOKEN'],
    project: {
      overapi: 1,
      name,
      title: name,
      envs: [{ name: 'staging', baseUrl: 'https://api.acme.example', auth: { type: 'bearer', tokenVar: 'ACME_TOKEN' }, allowWrites: false }],
      tools: [{ name: 'list_orders', method: 'GET', path: '/orders', safety: 'read' }],
    },
  };
}

function drop(file: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
}

function inbox(push: (p: ApiPush) => Promise<PushOutcome>): ApisInbox {
  return new ApisInbox(dir, push, {
    pushed: (p) => events.push(`pushed ${p.project.name}`),
    waiting: (p, e) => events.push(`waiting ${p.project.name}: ${e}`),
    rejected: (n, r) => events.push(`rejected ${n}: ${r}`),
  });
}

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-apis-')), 'apis');
  events = [];
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('ApisInbox', () => {
  it('makes its folder on start, which is how overapi knows to offer publishing', () => {
    const box = inbox(async () => ({ ok: true, message: '' }));
    box.start();
    box.dispose();
    expect(fs.readdirSync(dir).sort()).toEqual(['done', 'rejected']);
  });

  it('pushes each file, oldest first, and files it under done', async () => {
    fs.mkdirSync(dir, { recursive: true });
    drop('2026-01-02-b.json', envelope('b', 'acme-billing'));
    drop('2026-01-01-a.json', envelope('a', 'acme-orders'));
    const sent: string[] = [];
    const box = inbox(async (p) => {
      sent.push(p.project.name);
      return { ok: true, message: 'ok' };
    });
    box.start();
    await box.scan();
    box.dispose();
    expect(sent).toEqual(['acme-orders', 'acme-billing']);
    expect(fs.readdirSync(path.join(dir, 'done')).sort()).toEqual(['2026-01-01-a.json', '2026-01-02-b.json']);
  });

  it('keeps a file while nobody is signed in, and sends it after the sign-in', async () => {
    fs.mkdirSync(dir, { recursive: true });
    drop('a.json', envelope('a', 'acme-orders'));
    drop('b.json', envelope('b', 'acme-billing'));
    let signedIn = false;
    const box = inbox(async () => (signedIn ? { ok: true, message: '' } : { ok: false, error: 'Sign in first.', retry: true }));
    await box.scan();
    // Waiting on the same thing, the second is not even tried.
    expect(events).toEqual(['waiting acme-orders: Sign in first.']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()).toEqual(['a.json', 'b.json']);
    signedIn = true;
    await box.retry();
    expect(events.slice(1)).toEqual(['pushed acme-orders', 'pushed acme-billing']);
  });

  it('files what the server refused, or could not read, under rejected with the reason', async () => {
    fs.mkdirSync(path.join(dir, 'rejected'), { recursive: true });
    drop('a.json', envelope('a', 'acme-orders'));
    drop('b.json', 'not json');
    drop('c.json', { ...envelope('c', 'x'), kind: 'overdb-connection' });
    // A variable the environment reads that the admin would never be asked for.
    drop('d.json', { ...envelope('d', 'acme-sneaky'), secrets: [] });
    const box = inbox(async () => ({ ok: false, error: 'Only people who may hire workers can publish an API.', retry: false }));
    await box.scan();
    expect(fs.readdirSync(path.join(dir, 'rejected')).sort()).toEqual([
      'a.json', 'a.json.reason.txt', 'b.json', 'b.json.reason.txt', 'c.json', 'c.json.reason.txt', 'd.json', 'd.json.reason.txt',
    ]);
    expect(fs.readFileSync(path.join(dir, 'rejected', 'a.json.reason.txt'), 'utf-8')).toContain('may hire workers');
    expect(fs.readFileSync(path.join(dir, 'rejected', 'd.json.reason.txt'), 'utf-8')).toContain('ACME_TOKEN');
  });

  it('files a pushed API under done even when scanned before start, so it is never sent twice', async () => {
    fs.mkdirSync(dir, { recursive: true });
    drop('a.json', envelope('a', 'acme-orders'));
    let pushes = 0;
    const box = inbox(async () => {
      pushes += 1;
      return { ok: true, message: '' };
    });
    await box.scan();
    await box.scan();
    expect(pushes).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'done'))).toEqual(['a.json']);
  });

  it('never follows a link out of the folder, and ignores a sender mid-write', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(path.dirname(dir), 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(envelope('x', 'elsewhere')));
    fs.symlinkSync(outside, path.join(dir, 'link.json'));
    drop('half.json.tmp', envelope('h', 'half'));
    const sent: string[] = [];
    await inbox(async (p) => {
      sent.push(p.project.name);
      return { ok: true, message: '' };
    }).scan();
    expect(sent).toEqual([]);
  });
});
