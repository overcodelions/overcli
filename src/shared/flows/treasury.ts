// The treasury — one pot of money for every worker, drawn in roster order.
//
// Before this, each worker carried its own `budgetUSDPerMonth` and nothing
// carried the sum. Eight workers at $10 was an $80/month exposure nobody ever
// approved as a number, and the roster's up/down arrows moved rows around
// without moving anything real. Both problems have one answer: a top-level
// pool, drawn down in priority order, where a worker's POSITION is what
// decides whether the money reaches it.
//
// The rule is a waterfall, and it needs no new per-worker numbers:
//
//   A worker may spend only what is left of the pool after everyone above it
//   is fully funded to its own cap.
//
// So a worker's remaining cap is its reserve — held for it, not handed to the
// hungry worker below it — and that reserve evaporates as it spends, which is
// exactly when it stops needing one. Money the top of the roster does not
// claim trickles to the bottom; money the top does claim never gets eaten
// from underneath. Nobody has to maintain a second budget field for this to
// be true.
//
// Three consequences worth stating, because they are the point rather than
// side effects:
//   1. Dragging a worker up is a funding decision now, not decoration.
//   2. Pausing a worker releases its reserve to everyone below it, so "pause"
//      is a budgeting tool and not only a scheduling one.
//   3. Lowering the pool squeezes the BOTTOM of the roster first. The worker
//      that runs your morning cannot be starved by the one that tidies
//      changelogs, whatever order they happen to burn money in.
//
// Everything here is pure and derived: main allocates against the run-summary
// log and pushes the result, and the renderer re-derives locally while a drag
// is in flight so a reorder shows the money moving immediately.

import { sortRoster, type Worker } from './worker';

/// The pot. One number, deliberately — the whole feature exists because the
/// interesting number was the one nobody could see or set.
export interface Treasury {
  monthlyUSD: number;
}

/// What a fresh install starts with when there is nobody to sum.
export const DEFAULT_TREASURY_USD = 50;

/// Below a cent is not funding. Guards the "$0.004 available" row, which
/// would render as `$0.00` and read as a bug rather than as an exhausted
/// pool.
export const MIN_FUNDING_USD = 0.01;

/// Why a worker has nothing to spend. `pool` is the only one the treasury
/// itself causes, and the only one the user fixes by reordering.
export type FundingBlock = 'none' | 'cap' | 'pool' | 'paused';

/// One worker's slice of the month, entirely derived.
export interface WorkerFunding {
  workerId: string;
  name: string;
  /// Position in the roster, 1-based — the order the user drags, paused
  /// workers included.
  priority: number;
  /// Position in the queue the pot actually drains down, 1-based, counting
  /// only enabled workers; 0 for a paused one. A paused worker holds nothing
  /// back, so counting it as somebody "ahead" of the rows below overstates
  /// the queue they are waiting on — and reads as though pausing did nothing.
  queuePosition: number;
  enabled: boolean;
  /// The worker's own ceiling — `budgetUSDPerMonth`, unchanged in meaning.
  capUSD: number;
  spentUSD: number;
  /// Still claimable by higher-priority workers. This is the water that has
  /// to fall past everyone above before any reaches this row.
  claimedAboveUSD: number;
  /// The most this worker may still spend this month, under BOTH its own cap
  /// and the pool left after everyone above it.
  availableUSD: number;
  funded: boolean;
  blocked: FundingBlock;
}

export interface TreasuryAllocation {
  poolUSD: number;
  /// Every worker's spend this month, including paused and since-fired ones —
  /// money spent is spent, whoever spent it.
  spentUSD: number;
  remainingUSD: number;
  /// Priority order, top first. The same order the roster reads in.
  byWorker: WorkerFunding[];
}

export interface DistributedWorkerCap {
  workerId: string;
  budgetUSDPerMonth: number;
}

