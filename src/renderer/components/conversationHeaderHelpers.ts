import type { Backend, EffortLevel, PermissionMode } from '@shared/types';

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
  if (!effort) return 'Effort';
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
  const all: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
  return all.filter((b) => isBackendEnabled(settings, b));
}
