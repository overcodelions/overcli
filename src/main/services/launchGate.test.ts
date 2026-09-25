import { describe, expect, it } from 'vitest';
import { defaultLaunchLimit, LaunchGate } from './launchGate';

describe('LaunchGate', () => {
  it('lets the limit through and holds the rest in order', async () => {
    const gate = new LaunchGate(2);
    const order: string[] = [];
    const a = await gate.acquire();
    await gate.acquire();
    expect(gate.full).toBe(true);
    void gate.acquire().then(() => order.push('c'));
    void gate.acquire().then(() => order.push('d'));
    await Promise.resolve();
    expect(order).toEqual([]);

    a();
    await Promise.resolve();
    expect(order).toEqual(['c']);
  });

  it('frees one slot however many times it is released', async () => {
    const gate = new LaunchGate(1);
    const release = await gate.acquire();
    let second = false;
    let third = false;
    void gate.acquire().then(() => (second = true));
    void gate.acquire().then(() => (third = true));
    release();
    release();
    await Promise.resolve();
    expect([second, third]).toEqual([true, false]);
  });
});

describe('defaultLaunchLimit', () => {
  it('is a third of the cores, and never fewer than two', () => {
    expect(defaultLaunchLimit(10)).toBe(3);
    expect(defaultLaunchLimit(4)).toBe(2);
    expect(defaultLaunchLimit(24)).toBe(8);
  });
});
