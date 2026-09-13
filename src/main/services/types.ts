// Engine-side helpers over the shared service model.
//
// The data shapes live in `shared/services.ts` so the pane can render them
// without pulling node into the bundle; what lives here is the behaviour the
// engine derives from them. Re-exported so every module under `services/`
// keeps importing its types from one place.
//
// Two restraints are encoded rather than remembered, because both are easy to
// get wrong and expensive to undo:
//
//   * Dependency edges order STARTUP. They do not propagate restarts.
//   * A self-reloading runner is left alone on file changes.

export type {
  ConfigProjection,
  DebugKind,
  MachineEntry,
  MachineValues,
  MachineValuesView,
  ServiceOption,
  Evidence,
  LeaseDecision,
  PortClaim,
  ReadinessProbe,
  RunnerKind,
  ServiceBinding,
  ServiceFinding,
  ServiceProposal,
  ServiceRuntime,
  ServiceSpec,
  ServiceStatus,
  StackConfig,
  StackView,
} from '../../shared/services';

import type { ServiceSpec } from '../../shared/services';

/// Whether a file change in this service's checkout should cause a restart.
/// A self-reloading runner handles its own changes better than we can from
/// outside, so the correct action there is none at all.
export function shouldRestartOnChange(spec: Pick<ServiceSpec, 'selfReloads' | 'watch'>): boolean {
  if (spec.selfReloads) return false;
  return (spec.watch?.length ?? 0) > 0;
}

/// The services that must be ready before `serviceId` starts, in start order,
/// excluding the service itself. Depth-first so a dependency's own
/// dependencies come first; cycles are broken rather than thrown, because a
/// mis-detected edge should degrade the ordering, not refuse to start
/// anything.
export function startOrder(specs: readonly ServiceSpec[], serviceId: string): string[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const out: string[] = [];
  const seen = new Set<string>();

  function visit(id: string, path: Set<string>): void {
    if (seen.has(id) || path.has(id)) return;
    const spec = byId.get(id);
    if (!spec) return;
    const next = new Set(path).add(id);
    for (const dep of spec.deps ?? []) visit(dep, next);
    seen.add(id);
    out.push(id);
  }

  visit(serviceId, new Set());
  return out.filter((id) => id !== serviceId);
}

/// Services that should restart when `serviceId` restarts. Empty unless an
/// edge was explicitly marked `restartDependents` — ordering and restart
/// propagation are different relations, and treating them as one is why a
/// backend restart takes your frontend down for no reason.
export function restartDependents(specs: readonly ServiceSpec[], serviceId: string): string[] {
  const spec = specs.find((s) => s.id === serviceId);
  if (!spec?.restartDependents) return [];
  return specs.filter((s) => (s.deps ?? []).includes(serviceId)).map((s) => s.id);
}
