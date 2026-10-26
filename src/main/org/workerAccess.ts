// The org's worker access level, applied to the server's allow-list.
//
// `overcli serve --permissions allow-list` hands its engines one array of
// allowed tools, and every grant reads that array: the permission tap, each
// run's `--allowedTools`, the repo grants (repoGrants.ts). With an access
// level set in the org's rules, that array is the level's tools instead of
// the `--allow-tool` flags, kept current as an admin changes it. The flags
// (or `--max-access`) stay the ceiling: the console can narrow what the
// operator allowed, never widen it.

import { accessTools, levelOf, type AccessLevel, type WorkerAccess } from '../../shared/org/access';

export interface AccessServer {
  /// The console can set a level at all: the server runs an allow-list.
  managed: boolean;
  ceiling: AccessLevel;
  /// What the startup flags amount to: the level workers have until an
  /// admin picks one.
  current: AccessLevel;
}

let server: AccessServer = { managed: false, ceiling: 'read', current: 'read' };
let flags: string[] = [];
let read: () => WorkerAccess | undefined = () => undefined;

/// Called once by `overcli serve`.
export function configureAccess(args: { managed: boolean; allowTools: string[]; maxAccess?: AccessLevel; access: () => WorkerAccess | undefined }): void {
  flags = [...args.allowTools];
  const current = levelOf(args.allowTools);
  server = { managed: args.managed, ceiling: args.maxAccess ?? current, current };
  read = args.access;
}

export function accessServer(): AccessServer {
  return server;
}

/// The allow-list as it stands: the org's level when one is set, otherwise
/// the server's own flags, as before there was a setting.
export function baseAllowList(): string[] {
  if (!server.managed) return [...flags];
  let access: WorkerAccess | undefined;
  try {
    access = read();
  } catch {
    access = undefined;
  }
  return access ? accessTools(access, server.ceiling) : [...flags];
}

/// Tools refused to workers, counted, for the Permissions page: raise the
/// level when a worker keeps running into one, not on a guess.
export interface Refusal {
  worker: string;
  tool: string;
  /// The command, for a shell call.
  detail?: string;
  at: number;
}

const refusals: Refusal[] = [];
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function noteRefusal(r: Refusal): void {
  refusals.push({ ...r, ...(r.detail ? { detail: r.detail.slice(0, 160) } : {}) });
  const cutoff = r.at - KEEP_MS;
  while (refusals.length && (refusals[0].at < cutoff || refusals.length > 2000)) refusals.shift();
}

/// The last week's refusals, by worker and tool, most first.
export function refusalSummary(now = Date.now()): Array<{ worker: string; tool: string; count: number; lastAt: number; example?: string }> {
  const by = new Map<string, { worker: string; tool: string; count: number; lastAt: number; example?: string }>();
  for (const r of refusals) {
    if (r.at < now - KEEP_MS) continue;
    const key = `${r.worker}\u0000${r.tool}`;
    const row = by.get(key) ?? { worker: r.worker, tool: r.tool, count: 0, lastAt: 0 };
    row.count++;
    if (r.at >= row.lastAt) {
      row.lastAt = r.at;
      if (r.detail) row.example = r.detail;
    }
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}
