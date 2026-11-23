// What an ephemeral worker leaves behind, removed once its conversation ends.
//
// An ephemeral worker holds a tool whose output may carry customer data
// (`OrgPolicy.sensitiveTools`, shared/org/ephemeral.ts). What it read and
// said is kept only while the conversation is open: once nothing has been
// said for EPHEMERAL_IDLE_MS, or EPHEMERAL_MAX_MS after it began, this
// removes it — the agent's session transcripts, its runs and what they
// logged, its batches, the asks it answered, its journal and its files.
// The content goes; the record of what the worker did stays. Before each run
// is removed, the decision log gets its action record (`actionRecord`): when,
// how it ended, its cost, and each tool it called with a count, never what a
// tool was given or returned. Then one line says what was purged, with counts.
// Both are kept like the rest of the log, for as long as Setup → Records says.
//
// Run from housekeeping every few minutes, and once at start, so a server
// that was down when a conversation ended still purges it.
//
// Sessions are found through a ledger (`EphemeralLedger`): ids only, written
// as each turn of an ephemeral worker reports its session. The worker record
// alone is not enough — a new day's desk thread, or an edited job, replaces
// the session it held before anything could purge it.

import fs from 'node:fs';
import path from 'node:path';
import { conversationEnded, isEphemeralWorker, EPHEMERAL_IDLE_MS, type EphemeralPolicy, type EphemeralWorkerShape } from '../../shared/org/ephemeral';
import { flowRunActivityAt, type FlowRun } from '../../shared/flows/schema';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { AskStore, AuditStore } from './orgStores';
import { RUN_ACTIVITY_MAX } from '../flows/runActivity';

// ---- the ledger -------------------------------------------------------------

export interface LedgerEntry {
  workerId: string;
  /// The conversation (desk or thread) the sessions belong to, or the
  /// session itself for a one-off turn with no conversation.
  key: string;
  sessionIds: string[];
  startedAt: number;
  at: number;
}

export interface EphemeralLedger {
  list(): LedgerEntry[];
  /// Note a session a turn of this worker ran under.
  record(args: { workerId: string; key?: string; sessionId: string; at: number }): void;
  remove(keys: ReadonlyArray<{ workerId: string; key: string }>): void;
}

/// The ledger as a file of ids (no content), so a restart still knows what
/// to purge.
export function fileEphemeralLedger(file: string): EphemeralLedger {
  const read = (): LedgerEntry[] => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as LedgerEntry[]) : [];
    } catch {
      return [];
    }
  };
  const write = (entries: LedgerEntry[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    list: read,
    record({ workerId, key, sessionId, at }) {
      const k = key ?? sessionId;
      const all = read();
      const held = all.find((e) => e.workerId === workerId && e.key === k);
      if (held) {
        if (!held.sessionIds.includes(sessionId)) held.sessionIds.push(sessionId);
        held.at = Math.max(held.at, at);
      } else {
        all.push({ workerId, key: k, sessionIds: [sessionId], startedAt: at, at });
      }
      write(all);
    },
    remove(keys) {
      if (!keys.length) return;
      const gone = new Set(keys.map((k) => `${k.workerId}\n${k.key}`));
      write(read().filter((e) => !gone.has(`${e.workerId}\n${e.key}`)));
    },
  };
}

// ---- the purge --------------------------------------------------------------

export interface EphemeralWorker extends EphemeralWorkerShape {
  id: string;
  name: string;
  threadSessions?: Record<string, { conversationId: string; sessionId?: string; at: number }>;
  deskSession?: { conversationId: string; sessionId?: string };
}

export interface EphemeralPurgeDeps {
  policy(): EphemeralPolicy;
  workers(): EphemeralWorker[];
  ledger: EphemeralLedger;
  /// Delete these agent sessions' transcripts (sessionPurge.ts).
  purgeSessions(sessionIds: string[]): { purged: number };
  /// Drop ended conversations from the worker record, so the next message
  /// starts fresh instead of resuming a session that is gone.
  forgetConversations(workerId: string, ended: { threadKeys: string[]; desk: boolean }): void;
  runs: {
    list(): FlowRun[];
    /// Forced: an ephemeral run's worktree holds nothing anyone reviews later.
    delete(runId: string): { ok: boolean };
  };
  runActivity?: { forget(runId: string): unknown; list?(runId: string): ReadonlyArray<{ kind: string; tool?: string }> };
  workLog: { forget(runIds: string[]): number };
  orchestrations: { list(): Orchestration[]; delete(id: string): unknown };
  asks?: AskStore;
  journal: {
    list(workerId: string): Array<{ id: string; at: number }>;
    delete(workerId: string, ids: string[]): number;
  };
  files: {
    list(workerId: string): Array<{ name: string; modifiedAt: number }>;
    delete(workerId: string, name: string): unknown;
  };
  audit: AuditStore;
  now?(): number;
  log(message: string): void;
}

