// Getting people into the org without anyone copying a token.
//
// Three doors, one rule: a person is their Slack account, so "Pat's workers"
// means the same thing in Slack, the console, Claude and the overcli app.
//
//   Invites       an admin picks someone; overcli DMs them a one-time link
//                 (or the admin copies it). Opening the link signs them in.
//   Join requests anyone in the org's Slack types `/overgo join`. Slack has
//                 proved who they are, so an admin only says yes — or, with
//                 `openJoin`, nobody has to.
//   Pairing       the overcli app shows a short code and opens the browser;
//                 someone already signed in confirms it, and the app gets a
//                 token of its own. The device flow a TV uses.
//
// Every door ends in `createToken`, so a token is still the only credential
// and People can list and revoke each one. Codes are random and stored as
// hashes; pairing secrets live in memory for ten minutes and no longer.

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAdmin, parseOrgPolicy, type OrgCaller, type OrgPolicy, type OrgRole, type OrgSso, type WebFetchMode } from '../../shared/org/policy';
import { isSlackUserId } from '../../shared/flows/worker';
import { PREMIUM_MODELS } from '../../shared/modelCatalog';
import { modelProvider, type ModelProviderKind } from '../backends/providerModels';
import { accessServer, refusalSummary, type AccessServer } from './workerAccess';
import type { WorkerAccess } from '../../shared/org/access';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type PersonRole = 'member' | 'hirer' | 'approver' | 'admin';

const ROLE_NAME: Record<PersonRole, string> = { member: 'a member', hirer: 'a hirer', approver: 'an approver', admin: 'an admin' };

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
    /// Give a no-Slack sign-in its Slack id (see `linkSlack`).
    link?(name: string, admin: boolean, slackUserId: string, slackName?: string): number;
  };
  /// After a link: workers managed by that name, with no Slack id, get it
  /// (and the Slack name, when known).
  linkManagers?(name: string, slackUserId: string, slackName?: string): number;
  /// Change org.json in place (roles, allowances).
  updateOrg(mutate: (raw: Record<string, unknown>) => void): void;
  /// Write a line in the decision log.
  record?(caller: OrgCaller, what: string): void;
  /// Everyone signs in through the identity provider: invite links no longer
  /// sign anyone in (bar the first admin's), though they still carry a role.
  ssoRequired?(): boolean;
  /// Slack, when it is connected. Each returns whether the DM went.
  slack?: {
    dmInvite(invite: Invite, link: string, org: string): Promise<boolean>;
    askAdmins(request: JoinRequest, admins: string[], org: string): void;
    tellRequester(slackUserId: string, text: string): void;
    /// Ask that person, in a DM with a button, whether a console sign-in is them.
    dmLinkSlack?(slackUserId: string, linkId: string, signedInAs: string, org: string): Promise<boolean>;
  };
  now?(): number;
}

/// The rules the Admin page may change. Admins, allowances and roles of
/// people are set from People; the Slack workspace only with `org init`.
export const EDITABLE_RULES = [
  'name', 'publicUrl', 'timezone', 'hirers', 'budgetAllowanceUSD', 'approvers', 'orgVisibilityNeedsAdmin', 'webNeedsApproval', 'webFetch', 'ownDomains', 'serviceAccounts',
  'allowedMcpServers', 'sharedMcpServers', 'teams', 'roles', 'orgBudgetUSD', 'alertAtPercent', 'prSavedMultiplier', 'prSavedMinHours', 'retentionDays', 'sso', 'people', 'fleet',
  'redactSecrets', 'providerModels', 'workerAccess',
] as const;

