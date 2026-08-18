import type { Backend, BackendHealth, EffortLevel, PermissionMode } from '@shared/types';

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'auto':
      return 'Auto';
    case 'acceptEdits':
      return 'Accept edits';
    case 'bypassPermissions':
      return 'Bypass (dangerous)';
    default:
      return 'Default';
  }
}

export function permissionTone(mode: PermissionMode): string | undefined {
  if (mode === 'bypassPermissions') return '#f97a5a';
  if (mode === 'acceptEdits') return '#f7b267';
  return undefined;
}

export function effortLabel(effort: EffortLevel): string {
  if (!effort) return 'Auto effort';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function isBackendEnabled(
  settings: { disabledBackends?: Partial<Record<Backend, boolean>> },
  backend: Backend,
): boolean {
  return settings.disabledBackends?.[backend] !== true;
}

export function enabledBackends(
  settings: { disabledBackends?: Partial<Record<Backend, boolean>> },
): Backend[] {
  const all: Backend[] = ['claude', 'codex', 'gemini', 'copilot', 'ollama'];
  return all.filter((b) => isBackendEnabled(settings, b));
}

/// The backend a new conversation should start on.
///
/// An explicit `preferredBackend` always wins. Failing that we take the
/// first enabled CLI the health probe says is actually *ready*, rather than
/// the first one in list order — which is always Claude, so a machine with
/// only Codex installed used to open every conversation on a CLI that isn't
/// there and fail on the first send.
///
/// Falls back to plain enabled-order when health hasn't been probed yet, or
/// when nothing is ready: a default that might not run beats no default.
export function pickDefaultBackend(
  settings: {
    disabledBackends?: Partial<Record<Backend, boolean>>;
    preferredBackend?: Backend;
  },
  health?: Record<string, BackendHealth>,
): Backend {
  const preferred = settings.preferredBackend;
  if (preferred && isBackendEnabled(settings, preferred)) return preferred;
  const enabled = enabledBackends(settings);
  const ready = health ? enabled.find((b) => health[b]?.kind === 'ready') : undefined;
  return ready ?? enabled[0] ?? 'claude';
}
