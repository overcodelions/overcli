// Getting people into the org without anyone copying a token.
//
// Three doors, one rule: a person is their Slack account, so "Pat's workers"
// means the same thing in Slack, the console, Claude and the overcli app.
//
//   Invites       an admin picks someone; overcli DMs them a one-time link
//                 (or the admin copies it). Opening the link signs them in.
//   Join requests anyone in the org's Slack types `/overcli join`. Slack has
//                 proved who they are, so an admin only says yes — or, with
//                 `openJoin`, nobody has to.
//   Pairing       the overcli app shows a short code and opens the browser;
//                 someone already signed in confirms it, and the app gets a
//                 token of its own. The device flow a TV uses.
//
// Every door ends in `createToken`, so a token is still the only credential
// and People can list and revoke each one. Codes are random and stored as
// hashes; pairing secrets live in memory for ten minutes and no longer.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAdmin, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { isSlackUserId } from '../../shared/flows/worker';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type PersonRole = 'member' | 'hirer' | 'approver' | 'admin';

export const ROLE_TEXT: Record<PersonRole, string> = {
  member: 'ask workers things and rate their work',
  hirer: 'hire and manage their own workers',
  approver: 'approve hires over someone’s allowance',
  admin: 'run the org: people, rules and every worker',
};

export interface Invite {
  id: string;
  /// sha256 of the code in the link. The code itself is never stored.
  codeHash: string;
  name: string;
  slackUserId?: string;
  email?: string;
  role: PersonRole;
  allowanceUSD?: number;
  invitedBy: { name: string; slackUserId?: string };
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  /// Sent as a Slack DM, or handed over as a link.
  sentInSlack?: boolean;
  /// The link `serve` prints on first run, to sign in the first admin.
  setup?: boolean;
}

export interface JoinRequest {
  id: string;
  slackUserId: string;
  name: string;
  at: number;
}

export interface AccessStore {
  invites(): Invite[];
  saveInvites(invites: Invite[]): void;
  requests(): JoinRequest[];
  saveRequests(requests: JoinRequest[]): void;
}

interface Pairing {
  id: string;
  userCode: string;
  pollHash: string;
  device: string;
  createdAt: number;
  expiresAt: number;
  denied?: boolean;
  /// Set on approval, handed to the app on its next poll, then forgotten.
  token?: string;
  who?: { name: string; org: string };
}

