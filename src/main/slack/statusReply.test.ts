import { describe, expect, it } from 'vitest';
import type { TodayView } from '../org/orgService';
import { GREETING, STATUS_ASK, statusReply } from './statusReply';

const quiet: TodayView = {
  org: 'Acme',
  waiting: [],
  hireApprovals: [],
  teamTasks: [],
  proposals: [],
  delivered: [],
  crew: [{ id: 'w1', name: 'Vantage', state: 'idle' }],
  spend: { spentUSD: 12.5, projectedUSD: 30 },
};

describe('status reply', () => {
  it('takes a status question about the whole crew, not about one thing', () => {
    for (const q of ['how we doing today', 'How are we doing?', "what's going on", 'status', 'any updates', 'anything waiting on me', 'catch me up', "how's it going"]) {
      expect(STATUS_ASK.test(q), q).toBe(true);
    }
    for (const q of ["what's the status of ACME-412", 'how are we doing on the pricing page redesign', 'status of the export bug', 'fix the login page']) {
      expect(STATUS_ASK.test(q), q).toBe(false);
    }
  });

  it('knows a hello or a ping from a request', () => {
    for (const q of ['hello', 'are you there', 'hey overcli', 'you there?', 'ping']) expect(GREETING.test(q), q).toBe(true);
    for (const q of ['hello, can you check ACME-412', 'test the login page']) expect(GREETING.test(q), q).toBe(false);
  });

  it("leads with what's waiting on the person, then who's working and what landed", () => {
    const text = statusReply({
      ...quiet,
      waiting: [{ runId: 'r1', workerId: 'w2', workerName: 'Triage', kind: 'approval', title: 'Push the export fix', stepId: 's', since: 1 }],
      proposals: [{ batchId: 'b', workerId: 'w3', workerName: 'Scout', at: 1, task: 'shift', items: [{ candidateId: 'c', title: 'Audit acme.example' }] }],
      crew: [{ id: 'w1', name: 'Vantage', state: 'working' }, { id: 'w2', name: 'Triage', state: 'waiting' }],
      delivered: [{ entryId: 'e', workerId: 'w1', workerName: 'Vantage', title: 'Pricing comparison', at: 1 }],
    }, 'https://overcli.acme.example');
    expect(text.startsWith('*Waiting on you (2)*')).toBe(true);
    expect(text).toContain('*Triage* wants an OK: Push the export fix');
    expect(text).toContain('*Scout* proposes Audit acme.example');
    expect(text).toContain('*Now:* Vantage is working.');
    expect(text).toContain('• *Vantage*: Pricing comparison');
    expect(text).toContain('<https://overcli.acme.example|Open the console>');
  });

  it('says so when everything is quiet, or when there is no one to report on', () => {
    expect(statusReply(quiet)).toContain('Nothing is waiting on you.');
    expect(statusReply(quiet)).toContain('Everyone is idle right now.');
    expect(statusReply({ ...quiet, crew: [] })).toContain("You don't manage any workers yet.");
  });
});