export interface PurgeCounts {
  sessions: number;
  runs: number;
  batches: number;
  asks: number;
  notes: number;
  files: number;
}

const BUSY = new Set(['proposed', 'queued', 'running', 'paused']);

function batchActivityAt(o: Orchestration): number {
  return o.items.reduce((max, i) => Math.max(max, i.finishedAt ?? i.startedAt ?? 0), o.createdAt);
}

/// Purge every ephemeral worker's ended conversations. Returns what went, by worker id.
export function purgeEphemeral(deps: EphemeralPurgeDeps): Map<string, PurgeCounts> {
  const now = deps.now?.() ?? Date.now();
  const policy = deps.policy();
  const out = new Map<string, PurgeCounts>();
  const workers = deps.workers().filter((w) => isEphemeralWorker(w, policy));
  if (!workers.length) return out;
  const idleBefore = now - EPHEMERAL_IDLE_MS;
  const ledger = deps.ledger.list();
  const allRuns = deps.runs.list();
  const allBatches = deps.orchestrations.list();

  for (const w of workers) {
    const counts: PurgeCounts = { sessions: 0, runs: 0, batches: 0, asks: 0, notes: 0, files: 0 };
    const sessionIds: string[] = [];

    // Conversations (desk, Slack threads, one-off turns) that have ended.
    const mine = ledger.filter((e) => e.workerId === w.id);
    const ended = mine.filter((e) => conversationEnded(e.startedAt, e.at, now));
    const live = new Set(mine.filter((e) => !ended.includes(e)).map((e) => e.key));
    for (const e of ended) sessionIds.push(...e.sessionIds);
    // Held on the worker record but not live in the ledger: ended, or from
    // before the worker became ephemeral. Either way, not a conversation to keep.
    const threadKeys = Object.entries(w.threadSessions ?? {})
      .filter(([, s]) => !live.has(s.conversationId) && s.at <= idleBefore)
      .map(([key, s]) => {
        if (s.sessionId) sessionIds.push(s.sessionId);
        return key;
      });
    const desk = !!w.deskSession && !live.has(w.deskSession.conversationId);
    if (desk && w.deskSession?.sessionId) sessionIds.push(w.deskSession.sessionId);

    // Finished runs, quiet for the idle window.
    const runs = allRuns.filter(
      (r) => r.workerId === w.id && (r.state.kind === 'done' || r.state.kind === 'aborted') && flowRunActivityAt(r) <= idleBefore,
    );
    const goneRuns: string[] = [];
    for (const r of runs) {
      sessionIds.push(...Object.values(r.sessionIdsByParticipant ?? {}));
      // Read before the run goes: the record of what it did outlives it.
      const activity = deps.runActivity?.list?.(r.id) ?? [];
      if (deps.runs.delete(r.id).ok) {
        goneRuns.push(r.id);
        deps.audit.append({ at: now, by: 'overcli', what: actionRecord(w.name, r, activity) });
        void deps.runActivity?.forget(r.id);
      }
    }
    counts.runs = goneRuns.length;
    deps.workLog.forget(goneRuns);

    // Batches: the ask that made them and the worker's reply.
    for (const o of allBatches) {
      if (o.origin?.kind !== 'worker' || o.origin.workerId !== w.id) continue;
      if (o.items.some((i) => BUSY.has(i.status)) || batchActivityAt(o) > idleBefore) continue;
      deps.orchestrations.delete(o.id);
      counts.batches++;
    }

    // Asks it answered.
    if (deps.asks) {
      const all = deps.asks.list();
      const kept = all.filter((a) => a.workerId !== w.id || a.status === 'working' || (a.doneAt ?? a.at) > idleBefore);
      counts.asks = all.length - kept.length;
      if (counts.asks) deps.asks.save(kept);
    }

    // Its journal (notes, things it was told to remember) and its files.
    const notes = deps.journal.list(w.id).filter((e) => e.at <= idleBefore).map((e) => e.id);
    if (notes.length) counts.notes = deps.journal.delete(w.id, notes);
    for (const f of deps.files.list(w.id)) {
      if (f.modifiedAt > idleBefore) continue;
      deps.files.delete(w.id, f.name);
      counts.files++;
    }

    // Transcripts last: everything above may have named one.
    counts.sessions = deps.purgeSessions([...new Set(sessionIds)]).purged;
    if (threadKeys.length || desk) deps.forgetConversations(w.id, { threadKeys, desk });
    deps.ledger.remove(ended.map((e) => ({ workerId: w.id, key: e.key })));

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) continue;
    out.set(w.id, counts);
    const what = describe(counts);
    const kept = counts.runs ? ` Kept ${counts.runs === 1 ? '1 action record' : `${counts.runs} action records`}.` : '';
    deps.audit.append({ at: now, by: 'overcli', what: `Purged ${w.name}'s ended conversations (sensitive tools): ${what}.${kept}` });
    deps.log(`org: purged ${w.name}'s ended conversations: ${what}.`);
  }
  return out;
}

