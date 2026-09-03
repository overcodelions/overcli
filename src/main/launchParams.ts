// The launch identity of a resident backend process.
//
// A send can only reuse the process already running for a conversation when
// every argv-shaping value it was spawned with still matches what this turn
// asks for. The runner stamps those values onto the active record at spawn
// time (`launch*`, plus `cwd`); this module owns the comparison.
//
// It deliberately does NOT diff argv — argv is built per backend and per
// transport, and reconstructing it here would mean re-running the whole
// spawn path. Instead the stamped fields are the allowlist, which makes a
// field that shapes argv but never gets stamped fail silently and badly:
// the UI reports the new state, the process keeps running with the old one,
// and nothing errors. That is what happened with `launchChrome` (#265) and
// why this lives in one place with `launchParams.test.ts` guarding it.

import type { EffortLevel, PermissionMode } from '../shared/types';

export interface LaunchParams {
  launchPermissionMode: PermissionMode;
  launchAllowedTools: string;
  launchMcpFingerprint?: string;
  launchModel: string;
  launchTurbo: boolean;
  launchArtifacts: boolean;
  launchChrome: boolean;
  launchEffort?: EffortLevel;
  cwd: string;
}

/// Every field the reuse decision reads, in one enumerable place so the
/// tests can iterate it instead of restating the list.
export const LAUNCH_PARAM_KEYS = [
  'launchPermissionMode',
  'launchAllowedTools',
  'launchMcpFingerprint',
  'launchModel',
  'launchTurbo',
  'launchArtifacts',
  'launchChrome',
  'launchEffort',
  'cwd',
] as const satisfies readonly (keyof LaunchParams)[];

/// The subset the Claude MCP permission broker's registration depends on.
/// The broker only cares whether the mcp-config it wrote is still the right
/// one, so a turbo/artifacts/chrome/effort change must not cost a
/// re-registration — but the field *names* still come from here, so the
/// vocabulary stays single-sourced with the reuse check.
export const BROKER_LAUNCH_PARAM_KEYS = [
  'launchPermissionMode',
  'launchAllowedTools',
  'launchMcpFingerprint',
  'launchModel',
  'cwd',
] as const satisfies readonly (keyof LaunchParams)[];

type AssertNever<T extends never> = T;
/// Compile-time half of the exhaustiveness guard: adding a field to
/// LaunchParams without listing it above stops typechecking here.
export type _AllLaunchParamsListed = AssertNever<
  Exclude<keyof LaunchParams, (typeof LAUNCH_PARAM_KEYS)[number]>
>;

/// Whether the resident process's launch identity still matches what this
/// turn wants. `true` means the caller must respawn (or, on codex
/// app-server, hot-swap) — the running process cannot serve this send.
///
/// Callers normalize their own values before handing them over: the cli
/// path compares the user's *configured* effort tier rather than the tier
/// auto-effort classified for this turn, and the sdk path compares the
/// turbo-resolved one. Anything transport-specific (the cli ↔ sdk toggle,
/// the codex hot-swap branch) stays at the call site.
/// `keys` narrows the comparison for callers asking a smaller question than
/// "can this process be reused" — see BROKER_LAUNCH_PARAM_KEYS.
export function launchParamsChanged(
  existing: LaunchParams,
  requested: LaunchParams,
  keys: readonly (keyof LaunchParams)[] = LAUNCH_PARAM_KEYS,
): boolean {
  return keys.some((key) => existing[key] !== requested[key]);
}
