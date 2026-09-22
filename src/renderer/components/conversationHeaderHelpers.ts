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

/// One line on what a permission mode actually DOES. Shown under the mode
/// in every mode menu and again in the Basics sheet — one sentence, one
/// source, so a user who reads it in the composer recognises it in Help.
/// "Ask" here means overcli's own approval prompt, which is the only reason
/// any of these modes is visible in a GUI at all.
export function permissionNote(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Reads and plans only — no edits, no commands.';
    case 'auto':
      return 'Claude judges each call and only asks on the risky ones.';
    case 'acceptEdits':
      return 'File edits apply without asking. Commands still ask.';
    case 'bypassPermissions':
      return 'Nothing asks. Keep it to a worktree you can throw away.';
    default:
      return 'Asks before every edit and every command.';
  }
}

export function permissionTone(mode: PermissionMode): string | undefined {
  if (mode === 'bypassPermissions') return '#f97a5a';
  if (mode === 'acceptEdits') return '#f7b267';
  return undefined;
}

export function turboLabel(turbo: boolean | undefined): string {
  return turbo ? 'Turbo on' : 'Turbo off';
}

/// Coloured only while turbo is in force, so the colour carries exactly one
/// meaning: this conversation is running shallow right now.
export function turboTone(turbo: boolean | undefined): string | undefined {
  return turbo ? '#38bdf8' : undefined;
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
