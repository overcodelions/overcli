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
import type { TeamCheckpoints } from '../../shared/flows/team';
import type { PendingHire } from './orgService';
import type { ToolTrouble } from './toolHealth';
import type { AccessStore, Invite, JoinRequest } from './accessService';

export function orgDir(): string {
  return path.join(host().dataDir(), 'org');
}

export function orgPolicyPath(): string {
  return path.join(host().dataDir(), 'org.json');
}

function writeAtomicText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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

/// Tie a sign-in made before Slack was connected to the person's Slack id:
/// every token held by that name with no Slack id, which the server already
/// treats as one person. They take the person's Slack name when there is
/// one. Returns how many changed.
export function linkTokensToSlack(name: string, admin: boolean, slackUserId: string, slackName?: string): number {
  const all = listTokens();
  let n = 0;
  for (const t of all) {
    if (t.slackUserId || t.name !== name || t.admin !== admin) continue;
    t.slackUserId = slackUserId;
    if (slackName) t.name = slackName;
    n++;
  }
  if (n) writeAtomic(tokensPath(), all);
  return n;
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
  /// Every entry, oldest first — for the full log and its export.
  all?(): AuditEntry[];
  /// Drop entries older than `before`; returns how many went.
  prune?(before: number): number;
}

function readAudit(): AuditEntry[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(orgDir(), 'audit.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // a torn line
    }
  }
  return out;
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
  all: readAudit,
  prune(before) {
    const all = readAudit();
    const kept = all.filter((e) => e.at >= before);
    if (kept.length === all.length) return 0;
    // Rewritten whole and renamed into place, like every other store.
    const file = path.join(orgDir(), 'audit.jsonl');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return all.length - kept.length;
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

// ---- TOOL REQUESTS --------------------------------------------------------

/// A manager asking an admin for a tool for one of their workers: one the
/// org hasn't cleared for any hire, or one this server doesn't have yet.
export interface ToolRequest {
  id: string;
  workerId: string;
  workerName: string;
  /// The tool's name as installed, or what they called one that isn't.
  tool: string;
  why?: string;
  by: { name: string; slackUserId?: string };
  at: number;
  status: 'open' | 'given' | 'declined';
  decidedBy?: string;
  decidedAt?: number;
  /// What the admin said with a decline.
  note?: string;
}

export interface ToolRequestStore {
  list(): ToolRequest[];
  save(all: ToolRequest[]): void;
}

export const fileToolRequestStore: ToolRequestStore = {
  list() {
    const raw = readJson(path.join(orgDir(), 'tool-requests.json'));
    return Array.isArray(raw) ? (raw as ToolRequest[]) : [];
  },
  save(all) {
    // Open ones always; decided ones while they're still news.
    writeAtomic(path.join(orgDir(), 'tool-requests.json'), all.filter((r) => r.status === 'open').concat(all.filter((r) => r.status !== 'open').slice(-500)));
  },
};

// ---- WORKER VERSIONS ------------------------------------------------------

/// What a worker is set up to do, as one version: what restoring brings back.
export interface WorkerConfig {
  jobDescription: string;
  mcpServers: string[];
  toolScopes?: Record<string, unknown>;
  trust: string;
  visibility?: string;
  budgetUSDPerMonth: number;
  cadence: unknown;
  preferredFlowId?: string;
  answersAtOnce?: number;
  skipCheckpoints?: boolean;
  alwaysAllow?: string[];
}

export interface WorkerVersion {
  id: string;
  workerId: string;
  at: number;
  by: string;
  /// What this version changed, in words: "its job", "its tools".
  changed: string[];
  config: WorkerConfig;
}

/// Kept per worker; older ones go.
export const WORKER_VERSIONS_KEPT = 50;

export interface WorkerVersionStore {
  list(): WorkerVersion[];
  save(all: WorkerVersion[]): void;
}

export const fileWorkerVersionStore: WorkerVersionStore = {
  list() {
    const raw = readJson(path.join(orgDir(), 'worker-versions.json'));
    return Array.isArray(raw) ? (raw as WorkerVersion[]) : [];
  },
  save(all) {
    writeAtomic(path.join(orgDir(), 'worker-versions.json'), all);
  },
};

// ---- HANDBOOK -------------------------------------------------------------

/// What every worker should know about the org, written once by an admin.
export const HANDBOOK_MAX = 12_000;

export const fileHandbook = {
  read(): string {
    try {
      return fs.readFileSync(path.join(orgDir(), 'handbook.md'), 'utf8');
    } catch {
      return '';
    }
  },
  write(text: string): void {
    writeAtomicText(path.join(orgDir(), 'handbook.md'), text);
  },
};

// ---- DIGEST ---------------------------------------------------------------

/// The week the Monday digest last went out for, `YYYY-MM-DD` of its Monday.
export const fileDigestState = {
  lastWeek(): string | null {
    const raw = readJson(path.join(orgDir(), 'digest.json')) as { lastWeek?: unknown } | null;
    return raw && typeof raw.lastWeek === 'string' ? raw.lastWeek : null;
  },
  sent(week: string): void {
    writeAtomic(path.join(orgDir(), 'digest.json'), { lastWeek: week });
  },
};

export const fileToolHealthStore = {
  load(): ToolTrouble[] {
    const raw = readJson(path.join(orgDir(), 'tool-health.json'));
    return Array.isArray(raw) ? (raw as ToolTrouble[]) : [];
  },
  save(all: ToolTrouble[]): void {
    writeAtomic(path.join(orgDir(), 'tool-health.json'), all);
  },
};

// ---- TEAM FILES -----------------------------------------------------------

/// A team task's file someone kept in the Library. The text is a snapshot
/// (the first 6,000 characters), so it outlives the task's folder.
export interface KeptFile {
  id: string;
  taskId: string;
  teamId: string;
  teamName: string;
  name: string;
  title: string;
  body: string;
  /// Who wrote it: a member, or absent for the coordinator.
  writer?: { workerId: string; name: string };
  by: string;
  slackUserId?: string;
  at: number;
}

/// A team task's file saved to a Drive or SharePoint through its tool.
export interface SavedFile {
  taskId: string;
  name: string;
  destination: string;
  label: string;
  at: number;
  link?: string;
  by?: string;
  /// Whose own account it went to (a personal Drive): only they see it listed.
  person?: string;
}

export interface TeamFileStore {
  kept(): KeptFile[];
  saveKept(all: KeptFile[]): void;
  saved(): SavedFile[];
  saveSaved(all: SavedFile[]): void;
}

export const fileTeamFileStore: TeamFileStore = {
  kept() {
    const raw = readJson(path.join(orgDir(), 'kept-files.json'));
    return Array.isArray(raw) ? (raw as KeptFile[]) : [];
  },
  saveKept(all) {
    writeAtomic(path.join(orgDir(), 'kept-files.json'), all.slice(-2000));
  },
  saved() {
    const raw = readJson(path.join(orgDir(), 'saved-files.json'));
    return Array.isArray(raw) ? (raw as SavedFile[]) : [];
  },
  saveSaved(all) {
    writeAtomic(path.join(orgDir(), 'saved-files.json'), all.slice(-5000));
  },
};

// ---- QUESTIONS ------------------------------------------------------------

/// Something someone asked a worker, kept so the answer outlives the page
/// that asked: a worker can take minutes, and people walk away.
export interface AskRecord {
  id: string;
  workerId: string;
  workerName: string;
  by: string;
  slackUserId?: string;
  text: string;
  at: number;
  status: 'working' | 'answered' | 'failed';
  /// Where it was asked. Slack and MCP hand the answer back themselves.
  via?: 'console' | 'slack' | 'mcp' | 'trigger';
  reply?: string;
  launched?: number;
  /// The batch its answer led to, when it proposed or started work.
  orchestrationId?: string;
  /// The thread on the worker's page this replies to (a `WorkThread` id).
  replyTo?: string;
  /// One-tap answers the worker offered with its reply.
  choices?: string[];
  error?: string;
  doneAt?: number;
  /// What the worker was given, in full (who asked, the thread it replies
  /// to, the question), so a restart can ask it again.
  prompt?: string;
  /// How many files came with it. They are not kept, so an ask started
  /// again after a restart says they were lost.
  attachments?: number;
  /// Started again after a restart cut it short. Once only.
  resumed?: boolean;
  /// Called off by whoever started it: what its answer starts is stopped.
  cancelled?: boolean;
  /// The work it handed off has finished and gone back to the worker to
  /// finish up (`OrgService.handBack`). Once only.
  handedBack?: boolean;
  /// The Slack thread it was asked in (see `OrgService.startAsk`).
  conversation?: string;
  /// Asked by someone who doesn't manage the worker, or by a trigger: its errands run untrusted.
  untrusted?: boolean;
}

/// What came from someone's own install, by the id it had there: their
/// worker or team id → the one on this server. Publishing the same thing
/// again finds it here, so a team brings members the org already has rather
/// than a second copy, and a team published again is updated in place.
export interface PublishedTeamWaiting {
  localTeamId: string;
  team: TeamPublishShape;
  by: { name: string; slackUserId?: string };
  /// Members waiting on an approver: their local id → the hire.
  waiting: Record<string, string>;
  at: number;
}

/// A published team, members by their local ids. See OrgService.publishTeam.
export interface TeamPublishShape {
  name: string;
  purpose?: string;
  budgetUSDPerTask: number;
  checkpoints?: Partial<TeamCheckpoints>;
  piecesAskFirst?: boolean;
  members: Array<{ localId: string; role: string }>;
}

export interface PublishedState {
  workers: Record<string, string>;
  teams: Record<string, string>;
  waiting: PublishedTeamWaiting[];
}

export interface PublishedStore {
  load(): PublishedState;
  save(state: PublishedState): void;
}

export const filePublishedStore: PublishedStore = {
  load() {
    const raw = readJson(path.join(orgDir(), 'published.json')) as Partial<PublishedState> | null;
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {});
    return { workers: obj(raw?.workers), teams: obj(raw?.teams), waiting: Array.isArray(raw?.waiting) ? raw.waiting : [] };
  },
  save(state) {
    writeAtomic(path.join(orgDir(), 'published.json'), state);
  },
};

/// A small JSON document in the org folder, for state that must outlive a
/// restart but is nobody's record (what the Slack front door is following).
export function jsonOrgStore<T>(name: string, fallback: () => T): { load(): T; save(value: T): void } {
  return {
    load() {
      const raw = readJson(path.join(orgDir(), name));
      return raw && typeof raw === 'object' ? ({ ...fallback(), ...(raw as object) } as T) : fallback();
    },
    save(value) {
      writeAtomic(path.join(orgDir(), name), value);
    },
  };
}

export interface AskStore {
  list(): AskRecord[];
  save(asks: AskRecord[]): void;
}

export const fileAskStore: AskStore = {
  list() {
    const raw = readJson(path.join(orgDir(), 'asks.json'));
    return Array.isArray(raw) ? (raw as AskRecord[]) : [];
  },
  save(asks) {
    writeAtomic(path.join(orgDir(), 'asks.json'), asks.slice(-1000));
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
