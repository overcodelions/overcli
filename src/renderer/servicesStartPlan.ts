import type { ServiceSpec } from '@shared/services';

/// Dependency layers for a bulk start. Everything in one layer can start at
/// once; a later layer only begins after the services it names have settled.
/// Dependencies outside the clicked group are included, matching the single
/// service Start action.
export function startLayers(
  services: readonly ServiceSpec[],
  requestedIds: readonly string[],
): string[][] {
  const byId = new Map(services.map((service) => [service.id, service]));
  const needed = new Set<string>();

  function include(id: string, path: Set<string>): void {
    if (needed.has(id) || path.has(id)) return;
    const service = byId.get(id);
    if (!service) return;
    const next = new Set(path).add(id);
    for (const dependency of service.deps ?? []) include(dependency, next);
    needed.add(id);
  }
  for (const id of requestedIds) include(id, new Set());

  const remaining = new Set(needed);
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      (byId.get(id)?.deps ?? []).every((dependency) => !remaining.has(dependency)),
    );
    if (ready.length === 0) {
      // Saved configs should be acyclic, but imported or hand-edited ones may
      // not be. Serialising the remainder preserves the supervisor's existing
      // cycle-breaking behaviour without deadlocking the bulk action.
      layers.push(...[...remaining].map((id) => [id]));
      break;
    }
    layers.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  return layers;
}

/// Run a layer aggressively without turning a large Java workspace into an
/// unbounded burst of compilers. Four is enough to remove readiness latency
/// from the critical path while keeping CPU and memory pressure predictable.
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const pending = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, limit), pending.length) }, async () => {
    for (;;) {
      const item = pending.shift();
      if (item === undefined) return;
      await run(item);
    }
  });
  await Promise.all(workers);
}
