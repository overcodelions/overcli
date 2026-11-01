// A worker's runs get a number, #1, #2, …, for people to say and scan. The
// id stays the key everywhere (URLs, Slack, the API); the number is only
// what a person reads.
//
// Old runs are pruned, so "how many runs it has + 1" would hand out a
// number twice. The last number given is kept per worker in one small
// file, and never goes below the highest number still on disk, so a lost
// file can't repeat a number anyone can see. Runs from before numbering
// simply have none.

import fs from 'node:fs';
import path from 'node:path';

type Numbered = { workerId?: string; number?: number };

function read(file: string): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/// The next number for this worker's run, saved before it is returned.
export function nextRunNumber(file: string, workerId: string, runs: Iterable<Numbered>): number {
  const last = read(file);
  let top = Number.isInteger(last[workerId]) ? last[workerId] : 0;
  for (const r of runs) if (r.workerId === workerId && typeof r.number === 'number' && r.number > top) top = r.number;
  const next = top + 1;
  last[workerId] = next;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(last));
    fs.renameSync(tmp, file);
  } catch {
    // Unsaved, the next number still clears every run on disk.
  }
  return next;
}
