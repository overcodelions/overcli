// Which reasoning effort a conversation runs at, resolved from settings.
//
// Effort is the single largest lever on turn latency — reasoning is billed
// as output tokens and decodes at the same rate as everything else, so a
// tier that thinks twice as much takes twice as long. It is worth resolving
// in one place rather than at each call site.

import type { AppSettings, Backend, EffortLevel } from './types';

/// Backends that accept a reasoning-effort setting. Claude takes `--effort`,
/// codex takes `model_reasoning_effort`; the rest have no equivalent knob,
/// so offering them a control would be decoration. Mirrors the reasoning in
/// `turboSupported`.
export const EFFORT_BACKENDS: readonly Backend[] = ['claude', 'codex'];

export function effortSupported(backend: Backend): boolean {
  return EFFORT_BACKENDS.includes(backend);
}

/// Default effort for a backend: its own override, else the global default.
///
/// An empty string is Auto — the caller omits the flag entirely and lets the
/// CLI pick. Auto is deliberately *not* the same as a neutral middle tier:
/// each CLI resolves it differently, which is exactly why the per-backend
/// override exists.
export function effortForBackend(
  settings: Pick<AppSettings, 'defaultEffort' | 'backendDefaultEfforts'>,
  backend: Backend | undefined,
): EffortLevel {
  if (!backend) return settings.defaultEffort;
  const perBackend = settings.backendDefaultEfforts?.[backend];
  return perBackend ?? settings.defaultEffort;
}
