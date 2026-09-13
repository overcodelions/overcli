import { describe, expect, it, vi } from 'vitest';
import type { ServiceSpec } from '@shared/services';
import { runWithConcurrency, startLayers } from './servicesStartPlan';

function spec(id: string, deps?: string[]): ServiceSpec {
  return {
    id,
    name: id,
    runner: 'command',
    command: ['true'],
    ready: { kind: 'none' },
    selfReloads: false,
    config: {},
    deps,
  };
}

describe('startLayers', () => {
  it('starts independent services together and dependencies first', () => {
    const services = [
      spec('web', ['api']),
      spec('api', ['db', 'redis']),
      spec('worker', ['db']),
      spec('db'),
      spec('redis'),
    ];
    expect(startLayers(services, ['web', 'worker'])).toEqual([
      ['db', 'redis'],
      ['api', 'worker'],
      ['web'],
    ]);
  });

  it('includes a dependency outside the selected group', () => {
    expect(startLayers([spec('api', ['publish']), spec('publish')], ['api'])).toEqual([
      ['publish'],
      ['api'],
    ]);
  });

  it('degrades a cycle to serial starts', () => {
    expect(startLayers([spec('a', ['b']), spec('b', ['a'])], ['a'])).toEqual([['b'], ['a']]);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds its concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    });
    const work = runWithConcurrency([1, 2, 3, 4, 5], 2, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    releases.shift()?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());
    await work;
    expect(peak).toBe(2);
  });
});
