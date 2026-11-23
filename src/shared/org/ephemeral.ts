// Ephemeral workers: ones that hold a tool whose output may carry customer
// data (`OrgPolicy.sensitiveTools`). What such a worker reads and says lives
// only as long as the conversation it was said in; after that the purge
// (src/main/org/ephemeralPurge.ts) removes it. What it DID stays: each run's
// action record (tools and counts, no content) goes in the decision log first.
//
// Decided per WORKER rather than per run on purpose. A run's tool calls are
// not all seen — read-only calls are approved without a request — so a
// per-run flag could miss the one call that mattered. A worker that merely
// holds the tool is treated as if it used it.

import type { OrgRole } from './policy';
import { roleToolsFor } from './roleTools';
import { mcpServerKey } from '../flows/toolScope';

/// A conversation with nothing said in it for this long has ended.
export const EPHEMERAL_IDLE_MS = 2 * 60 * 60 * 1000;
/// However busy, a conversation is ended (and purged) this long after it began.
export const EPHEMERAL_MAX_MS = 24 * 60 * 60 * 1000;

export interface EphemeralPolicy {
  sensitiveTools?: string[];
  sharedMcpServers?: string[];
  roles: readonly OrgRole[];
}

export interface EphemeralWorkerShape {
  mcpServers?: string[];
  role?: string;
  roleToolsOff?: string[];
}

/// The sensitive tools this worker holds: its own, its role's, and the ones
/// every worker shares. Matched as `mcp__<server>__…` would name them, so
/// "Cloud Watch" in org.json still matches a server called `Cloud_Watch`.
export function sensitiveToolsHeld(w: EphemeralWorkerShape, policy: EphemeralPolicy): string[] {
  const sensitive = new Set((policy.sensitiveTools ?? []).map((t) => mcpServerKey(t).toLowerCase()));
  if (!sensitive.size) return [];
  const held = [...(w.mcpServers ?? []), ...roleToolsFor(w, policy.roles), ...(policy.sharedMcpServers ?? [])];
  return [...new Set(held.filter((t) => sensitive.has(mcpServerKey(t).toLowerCase())))];
}

export function isEphemeralWorker(w: EphemeralWorkerShape, policy: EphemeralPolicy): boolean {
  return sensitiveToolsHeld(w, policy).length > 0;
}

export interface EphemeralMessageWorker extends EphemeralWorkerShape {
  name: string;
  threadSessions?: Record<string, unknown>;
}

/// Whether an outbound Slack message is an ephemeral worker's, so personal
/// data is scrubbed out of it: posted under its name, signed with it
/// (`*Name:* …`), or in a thread it is talking in.
export function isEphemeralMessage(
  ctx: { channel?: string; threadTs?: string; username?: string; text?: string },
  roster: readonly EphemeralMessageWorker[],
  policy: EphemeralPolicy,
): boolean {
  if (!policy.sensitiveTools?.length) return false;
  const thread = ctx.channel && ctx.threadTs ? `slack:${ctx.channel}:${ctx.threadTs}` : null;
  return roster.some(
    (w) =>
      isEphemeralWorker(w, policy) &&
      (ctx.username === w.name || !!ctx.text?.startsWith(`*${w.name}:*`) || (!!thread && !!w.threadSessions?.[thread])),
  );
}

/// Whether a conversation that began at `startedAt` and last spoke at
/// `lastAt` is over, and so due for the purge.
export function conversationEnded(startedAt: number, lastAt: number, now: number): boolean {
  return now - lastAt >= EPHEMERAL_IDLE_MS || now - startedAt >= EPHEMERAL_MAX_MS;
}
