import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboundHandoff } from '../shared/handoff';
import { HandoffInbox } from './handoffInbox';

let dir: string;
let inbox: HandoffInbox | null;
let changes: InboundHandoff[][];

function handoff(over: Partial<InboundHandoff> = {}): InboundHandoff {
  return {
    v: 1,
    id: 'h1',
    from: 'overdb',
    kind: 'slow-query',
    title: 'orders_by_customer scans on prod',
    summary: 'Seq scan on orders.',
    repoHints: ['/work/acme-orders'],
    createdAt: 1000,
    ...over,
  };
}

function drop(name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
}

function open(): HandoffInbox {
  inbox = new HandoffInbox(dir, (items) => changes.push(items));
  inbox.start();
  return inbox;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-inbox-'));
  changes = [];
  inbox = null;
});

afterEach(() => {
  inbox?.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('HandoffInbox', () => {
  it('reads what arrived while the app was closed', () => {
    drop('1000-h1.json', handoff());
    const box = open();
    expect(box.list().map((h) => h.id)).toEqual(['h1']);
    expect(changes).toHaveLength(1);
  });

  it('creates its folders on a fresh machine', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    open();
    expect(fs.existsSync(path.join(dir, 'done'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'rejected'))).toBe(true);
  });

  it('orders the list oldest first', () => {
    drop('b.json', handoff({ id: 'late', createdAt: 2000 }));
    drop('a.json', handoff({ id: 'early', createdAt: 1000 }));
    expect(open().list().map((h) => h.id)).toEqual(['early', 'late']);
  });

  it('ignores a sender mid-write and dotfiles', () => {
    drop('1000-h1.json.tmp', handoff());
    drop('.DS_Store', 'x');
    expect(open().list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, '1000-h1.json.tmp'))).toBe(true);
  });

  it('moves an unreadable file to rejected with the reason beside it', () => {
    drop('bad.json', '{not json');
    drop('old.json', handoff({ v: 2 as 1 }));
    const box = open();
    expect(box.list()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'rejected')).sort()).toEqual([
      'bad.json',
      'bad.json.reason.txt',
      'old.json',
      'old.json.reason.txt',
    ]);
    expect(fs.readFileSync(path.join(dir, 'rejected', 'old.json.reason.txt'), 'utf-8')).toMatch(
      /unsupported version/,
    );
  });

  it('rejects an oversized file without reading it into the list', () => {
    drop('big.json', handoff({ summary: 'x'.repeat(70 * 1024) }));
    expect(open().list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'rejected', 'big.json'))).toBe(true);
  });

  it('does not follow a symlink out of the inbox', () => {
    const outside = path.join(os.tmpdir(), `overcli-outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify(handoff()));
    try {
      fs.symlinkSync(outside, path.join(dir, 'link.json'));
      expect(open().list()).toEqual([]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('treats a resend of a waiting id as the same work', () => {
    drop('a.json', handoff());
    drop('b.json', handoff());
    const box = open();
    expect(box.list()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'done', 'b.json'))).toBe(true);
  });

  it('resolve moves the file to done and reports the change', () => {
    drop('1000-h1.json', handoff());
    const box = open();
    expect(box.resolve('h1')).toBe(true);
    expect(box.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'done', '1000-h1.json'))).toBe(true);
    expect(changes.at(-1)).toEqual([]);
    expect(box.resolve('h1')).toBe(false);
  });

  it('a rescan picks up new files and only reports real changes', () => {
    const box = open();
    expect(changes).toHaveLength(0);
    drop('1000-h1.json', handoff());
    box.scan();
    expect(changes).toHaveLength(1);
    box.scan();
    expect(changes).toHaveLength(1);
  });

  it('a file the sender withdrew leaves the list', () => {
    drop('1000-h1.json', handoff());
    const box = open();
    fs.rmSync(path.join(dir, '1000-h1.json'));
    box.scan();
    expect(box.list()).toEqual([]);
  });
});
