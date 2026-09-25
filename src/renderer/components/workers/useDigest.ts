// The digest entry for each finished job: its headline, a sentence and a few
// facts, read from the best source the job has.
//
// In order: the headline the run recorded from its worker (`run.digest`), the
// file it delivered, the last output its run kept, and — for a job with none
// of those — its own title. A file is read once per version (path + mtime),
// so the page settling every thirty seconds costs nothing.

import { useEffect, useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { digestFor, kindOf, type DigestSummary } from './digestSummary';
import type { QueueRow } from './workQueue';
import type { WorkerFile } from './workerDeskSelectors';
import type { FlowRun } from '@shared/flows/schema';

/// Enough of a deliverable to skim; the reader loads the whole thing.
const SKIM_BYTES = 24_000;

const fileText = new Map<string, string | null>();

function fileKey(file: WorkerFile): string {
  return `${file.path}@${file.modifiedAt}`;
}

/// The run's last produced artifact — the flow's final output — as text.
export function finalArtifactText(run: FlowRun | undefined): string {
  if (!run) return '';
  const artifacts = Object.values(run.artifacts ?? {});
  if (artifacts.length === 0) return '';
  const last = artifacts.reduce((a, b) => (b.producedAt > a.producedAt ? b : a));
  return last.body ?? '';
}

export function useDigest(
  rows: QueueRow[],
  filed: Record<string, WorkerFile | null | undefined>,
): Record<string, DigestSummary> {
  const runs = useFlowsStore((s) => s.runs);
  const [version, bump] = useState(0);

  // Read every delivered file not yet cached. One read per file version.
  useEffect(() => {
    const wanted = rows
      .map((row) => filed[row.key])
      .filter((f): f is WorkerFile => !!f && !fileText.has(fileKey(f)));
    if (wanted.length === 0) return;
    let live = true;
    for (const f of wanted) fileText.set(fileKey(f), null);
    void Promise.all(
      wanted.map(async (f) => {
        const res = await window.overcli.invoke('fs:readLargeTextPreview', { path: f.path });
        fileText.set(fileKey(f), res && res.ok ? res.content.slice(0, SKIM_BYTES) : '');
      }),
    ).then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [rows, filed]);

  return useMemo(() => {
    const out: Record<string, DigestSummary> = {};
    for (const row of rows) {
      const run = row.runId ? runs[row.runId] : undefined;
      if (run?.digest?.headline) {
        out[row.key] = { headline: run.digest.headline, summary: run.digest.summary ?? '', points: run.digest.points ?? [] };
        continue;
      }
      const file = filed[row.key];
      const text = file ? fileText.get(fileKey(file)) : undefined;
      if (file && text) {
        out[row.key] = digestFor(text, kindOf(file.name), row.title);
        continue;
      }
      const final = finalArtifactText(run);
      out[row.key] = final
        ? digestFor(final, 'markdown', row.title)
        : { headline: row.title, summary: '', points: [] };
    }
    return out;
    // `version` moves when a file read lands.
  }, [rows, filed, runs, version]);
}
