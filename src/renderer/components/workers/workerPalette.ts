// A colour per worker, and a mark for trust.
//
// The calendar used to tint every block by TRUST, which meant the four workers
// on probation were the same amber and told you nothing about which of them
// was on at 8am. Identity is the thing a week grid has to answer first — whose
// block is that — so colour now belongs to the worker, and trust moved to a
// shape (see TrustPips), which is the right encoding for it anyway: trust is a
// three-rung ladder, and a ladder reads as a count, not as a hue.

import type { Worker, WorkerTrustLevel } from '@shared/flows/worker';

/// Ten hues that stay distinguishable on both themes and don't collapse into
/// each other at 11px. Deliberately not the trust colours' saturation — a
/// block should read as "Fielder", not as an alert.
export const WORKER_PALETTE = [
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#34d399', // emerald
  '#fbbf24', // amber
  '#f472b6', // pink
  '#60a5fa', // blue
  '#fb923c', // orange
  '#22d3ee', // cyan
  '#4ade80', // green
  '#c084fc', // purple
];

/// Colour per worker id, assigned by HIRE ORDER rather than by hashing the id.
///
/// A hash is stable across roster changes but collides: two workers can land on
/// the same hue while both are on screen, which is the one thing this must not
/// do. Ordering by `createdAt` gives every worker a distinct colour until the
/// roster outgrows the palette, and keeps a worker's colour fixed for as long
/// as nobody hired BEFORE it is fired — the trade that matters less, because a
/// firing is a deliberate act you are present for.
export function workerColorMap(workers: Worker[]): Record<string, string> {
  const out: Record<string, string> = {};
  const ordered = workers
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  ordered.forEach((w, i) => {
    out[w.id] = WORKER_PALETTE[i % WORKER_PALETTE.length];
  });
  return out;
}

/// A colour for an id that may not be in the map — a fired worker's shifts
/// outlive it on the grid, and they still have to be drawn as something.
export function workerColorFor(map: Record<string, string>, workerId: string): string {
  return map[workerId] ?? WORKER_PALETTE[0];
}

/// The one colour every schedule draws in on the shift calendar.
///
/// Deliberately NOT a slice of WORKER_PALETTE. Colour on that grid means "who
/// is this", and a schedule is not a who — giving each schedule its own hue
/// would put ten more identities into a legend that exists to name the roster,
/// and would make a schedule and a worker at 09:00 look like two colleagues.
/// One steel tone plus the clock mark says "this block is machinery" at a
/// glance, and the block's own label says which machinery.
export const SCHEDULE_TINT = '#94a3b8';

/// How many rungs of the trust ladder this worker has climbed. Drives the pip
/// count; the words live in TRUST_LABEL.
export function trustRungs(trust: WorkerTrustLevel): number {
  if (trust === 'autonomous') return 3;
  if (trust === 'trusted') return 2;
  return 1;
}

export const TRUST_RUNG_TOTAL = 3;
