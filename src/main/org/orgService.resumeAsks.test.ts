import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import { OrgService } from './orgService';
import type { AskRecord } from './orgStores';

const NOW = 10 * 24 * 3_600_000;
const scout = { id: 'scout', name: 'Scout', enabled: true } as unknown as Worker;

function harness(asks: AskRecord[]) {
  let stored = asks;
  const errands: Array<[string, string]> = [];
  const told: AskRecord[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [scout],
      get: (id: string) => (id === scout.id ? scout : null),
      runErrand: async (id: string, text: string) => {
        errands.push([id, text]);
        return { ok: true, result: { reply: 'Acme moved first.', queued: 0, count: 0, orchestrationId: '' } };
      },
    },
    policy: () => DEFAULT_ORG_POLICY,
    asks: { list: () => stored, save: (all: AskRecord[]) => (stored = all) },
    onAskDone: (a: AskRecord) => told.push(a),
    now: () => NOW,
  } as unknown as ConstructorParameters<typeof OrgService>[0]);
  return { svc, errands, told, stored: () => stored };
}

const ask = (over: Partial<AskRecord>): AskRecord => ({ id: 'a1', workerId: 'scout', workerName: 'Scout', by: 'Pat', slackUserId: 'U0ACMEPAT', text: 'who moved first?', at: NOW - 60_000, status: 'working', via: 'slack', ...over });

describe('asks a restart cut short', () => {
  it('asks again, once, with what the worker was first given, and says files were lost', async () => {
    const { svc, errands, told, stored } = harness([ask({ prompt: '(Asked by Pat)\nwho moved first?', attachments: 2 })]);
    expect(svc.resumeAsks()).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(errands).toEqual([['scout', '(Asked by Pat)\nwho moved first?\n\n(The 2 files attached to this were lost when the server restarted. Say so if you need them.)']]);
    expect(stored()[0]).toMatchObject({ status: 'answered', reply: 'Acme moved first.', resumed: true });
    expect(told.map((a) => a.resumed)).toEqual([true]);
  });

  it('fails one already asked again, one older than a day, and one for a paused or gone worker', () => {
    const { svc, errands, stored } = harness([
      ask({ id: 'again', resumed: true }),
      ask({ id: 'old', at: NOW - 25 * 3_600_000 }),
      ask({ id: 'gone', workerId: 'nobody' }),
    ]);
    expect(svc.resumeAsks()).toBe(0);
    expect(errands).toEqual([]);
    expect(stored().map((a) => [a.id, a.status])).toEqual([['again', 'failed'], ['old', 'failed'], ['gone', 'failed']]);
  });
});