export interface AccessDeps {
  policy(): OrgPolicy;
  store: AccessStore;
  tokens: {
    create(args: { name: string; slackUserId?: string; admin?: boolean; device?: string }): { token: string };
    revokeFor(slackUserId: string): number;
    revoke(id: string): boolean;
    list(): Array<{ id: string; name: string; slackUserId?: string; device?: string }>;
  };
  /// Change org.json in place (roles, allowances).
  updateOrg(mutate: (raw: Record<string, unknown>) => void): void;
  /// Slack, when it is connected. Each returns whether the DM went.
  slack?: {
    dmInvite(invite: Invite, link: string, org: string): Promise<boolean>;
    askAdmins(request: JoinRequest, admins: string[], org: string): void;
    tellRequester(slackUserId: string, text: string): void;
  };
  now?(): number;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRS = 100;

function hash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/// A code a person can read off one screen and check on another: no 0/O or
/// 1/I/L to confuse.
function userCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 3).join('')}-${chars.slice(3).join('')}`;
}

export function personRole(policy: OrgPolicy, slackUserId?: string): PersonRole {
  if (!slackUserId) return 'member';
  if (policy.admins.includes(slackUserId)) return 'admin';
  if (policy.approvers.includes(slackUserId)) return 'approver';
  if (policy.hirers === '*' || policy.hirers.includes(slackUserId)) return 'hirer';
  return 'member';
}

export class AccessService {
  private pairings = new Map<string, Pairing>();
  /// The last address the console was reached at — where links point when
  /// org.json has no publicUrl.
  private seenOrigin: string | null = null;

  constructor(private readonly deps: AccessDeps) {}

  noteOrigin(origin: string): void {
    if (/^https?:\/\/[^/]+$/.test(origin)) this.seenOrigin = origin;
  }

  /// Where links sent from Slack point: org.json's publicUrl, else wherever
  /// the console was last used. Null until one of those is known.
  baseUrl(): string | null {
    return this.deps.policy().publicUrl ?? this.seenOrigin;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private org(): string {
    return this.deps.policy().name ?? 'your org';
  }

  private requireAdmin(caller: OrgCaller): string | null {
    return isAdmin(this.deps.policy(), caller) ? null : 'Only admins can do that.';
  }

  // ---- INVITES ----------------------------------------------------------

  private liveInvites(): Invite[] {
    const now = this.now();
    return this.deps.store.invites().filter((i) => !i.usedAt && i.expiresAt > now);
  }

  async invite(
    caller: OrgCaller,
    args: { name: string; slackUserId?: string; email?: string; role: PersonRole; allowanceUSD?: number; setup?: boolean },
    baseUrl: string,
  ): Promise<Result<{ invite: InviteSummary; link: string; sentInSlack: boolean }>> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    const name = args.name?.trim() ?? '';
    if (!name) return { ok: false, error: 'Say who the invite is for.' };
    const slackUserId = args.slackUserId?.trim() || undefined;
    if (slackUserId && !isSlackUserId(slackUserId)) return { ok: false, error: 'That is not a Slack member ID (it looks like U012AB3CD).' };
    if (!(['member', 'hirer', 'approver', 'admin'] as const).includes(args.role)) return { ok: false, error: 'Pick what they can do.' };
    if (args.allowanceUSD !== undefined && (!Number.isFinite(args.allowanceUSD) || args.allowanceUSD < 0)) {
      return { ok: false, error: 'An allowance is a number of dollars, zero or more.' };
    }
    const code = randomBytes(18).toString('base64url');
    const now = this.now();
    const invite: Invite = {
      id: randomUUID().slice(0, 8),
      codeHash: hash(code),
      name,
      ...(slackUserId ? { slackUserId } : {}),
      ...(args.email?.trim() ? { email: args.email.trim() } : {}),
      role: args.role,
      ...(args.allowanceUSD !== undefined ? { allowanceUSD: args.allowanceUSD } : {}),
      invitedBy: { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) },
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
      ...(args.setup ? { setup: true } : {}),
    };
    const link = `${baseUrl.replace(/\/+$/, '')}/join/${code}`;
    // A second invite for the same person replaces the first: one live link each.
    const rest = this.deps.store.invites().filter((i) => !(slackUserId && i.slackUserId === slackUserId && !i.usedAt));
    let sentInSlack = false;
    if (slackUserId && this.deps.slack) sentInSlack = await this.deps.slack.dmInvite(invite, link, this.org());
    invite.sentInSlack = sentInSlack;
    this.deps.store.saveInvites([...rest, invite]);
    return { ok: true, invite: summarize(invite), link, sentInSlack };
  }

  invites(caller: OrgCaller): Result<{ invites: InviteSummary[] }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    return { ok: true, invites: this.liveInvites().map(summarize).sort((a, b) => b.createdAt - a.createdAt) };
  }

  cancelInvite(caller: OrgCaller, id: string): Result {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    const all = this.deps.store.invites();
    if (!all.some((i) => i.id === id)) return { ok: false, error: 'No invite with that id.' };
    this.deps.store.saveInvites(all.filter((i) => i.id !== id));
    return { ok: true };
  }

  private findInvite(code: string): Invite | null {
    if (!code || code.length > 100) return null;
    const want = hash(code);
    return this.liveInvites().find((i) => sameHash(i.codeHash, want)) ?? null;
  }

  /// What the join page shows before anyone presses anything. Public: the
  /// code in the URL is the credential.
  inviteInfo(code: string): Result<{ org: string; name: string; invitedBy: string; role: PersonRole; roleText: string; allowanceUSD?: number; expiresAt: number; setup?: boolean }> {
    const invite = this.findInvite(code);
    if (!invite) return { ok: false, error: 'This invite has been used, has expired, or was never sent. Ask for a new one.' };
    const allowance = invite.allowanceUSD ?? (invite.role === 'hirer' ? this.deps.policy().budgetAllowanceUSD : undefined);
    return {
      ok: true,
      org: this.org(),
      name: invite.name,
      invitedBy: invite.invitedBy.name,
      role: invite.role,
      roleText: ROLE_TEXT[invite.role],
      ...(allowance !== undefined ? { allowanceUSD: allowance } : {}),
      expiresAt: invite.expiresAt,
      ...(invite.setup ? { setup: true } : {}),
    };
  }

  /// Use an invite: apply its role, mint the person's token, spend the code.
  redeem(code: string, device = 'Browser'): Result<{ token: string; name: string; org: string }> {
    const invite = this.findInvite(code);
    if (!invite) return { ok: false, error: 'This invite has been used, has expired, or was never sent. Ask for a new one.' };
    if (invite.slackUserId) this.applyRole(invite.slackUserId, invite.role, invite.allowanceUSD);
    const { token } = this.deps.tokens.create({
      name: invite.name,
      ...(invite.slackUserId ? { slackUserId: invite.slackUserId } : {}),
      // With a Slack id, admin rights live in org.json (applyRole above).
      // Without one there is nowhere else to keep them: the token carries it.
      admin: invite.role === 'admin' && !invite.slackUserId,
      device,
    });
    const all = this.deps.store.invites();
    const stored = all.find((i) => i.id === invite.id);
    if (stored) stored.usedAt = this.now();
    this.deps.store.saveInvites(all);
    return { ok: true, token, name: invite.name, org: this.org() };
  }

  // ---- ROLES ------------------------------------------------------------

  private applyRole(slackUserId: string, role: PersonRole, allowanceUSD?: number): void {
    this.deps.updateOrg((raw) => {
      const list = (key: string): string[] => (Array.isArray(raw[key]) ? (raw[key] as string[]).filter((x) => x !== slackUserId) : []);
      const admins = list('admins');
      const approvers = list('approvers');
      const hirersOpen = raw.hirers === '*';
      const hirers = hirersOpen ? null : list('hirers');
      if (role === 'admin') admins.push(slackUserId);
      if (role === 'approver') approvers.push(slackUserId);
      if (hirers && (role === 'hirer' || role === 'approver' || role === 'admin')) hirers.push(slackUserId);
      raw.admins = admins;
      raw.approvers = approvers;
      if (hirers) raw.hirers = hirers;
      if (allowanceUSD !== undefined) {
        const allowances = raw.allowances && typeof raw.allowances === 'object' ? (raw.allowances as Record<string, number>) : {};
        allowances[slackUserId] = allowanceUSD;
        raw.allowances = allowances;
      }
    });
  }

  /// Change what someone can do, from People.
  setRole(caller: OrgCaller, slackUserId: string, role: PersonRole, allowanceUSD?: number): Result<{ role: PersonRole; note?: string }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    if (!isSlackUserId(slackUserId)) return { ok: false, error: 'That person has no Slack member ID, so there is no role to set.' };
    if (caller.slackUserId === slackUserId && role !== 'admin' && this.deps.policy().admins.length <= 1) {
      return { ok: false, error: 'You are the only admin. Make someone else an admin first.' };
    }
    this.applyRole(slackUserId, role, allowanceUSD);
    const now = personRole(this.deps.policy(), slackUserId);
    return now === role
      ? { ok: true, role: now }
      : { ok: true, role: now, note: 'Everyone in the org may hire (hirers is "*" in org.json), so this person can still hire.' };
  }

  /// Whether anyone in the org's Slack gets in by asking.
  setOpenJoin(caller: OrgCaller, on: boolean): Result<{ openJoin: boolean }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    this.deps.updateOrg((raw) => {
      raw.openJoin = on;
    });
    return { ok: true, openJoin: this.deps.policy().openJoin };
  }

  signOutEverywhere(caller: OrgCaller, slackUserId: string): Result<{ count: number }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    if (caller.slackUserId === slackUserId) return { ok: false, error: 'Sign yourself out from your own devices instead.' };
    return { ok: true, count: this.deps.tokens.revokeFor(slackUserId) };
  }

  /// Sign out one place. Your own any time; anyone's as an admin.
  signOutDevice(caller: OrgCaller, tokenId: string): Result {
    const token = this.deps.tokens.list().find((t) => t.id === tokenId);
    if (!token) return { ok: false, error: 'No sign-in with that id.' };
    const own = !!caller.slackUserId && token.slackUserId === caller.slackUserId;
    if (!own && !isAdmin(this.deps.policy(), caller)) return { ok: false, error: 'Only admins can sign other people out.' };
    this.deps.tokens.revoke(tokenId);
    return { ok: true };
  }

  // ---- JOIN REQUESTS ----------------------------------------------------

  /// `/overcli join` in Slack. Slack has already said who this is.
  async requestJoin(person: { slackUserId: string; name: string }, baseUrl: string): Promise<Result<{ outcome: 'invited' | 'asked' | 'already' }>> {
    if (!isSlackUserId(person.slackUserId)) return { ok: false, error: 'Not a Slack member.' };
    const policy = this.deps.policy();
    if (policy.openJoin) {
      const role: PersonRole = personRole(policy, person.slackUserId);
      const made = await this.invite({ name: 'Slack', admin: true }, { name: person.name, slackUserId: person.slackUserId, role }, baseUrl);
      return made.ok ? { ok: true, outcome: 'invited' } : made;
    }
    const requests = this.deps.store.requests();
    if (requests.some((r) => r.slackUserId === person.slackUserId)) return { ok: true, outcome: 'already' };
    const request: JoinRequest = { id: randomUUID().slice(0, 8), slackUserId: person.slackUserId, name: person.name, at: this.now() };
    this.deps.store.saveRequests([...requests, request]);
    this.deps.slack?.askAdmins(request, policy.admins, this.org());
    return { ok: true, outcome: 'asked' };
  }

  requests(caller: OrgCaller): Result<{ requests: JoinRequest[] }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    return { ok: true, requests: [...this.deps.store.requests()].sort((a, b) => a.at - b.at) };
  }

  /// Let someone in (an invite DMed to them) or turn them down.
  async decideRequest(caller: OrgCaller, id: string, approve: boolean, baseUrl: string, role: PersonRole = 'member'): Promise<Result<{ sentInSlack?: boolean; link?: string }>> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    const requests = this.deps.store.requests();
    const request = requests.find((r) => r.id === id);
    if (!request) return { ok: false, error: 'That request was already handled.' };
    this.deps.store.saveRequests(requests.filter((r) => r.id !== id));
    if (!approve) {
      this.deps.slack?.tellRequester(request.slackUserId, `An admin didn’t let you into ${this.org()}’s workers this time. Ask them if you think that’s a mistake.`);
      return { ok: true };
    }
    const made = await this.invite(caller, { name: request.name, slackUserId: request.slackUserId, role }, baseUrl);
    if (!made.ok) return made;
    return { ok: true, sentInSlack: made.sentInSlack, ...(made.sentInSlack ? {} : { link: made.link }) };
  }

  // ---- PAIRING (the overcli app) ----------------------------------------

  private livePairing(id: string): Pairing | null {
    const p = this.pairings.get(id);
    if (!p) return null;
    if (p.expiresAt <= this.now()) {
      this.pairings.delete(id);
      return null;
    }
    return p;
  }

  private sweepPairings(): void {
    const now = this.now();
    for (const [id, p] of this.pairings) if (p.expiresAt <= now) this.pairings.delete(id);
  }

  /// The app asks to pair. Public: nothing is granted until a signed-in
  /// person confirms the code.
  pairStart(device: string, baseUrl: string): Result<{ pairId: string; userCode: string; pollSecret: string; verifyUrl: string; expiresAt: number }> {
    this.sweepPairings();
    if (this.pairings.size >= MAX_PENDING_PAIRS) return { ok: false, error: 'Too many sign-ins waiting. Try again in a few minutes.' };
    const label = (device || 'overcli app').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'overcli app';
    const pollSecret = randomBytes(24).toString('base64url');
    const pairing: Pairing = {
      id: randomUUID(),
      userCode: userCode(),
      pollHash: hash(pollSecret),
      device: label,
      createdAt: this.now(),
      expiresAt: this.now() + PAIR_TTL_MS,
    };
    this.pairings.set(pairing.id, pairing);
    return {
      ok: true,
      pairId: pairing.id,
      userCode: pairing.userCode,
      pollSecret,
      verifyUrl: `${baseUrl.replace(/\/+$/, '')}/pair?code=${encodeURIComponent(pairing.userCode)}`,
      expiresAt: pairing.expiresAt,
    };
  }

  private byCode(code: string): Pairing | null {
    const want = code.trim().toUpperCase();
    for (const p of this.pairings.values()) {
      if (p.userCode === want && !p.token && !p.denied && this.livePairing(p.id)) return p;
    }
    return null;
  }

  pairInfo(caller: OrgCaller, code: string): Result<{ device: string; expiresAt: number; org: string }> {
    void caller;
    const p = this.byCode(code);
    if (!p) return { ok: false, error: 'That code has expired or was already used. Start again from the overcli app.' };
    return { ok: true, device: p.device, expiresAt: p.expiresAt, org: this.org() };
  }

  /// The signed-in person confirms (or refuses) the code the app showed.
  pairDecide(caller: OrgCaller, code: string, allow: boolean): Result {
    const p = this.byCode(code);
    if (!p) return { ok: false, error: 'That code has expired or was already used. Start again from the overcli app.' };
    if (!allow) {
      p.denied = true;
      return { ok: true };
    }
    const { token } = this.deps.tokens.create({
      name: caller.name,
      ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}),
      // An admin token pairs as an admin only when it is not a person's:
      // a person's admin rights come from org.json, not the token.
      admin: caller.admin && !caller.slackUserId,
      device: `overcli app: ${p.device}`,
    });
    p.token = token;
    p.who = { name: caller.name, org: this.org() };
    return { ok: true };
  }

  /// The app polls until the code is confirmed. The token is handed over
  /// once; the pairing is forgotten as it goes.
  pairPoll(pairId: string, pollSecret: string): Result<{ status: 'waiting' | 'denied' | 'expired' } | { status: 'signedIn'; token: string; name: string; org: string }> {
    const p = this.livePairing(pairId);
    if (!p) return { ok: true, status: 'expired' };
    if (!pollSecret || !sameHash(p.pollHash, hash(pollSecret))) return { ok: false, error: 'Not your sign-in.' };
    if (p.denied) {
      this.pairings.delete(pairId);
      return { ok: true, status: 'denied' };
    }
    if (!p.token) return { ok: true, status: 'waiting' };
    this.pairings.delete(pairId);
    return { ok: true, status: 'signedIn', token: p.token, name: p.who!.name, org: p.who!.org };
  }
}

export interface InviteSummary {
  id: string;
  name: string;
  slackUserId?: string;
  email?: string;
  role: PersonRole;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  sentInSlack: boolean;
}

function summarize(i: Invite): InviteSummary {
  return {
    id: i.id,
    name: i.name,
    ...(i.slackUserId ? { slackUserId: i.slackUserId } : {}),
    ...(i.email ? { email: i.email } : {}),
    role: i.role,
    invitedBy: i.invitedBy.name,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    sentInSlack: !!i.sentInSlack,
  };
}
