// What each finished job actually PRODUCED, keyed by row.
//
// A tail that says "Done" ten times tells you the crew was busy and nothing
// about what you got — and the report, the spec, the page is the entire
// reason the job was run.
//
// Both front pages ask this question now, so it lives here rather than twice.
// It is addressed through `workers:deliverables`, which takes the same four
// facts the filing used; main owns that naming rule and the renderer does not
// reproduce it. The two would drift the first time either changed, and the
// failure would be a silently missing link rather than anything that breaks.

import { useEffect, useMemo, useState } from 'react';

import { pickDeliverable, type QueueRow } from './workQueue';

import type { WorkerFile } from './workerDeskSelectors';

/// How long a just-finished job's empty answer is re-asked.
///
/// A null is cached like any other answer, EXCEPT for a job that finished
/// moments ago: the run is done but the file may still be landing, so an
/// empty answer there is a race rather than a fact.
const SETTLING_MS = 120_000;

export function useDeliverables(rows: QueueRow[], now: number): Record<string, WorkerFile | null> {
  const [filed, setFiled] = useState<Record<string, WorkerFile | null>>({});

  // Only `done` rows: a failure, an orphan and a quiet shift all filed
  // nothing, so asking about them is a directory read per row per render for
  // a guaranteed empty answer.
  const asking = useMemo(
    () => rows.filter((row) => row.status === 'done' && row.batchLabel),
    [rows],
  );

  useEffect(() => {
    const wanted = asking.filter(
      (row) => !(row.key in filed) || (filed[row.key] === null && now - row.at < SETTLING_MS),
    );
    if (wanted.length === 0) return;
    let live = true;
    void Promise.all(
      wanted.map(async (row) => {
        const files = await window.overcli.invoke('workers:deliverables', {
          id: row.workerId,
          task: row.task,
          label: row.batchLabel!,
          title: row.title,
          at: row.at,
        });
        return [row.key, pickDeliverable(files)] as const;
      }),
    ).then((pairs) => {
      if (live) setFiled((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      live = false;
    };
  }, [asking, filed, now]);

  return filed;
}
