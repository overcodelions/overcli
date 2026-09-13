// Ports are the scarce resource, so they are where stacks collide.
//
// Several flows run at once on different worktrees, and any of them may want
// the same service. Two things follow. First, a stack must be able to run a
// second copy of a service beside the one already up — that is how you see
// the outcome, old and new side by side. Second, when it cannot, the clash
// must be visible and offered as a choice, never resolved silently: a stack
// that quietly stole :8080 from a flow you were not watching is worse than
// one that refuses to start.
//
// Offsets are per BINDING, not per service, which is why the port a process
// actually binds lives on the runtime rather than the spec.

import type { LeaseDecision, PortClaim, ServiceSpec } from './types';

export type { LeaseDecision, PortClaim };

/// Distance between one stack's ports and the next. Ten thousand keeps the
/// offset visible at a glance (8080 -> 18080 -> 28080) rather than producing
/// a neighbouring number that reads like a typo.
export const PORT_OFFSET_STEP = 10_000;

/// Highest port a system will accept.
const MAX_PORT = 65_535;

/// The port a binding should use at this offset. Offset 0 is the service's
/// configured port — the common case, and the one a bookmark still works for.
export function portForOffset(basePort: number, offset: number): number {
  return basePort + offset * PORT_OFFSET_STEP;
}

/// The smallest offset whose port is free, or null when none is. Deliberately
/// bounded: if six copies of a service are already up, the answer the user
/// needs is "something is wrong", not a seventh.
export function nextFreeOffset(
  basePort: number,
  claims: readonly PortClaim[],
  opts: { maxOffset?: number } = {},
): number | null {
  const taken = new Set(claims.map((c) => c.port));
  const maxOffset = opts.maxOffset ?? 3;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const port = portForOffset(basePort, offset);
    if (port > MAX_PORT) return null;
    if (!taken.has(port)) return offset;
  }
  return null;
}

/// Decide what starting `spec` in `stackId` means, given what is already up.
/// Pure, so the pane can render the choice before anything is spawned.
export function leaseFor(
  spec: Pick<ServiceSpec, 'id' | 'port'>,
  stackId: string,
  claims: readonly PortClaim[],
): LeaseDecision {
  // A service that binds nothing cannot collide with anything.
  if (spec.port === undefined) return { kind: 'free', port: 0, offset: 0 };

  const mine = claims.find((c) => c.serviceId === spec.id && c.stackId === stackId);
  if (mine) return { kind: 'already-running', claim: mine };

  const onBase = claims.find((c) => c.port === spec.port);
  if (!onBase) return { kind: 'free', port: spec.port, offset: 0 };

  const offset = nextFreeOffset(spec.port, claims);
  return {
    kind: 'held',
    claim: onBase,
    alongside: offset === null || offset === 0 ? null : { port: portForOffset(spec.port, offset), offset },
  };
}

/// Ports this stack is holding, for the footer line under the service list.
export function heldPorts(claims: readonly PortClaim[], stackId: string): number[] {
  return claims
    .filter((c) => c.stackId === stackId && c.port > 0)
    .map((c) => c.port)
    .sort((a, b) => a - b);
}