/// Split what remains in the pot across the workers who can use it, weighted
/// by funding order. With N active workers the first receives N shares, the
/// next N-1, down to one share for the last. A cap is a lifetime-for-the-month
/// ceiling, so each new cap includes that worker's spend to date plus its
/// priority share of the money still available.
/// Paused workers are intentionally absent: pausing already releases their
/// reserve, and distributing must not erase the cap they resume with.
export function distributeRemainingFunds(allocation: TreasuryAllocation): DistributedWorkerCap[] {
  const active = allocation.byWorker.filter((row) => row.enabled);
  if (active.length === 0) return [];

  const remainingCents = Math.max(0, Math.round(allocation.remainingUSD * 100));
  const totalWeight = (active.length * (active.length + 1)) / 2;
  const shares = active.map((row, index) => {
    const weight = active.length - index;
    const exact = (remainingCents * weight) / totalWeight;
    return {
      row,
      cents: Math.floor(exact),
      fraction: exact - Math.floor(exact),
    };
  });
  let centsLeft = remainingCents - shares.reduce((sum, share) => sum + share.cents, 0);
  // Largest-remainder apportionment keeps the total exact without always
  // handing rounding pennies to the first worker. Roster order breaks ties.
  const remainderOrder = shares
    .map((share, index) => ({ index, fraction: share.fraction }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < centsLeft; i += 1) shares[remainderOrder[i].index].cents += 1;

  // Weighting can floor a low-priority share to zero even when the pot holds a
  // cent for everyone — which made Distribute a dead button that claimed there
  // was not enough money when there was. Borrow from the largest share instead;
  // the total stays exact because every cent moved is a cent taken.
  if (remainingCents >= active.length) {
    for (const share of shares) {
      if (share.cents > 0) continue;
      let donor = shares[0];
      for (const candidate of shares) if (candidate.cents > donor.cents) donor = candidate;
      if (donor.cents <= 1) break;
      donor.cents -= 1;
      share.cents += 1;
    }
  }

  return shares.map(({ row, cents }) => ({
    workerId: row.workerId,
    // Keep model-cost precision in spend while distributing the user-facing
    // remainder in cents. Six decimals avoids binary-float tails on disk.
    budgetUSDPerMonth: Number((row.spentUSD + cents / 100).toFixed(6)),
  }));
}

type FundableWorker = Pick<
  Worker,
  'id' | 'name' | 'order' | 'createdAt' | 'enabled' | 'budgetUSDPerMonth' | 'cadence'
>;

/// Run the waterfall.
///
/// `spentByWorker` is passed in rather than read here so the same function
/// serves main (reading the run-summary log) and the renderer (replaying the
/// spend it was last pushed) without either one owning the rule.
export function allocateTreasury(
  workers: FundableWorker[],
  spentByWorker: (workerId: string) => number,
  poolUSD: number,
  /// Spend across EVERY id in the run log, fired workers included. Omitted
  /// only by callers that have no wider figure; then the roster is the total.
  totalSpentUSD?: number,
): TreasuryAllocation {
  const ordered = sortRoster(workers);
  const poolTotal = Math.max(0, poolUSD);

  // Total spend counts EVERY worker, enabled or not. A worker paused halfway
  // through the month already took its money out of the pot; releasing its
  // reserve must not also refund what it burned.
  let rosterSpent = 0;
  const spend = new Map<string, number>();
  for (const w of ordered) {
    const s = Math.max(0, spentByWorker(w.id));
    spend.set(w.id, s);
    rosterSpent += s;
  }
  const spentUSD = totalSpentUSD === undefined ? rosterSpent : Math.max(0, totalSpentUSD);
  const remainingUSD = Math.max(0, poolTotal - spentUSD);

  let claimedAbove = 0;
  let queued = 0;
  const byWorker = ordered.map((w, index) => {
    const capUSD = Math.max(0, w.budgetUSDPerMonth);
    const workerSpend = spend.get(w.id) ?? 0;
    const ownRemaining = Math.max(0, capUSD - workerSpend);
    const fromPool = Math.max(0, remainingUSD - claimedAbove);
    const availableUSD = w.enabled ? Math.min(ownRemaining, fromPool) : 0;
    // An on-demand worker spends like anyone else but RESERVES like nobody:
    // it draws from whatever is left at the moment you ask it something, and
    // between those moments its cap sits over the pool without holding any of
    // it back. Reserving would be the wrong bargain — a desk you visit twice a
    // week would starve the CI watcher below it for the other five days — and
    // so would the paused treatment (zero available), which is what made
    // pausing a worker also shut its desk.
    const reserves = w.enabled && w.cadence !== null;

    const row: WorkerFunding = {
      workerId: w.id,
      name: w.name,
      priority: index + 1,
      queuePosition: w.enabled ? ++queued : 0,
      enabled: w.enabled,
      capUSD,
      spentUSD: workerSpend,
      claimedAboveUSD: claimedAbove,
      availableUSD,
      funded: availableUSD >= MIN_FUNDING_USD,
      blocked: !w.enabled
        ? 'paused'
        : ownRemaining < MIN_FUNDING_USD
          ? 'cap'
          : fromPool < MIN_FUNDING_USD
            ? 'pool'
            : 'none',
    };

    // A paused worker holds nothing back. That is what makes pausing the
    // cheapest way to fund everyone below it. An on-demand worker holds
    // nothing back either, for the reason above — but unlike a paused one it
    // is still funded.
    if (reserves) claimedAbove += ownRemaining;
    return row;
  });

  return { poolUSD: poolTotal, spentUSD, remainingUSD, byWorker };
}

export function fundingFor(allocation: TreasuryAllocation | null, workerId: string): WorkerFunding | null {
  return allocation?.byWorker.find((f) => f.workerId === workerId) ?? null;
}

/// Enabled workers the pool can no longer reach — the ones a reorder or a
/// bigger pot would revive. Named separately from `blocked === 'cap'` because
/// only these are the treasury's doing.
export function starvedWorkers(allocation: TreasuryAllocation): WorkerFunding[] {
  return allocation.byWorker.filter((f) => f.blocked === 'pool');
}

/// One sentence explaining an unfunded worker, written once so the journal
/// entry main writes, the notification it sends, and the row the renderer
/// draws cannot drift into three different explanations.
export function describeFundingBlock(funding: WorkerFunding, allocation: TreasuryAllocation): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  switch (funding.blocked) {
    case 'cap':
      return `Its monthly budget is spent (${money(funding.spentUSD)} of ${money(funding.capUSD)}) — idle until the month rolls over.`;
    case 'pool': {
      // Counted over the QUEUE, not the roster: a paused worker above this one
      // claims nothing, so naming it among the workers "ahead" would blame the
      // pot on rows that are not touching it.
      const ahead = Math.max(0, funding.queuePosition - 1);
      return (
        `The monthly pool is committed above it — ${money(allocation.remainingUSD)} left of ` +
        `${money(allocation.poolUSD)}, all of it claimed by the ${ahead} worker` +
        `${ahead === 1 ? '' : 's'} ahead. Raise the pool, pause someone above it, ` +
        `or move it up the roster.`
      );
    }
    case 'paused':
      return 'Paused — it holds no funds and works no shifts.';
    default:
      return `${money(funding.availableUSD)} available this month.`;
  }
}

export function validateTreasury(monthlyUSD: number): string | null {
  if (!Number.isFinite(monthlyUSD) || monthlyUSD <= 0) return 'The monthly pool has to be more than zero.';
  return null;
}

/// What to start an existing install on: the sum of the per-worker caps it
/// already had. Upgrading must not change anyone's behaviour on day one —
/// the pool only starts biting once the user lowers it.
export function seedTreasury(workers: Array<Pick<Worker, 'budgetUSDPerMonth'>>): Treasury {
  const sum = workers.reduce((total, w) => total + Math.max(0, w.budgetUSDPerMonth || 0), 0);
  return { monthlyUSD: sum > 0 ? sum : DEFAULT_TREASURY_USD };
}
