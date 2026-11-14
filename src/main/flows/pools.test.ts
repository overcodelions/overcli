import { describe, expect, it } from 'vitest';
import { Pool, limitNow, poolLimits } from './pools';

const GiB = 1024 ** 3;

describe('Pool', () => {
  it('lets the waiting in first come first served as places free', async () => {
    const pool = new Pool(1);
    const order: string[] = [];
    const first = await pool.take();
    const b = pool.take().then((r) => (order.push('b'), r));
    const c = pool.take().then((r) => (order.push('c'), r));
    expect(pool.waiting).toBe(2);
    expect(pool.tryTake()).toBe(false);
    first();
    first(); // twice gives back one place, not two
    const releaseB = await b;
    expect(order).toEqual(['b']);
    expect(pool.inUse).toBe(1);
    releaseB();
    (await c)();
    expect(order).toEqual(['b', 'c']);
    expect(pool.inUse).toBe(0);
  });

  it('reads a changing limit, and lets the waiting in when it is raised', async () => {
    let cap = 1;
    const pool = new Pool(() => cap);
    await pool.take();
    let got = false;
    void pool.take().then(() => (got = true));
    await Promise.resolve();
    expect(got).toBe(false);
    cap = 2;
    pool.poke();
    await Promise.resolve();
    expect(got).toBe(true);
    expect(pool.inUse).toBe(2);
  });

  it('never makes anyone wait without a limit', async () => {
    const pool = new Pool(null);
    await Promise.all([pool.take(), pool.take(), pool.take()]);
    expect(pool.inUse).toBe(3);
    expect(pool.tryTake()).toBe(true);
  });
});

describe('poolLimits', () => {
  it('sizes answers by memory and code runs by CPU', () => {
    expect(poolLimits({}, { cpus: 2, memBytes: 8 * GiB })).toEqual({ answers: { machine: 12 }, code: { machine: 2 } });
    expect(poolLimits({}, { cpus: 4, memBytes: 16 * GiB })).toEqual({ answers: { machine: 28 }, code: { machine: 4 } });
    expect(poolLimits({}, { cpus: 1, memBytes: 2 * GiB })).toEqual({ answers: { machine: 4 }, code: { machine: 1 } });
    expect(poolLimits({}, { cpus: 64, memBytes: 256 * GiB })).toEqual({ answers: { machine: 64 }, code: { machine: 64 } });
  });

  it('reads the environment, 0 for no limit, and ignores nonsense', () => {
    const machine = { cpus: 2, memBytes: 8 * GiB };
    expect(poolLimits({ OVERCLI_ANSWERS_AT_ONCE: '30', OVERCLI_CODE_RUNS_AT_ONCE: '0' }, machine)).toEqual({ answers: { machine: 12, env: 30 }, code: { machine: 2, env: null } });
    expect(poolLimits({ OVERCLI_ANSWERS_AT_ONCE: 'lots', OVERCLI_CODE_RUNS_AT_ONCE: '-1' }, machine)).toEqual({ answers: { machine: 12 }, code: { machine: 2 } });
  });

  it('takes the environment over the rule, and the rule over the machine', () => {
    expect(limitNow({ machine: 2 }, undefined)).toBe(2);
    expect(limitNow({ machine: 2 }, 5)).toBe(5);
    expect(limitNow({ machine: 2, env: 3 }, 5)).toBe(3);
    expect(limitNow({ machine: 2, env: null }, 5)).toBeNull();
  });
});
