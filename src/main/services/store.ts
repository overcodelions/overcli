// Where a workspace's services and their local config live on disk.
//
// Two different things are stored here and they are deliberately in different
// places:
//
//   <dataDir>/services/<workspaceId>/stack.json   — the service identities
//     and their current bindings. Persisted, because losing it means
//     re-answering every question about how a stack boots.
//   <dataDir>/services/<workspaceId>/<serviceId>/ — the service's OWN config
//     (application-local.yml, .env.local, a vhost template). This is the
//     directory that gets injected, symlinked or rendered into whichever
//     worktree the service is bound to, and the reason local props survive a
//     worktree switch: they were never in the worktree.
//
// Ids arrive over IPC and are joined straight into paths that get written to,
// so they are validated as bare slugs first — the same rule `workspace.ts`
// applies for the same reason.

import fs from 'node:fs';
import path from 'node:path';

import type { MachineValues, StackConfig } from './types';

/// Ids are `crypto.randomUUID()` values, but an id of `../../Documents` would
/// escape the data directory. Reject anything that is not a bare slug.
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function servicesRoot(dataDir: string): string {
  return path.join(dataDir, 'services');
}

export function stackDir(dataDir: string, workspaceId: string): string {
  if (!ID_RE.test(workspaceId)) throw new Error('Invalid workspace id');
  return path.join(servicesRoot(dataDir), workspaceId);
}

export function stackFile(dataDir: string, workspaceId: string): string {
  return path.join(stackDir(dataDir, workspaceId), 'stack.json');
}

/// The directory holding one service's own configuration. Substituted into
/// projections as `${SERVICE_CONFIG_DIR}`.
export function serviceConfigDir(dataDir: string, workspaceId: string, serviceId: string): string {
  if (!ID_RE.test(serviceId)) throw new Error('Invalid service id');
  return path.join(stackDir(dataDir, workspaceId), serviceId);
}

/// Values shared by every service on this machine. One file, not one per
/// workspace: a database password retyped into forty services is how forty
/// services end up with thirty-nine different passwords.
export function machineValuesFile(dataDir: string): string {
  return path.join(servicesRoot(dataDir), 'machine.json');
}

export function loadMachineValues(dataDir: string): MachineValues {
  const file = machineValuesFile(dataDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Values only — a nested object here would render as "[object Object]" on
    // a command line, which is worse than dropping it.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}

export function saveMachineValues(dataDir: string, values: MachineValues): void {
  fs.mkdirSync(servicesRoot(dataDir), { recursive: true });
  const file = machineValuesFile(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/// Read a workspace's stack, or an empty one. A workspace with no services is
/// the normal state for most of them — it must not look like an error, and
/// must not create anything on disk just by being looked at.
export function loadStack(dataDir: string, workspaceId: string): StackConfig {
  const file = stackFile(dataDir, workspaceId);
  if (!fs.existsSync(file)) return { workspaceId, services: [], bindings: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StackConfig>;
    return {
      workspaceId,
      services: Array.isArray(parsed.services) ? parsed.services : [],
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
    };
  } catch {
    // A truncated or hand-edited file should not take the pane down with it.
    // An empty stack is recoverable by re-scanning; a crash on boot is not.
    return { workspaceId, services: [], bindings: [] };
  }
}

export function saveStack(dataDir: string, stack: StackConfig): void {
  const dir = stackDir(dataDir, stack.workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stack.json');
  // Write-then-rename, so a crash mid-write cannot leave a half-written stack
  // where a readable one used to be.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(stack, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/// Make sure a service's config directory exists, so a projection pointing at
/// it resolves even before the user has put anything there.
export function ensureServiceConfigDir(
  dataDir: string,
  workspaceId: string,
  serviceId: string,
): string {
  const dir = serviceConfigDir(dataDir, workspaceId, serviceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
