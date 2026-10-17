// Which Slack thread is about which paused run.
//
// A DM is the question; its thread is where the answer comes back. The record
// is written BEFORE the bridge treats a post as done, so a restart between
// posting and saving cannot DM the same question twice — and a reply that
// arrives after a restart still finds its run.

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';
import type { UUID } from '../../shared/types';

export type SlackThreadKind = 'question' | 'approval';

export interface SlackThread {
  id: string;
  kind: SlackThreadKind;
  runId: UUID;
  stepId: string;
  /// The exchange a question came from, so a second question on the same
  /// step is a second thread rather than a duplicate of the first.
  exchangeId?: string;
  workerId: UUID;
  workerName: string;
  managerSlackUserId: string;
  channel: string;
  /// The DM's own ts; replies carry it as `thread_ts`.
  threadTs: string;
  createdAt: number;
  resolvedAt?: number;
  resolution?: 'answered' | 'approved' | 'rejected' | 'elsewhere';
}

/// Resolved threads are kept this long so a late reply still gets a polite
/// "already handled" instead of silence, then pruned.
const KEEP_RESOLVED_MS = 14 * 24 * 60 * 60 * 1000;

export function threadKey(t: Pick<SlackThread, 'runId' | 'stepId' | 'kind' | 'exchangeId'>): string {
  return `${t.runId}:${t.stepId}:${t.kind}:${t.exchangeId ?? ''}`;
}

export interface ThreadStore {
  list(): SlackThread[];
  save(threads: SlackThread[]): void;
}

function storePath(): string {
  return path.join(host().dataDir(), 'slack', 'threads.json');
}

export const fileThreadStore: ThreadStore = {
  list() {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as SlackThread[]) : [];
    } catch {
      return [];
    }
  },
  save(threads) {
    const target = storePath();
    const now = Date.now();
    const kept = threads.filter((t) => !t.resolvedAt || now - t.resolvedAt < KEEP_RESOLVED_MS);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(kept), 'utf8');
      fs.renameSync(tmp, target);
    } catch (err) {
      log('warn', 'slack', `Failed to persist Slack threads: ${String(err)}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
    }
  },
};
