import { describe, expect, it, vi } from 'vitest';
import { describeProbe, probeOnce, waitUntilReady, type ProbeDeps } from './readiness';
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

describe('describeProbe', () => {
  it('says what each probe checks in the pane wording', () => {
    expect(describeProbe({ kind: 'http', path: '/actuator/health', port: 8080 })).toBe(
      'GET :8080/actuator/health',
    );
    expect(describeProbe({ kind: 'none' })).toBe('ready as soon as it starts');
  });
});
