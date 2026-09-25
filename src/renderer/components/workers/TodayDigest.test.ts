import { describe, expect, it } from 'vitest';

import { defaultItem, findRow, type DigestModel } from './TodayDigest';
import type { QueueRow } from './workQueue';

function row(key: string, extra: Partial<QueueRow> = {}): QueueRow {
  return {
    key,
    workerId: 'w1',
    workerName: 'Chief of Staff',
    task: 'errand',
    status: 'quiet',
    title: key,
    steps: [],
    at: 1,
    ...extra,
  } as QueueRow;
}

function model(done: QueueRow[]): DigestModel {
  return {
    spine: {} as DigestModel['spine'],
    now: 0,
    needs: [],
    working: [],
    done,
    quiet: [],
    earlier: [],
    filed: {},
    digest: {},
  };
}

describe('findRow', () => {
  it('finds a row by its key', () => {
    const m = model([row('a'), row('b')]);
    expect(findRow(m, { kind: 'done', key: 'b' })?.key).toBe('b');
  });

  it('follows a lone answer into the group it folded into', () => {
    const group = row('answers:w1:0', { answers: [{ key: 'b', title: 'b', at: 2 }, { key: 'a', title: 'a', at: 1 }] });
    const m = model([group]);
    expect(findRow(m, { kind: 'done', key: 'a' })?.key).toBe('answers:w1:0');
    expect(defaultItem(m)).toEqual({ kind: 'done', key: 'answers:w1:0' });
  });

  it('is undefined for a key that left the list', () => {
    expect(findRow(model([row('a')]), { kind: 'done', key: 'zzz' })).toBeUndefined();
  });
});
