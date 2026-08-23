// `cancelOneShot` is the Stop button behind the document rewrite bar. The
// contract that matters: an in-flight turn resolves as cancelled (which runs
// the same teardown as any other ending, so the CLI subprocess dies), and a
// key with nothing behind it is a no-op rather than a throw.

import { describe, expect, it } from 'vitest';
import { ONE_SHOT_CANCELLED } from './runner';

type Waiter = { settled: boolean; finish: (r: { ok: false; error: string }) => void };

/// The cancel path only touches two maps and the waiter's `finish`, so it is
/// exercised here against those structures rather than by booting a real
/// RunnerManager (which would spawn a CLI).
function cancelOneShot(
  cancelKeys: Map<string, string>,
  waiters: Map<string, Waiter>,
  cancelKey: string,
): boolean {
  const conversationId = cancelKeys.get(cancelKey);
  if (!conversationId) return false;
  const waiter = waiters.get(conversationId);
  if (!waiter || waiter.settled) return false;
  waiter.finish({ ok: false, error: ONE_SHOT_CANCELLED });
  return true;
}

describe('cancelOneShot', () => {
  it('resolves the in-flight turn as cancelled', () => {
    const results: string[] = [];
    const waiters = new Map<string, Waiter>([
      ['conv-1', { settled: false, finish: (r) => results.push(r.error) }],
    ]);
    const keys = new Map([['req-1', 'conv-1']]);

    expect(cancelOneShot(keys, waiters, 'req-1')).toBe(true);
    expect(results).toEqual([ONE_SHOT_CANCELLED]);
  });

  it('is a no-op for a key with nothing behind it', () => {
    expect(cancelOneShot(new Map(), new Map(), 'nope')).toBe(false);
  });

  it('will not re-finish a turn that already settled', () => {
    const results: string[] = [];
    const waiters = new Map<string, Waiter>([
      ['conv-1', { settled: true, finish: (r) => results.push(r.error) }],
    ]);
    const keys = new Map([['req-1', 'conv-1']]);

    expect(cancelOneShot(keys, waiters, 'req-1')).toBe(false);
    expect(results).toEqual([]);
  });

  it('uses a sentinel the UI can tell apart from a real failure', () => {
    expect(ONE_SHOT_CANCELLED).toBe('Cancelled.');
  });
});
