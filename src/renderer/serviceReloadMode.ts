// What a service does when its files change, as one of three answers.
//
// The stored shape is two fields — `selfReloads` and `watch` — and reading a
// mode out of them was written out longhand wherever it was needed. Pulled
// here so the settings editor and the bulk action agree by construction:
// setting five services to "restart on change" from the selection bar has to
// mean exactly what clicking it on each one would have.

import type { ServiceSpec } from '@shared/services';

export type ReloadMode = 'self' | 'restart' | 'off';

/// What a service falls back to when it is asked to watch and has never been
/// told what. The same default the single-service editor offers.
export const DEFAULT_WATCH = ['src/**'];

export function reloadModeOf(spec: Pick<ServiceSpec, 'selfReloads' | 'watch'>): ReloadMode {
  if (spec.selfReloads) return 'self';
  return (spec.watch?.length ?? 0) > 0 ? 'restart' : 'off';
}

/// The two stored fields for a mode, keeping whatever patterns the service
/// already had. A service switched off and back on gets its own globs again,
/// not the default over the top of them — the patterns are the part someone
/// took the trouble to write.
export function watchForMode(
  spec: Pick<ServiceSpec, 'watch'>,
  mode: ReloadMode,
): { selfReloads: boolean; watch: string[] } {
  if (mode === 'self') return { selfReloads: true, watch: [] };
  if (mode === 'off') return { selfReloads: false, watch: [] };
  return { selfReloads: false, watch: spec.watch?.length ? [...spec.watch] : [...DEFAULT_WATCH] };
}
