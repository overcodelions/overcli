// The two ends of a handoff, found from either one. A handoff is two batches
// on two desks — the turn that handed it on, and the errand it became on the
// colleague's desk — and each side of the reader links to the other, so a
// collaboration reads as one instead of as two unrelated conversations.

import type { Orchestration } from '@shared/flows/orchestration';

/// The batch on the SENDER's desk that handed `o` over, or undefined when a
/// person asked for `o` themselves.
///
/// Handoffs record the sender's batch now. Older ones did not, and for those
/// the sender's latest batch that began before this one is the one that did
/// the handing: a referral goes out at the end of the turn that wrote it.
export function senderBatch(o: Orchestration, all: Record<string, Orchestration>): Orchestration | undefined {
  const from = o.origin?.kind === 'worker' ? o.origin.from : undefined;
  if (!from) return undefined;
  if (from.orchestrationId) return all[from.orchestrationId];
  let best: Orchestration | undefined;
  for (const b of Object.values(all)) {
    if (b.id === o.id || b.origin?.kind !== 'worker' || b.origin.workerId !== from.workerId) continue;
    if (b.createdAt > o.createdAt) continue;
    if (!best || b.createdAt > best.createdAt) best = b;
  }
  return best;
}

/// The errand `sent` became on `receiverId`'s desk. The inverse of
/// `senderBatch`, so the two links always agree.
export function receiverBatch(
  sent: Orchestration,
  receiverId: string,
  all: Record<string, Orchestration>,
): Orchestration | undefined {
  let first: Orchestration | undefined;
  for (const b of Object.values(all)) {
    if (b.origin?.kind !== 'worker' || b.origin.workerId !== receiverId || !b.origin.from) continue;
    if (senderBatch(b, all)?.id !== sent.id) continue;
    if (!first || b.createdAt < first.createdAt) first = b;
  }
  return first;
}
