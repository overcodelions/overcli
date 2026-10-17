// The org layer's files under the state directory.
//
//   org.json             who the org is and its rules (written by hand or
//                        `overcli org init`, read here)
//   org/tokens.json      who may call the control plane, as token hashes
//   org/hires.json       hires drafted but not yet made, and hires waiting
//                        on an approver
//
// Tokens are stored hashed: the file is a list of who holds access, never the
// access itself, so a leaked state directory does not leak a working token.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';
import { DEFAULT_ORG_POLICY, parseOrgPolicy, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import type { PendingHire } from './orgService';
import type { AccessStore, Invite, JoinRequest } from './accessService';

function orgDir(): string {
  return path.join(host().dataDir(), 'org');
}

export function orgPolicyPath(): string {
  return path.join(host().dataDir(), 'org.json');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    log('warn', 'org', `Failed to write ${path.basename(file)}: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

// ---- POLICY ---------------------------------------------------------------

let policyCache: { mtimeMs: number; policy: OrgPolicy; warnings: string[] } | null = null;

/// The policy as the file says now. Re-read when the file changes, so an
/// operator's edit applies without a restart; absent means the defaults.
export function loadOrgPolicy(): { policy: OrgPolicy; warnings: string[]; fromFile: boolean } {
  const file = orgPolicyPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    policyCache = null;
    return { policy: { ...DEFAULT_ORG_POLICY }, warnings: [], fromFile: false };
  }
  if (policyCache && policyCache.mtimeMs === mtimeMs) return { ...policyCache, fromFile: true };
  const raw = readJson(file);
  const parsed = raw === undefined
    ? { policy: { ...DEFAULT_ORG_POLICY }, warnings: ['org.json is not valid JSON; using the defaults.'] }
    : parseOrgPolicy(raw);
  for (const w of parsed.warnings) log('warn', 'org', w);
  policyCache = { mtimeMs, ...parsed };
  return { ...parsed, fromFile: true };
}

// ---- TOKENS ---------------------------------------------------------------

export interface OrgToken {
  id: string;
  name: string;
  slackUserId?: string;
  admin: boolean;
  /// Where this token lives — "console", "overcli app on Pat's MacBook" — so
  /// People can show where someone is signed in and sign one place out.
  device?: string;
  /// sha256 of the token. The token itself is shown once, at creation.
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

const TOKEN_PREFIX = 'ocli_';

function tokensPath(): string {
  return path.join(orgDir(), 'tokens.json');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function listTokens(): OrgToken[] {
  const raw = readJson(tokensPath());
  return Array.isArray(raw) ? (raw as OrgToken[]) : [];
}

export function createToken(args: { name: string; slackUserId?: string; admin?: boolean; device?: string }): { token: string; record: OrgToken } {
  const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
  const record: OrgToken = {
    id: randomUUID().slice(0, 8),
    name: args.name.trim(),
    ...(args.slackUserId ? { slackUserId: args.slackUserId } : {}),
    admin: args.admin === true,
    ...(args.device ? { device: args.device.trim().slice(0, 80) } : {}),
    hash: hashToken(token),
    createdAt: Date.now(),
  };
  writeAtomic(tokensPath(), [...listTokens(), record]);
  return { token, record };
}

/// Sign a person out everywhere: every token tied to their Slack id.
export function revokeTokensFor(slackUserId: string): number {
  const all = listTokens();
  const kept = all.filter((t) => t.slackUserId !== slackUserId);
  if (kept.length !== all.length) writeAtomic(tokensPath(), kept);
  return all.length - kept.length;
}

/// Sign out the one sign-in behind this token: what a device's own "Sign
/// out" does, so the token stops working on the server, not just locally.
export function revokeOwnToken(token: string): boolean {
  const want = hashToken(token);
  const all = listTokens();
  const kept = all.filter((t) => t.hash !== want);
  if (kept.length === all.length) return false;
  writeAtomic(tokensPath(), kept);
  return true;
}

export function revokeToken(idOrName: string): boolean {
  const all = listTokens();
  const kept = all.filter((t) => t.id !== idOrName && t.name !== idOrName);
  if (kept.length === all.length) return false;
  writeAtomic(tokensPath(), kept);
  return true;
}

/// The caller behind a bearer token, or null. Compares hashes in constant
/// time so the check does not leak how much of a guess was right.
export function callerForToken(token: string | undefined, policy: OrgPolicy): OrgCaller | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const want = Buffer.from(hashToken(token), 'hex');
  const all = listTokens();
  const hit = all.find((t) => {
    const have = Buffer.from(t.hash, 'hex');
    return have.length === want.length && timingSafeEqual(have, want);
  });
  if (!hit) return null;
  // Throttled: a busy console must not rewrite the file on every request.
  if (!hit.lastUsedAt || Date.now() - hit.lastUsedAt > 60_000) {
    hit.lastUsedAt = Date.now();
    writeAtomic(tokensPath(), all);
  }
  return {
    name: hit.name,
    ...(hit.slackUserId ? { slackUserId: hit.slackUserId } : {}),
    admin: hit.admin || (!!hit.slackUserId && policy.admins.includes(hit.slackUserId)),
  };
}

// ---- HIRES ----------------------------------------------------------------

export interface HireStore {
  list(): PendingHire[];
  save(hires: PendingHire[]): void;
}

/// Drafts nobody confirmed are dropped after a day; hires waiting on an
/// approver after a fortnight, when the ask has gone stale.
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const fileHireStore: HireStore = {
  list() {
    const raw = readJson(path.join(orgDir(), 'hires.json'));
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return (raw as PendingHire[]).filter((h) =>
      h.status === 'drafted' ? now - h.createdAt < DRAFT_TTL_MS : now - h.createdAt < APPROVAL_TTL_MS,
    );
  },
  save(hires) {
    writeAtomic(path.join(orgDir(), 'hires.json'), hires);
  },
};

/// Change `org.json` in place: read the file as written (not the parsed
/// policy, so keys this build does not know survive), let `mutate` change it,
/// write it back. The cache is dropped so the next read sees the change.
export function updateOrgFile(mutate: (raw: Record<string, unknown>) => void): void {
  const file = orgPolicyPath();
  const existing = readJson(file);
  const isObject = !!existing && typeof existing === 'object' && !Array.isArray(existing);
  // A file someone broke by hand is never written over: starting from {}
  // would drop the org's name, Slack workspace, roles and allowances.
  if (!isObject && fs.existsSync(file)) {
    throw new Error(`${file} is not valid JSON, so it was left as it is. Fix it, then try again.`);
  }
  const raw: Record<string, unknown> = isObject ? (existing as Record<string, unknown>) : {};
  mutate(raw);
  writeAtomic(file, raw);
  policyCache = null;
}

/// Write `org.json` for a new org, or fill in the identity of an existing one
/// without touching its rules. Returns what was written.
export function initOrgConfig(args: { name: string; admins?: string[]; slackTeamId?: string; timezone?: string; publicUrl?: string; force?: boolean }): {
  created: boolean;
  file: string;
} {
  const file = orgPolicyPath();
  const existing = readJson(file);
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing) && !args.force ? (existing as Record<string, unknown>) : {};
  const admins = new Set([...(Array.isArray(base.admins) ? (base.admins as string[]) : []), ...(args.admins ?? [])]);
  const next: Record<string, unknown> = {
    name: args.name,
    ...(args.slackTeamId ? { slackTeamId: args.slackTeamId } : {}),
    ...(args.timezone ? { timezone: args.timezone } : {}),
    // A fresh org starts narrow: admins hire, everyone else asks an admin.
    hirers: [],
    budgetAllowanceUSD: 50,
    approvers: [],
    teams: {},
    roles: [],
    ...base,
  };
  next.name = args.name;
  if (args.slackTeamId) next.slackTeamId = args.slackTeamId;
  if (args.timezone) next.timezone = args.timezone;
  if (args.publicUrl) next.publicUrl = args.publicUrl;
  next.admins = [...admins];
  writeAtomic(file, next);
  policyCache = null;
  return { created: existing === undefined, file };
}

// ---- AUDIT ----------------------------------------------------------------

export interface AuditEntry {
  at: number;
  /// Who did it, as the plane knew them.
  by: string;
  slackUserId?: string;
  /// One plain sentence: "Approved Max posting in #product."
  what: string;
}

export interface AuditStore {
  append(entry: AuditEntry): void;
  recent(limit: number): AuditEntry[];
}

/// Append-only, one JSON object per line, so a crash mid-write loses at most
/// the line being written and an operator can `tail -f` it.
export const fileAuditStore: AuditStore = {
  append(entry) {
    try {
      fs.mkdirSync(orgDir(), { recursive: true });
      fs.appendFileSync(path.join(orgDir(), 'audit.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (err) {
      log('warn', 'org', `Failed to write the audit log: ${String(err)}`);
    }
  },
  recent(limit) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(orgDir(), 'audit.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i].trim()) continue;
      try {
        out.push(JSON.parse(lines[i]) as AuditEntry);
      } catch {
        // a torn last line
      }
    }
    return out;
  },
};

// ---- RATINGS --------------------------------------------------------------

export interface Rating {
  /// The journal entry rated: a finished piece of work.
  entryId: string;
  workerId: string;
  useful: boolean;
  note?: string;
  by: string;
  slackUserId?: string;
  at: number;
}

export interface RatingStore {
  list(): Rating[];
  save(ratings: Rating[]): void;
}

export const fileRatingStore: RatingStore = {
  list() {
    const raw = readJson(path.join(orgDir(), 'ratings.json'));
    return Array.isArray(raw) ? (raw as Rating[]) : [];
  },
  save(ratings) {
    // The newest few thousand are plenty for "was it useful"; older ones
    // already live on as notes in the workers' journals.
    writeAtomic(path.join(orgDir(), 'ratings.json'), ratings.slice(-5000));
  },
};

// ---- ACCESS ---------------------------------------------------------------

/// Invites (hashed codes) and Slack join requests waiting on an admin.
export const fileAccessStore: AccessStore = {
  invites() {
    const raw = readJson(path.join(orgDir(), 'invites.json'));
    return Array.isArray(raw) ? (raw as Invite[]) : [];
  },
  saveInvites(invites) {
    // Used and expired invites are kept a month for the People page's
    // history, then dropped.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeAtomic(path.join(orgDir(), 'invites.json'), invites.filter((i) => (i.usedAt ?? i.expiresAt) > cutoff));
  },
  requests() {
    const raw = readJson(path.join(orgDir(), 'join-requests.json'));
    return Array.isArray(raw) ? (raw as JoinRequest[]) : [];
  },
  saveRequests(requests) {
    writeAtomic(path.join(orgDir(), 'join-requests.json'), requests);
  },
};
