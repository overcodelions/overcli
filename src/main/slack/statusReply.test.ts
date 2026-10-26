import { describe, expect, it } from 'vitest';
import type { TodayView } from '../org/orgService';
import { GREETING, SELF_ASK, STATUS_ASK, adminReply, selfReply, statusReply, withoutHello } from './statusReply';

const quiet: TodayView = {
  org: 'Acme',
  waiting: [],
  hireApprovals: [], toolRequests: [], toolTrouble: [],
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

  it('answers spend questions about the crew, not the cost of some piece of work', () => {
    const view = { today: () => quiet };
    for (const q of ['which worker is spending the nost', 'Which worker is spending the most?', "who's the most expensive", 'who is over budget', 'how much have we spent', "what's our spend", 'spend by worker', 'most expensive workers']) {
      expect(adminReply(q, view), q).toContain('spent');
    }
    for (const q of ['how much will the migration cost', 'what would it cost to add SSO', 'reduce the cost of the checkout page', 'who owns the billing page']) {
      expect(adminReply(q, view), q).toBeNull();
    }
  });

  it('ranks workers by spend this month, with their budget', () => {
    const text = adminReply('which worker is spending the most', { today: () => ({
      ...quiet,
      crew: [
        { id: 'w1', name: 'Vantage', state: 'idle', spentUSD: 4 },
        { id: 'w2', name: 'Triage', state: 'working', spentUSD: 61.5, budgetUSDPerMonth: 50 },
        { id: 'w3', name: 'Scout', state: 'idle', spentUSD: 0 },
      ],
      spend: { spentUSD: 65.5, projectedUSD: 140 },
    }) }, 'https://overcli.acme.example')!;
    expect(text).toContain('*$65.50 spent this month* (on pace for $140)');
    expect(text.indexOf('*Triage*')).toBeLessThan(text.indexOf('*Vantage*'));
    expect(text).toContain('1. *Triage* $61.50 of $50 — *over budget*');
    expect(text).toContain("One other worker hasn't spent anything.");
    expect(adminReply('how much have we spent', { today: () => ({ ...quiet, crew: [{ id: 'w1', name: 'Vantage', state: 'idle', spentUSD: 0 }] }) })).toContain('Nothing spent yet');
  });

  it("answers who's working, stuck or idle, and lists the crew", () => {
    const view = { today: () => ({ ...quiet, crew: [{ id: 'w1', name: 'Vantage', state: 'working' as const }, { id: 'w2', name: 'Triage', state: 'stuck' as const }] }) };
    expect(adminReply("who's working?", view)).toBe('Vantage is working.');
    expect(adminReply('who is stuck', view)).toBe('Triage is stuck.');
    expect(adminReply('who is idle', view)).toBe('No one is idle right now.');
    expect(adminReply('list my workers', view)).toContain('*2 workers*');
    expect(adminReply('who is working on the pricing page', view)).toBeNull();
  });

  it('answers who does the most work from the timesheet, past a hello in front', () => {
    const view = {
      today: () => quiet,
      work: () => [
        { name: 'Vantage', itemsDone: 2, runs: 5, workedMs: 40 * 60_000 },
        { name: 'Ruby', itemsDone: 9, runs: 14, workedMs: 190 * 60_000 },
        { name: 'Scout', itemsDone: 0, runs: 0, workedMs: 0 },
      ],
    };
    for (const q of ['you there? which worker is doing the most work', 'who is the busiest', 'which worker has done the most', "hey, who's the most active"]) {
      expect(adminReply(q, view), q).toContain('*Most work, last 30 days*');
    }
    const text = adminReply('which worker is doing the most work', view)!;
    expect(text).toContain('1. *Ruby* 9 done · 14 runs · 3h 10m working');
    expect(text.indexOf('*Ruby*')).toBeLessThan(text.indexOf('*Vantage*'));
    expect(text).toContain("One other worker hasn't done anything.");
    expect(adminReply('who is doing the most work on ACME-412', { today: () => quiet })).toBeNull();
    expect(adminReply('which worker should do the pricing page', view)).toBeNull();
  });

  it('knows a question about the door itself from work about something else', () => {
    for (const q of ['what is overgo', 'What is overgo?', "what's overgo", 'who are you?', 'what can you do', 'what can I ask you', 'how does this work', 'help', 'what is this bot']) {
      expect(SELF_ASK.test(q), q).toBe(true);
    }
    for (const q of ["what is overgo's pricing vs Acme", 'what is the export bug', 'help me fix the login page', 'who is working on ACME-412']) {
      expect(SELF_ASK.test(q), q).toBe(false);
    }
  });

  it('says what the door is and who it can hand work to', () => {
    const text = selfReply([{ name: 'Vantage', tagline: 'Competitive analyst' }, { name: 'Triage' }]);
    expect(text).toContain("I'm overgo");
    expect(text).toContain('• *Vantage* — Competitive analyst\n• *Triage*');
    expect(selfReply([])).toContain('/hire');
  });

  it('sees a status question past a hello in front of it', () => {
    expect(STATUS_ASK.test(withoutHello('you there? how are we doing'))).toBe(true);
    expect(withoutHello('hello')).toBe('hello');
    expect(withoutHello('hey can you fix the login page')).toBe('hey can you fix the login page');
  });
});
