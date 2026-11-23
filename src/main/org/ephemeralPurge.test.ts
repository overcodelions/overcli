import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EPHEMERAL_IDLE_MS, EPHEMERAL_MAX_MS, conversationEnded, isEphemeralWorker, sensitiveToolsHeld } from '../../shared/org/ephemeral';
import type { FlowRun } from '../../shared/flows/schema';
import type { Orchestration } from '../../shared/flows/orchestration';
import { fileEphemeralLedger, purgeEphemeral, withSessionLedger, type EphemeralPurgeDeps, type EphemeralWorker } from './ephemeralPurge';
import type { AskRecord, AuditEntry } from './orgStores';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);
const SID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('which workers are ephemeral', () => {
  const policy = { sensitiveTools: ['Log Reader'], roles: [{ name: 'Support', tools: ['log_reader'] }] as never[] };

  it('is the worker holding a sensitive tool, by its own list, its role, or the shared ones', () => {
    expect(isEphemeralWorker({ mcpServers: ['Log_Reader'] }, policy)).toBe(true);
    expect(isEphemeralWorker({ role: 'support' }, policy)).toBe(true);
    expect(isEphemeralWorker({ role: 'support', roleToolsOff: ['log_reader'] }, policy)).toBe(false);
    expect(isEphemeralWorker({}, { ...policy, sharedMcpServers: ['log reader'] })).toBe(true);
    expect(isEphemeralWorker({ mcpServers: ['wiki'] }, policy)).toBe(false);
  });

  it('is nobody when the org names no sensitive tools', () => {
    expect(sensitiveToolsHeld({ mcpServers: ['Log_Reader'] }, { roles: [] })).toEqual([]);
  });

  it('ends a conversation after the idle window, or the cap however busy', () => {
    expect(conversationEnded(NOW - HOUR, NOW - 10 * 60_000, NOW)).toBe(false);
    expect(conversationEnded(NOW - 3 * HOUR, NOW - EPHEMERAL_IDLE_MS, NOW)).toBe(true);
    expect(conversationEnded(NOW - EPHEMERAL_MAX_MS, NOW - 60_000, NOW)).toBe(true);
  });
});

function run(id: string, workerId: string, endedAt: number, sessions: string[], kind: 'done' | 'running' = 'done'): FlowRun {
  return {
    id,
    workerId,
    createdAt: endedAt - HOUR,
    attempts: [{ stepId: 's', startedAt: endedAt - HOUR, endedAt }],
    state: { kind },
    sessionIdsByParticipant: Object.fromEntries(sessions.map((s, i) => [`p${i}`, s])),
  } as unknown as FlowRun;
}

function harness(
  workers: EphemeralWorker[],
  opts: { runs?: FlowRun[]; batches?: Orchestration[]; asks?: AskRecord[]; activity?: Record<string, Array<{ kind: string; tool?: string; text: string }>> } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-eph-'));
  const ledger = fileEphemeralLedger(path.join(dir, 'ledger.json'));
  let runs = opts.runs ?? [];
  let batches = opts.batches ?? [];
  let asks = opts.asks ?? [];
  let journal = [
    { workerId: 'w1', id: 'j-old', at: NOW - 5 * HOUR },
    { workerId: 'w1', id: 'j-new', at: NOW - 10 * 60_000 },
  ];
  let files = [
    { name: 'old.md', modifiedAt: NOW - 5 * HOUR },
    { name: 'new.md', modifiedAt: NOW - 60_000 },
  ];
  const purged: string[] = [];
  const forgotten: Array<{ id: string; threadKeys: string[]; desk: boolean }> = [];
  const workLogForgot: string[] = [];
  const activityForgot: string[] = [];
  const audit: AuditEntry[] = [];
  const deps: EphemeralPurgeDeps = {
    policy: () => ({ sensitiveTools: ['logs'], roles: [] }),
    workers: () => workers,
    ledger,
    purgeSessions: (ids) => (purged.push(...ids), { purged: ids.length }),
    forgetConversations: (id, ended) => forgotten.push({ id, ...ended }),
    runs: { list: () => runs, delete: (id) => ((runs = runs.filter((r) => r.id !== id)), { ok: true }) },
    runActivity: { forget: (id) => activityForgot.push(id), list: (id) => opts.activity?.[id] ?? [] },
    workLog: { forget: (ids) => (workLogForgot.push(...ids), ids.length) },
    orchestrations: { list: () => batches, delete: (id) => (batches = batches.filter((b) => b.id !== id)) },
    asks: { list: () => asks, save: (a) => (asks = a) },
    journal: {
      list: (w) => journal.filter((e) => e.workerId === w),
      delete: (w, ids) => {
        const n = journal.length;
        journal = journal.filter((e) => e.workerId !== w || !ids.includes(e.id));
        return n - journal.length;
      },
    },
    files: { list: () => files, delete: (_w, name) => (files = files.filter((f) => f.name !== name)) },
    audit: { append: (e) => audit.push(e), recent: () => audit },
    now: () => NOW,
    log: () => {},
  };
  return {
    deps,
    ledger,
    purged,
    forgotten,
    workLogForgot,
    activityForgot,
    audit,
    runs: () => runs,
    batches: () => batches,
    asks: () => asks,
    journal: () => journal,
    files: () => files,
  };
}

