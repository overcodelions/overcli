// Find past work, not just the worker who did it.
//
// The sidebar's search used to match worker names only, so "where is the
// thing Soraya found about the London hotel" had no answer short of opening
// each desk and scrolling. This searches every job the renderer holds — what
// it was called, what you asked for, which shift, which worker, and the
// worker's own headline for it — newest first.
//
// Every word of the query must appear somewhere in the job (in any field, in
// any order): "soraya hotel" finds Soraya's hotel job without matching every
// job that mentions a hotel.

import type { Orchestration } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';

export interface WorkMatch {
  key: string;
  workerId: string;
  workerName: string;
  orchestrationId: string;
  title: string;
  /// When it finished, or when it was proposed if it never ran.
  at: number;
  status: string;
  runId?: string;
  task: 'shift' | 'errand';
  /// The worker's own headline for the result, when the run recorded one.
  headline?: string;
}

export function searchWork(
  orchestrations: Record<string, Orchestration>,
  runs: Record<string, FlowRun>,
  query: string,
  limit = 40,
): WorkMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: WorkMatch[] = [];
  for (const batch of Object.values(orchestrations)) {
    const origin = batch.origin;
    if (origin?.kind !== 'worker') continue;
    const task = origin.task ?? 'shift';
    for (const item of batch.items) {
      const run = item.runId ? runs[item.runId] : undefined;
      const headline = run?.digest?.headline;
      const haystack = [
        item.candidate.title,
        item.candidate.prompt,
        item.candidate.note,
        origin.errand,
        origin.workerName,
        batch.title,
        headline,
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!words.every((w) => haystack.includes(w))) continue;
      out.push({
        key: `${batch.id}:${item.candidate.id}`,
        workerId: origin.workerId,
        workerName: origin.workerName,
        orchestrationId: batch.id,
        title: item.candidate.title,
        at: item.finishedAt ?? item.startedAt ?? batch.createdAt,
        status: item.status,
        ...(item.runId ? { runId: item.runId } : {}),
        task,
        ...(headline ? { headline } : {}),
      });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
