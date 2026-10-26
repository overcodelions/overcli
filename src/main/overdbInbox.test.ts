import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionsInbox, type PushOutcome } from './overdbInbox';
import type { ConnectionPush } from '../shared/overdbConnection';

let dir: string;
let events: string[];

function envelope(id: string, name: string, createdAt = '2026-01-02T03:04:05.000Z') {
  return {
    version: 1,
    kind: 'overdb-connection',
    id,
    createdAt,
    connection: { id: `c-${id}`, name, env: 'staging', engine: 'postgres', host: 'db.internal', credential: { source: 'aws-iam' } },
  };
}

function drop(file: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
}

function inbox(push: (p: ConnectionPush) => Promise<PushOutcome>): ConnectionsInbox {
  return new ConnectionsInbox(dir, push, {
    pushed: (p) => events.push(`pushed ${p.connection.name}`),
    waiting: (p, e) => events.push(`waiting ${p.connection.name}: ${e}`),
    rejected: (n, r) => events.push(`rejected ${n}: ${r}`),
  });
}

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-conns-')), 'connections');
  events = [];
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('ConnectionsInbox', () => {
  it('makes its folder on start, which is how overdb knows to offer publishing', () => {
    const box = inbox(async () => ({ ok: true, message: '' }));
    box.start();
    box.dispose();
    expect(fs.readdirSync(dir).sort()).toEqual(['done', 'rejected']);
  });

  it('pushes each file, oldest first, and files it under done', async () => {
    fs.mkdirSync(dir, { recursive: true });
    drop('2026-01-02-b.json', envelope('b', 'orders-prod'));
    drop('2026-01-01-a.json', envelope('a', 'shop-staging'));
    const sent: string[] = [];
    const box = inbox(async (p) => {
      sent.push(p.connection.name);
      return { ok: true, message: 'ok' };
    });
    box.start();
    await box.scan();
    box.dispose();
    expect(sent).toEqual(['shop-staging', 'orders-prod']);
    expect(fs.readdirSync(path.join(dir, 'done')).sort()).toEqual(['2026-01-01-a.json', '2026-01-02-b.json']);
  });

  it('keeps a file while nobody is signed in, and sends it after the sign-in', async () => {
    fs.mkdirSync(dir, { recursive: true });
    drop('a.json', envelope('a', 'shop-staging'));
    drop('b.json', envelope('b', 'orders-prod'));
    let signedIn = false;
    const box = inbox(async () => (signedIn ? { ok: true, message: '' } : { ok: false, error: 'Sign in first.', retry: true }));
    await box.scan();
    // Waiting on the same thing, the second is not even tried.
    expect(events).toEqual(['waiting shop-staging: Sign in first.']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()).toEqual(['a.json', 'b.json']);
    signedIn = true;
    await box.retry();
    expect(events.slice(1)).toEqual(['pushed shop-staging', 'pushed orders-prod']);
  });

  it('files what the server refused, or could not read, under rejected with the reason', async () => {
    fs.mkdirSync(path.join(dir, 'rejected'), { recursive: true });
    drop('a.json', envelope('a', 'shop-staging'));
    drop('b.json', 'not json');
    drop('c.json', { ...envelope('c', 'x'), kind: 'slow-query' });
    const box = inbox(async () => ({ ok: false, error: 'Only people who may hire workers can publish a database.', retry: false }));
    await box.scan();
    expect(fs.readdirSync(path.join(dir, 'rejected')).sort()).toEqual([
      'a.json', 'a.json.reason.txt', 'b.json', 'b.json.reason.txt', 'c.json', 'c.json.reason.txt',
    ]);
    expect(fs.readFileSync(path.join(dir, 'rejected', 'a.json.reason.txt'), 'utf-8')).toContain('may hire workers');
  });

  it('files a pushed connection under done even when scanned before start, so it is never sent twice', async () => {
    fs.mkdirSync(dir, { recursive: true });
    drop('a.json', envelope('a', 'shop-staging'));
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
      sent.push(p.connection.name);
      return { ok: true, message: '' };
    }).scan();
    expect(sent).toEqual([]);
  });
});