export interface EditableRules {
  name: string;
  publicUrl: string;
  timezone: string;
  hirers: '*' | string[];
  budgetAllowanceUSD: number;
  approvers: string[];
  orgVisibilityNeedsAdmin: boolean;
  webNeedsApproval: boolean;
  webFetch: WebFetchMode;
  ownDomains: string[];
  allowedMcpServers: string[];
  sharedMcpServers: string[];
  teams: Record<string, string[]>;
  roles: OrgRole[];
  orgBudgetUSD: number | null;
  alertAtPercent: number;
  prSavedMultiplier: number;
  prSavedMinHours: number;
  retentionDays: number | null;
  sso: OrgSso | null;
  people: Record<string, string>;
  fleet: Array<{ name: string; url: string }>;
  redactSecrets: boolean;
  providerModels: Record<string, string>;
  /// Read only, for the Model ids page: the Claude models overcli offers, and
  /// which provider this server's environment sends them to.
  claudeModels: string[];
  modelProvider: ModelProviderKind;
  workerAccess: WorkerAccess | null;
  /// Read only, for the Permissions page: whether this server lets the
  /// console set a level, the highest it allows, and the last week's refusals.
  accessServer: AccessServer;
  accessRefusals: ReturnType<typeof refusalSummary>;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/// The first-admin link goes to the log, where more people can read it.
export const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
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
  // randomInt, not a byte mod 31: that favours the first few letters.
  const chars = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]);
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

  // ---- LINK SLACK ---------------------------------------------------------

  /// "This is me" requests waiting for the named Slack person to press the
  /// button in their DM. In memory: a restart, like the quarter hour, ends one.
  private pendingLinks = new Map<string, { name: string; admin: boolean; slackUserId: string; until: number }>();

  /// A sign-in made before Slack was connected (the first admin's link, a
  /// token from the command line) has no Slack id, so nothing in Slack can
  /// reach that person and the workers they manage DM nobody. This links
  /// it — but only once the Slack person themselves says so: the server DMs
  /// them a button, and only they can press it. A member ID typed into the
  /// console alone would let anyone act as a colleague.
  async linkSlackStart(caller: OrgCaller, slackUserId: string): Promise<Result<{ sentTo: string }>> {
    const id = slackUserId.trim();
    if (caller.slackUserId) return { ok: false, error: 'This sign-in is already linked to Slack.' };
    if (!isSlackUserId(id)) return { ok: false, error: 'That is not a Slack member ID (it looks like U012AB3CD). In Slack: your profile → ⋮ → Copy member ID.' };
    if (!this.deps.slack?.dmLinkSlack || !this.deps.tokens.link) return { ok: false, error: 'Slack is not connected to this server yet.' };
    const now = this.now();
    for (const [k, v] of this.pendingLinks) if (v.until <= now) this.pendingLinks.delete(k);
    const linkId = randomUUID();
    this.pendingLinks.set(linkId, { name: caller.name, admin: caller.admin, slackUserId: id, until: now + 15 * 60_000 });
    const sent = await this.deps.slack.dmLinkSlack(id, linkId, caller.name, this.org());
    if (!sent) {
      this.pendingLinks.delete(linkId);
      return { ok: false, error: 'Slack could not DM that member ID. Check it, and that the app is installed in your workspace.' };
    }
    this.deps.record?.(caller, `Asked Slack to link this sign-in to <@${id}>.`);
    return { ok: true, sentTo: id };
  }

  /// The button in that DM, pressed by `pressedBy` as Slack reports it.
  /// `slackName` is their name in Slack: the sign-in and its workers'
  /// manager take it, so People shows one person by their real name.
  linkSlackConfirm(pressedBy: string, linkId: string, slackName?: string): Result<{ name: string; was: string; signIns: number; workers: number }> {
    const p = this.pendingLinks.get(linkId);
    if (!p || p.until <= this.now()) {
      this.pendingLinks.delete(linkId);
      return { ok: false, error: 'That request has expired. Start again from People in the console.' };
    }
    if (pressedBy !== p.slackUserId) return { ok: false, error: 'This request is for someone else.' };
    this.pendingLinks.delete(linkId);
    const name = slackName?.trim().slice(0, 80) || undefined;
    const signIns = this.deps.tokens.link?.(p.name, p.admin, p.slackUserId, name) ?? 0;
    const workers = this.deps.linkManagers?.(p.name, p.slackUserId, name) ?? 0;
    this.deps.record?.({ name: name ?? p.name, slackUserId: p.slackUserId, admin: p.admin }, `Linked the sign-in "${p.name}" to <@${p.slackUserId}> (${signIns} sign-in${signIns === 1 ? '' : 's'}, ${workers} worker${workers === 1 ? '' : 's'} managed).`);
    return { ok: true, name: name ?? p.name, was: p.name, signIns, workers };
  }

  /// "No, that's not me": the request goes, and nothing changes.
  linkSlackDecline(pressedBy: string, linkId: string): Result {
    const p = this.pendingLinks.get(linkId);
    if (p && pressedBy === p.slackUserId) this.pendingLinks.delete(linkId);
    return { ok: true };
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
      // The first-admin link is printed to the log, so it lives a day, not a week.
      expiresAt: now + (args.setup ? SETUP_TTL_MS : INVITE_TTL_MS),
      ...(args.setup ? { setup: true } : {}),
    };
    const link = `${baseUrl.replace(/\/+$/, '')}/join/${code}`;
    // A second invite for the same person replaces the first: one live link
    // each. Likewise one first-admin link: each start prints a new one.
    const replaced = (i: Invite) => !i.usedAt && ((!!slackUserId && i.slackUserId === slackUserId) || (!!args.setup && !!i.setup));
    this.deps.store.saveInvites([...this.deps.store.invites().filter((i) => !replaced(i)), invite]);
    let sentInSlack = false;
    if (slackUserId && this.deps.slack) sentInSlack = await this.deps.slack.dmInvite(invite, link, this.org());
    // Saved before the DM and marked after, from a fresh read: a link
    // redeemed or cancelled while Slack was answering stays that way.
    if (sentInSlack) this.deps.store.saveInvites(this.deps.store.invites().map((i) => (i.id === invite.id ? { ...i, sentInSlack } : i)));
    invite.sentInSlack = sentInSlack;
    if (!args.setup) this.deps.record?.(caller, `Invited ${name} as ${ROLE_NAME[args.role]}.`);
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
  inviteInfo(code: string): Result<{ org: string; name: string; invitedBy: string; role: PersonRole; roleText: string; allowanceUSD?: number; expiresAt: number; setup?: boolean; ssoRequired?: boolean; ssoProvider?: string }> {
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
      ...(this.deps.ssoRequired?.() ? { ssoRequired: true } : {}),
      ...(this.deps.ssoRequired?.() && this.deps.policy().sso ? { ssoProvider: new URL(this.deps.policy().sso!.issuer).hostname } : {}),
    };
  }

  /// Use an invite: apply its role, mint the person's token, spend the code.
  redeem(code: string, device = 'Browser'): Result<{ token: string; name: string; org: string }> {
    const invite = this.findInvite(code);
    if (!invite) return { ok: false, error: 'This invite has been used, has expired, or was never sent. Ask for a new one.' };
    if (this.deps.ssoRequired?.() && !invite.setup) {
      return { ok: false, error: 'This org signs in with its company sign-in. Open the console and press Sign in; your invite applies when you do.' };
    }
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

  /// A browser signed in through the identity provider. An invite waiting for
  /// this person is used up here, so its role applies; otherwise they come in
  /// with whatever role org.json already gives them.
  signInWithSso(person: { slackUserId: string; name: string; email: string }): { token: string } {
    const now = this.now();
    const all = this.deps.store.invites();
    const waiting = all.find((i) => i.slackUserId === person.slackUserId && !i.usedAt && i.expiresAt > now);
    if (waiting) {
      this.applyRole(person.slackUserId, waiting.role, waiting.allowanceUSD);
      waiting.usedAt = now;
      this.deps.store.saveInvites(all);
    }
    return this.deps.tokens.create({ name: person.name, slackUserId: person.slackUserId, device: 'Browser (company sign-in)' });
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
    this.deps.record?.(caller, `Made ${slackUserId} ${ROLE_NAME[role]}${allowanceUSD !== undefined ? `, allowance $${allowanceUSD}` : ''}.`);
    const now = personRole(this.deps.policy(), slackUserId);
    return now === role
      ? { ok: true, role: now }
      : { ok: true, role: now, note: 'Everyone in the org may hire (hirers is "*" in org.json), so this person can still hire.' };
  }

  /// Someone has left: every way in closed and every rule that names them
  /// cleared. Their workers are handed on first, by `OrgService.handOverAll`.
  removePerson(caller: OrgCaller, slackUserId: string): Result<{ signedOut: number }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    if (!isSlackUserId(slackUserId)) return { ok: false, error: 'That is not a Slack member ID.' };
    if (caller.slackUserId === slackUserId) return { ok: false, error: 'Someone else has to offboard you.' };
    const policy = this.deps.policy();
    if (policy.admins.length === 1 && policy.admins[0] === slackUserId) return { ok: false, error: 'They are the only admin. Make someone else an admin first.' };
    const signedOut = this.deps.tokens.revokeFor(slackUserId);
    this.deps.updateOrg((raw) => {
      for (const key of ['admins', 'approvers', 'hirers']) {
        if (Array.isArray(raw[key])) raw[key] = (raw[key] as string[]).filter((x) => x !== slackUserId);
      }
      if (raw.allowances && typeof raw.allowances === 'object') delete (raw.allowances as Record<string, unknown>)[slackUserId];
      if (raw.teams && typeof raw.teams === 'object') {
        for (const [team, members] of Object.entries(raw.teams as Record<string, unknown>)) {
          if (Array.isArray(members)) (raw.teams as Record<string, unknown>)[team] = members.filter((x) => x !== slackUserId);
        }
      }
      if (raw.people && typeof raw.people === 'object') {
        for (const [email, id] of Object.entries(raw.people as Record<string, unknown>)) {
          if (id === slackUserId) delete (raw.people as Record<string, unknown>)[email];
        }
      }
    });
    this.deps.store.saveInvites(this.deps.store.invites().filter((i) => i.slackUserId !== slackUserId));
    this.deps.store.saveRequests(this.deps.store.requests().filter((r) => r.slackUserId !== slackUserId));
    this.deps.record?.(caller, `Offboarded ${slackUserId}: signed out of ${signedOut} place${signedOut === 1 ? '' : 's'} and removed from the rules.`);
    return { ok: true, signedOut };
  }

  /// Whether anyone in the org's Slack gets in by asking.
  setOpenJoin(caller: OrgCaller, on: boolean): Result<{ openJoin: boolean }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    this.deps.updateOrg((raw) => {
      raw.openJoin = on;
    });
    this.deps.record?.(caller, on ? 'Let anyone in the Slack join by asking.' : 'Made joining need an admin again.');
    return { ok: true, openJoin: this.deps.policy().openJoin };
  }

  // ---- RULES ------------------------------------------------------------

  /// The rules as an admin edits them on the Admin page.
  rules(caller: OrgCaller): Result<{ rules: EditableRules }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    const p = this.deps.policy();
    return {
      ok: true,
      rules: {
        name: p.name ?? '',
        publicUrl: p.publicUrl ?? '',
        timezone: p.timezone ?? '',
        hirers: p.hirers,
        budgetAllowanceUSD: p.budgetAllowanceUSD,
        approvers: p.approvers,
        orgVisibilityNeedsAdmin: p.orgVisibilityNeedsAdmin,
        webNeedsApproval: p.webNeedsApproval,
        webFetch: p.webFetch,
        ownDomains: p.ownDomains,
        allowedMcpServers: p.allowedMcpServers ?? [],
        sharedMcpServers: p.sharedMcpServers ?? [],
        teams: p.teams,
        roles: p.roles,
        orgBudgetUSD: p.orgBudgetUSD ?? null,
        alertAtPercent: p.alertAtPercent,
        prSavedMultiplier: p.prSavedMultiplier,
        prSavedMinHours: p.prSavedMinHours,
        retentionDays: p.retentionDays ?? null,
        sso: p.sso ?? null,
        people: p.people,
        fleet: p.fleet,
        redactSecrets: p.redactSecrets,
        providerModels: p.providerModels ?? {},
        claudeModels: [...PREMIUM_MODELS.claude],
        modelProvider: modelProvider(),
        workerAccess: p.workerAccess ?? null,
        accessServer: accessServer(),
        accessRefusals: refusalSummary(),
      },
    };
  }

  /// Change some rules. Each key is checked the way org.json is read; a
  /// value that would not survive the reading is refused, not written, so
  /// the console can never save a rule that quietly falls back to a default.
  /// `null` removes an optional rule.
  setRules(caller: OrgCaller, patch: Record<string, unknown>): Result<{ rules: EditableRules }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    const keys = Object.keys(patch).filter((k) => (EDITABLE_RULES as readonly string[]).includes(k));
    if (!keys.length) return { ok: false, error: 'Nothing to change.' };
    let refused: string | null = null;
    this.deps.updateOrg((raw) => {
      const next: Record<string, unknown> = { ...raw };
      for (const k of keys) {
        const v = patch[k];
        if (v === null || v === '') delete next[k];
        else next[k] = v;
      }
      const { warnings } = parseOrgPolicy(next);
      const mine = warnings.filter((w) => keys.some((k) => w.startsWith(k) || w.includes(` ${k} `)));
      if (mine.length) {
        refused = mine.join(' ');
        return;
      }
      for (const k of keys) {
        if (k in next) raw[k] = next[k];
        else delete raw[k];
      }
    });
    if (refused) return { ok: false, error: refused };
    this.deps.record?.(caller, `Changed the rules: ${keys.join(', ')}.`);
    return this.rules(caller);
  }

  signOutEverywhere(caller: OrgCaller, slackUserId: string): Result<{ count: number }> {
    const denied = this.requireAdmin(caller);
    if (denied) return { ok: false, error: denied };
    if (caller.slackUserId === slackUserId) return { ok: false, error: 'Sign yourself out from your own devices instead.' };
    const count = this.deps.tokens.revokeFor(slackUserId);
    this.deps.record?.(caller, `Signed ${slackUserId} out everywhere.`);
    return { ok: true, count };
  }

  /// Sign out one place. Your own any time; anyone's as an admin.
  /// A key of the caller's own for one tool (Claude Code, Codex, a script),
  /// listed among their sign-ins so it can be signed out on its own.
  createDeviceKey(caller: OrgCaller, device: string): Result<{ token: string }> {
    const label = device.trim().slice(0, 40) || 'A tool';
    // An admin not known in Slack (signed in with the first-admin link, no
    // Slack) gets an admin key: they could invite themselves one anyway.
    if (!caller.slackUserId) {
      if (!caller.admin) return { ok: false, error: 'Only people signed in through Slack, or admins, can make keys. Ask an admin for a service token.' };
      return { ok: true, token: this.deps.tokens.create({ name: caller.name, admin: true, device: label }).token };
    }
    const { token } = this.deps.tokens.create({ name: caller.name, slackUserId: caller.slackUserId, device: label });
    return { ok: true, token };
  }

  signOutDevice(caller: OrgCaller, tokenId: string): Result {
    const token = this.deps.tokens.list().find((t) => t.id === tokenId);
    if (!token) return { ok: false, error: 'No sign-in with that id.' };
    const own = !!caller.slackUserId && token.slackUserId === caller.slackUserId;
    if (!own && !isAdmin(this.deps.policy(), caller)) return { ok: false, error: 'Only admins can sign other people out.' };
    this.deps.tokens.revoke(tokenId);
    return { ok: true };
  }

  // ---- JOIN REQUESTS ----------------------------------------------------

  /// `/overgo join` in Slack. Slack has already said who this is.
  async requestJoin(person: { slackUserId: string; name: string }, baseUrl: string): Promise<Result<{ outcome: 'invited' | 'asked' | 'already' }>> {
    if (!isSlackUserId(person.slackUserId)) return { ok: false, error: 'Not a Slack member.' };
    const policy = this.deps.policy();
    const known = this.deps.tokens.list().some((t) => t.slackUserId === person.slackUserId) || personRole(policy, person.slackUserId) !== 'member';
    if ((policy.openJoin || known) && !baseUrl) {
      return { ok: false, error: 'This org hasn’t told overgo its web address yet, so there’s no link to send. Ask an admin to set it (publicUrl in org.json).' };
    }
    if (policy.openJoin) {
      const role: PersonRole = personRole(policy, person.slackUserId);
      const made = await this.invite({ name: 'Slack', admin: true }, { name: person.name, slackUserId: person.slackUserId, role }, baseUrl);
      return made.ok ? { ok: true, outcome: 'invited' } : made;
    }
    // Someone already in — lost their link, new browser — gets a fresh one at
    // the role they have: Slack has already said who they are.
    if (known) {
      const made = await this.invite({ name: 'Slack', admin: true }, { name: person.name, slackUserId: person.slackUserId, role: personRole(policy, person.slackUserId) }, baseUrl);
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