/// What a run did, without anything it read or said: written to the decision
/// log as the run is purged, so the record of an ephemeral worker's actions
/// outlives its content. Tool names and counts only, never their inputs or
/// results. The run id ties it to the decisions people made about the run
/// (approvals, answers, a stop), which name an ephemeral worker's runs by id.
export function actionRecord(workerName: string, r: FlowRun, activity: ReadonlyArray<{ kind: string; tool?: string }>): string {
  const started = r.attempts.reduce((min, a) => Math.min(min, a.startedAt ?? min), r.createdAt ?? 0);
  const ended = flowRunActivityAt(r);
  const steps = new Set(r.attempts.map((a) => a.stepId)).size;
  const cost = r.costUSD ?? r.attempts.reduce((sum, a) => sum + (a.costUSD ?? 0), 0);
  const used = tally(activity.filter((i) => i.kind === 'tool'));
  const refused = tally(activity.filter((i) => i.kind === 'denied'));
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  return (
    `${workerName}'s run ${r.id} ${r.state.kind === 'aborted' ? 'was stopped' : 'ended'} ` +
    `(${stamp(started)} to ${stamp(ended)} UTC, ${steps} ${steps === 1 ? 'step' : 'steps'}, $${cost.toFixed(2)}). ` +
    `Tools used: ${used || 'none recorded'}.` +
    (refused ? ` Refused: ${refused}.` : '') +
    (activity.length >= RUN_ACTIVITY_MAX ? ' Only its latest activity was kept, so counts may be low.' : '')
  );
}

/// `mcp__acme_logs__search` as `acme_logs.search`; built-in tools as named.
function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}.${m[2]}` : name;
}

function tally(items: ReadonlyArray<{ tool?: string }>): string {
  const counts = new Map<string, number>();
  let unnamed = 0;
  for (const i of items) {
    if (!i.tool) unnamed++;
    else counts.set(toolLabel(i.tool), (counts.get(toolLabel(i.tool)) ?? 0) + 1);
  }
  const named = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => `${t} ×${n}`);
  if (unnamed) named.push(`${unnamed} unnamed ${unnamed === 1 ? 'call' : 'calls'}`);
  return named.join(', ');
}

function describe(c: PurgeCounts): string {
  const part = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
  return [
    ...part(c.sessions, 'transcript', 'transcripts'),
    ...part(c.runs, 'run', 'runs'),
    ...part(c.batches, 'batch', 'batches'),
    ...part(c.asks, 'ask', 'asks'),
    ...part(c.notes, 'journal entry', 'journal entries'),
    ...part(c.files, 'file', 'files'),
  ].join(', ');
}

// ---- recording sessions -----------------------------------------------------

type ParkProposal<A, R> = { parkProposal(args: A): Promise<R> };

/// The worker engine's parker, with each producer turn of an ephemeral worker
/// noted in the ledger: the turn's conversation (desk or thread) and the
/// session it ran under. Everything else passes straight through.
export function withSessionLedger<
  P extends ParkProposal<{ origin?: Orchestration['origin']; conversationId?: string }, { ok: boolean; sessionId?: string }>,
>(parker: P, opts: { ledger: EphemeralLedger; isEphemeral(workerId: string): boolean; now?(): number; log(message: string): void }): P {
  return new Proxy(parker, {
    get(target, prop) {
      if (prop === 'parkProposal') {
        return async (args: Parameters<P['parkProposal']>[0]) => {
          const res = await target.parkProposal(args);
          const origin = args.origin;
          if (origin?.kind === 'worker' && res.sessionId) {
            try {
              if (opts.isEphemeral(origin.workerId)) {
                opts.ledger.record({ workerId: origin.workerId, key: args.conversationId, sessionId: res.sessionId, at: opts.now?.() ?? Date.now() });
              }
            } catch (err) {
              opts.log(`org: could not note an ephemeral session: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return res;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