const cw: EphemeralWorker = { id: 'w1', name: 'Logan', mcpServers: ['logs'] };
const plain: EphemeralWorker = { id: 'w2', name: 'Wiki', mcpServers: ['wiki'] };

describe('purgeEphemeral', () => {
  it('purges an ended conversation and keeps one still going', () => {
    const h = harness([cw]);
    h.ledger.record({ workerId: 'w1', key: 'slack:C1:1.1', sessionId: SID(1), at: NOW - 4 * HOUR });
    h.ledger.record({ workerId: 'w1', key: 'slack:C1:1.1', sessionId: SID(2), at: NOW - 3 * HOUR });
    h.ledger.record({ workerId: 'w1', key: 'slack:C1:2.2', sessionId: SID(3), at: NOW - 5 * 60_000 });
    purgeEphemeral(h.deps);
    expect(h.purged.sort()).toEqual([SID(1), SID(2)]);
    expect(h.ledger.list().map((e) => e.key)).toEqual(['slack:C1:2.2']);
  });

  it('ends a busy conversation at the cap', () => {
    const h = harness([cw]);
    h.ledger.record({ workerId: 'w1', key: 'desk', sessionId: SID(1), at: NOW - 25 * HOUR });
    h.ledger.record({ workerId: 'w1', key: 'desk', sessionId: SID(1), at: NOW - 60_000 });
    purgeEphemeral(h.deps);
    expect(h.purged).toEqual([SID(1)]);
  });

  it('removes quiet finished runs with their transcripts, activity and work log, and leaves running ones', () => {
    const h = harness([cw], {
      runs: [run('r-old', 'w1', NOW - 3 * HOUR, [SID(7)]), run('r-live', 'w1', NOW - 3 * HOUR, [SID(8)], 'running'), run('r-recent', 'w1', NOW - 60_000, [SID(9)]), run('r-other', 'w2', NOW - 9 * HOUR, [SID(10)])],
    });
    purgeEphemeral(h.deps);
    expect(h.runs().map((r) => r.id).sort()).toEqual(['r-live', 'r-other', 'r-recent']);
    expect(h.purged).toEqual([SID(7)]);
    expect(h.workLogForgot).toEqual(['r-old']);
    expect(h.activityForgot).toEqual(['r-old']);
  });

  it('removes quiet settled batches, answered asks, old journal entries and files', () => {
    const batch = (id: string, status: string, finishedAt: number) =>
      ({ id, createdAt: finishedAt - HOUR, origin: { kind: 'worker', workerId: 'w1', workerName: 'Logan' }, items: [{ status, finishedAt }] }) as unknown as Orchestration;
    const ask = (id: string, workerId: string, status: AskRecord['status'], doneAt: number) => ({ id, workerId, status, at: doneAt - 60_000, doneAt }) as AskRecord;
    const h = harness([cw], {
      batches: [batch('b-old', 'done', NOW - 3 * HOUR), batch('b-busy', 'running', NOW - 3 * HOUR), batch('b-new', 'done', NOW - 60_000)],
      asks: [ask('a-old', 'w1', 'answered', NOW - 3 * HOUR), ask('a-working', 'w1', 'working', NOW - 3 * HOUR), ask('a-other', 'w2', 'answered', NOW - 9 * HOUR)],
    });
    purgeEphemeral(h.deps);
    expect(h.batches().map((b) => b.id)).toEqual(['b-busy', 'b-new']);
    expect(h.asks().map((a) => a.id)).toEqual(['a-working', 'a-other']);
    expect(h.journal().map((e) => e.id)).toEqual(['j-new']);
    expect(h.files().map((f) => f.name)).toEqual(['new.md']);
  });

  it('drops quiet thread and desk sessions from the worker record, keeping live ones', () => {
    const worker: EphemeralWorker = {
      ...cw,
      threadSessions: {
        'slack:C1:1.1': { conversationId: 'slack:C1:1.1', sessionId: SID(4), at: NOW - 3 * HOUR },
        'slack:C1:2.2': { conversationId: 'slack:C1:2.2', sessionId: SID(5), at: NOW - 60_000 },
      },
      deskSession: { conversationId: 'desk-1', sessionId: SID(6) },
    };
    const h = harness([worker]);
    h.ledger.record({ workerId: 'w1', key: 'desk-1', sessionId: SID(6), at: NOW - 60_000 });
    purgeEphemeral(h.deps);
    expect(h.forgotten).toEqual([{ id: 'w1', threadKeys: ['slack:C1:1.1'], desk: false }]);
    expect(h.purged).toEqual([SID(4)]);
  });

  it('writes one audit line with counts and no content', () => {
    const h = harness([cw], { runs: [run('r-old', 'w1', NOW - 3 * HOUR, [SID(7)])] });
    purgeEphemeral(h.deps);
    expect(h.audit).toHaveLength(2);
    expect(h.audit[0].what).toMatch(/^Logan's run \S+ ended \(/);
    expect(h.audit[1].what).toBe("Purged Logan's ended conversations (sensitive tools): 1 transcript, 1 run, 1 journal entry, 1 file. Kept 1 action record.");
  });

  it('keeps a record of what each purged run did: tools and counts, nothing it read or said', () => {
    const h = harness([cw], {
      runs: [run('r-old', 'w1', NOW - 3 * HOUR, [])],
      activity: {
        'r-old': [
          { kind: 'said', text: 'Customer jo@acme.example.com asked about order 991' },
          { kind: 'tool', tool: 'mcp__logs__search', text: 'logs: search (jo@acme.example.com)' },
          { kind: 'tool', tool: 'mcp__logs__search', text: 'logs: search (order 991)' },
          { kind: 'tool', tool: 'Read', text: 'Read customers/jo.md' },
          { kind: 'tool', text: 'an older item, written before names were kept' },
          { kind: 'error', text: 'Order 991 not found' },
          { kind: 'denied', tool: 'Bash', text: 'Refused: curl https://acme.example.com/export' },
        ],
      },
    });
    purgeEphemeral(h.deps);
    expect(h.runs()).toEqual([]);
    const record = h.audit.find((e) => e.what.includes('r-old'))!.what;
    expect(record).toMatch(/^Logan's run r-old ended \(\d{4}-\d\d-\d\d \d\d:\d\d to \d{4}-\d\d-\d\d \d\d:\d\d UTC, 1 step, \$0\.00\)\./);
    expect(record).toContain('Tools used: logs.search ×2, Read ×1, 1 unnamed call.');
    expect(record).toContain('Refused: Bash ×1.');
    expect(record).not.toMatch(/jo@|991|customers|curl|acme\.example/);
  });

  it('leaves workers without a sensitive tool alone', () => {
    const h = harness([plain], { runs: [run('r-old', 'w2', NOW - 9 * HOUR, [SID(7)])] });
    expect(purgeEphemeral(h.deps).size).toBe(0);
    expect(h.runs()).toHaveLength(1);
    expect(h.audit).toHaveLength(0);
  });
});

describe('withSessionLedger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-eph-ledger-'));

  it('notes an ephemeral worker turn under its conversation, and passes everything else through', async () => {
    const ledger = fileEphemeralLedger(path.join(dir, 'l.json'));
    const parker = {
      calls: 0,
      async parkProposal(args: { origin?: Orchestration['origin']; conversationId?: string }) {
        this.calls++;
        return { ok: true as const, sessionId: args.origin?.kind === 'worker' && args.origin.workerId === 'w1' ? SID(1) : SID(2) };
      },
      list() {
        return this.calls;
      },
    };
    const wrapped = withSessionLedger(parker, { ledger, isEphemeral: (id) => id === 'w1', now: () => NOW, log: () => {} });
    const origin = (workerId: string) => ({ kind: 'worker', workerId, workerName: workerId }) as Orchestration['origin'];
    await wrapped.parkProposal({ origin: origin('w1'), conversationId: 'slack:C1:1.1' });
    await wrapped.parkProposal({ origin: origin('w2'), conversationId: 'slack:C1:1.1' });
    expect(ledger.list()).toEqual([{ workerId: 'w1', key: 'slack:C1:1.1', sessionIds: [SID(1)], startedAt: NOW, at: NOW }]);
    expect(wrapped.list()).toBe(2);
  });
});
