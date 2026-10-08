import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  describeProbe,
  describeProbeFailure,
  probeAttempt,
  probeOnce,
  waitUntilReady,
  type ProbeDeps,
} from './readiness';
import type { ReadinessProbe } from './types';

/// A clock that only moves when the code under test sleeps, so a 60s timeout
/// costs nothing to assert on.
function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  let clock = 0;
  return {
    httpStatus: async () => 200,
    tcpOpen: async () => true,
    exitCode: async () => 0,
    logMatched: () => true,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    ...over,
  };
}

describe('probeOnce', () => {
  it('accepts the statuses the probe declares', async () => {
    const probe: ReadinessProbe = { kind: 'http', path: '/health', port: 8080, okStatuses: [204] };
    expect(await probeOnce(probe, deps({ httpStatus: async () => 204 }))).toBe(true);
    expect(await probeOnce(probe, deps({ httpStatus: async () => 200 }))).toBe(false);
  });

  it('treats a refused connection as "not yet", not as an error', async () => {
    const rejecting = deps({
      httpStatus: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(probeOnce({ kind: 'http', path: '/h', port: 8080 }, rejecting)).resolves.toBe(false);
  });

  it('asks the supervisor whether the log pattern has matched', async () => {
    const probe: ReadinessProbe = { kind: 'log', pattern: 'Compiled successfully' };
    expect(await probeOnce(probe, deps({ logMatched: () => false }))).toBe(false);
    expect(await probeOnce(probe, deps({ logMatched: () => true }))).toBe(true);
  });

  it('reads a command probe as exit zero', async () => {
    const probe: ReadinessProbe = { kind: 'command', command: ['pg_isready'] };
    expect(await probeOnce(probe, deps({ exitCode: async () => 1 }))).toBe(false);
  });
});

describe('probeAttempt', () => {
  it('keeps the status of an http answer that failed the probe', async () => {
    const probe: ReadinessProbe = { kind: 'http', path: '/actuator/health', port: 8088 };
    expect(await probeAttempt(probe, deps({ httpStatus: async () => 401 }))).toEqual({ ok: false, status: 401 });
  });

  it('says why nothing answered', async () => {
    const seen = await probeAttempt(
      { kind: 'http', path: '/h', port: 8080 },
      deps({
        httpStatus: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(seen).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('waitUntilReady', () => {
  it('returns immediately for a service that declares no probe', async () => {
    const sleep = vi.fn();
    const result = await waitUntilReady({ kind: 'none' }, deps({ sleep }));
    expect(result).toEqual({ ready: true, waitedMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until the probe passes and reports how long it took', async () => {
    let calls = 0;
    const result = await waitUntilReady(
      { kind: 'tcp', port: 8080 },
      deps({
        tcpOpen: async () => ++calls >= 3,
      }),
      { intervalMs: 500 },
    );
    expect(result.ready).toBe(true);
    expect(result.waitedMs).toBe(1000);
  });

  it('gives up at the timeout', async () => {
    const result = await waitUntilReady(
      { kind: 'tcp', port: 8080 },
      deps({ tcpOpen: async () => false }),
      { timeoutMs: 2000, intervalMs: 500 },
    );
    expect(result).toEqual({ ready: false, waitedMs: 2000 });
  });

  it('stops the moment the process dies instead of polling a corpse', async () => {
    // "It exited" and "it is up but not answering" have different causes and
    // different remedies — waiting out a 60s budget to say the vaguer one is
    // a worse answer delivered later.
    const result = await waitUntilReady(
      { kind: 'tcp', port: 8080 },
      deps({ tcpOpen: async () => false }),
      { timeoutMs: 60_000, isAlive: () => false },
    );
    expect(result.exited).toBe(true);
    expect(result.waitedMs).toBe(0);
  });
});

describe('waitUntilReady backoff', () => {
  it('asks quickly at first, then backs off to a cap', async () => {
    const gaps: number[] = [];
    let clock = 0;
    await waitUntilReady(
      { kind: 'tcp', port: 8080 },
      deps({
        tcpOpen: async () => false,
        now: () => clock,
        sleep: async (ms) => {
          gaps.push(ms);
          clock += ms;
        },
      }),
      { timeoutMs: 60_000 },
    );
    expect(gaps.slice(0, 6)).toEqual([1_000, 2_000, 5_000, 10_000, 10_000, 10_000]);
    expect(Math.max(...gaps)).toBe(10_000);
    // Under a tenth of the 120 attempts a fixed 500ms interval made.
    expect(gaps.length).toBeLessThan(12);
  });

  it('does not sleep past its budget', async () => {
    const gaps: number[] = [];
    let clock = 0;
    const result = await waitUntilReady(
      { kind: 'tcp', port: 8080 },
      deps({
        tcpOpen: async () => false,
        now: () => clock,
        sleep: async (ms) => {
          gaps.push(ms);
          clock += ms;
        },
      }),
      { timeoutMs: 4_000 },
    );
    expect(gaps).toEqual([1_000, 2_000, 1_000]);
    expect(result.waitedMs).toBe(4_000);
  });

  it('keeps a fixed interval when one is asked for', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await waitUntilReady({ kind: 'tcp', port: 1 }, deps({ tcpOpen: async () => ++calls >= 4, sleep }), {
      intervalMs: 3_000,
    });
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([3_000, 3_000, 3_000]);
  });

  it('caps the delay at the last step', () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(50)).toBe(10_000);
  });

  it('reports the last status the app answered with', async () => {
    let calls = 0;
    const result = await waitUntilReady(
      { kind: 'http', path: '/actuator/health', port: 8088 },
      deps({
        httpStatus: async () => {
          // Answers 401 once, then refuses — the 401 is still the news.
          if (++calls === 1) return 401;
          throw new Error('ECONNREFUSED');
        },
      }),
      { timeoutMs: 5_000 },
    );
    expect(result).toEqual({ ready: false, waitedMs: 5_000, lastStatus: 401 });
  });
});

describe('describeProbeFailure', () => {
  const probe: ReadinessProbe = { kind: 'http', path: '/actuator/health', port: 8088 };

  it('says a 401 means up but protected, and what to do', () => {
    expect(describeProbeFailure(probe, 401)).toBe(
      'probe failing: 401 on /actuator/health — the app is up but this path needs auth; pick another probe',
    );
  });

  it('says a 404 means up but nothing there', () => {
    expect(describeProbeFailure(probe, 404)).toContain('nothing is served there');
  });

  it('has nothing to add without a status', () => {
    expect(describeProbeFailure(probe, undefined)).toBeUndefined();
    expect(describeProbeFailure({ kind: 'tcp', port: 8088 }, 401)).toBeUndefined();
  });
});

describe('describeProbe', () => {
  it('says what each probe checks in the pane wording', () => {
    expect(describeProbe({ kind: 'http', path: '/actuator/health', port: 8080 })).toBe(
      'GET :8080/actuator/health',
    );
    expect(describeProbe({ kind: 'none' })).toBe('ready as soon as it starts');
  });
});
