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

  describe('status for overdb', () => {
    function withOrg(org: () => import('../shared/overdbConnection').ConnectionsOrg, push: (p: ConnectionPush) => Promise<PushOutcome>) {
      return new ConnectionsInbox(dir, push, { pushed: () => {}, waiting: () => {}, rejected: () => {} }, org);
    }
    const status = () => JSON.parse(fs.readFileSync(path.join(dir, '.status.json'), 'utf-8'));

    it('says which org a push goes to, from the start', () => {
      const box = withOrg(() => ({ signedIn: true, org: 'Acme', url: 'https://overgo.acme.dev' }), async () => ({ ok: true, message: '' }));
      box.start();
      box.dispose();
      expect(status()).toMatchObject({ version: 1, signedIn: true, org: 'Acme', url: 'https://overgo.acme.dev' });
      expect(status().waiting).toBeUndefined();
    });

    it('says nobody is signed in, and why a push is waiting, until one lands', async () => {
      let signedIn = false;
      const box = withOrg(
        () => (signedIn ? { signedIn: true, url: 'https://overgo.acme.dev' } : { signedIn: false, error: 'Sign in first.' }),
        async () => (signedIn ? { ok: true, message: '' } : { ok: false, error: 'Sign in first.', retry: true }),
      );
      fs.mkdirSync(dir, { recursive: true });
      drop('2026-01-01-a.json', envelope('a', 'shop-staging'));
      box.start();
      await box.scan();
      expect(status()).toMatchObject({ signedIn: false, error: 'Sign in first.', waiting: 'Sign in first.' });
      signedIn = true;
      await box.retry();
      box.dispose();
      expect(status()).toMatchObject({ signedIn: true });
      expect(status().waiting).toBeUndefined();
      expect(fs.readdirSync(path.join(dir, 'done'))).toEqual(['2026-01-01-a.json']);
    });

    it('stops saying a push is waiting once the server refuses it outright', async () => {
      let signedIn = false;
      const box = withOrg(
        () => ({ signedIn: true, url: 'https://overgo.acme.dev' }),
        async () => (signedIn ? { ok: false, error: 'No such project.', retry: false } : { ok: false, error: 'Sign in first.', retry: true }),
      );
      fs.mkdirSync(dir, { recursive: true });
      drop('2026-01-01-a.json', envelope('a', 'shop-staging'));
      box.start();
      await box.scan();
      expect(status().waiting).toBe('Sign in first.');
      signedIn = true;
      await box.retry();
      box.dispose();
      expect(status().waiting).toBeUndefined();
      expect(fs.readdirSync(path.join(dir, 'rejected'))).toContain('2026-01-01-a.json');
    });

    it('is never taken for a push', async () => {
      const sent: string[] = [];
      const box = withOrg(() => ({ signedIn: false, error: 'no' }), async (p) => {
        sent.push(p.id);
        return { ok: true, message: '' };
      });
      box.start();
      await box.scan();
      box.dispose();
      expect(sent).toEqual([]);
      expect(fs.readdirSync(path.join(dir, 'rejected'))).toEqual([]);
    });

    it('does not set its own watcher off: an unchanged status is not rewritten', async () => {
      const box = withOrg(() => ({ signedIn: true, url: 'https://overgo.acme.dev' }), async () => ({ ok: true, message: '' }));
      box.start();
      await box.scan();
      const first = fs.statSync(path.join(dir, '.status.json')).mtimeMs;
      await new Promise((r) => setTimeout(r, 600));
      await box.scan();
      box.dispose();
      expect(fs.statSync(path.join(dir, '.status.json')).mtimeMs).toBe(first);
    });
  });
});
