// Who in the org may do what with the workers.
//
// The desktop app never needed this: one person, one roster, every action
// theirs. Once workers live on a shared box and anyone can reach them through
// Slack or MCP, every action needs an answer to "may this person do that?".
// This module is that answer, as pure functions over a policy file the
// operator writes (`<state dir>/org.json`) and the roster as it is.
//
// The default is narrow on purpose. With no policy file, a remote caller can
// see workers that are visible to everyone and manage the ones they manage —
// and nobody can hire. Opening hiring is a decision someone writes down.

import { ACCESS_LEVELS, commandGrant, type AccessLevel, type WorkerAccess } from './access';
import type { UUID } from '../types';
import type { Worker, WorkerVisibility } from '../flows/worker';
import { isSlackUserId } from '../flows/worker';
import { managerFor } from '../flows/org';
import { parseToolScope, type ToolScopes } from '../flows/toolScope';

/// A role the org has approved for hiring: a known job, a known cost, and
/// tools cleared in advance. Hiring from one skips the drafter's interview,
/// and its tools need no approver even when they are not on the org-wide
/// cleared list.
export interface OrgRole {
  name: string;
  /// The job, as it would be typed into the hire box.
  job: string;
  /// MCP servers this role may have without approval.
  tools: string[];
  budgetUSDPerMonth: number;
}

export interface OrgPolicy {
  /// The org's name, shown in the console, Slack messages and MCP. Absent:
  /// "your org".
  name?: string;
  /// The Slack workspace this org is. The bridge refuses a bot token from any
  /// other, so a box set up for one org never answers another's people.
  slackTeamId?: string;
  /// The address people reach the console at, e.g.
  /// https://overcli.acme.internal:7420. Links sent from Slack (invites) are
  /// built on it, since a Slack event cannot say where the console lives.
  publicUrl?: string;
  /// IANA zone for "today" and schedules shown to people, e.g.
  /// America/New_York. Absent: the server's own.
  timezone?: string;
  /// The approved role catalog.
  roles: OrgRole[];
  /// Slack member ids that may do anything: hire past allowances, manage any
  /// worker, widen visibility, decide pending hires.
  admins: string[];
  /// Who may hire. `'*'` is everyone who can reach the server.
  hirers: '*' | string[];
  /// What one person's workers may cost each month in total before a new
  /// hire needs an approver. Zero means every hire needs one.
  budgetAllowanceUSD: number;
  /// Per-person allowances that override `budgetAllowanceUSD`.
  allowances: Record<string, number>;
  /// Who decides hires over an allowance. Empty falls back to the admins.
  approvers: string[];
  /// Named groups of people, for `visibility: 'team'`: a worker is visible
  /// to everyone who shares a team with its manager.
  teams: Record<string, string[]>;
  /// MCP servers a hire may be granted without an admin. Absent: none — a
  /// hire starts with no connectors and someone grants them by hand.
  allowedMcpServers?: string[];
  /// MCP servers every worker gets, without anyone giving them — tools that
  /// read, mostly. Absent: none.
  sharedMcpServers?: string[];
  /// How much of each tool a worker gets unless its own scope says
  /// otherwise, by tool name (toolScope.ts). Absent: the whole tool.
  toolDefaults?: ToolScopes;
  /// Whether making a worker visible to the whole org needs an admin.
  orgVisibilityNeedsAdmin: boolean;
  /// Whether a worker on the org's server must ask before it reads the web
  /// (WebSearch, WebFetch). Off by default: research is most of what
  /// workers do, and a manager asked before every page stops reading them.
  /// On for a server whose network can reach things the web must not (see
  /// docs/security.md).
  webNeedsApproval: boolean;
  /// How workers open web pages (WebFetch): `ask` before each step that
  /// does, `safe` without asking when the address came from the ask, a
  /// search result or a page it read (src/main/safeFetch.ts), `any` freely.
  /// From `webNeedsApproval` when unset (true: ask, false: any), else safe.
  webFetch: WebFetchMode;
  /// Tools whose keys belong to a service account rather than a person, as
  /// an admin said: no "acts as a person" warning on them.
  serviceAccounts?: string[];
  /// The org's own sites (`acme.atlassian.net`, `wiki.acme.com`): a safe
  /// fetch opens them, and the pages under them, whatever the address.
  ownDomains: string[];
  /// Anyone in the org's Slack who asks (`/overgo join`) gets in straight
  /// away, as someone who can ask workers things. Off: an admin lets them in.
  openJoin: boolean;
  /// Scrub credentials (passwords, AWS keys, tokens, the server's stored
  /// secrets) out of everything a worker says to people: Slack, the console's
  /// answers, notifications. On unless an admin turns it off.
  redactSecrets: boolean;
  /// What workers may do on the server (Setup → Workers → Permissions).
  /// Absent: what `overcli serve --allow-tool` says, as before.
  workerAccess?: WorkerAccess;
  /// Model ids as the server's provider names them (Bedrock, Vertex), by the
  /// id overcli knows: `{ "claude-opus-5-5": "us.anthropic.claude-opus-5-5" }`.
  /// Absent ones are translated by rule (`providerModelId`).
  providerModels?: Record<string, string>;
  /// What every worker together may cost in a month. Past it, scheduled runs
  /// stop until the month turns or someone raises it. Absent: no org cap,
  /// only each worker's own budget.
  orgBudgetUSD?: number;
  /// Tell a worker's manager (and the admins, for the org cap) when spend
  /// passes this share of a budget. 0 turns the warnings off.
  alertAtPercent: number;
  /// Keep the decision log and finished runs this many days. Absent: forever.
  retentionDays?: number;
  /// Sign in with the company's identity provider (OpenID Connect).
  sso?: OrgSso;
  /// Who is who by work email, for SSO: email → Slack member id. People not
  /// listed are looked up in Slack by email when the bot may.
  people: Record<string, string>;
  /// Other overcli servers in the company, shown together on Admin.
  fleet: Array<{ name: string; url: string }>;
}

export interface OrgSso {
  /// The provider's issuer URL, e.g. https://acme.okta.example or
  /// https://login.microsoftonline.com/<tenant>/v2.0.
  issuer: string;
  clientId: string;
  /// Only these email domains may sign in. Empty: any the provider vouches for.
  allowedDomains: string[];
  /// Sign-in links and pasted tokens stop working in the browser; everyone
  /// signs in through the provider. Scripts' tokens still work.
  required: boolean;
}

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  roles: [],
  admins: [],
  hirers: [],
  budgetAllowanceUSD: 0,
  allowances: {},
  approvers: [],
  teams: {},
  orgVisibilityNeedsAdmin: true,
  webNeedsApproval: false,
  webFetch: 'safe',
  ownDomains: [],
  openJoin: false,
  redactSecrets: true,
  alertAtPercent: 80,
  people: {},
  fleet: [],
};

/// The person (or program) behind a call.
export interface OrgCaller {
  /// The Slack member id, which is how the org layer knows people. Absent for
  /// a service token that is not anyone in Slack.
  slackUserId?: string;
  name: string;
  /// Granted by a token minted with `--admin`, or by `OrgPolicy.admins`.
  admin: boolean;
}

export type WebFetchMode = 'ask' | 'safe' | 'any';

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
}

/// Read a policy file's JSON into a policy, keeping what is well-formed and
/// reporting the rest. A typo must not silently open hiring to everyone, so a
/// malformed field falls back to its NARROW default, never a wide one.
export function parseOrgPolicy(raw: unknown): { policy: OrgPolicy; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: { ...DEFAULT_ORG_POLICY }, warnings: ['The org policy is not a JSON object; using the defaults.'] };
  }
  const r = raw as Record<string, unknown>;
  const ids = (key: string): string[] => {
    const list = strings(r[key]);
    for (const id of list) if (!isSlackUserId(id)) warnings.push(`${key}: "${id}" is not a Slack member id.`);
    return list.filter(isSlackUserId);
  };
  const hirers: OrgPolicy['hirers'] = r.hirers === '*' ? '*' : ids('hirers');
  const num = (key: string, fallback: number): number => {
    const v = r[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      warnings.push(`${key} must be a number of dollars, zero or more.`);
      return fallback;
    }
    return v;
  };
  const allowances: Record<string, number> = {};
  if (r.allowances && typeof r.allowances === 'object') {
    for (const [id, v] of Object.entries(r.allowances as Record<string, unknown>)) {
      if (isSlackUserId(id) && typeof v === 'number' && Number.isFinite(v) && v >= 0) allowances[id] = v;
      else warnings.push(`allowances: "${id}" needs a Slack member id and a dollar amount.`);
    }
  }
  const teams: Record<string, string[]> = {};
  if (r.teams && typeof r.teams === 'object') {
    for (const [name, members] of Object.entries(r.teams as Record<string, unknown>)) {
      teams[name] = strings(members).filter(isSlackUserId);
    }
  }
  const text = (key: string, max: number): string | undefined => {
    const v = r[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.length > max) {
      warnings.push(`${key} must be text of at most ${max} characters.`);
      return undefined;
    }
    return v.trim();
  };
  let slackTeamId = text('slackTeamId', 20);
  if (slackTeamId && !/^[TE][A-Z0-9]{6,}$/.test(slackTeamId)) {
    warnings.push(`slackTeamId "${slackTeamId}" is not a Slack workspace id (T…).`);
    slackTeamId = undefined;
  }
  let publicUrl = text('publicUrl', 200);
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      publicUrl = `${u.protocol}//${u.host}`;
    } catch {
      warnings.push(`publicUrl "${publicUrl}" is not a web address.`);
      publicUrl = undefined;
    }
  }
  let timezone = text('timezone', 60);
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      warnings.push(`timezone "${timezone}" is not a time zone this server knows.`);
      timezone = undefined;
    }
  }
  const roles: OrgRole[] = [];
  if (r.roles !== undefined) {
    if (!Array.isArray(r.roles)) warnings.push('roles must be a list.');
    else {
      for (const raw of r.roles as unknown[]) {
        const role = raw as Record<string, unknown>;
        const name = typeof role?.name === 'string' ? role.name.trim() : '';
        const job = typeof role?.job === 'string' ? role.job.trim() : '';
        const budget = role?.budgetUSDPerMonth;
        if (!name || job.length < 20 || typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
          warnings.push(`roles: "${name || '(unnamed)'}" needs a name, a job of a sentence or more, and a budgetUSDPerMonth above zero.`);
          continue;
        }
        roles.push({ name, job, tools: strings(role.tools), budgetUSDPerMonth: budget });
      }
    }
  }
  const orgBudget = r.orgBudgetUSD === undefined ? undefined : num('orgBudgetUSD', 0) || undefined;
  const alertAt = num('alertAtPercent', 80);
  if (alertAt > 100) warnings.push('alertAtPercent must be between 0 and 100.');
  let retentionDays: number | undefined;
  if (r.retentionDays !== undefined) {
    const v = r.retentionDays;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 7) retentionDays = v;
    else warnings.push('retentionDays must be a whole number of days, 7 or more.');
  }
  let sso: OrgSso | undefined;
  if (r.sso !== undefined) {
    const o = (r.sso ?? {}) as Record<string, unknown>;
    let issuer = typeof o.issuer === 'string' ? o.issuer.trim().replace(/\/+$/, '') : '';
    try {
      if (new URL(issuer).protocol !== 'https:') issuer = '';
    } catch {
      issuer = '';
    }
    const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : '';
    if (!issuer || !clientId) warnings.push('sso needs an https issuer and a clientId.');
    else sso = { issuer, clientId, allowedDomains: strings(o.allowedDomains).map((d) => d.toLowerCase().replace(/^@/, '')), required: o.required === true };
  }
  const people: Record<string, string> = {};
  if (r.people && typeof r.people === 'object' && !Array.isArray(r.people)) {
    for (const [email, id] of Object.entries(r.people as Record<string, unknown>)) {
      if (/^[^@\s]+@[^@\s]+$/.test(email) && typeof id === 'string' && isSlackUserId(id)) people[email.toLowerCase()] = id;
      else warnings.push(`people: "${email}" needs a work email and a Slack member id.`);
    }
  }
  const fleet: Array<{ name: string; url: string }> = [];
  if (Array.isArray(r.fleet)) {
    for (const raw of r.fleet as unknown[]) {
      const f = (raw ?? {}) as Record<string, unknown>;
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      try {
        const u = new URL(typeof f.url === 'string' ? f.url : '');
        if (!name || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error('bad');
        fleet.push({ name, url: `${u.protocol}//${u.host}` });
      } catch {
        warnings.push(`fleet: "${name || '(unnamed)'}" needs a name and a web address.`);
      }
    }
  }
  return {
    policy: {
      ...(text('name', 80) ? { name: text('name', 80) } : {}),
      ...(slackTeamId ? { slackTeamId } : {}),
      ...(timezone ? { timezone } : {}),
      ...(publicUrl ? { publicUrl } : {}),
      roles,
      admins: ids('admins'),
      hirers,
      budgetAllowanceUSD: num('budgetAllowanceUSD', 0),
      allowances,
      approvers: ids('approvers'),
      teams,
      ...(r.allowedMcpServers !== undefined ? { allowedMcpServers: strings(r.allowedMcpServers) } : {}),
      ...(r.sharedMcpServers !== undefined ? { sharedMcpServers: strings(r.sharedMcpServers) } : {}),
      ...(r.serviceAccounts !== undefined ? { serviceAccounts: strings(r.serviceAccounts) } : {}),
      ...(() => {
        const raw = r.toolDefaults && typeof r.toolDefaults === 'object' ? (r.toolDefaults as Record<string, unknown>) : {};
        const out: ToolScopes = {};
        for (const [name, v] of Object.entries(raw)) {
          const scope = parseToolScope(v);
          if (scope && scope.mode !== 'full' && /^[A-Za-z0-9 ._-]{1,80}$/.test(name)) out[name] = scope;
        }
        return Object.keys(out).length ? { toolDefaults: out } : {};
      })(),
      orgVisibilityNeedsAdmin: r.orgVisibilityNeedsAdmin !== false,
      ...(() => {
        const set = r.webFetch === 'ask' || r.webFetch === 'safe' || r.webFetch === 'any' ? r.webFetch : undefined;
        if (r.webFetch !== undefined && !set) warnings.push('webFetch must be "ask", "safe" or "any".');
        const webFetch: WebFetchMode = set ?? (r.webNeedsApproval === true ? 'ask' : r.webNeedsApproval === false ? 'any' : 'safe');
        return { webFetch, webNeedsApproval: webFetch === 'ask' };
      })(),
      ownDomains: strings(r.ownDomains).filter((d) => {
        const ok = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(d);
        if (!ok) warnings.push(`ownDomains: "${d}" is not a site name like acme.atlassian.net.`);
        return ok;
      }),
      openJoin: r.openJoin === true,
      redactSecrets: r.redactSecrets !== false,
      ...(() => {
        if (r.workerAccess === undefined) return {};
        const a = r.workerAccess && typeof r.workerAccess === 'object' && !Array.isArray(r.workerAccess) ? (r.workerAccess as Record<string, unknown>) : null;
        if (!a || !ACCESS_LEVELS.includes(a.level as AccessLevel)) {
          warnings.push('workerAccess needs a level: read, standard, shell or everything.');
          return {};
        }
        const commands = strings(a.commands);
        for (const c of commands) if (!commandGrant(c)) warnings.push(`workerAccess: "${c}" is not a command to allow (no ; | & $ ( ) or redirects).`);
        const tools = strings(a.tools);
        for (const t of tools) if (!/^[\w.-]{1,120}$/.test(t)) warnings.push(`workerAccess: "${t}" is not a tool name.`);
        return { workerAccess: { level: a.level as AccessLevel, commands: commands.filter((c) => commandGrant(c)), tools: tools.filter((t) => /^[\w.-]{1,120}$/.test(t)) } };
      })(),
      ...(() => {
        if (r.providerModels === undefined) return {};
        const out: Record<string, string> = {};
        const raw = r.providerModels && typeof r.providerModels === 'object' && !Array.isArray(r.providerModels) ? (r.providerModels as Record<string, unknown>) : null;
        if (!raw) warnings.push('providerModels must map model ids to the provider\'s ids.');
        for (const [from, to] of Object.entries(raw ?? {})) {
          if (typeof to === 'string' && /^[\w.:@/-]{1,200}$/.test(to.trim()) && /^[\w.:@-]{1,100}$/.test(from)) out[from] = to.trim();
          else warnings.push(`providerModels: "${from}" needs a model id like us.anthropic.claude-opus-5-5.`);
        }
        return Object.keys(out).length ? { providerModels: out } : {};
      })(),
      ...(orgBudget ? { orgBudgetUSD: orgBudget } : {}),
      alertAtPercent: Math.min(alertAt, 100),
      ...(retentionDays ? { retentionDays } : {}),
      ...(sso ? { sso } : {}),
      people,
      fleet,
    },
    warnings,
  };
}

export function isAdmin(policy: OrgPolicy, caller: OrgCaller): boolean {
  return caller.admin || (!!caller.slackUserId && policy.admins.includes(caller.slackUserId));
}

type RosterWorker = Pick<Worker, 'id' | 'reportsTo' | 'enabled' | 'manager' | 'visibility'> & Partial<Pick<Worker, 'audience'>>;

/// The person a worker answers to — its own manager, or the nearest one up
/// the chain. Managing a worker means being that person.
export function managesWorker(roster: readonly RosterWorker[], workerId: UUID, caller: OrgCaller): boolean {
  if (!caller.slackUserId) return false;
  return managerFor(roster, workerId)?.slackUserId === caller.slackUserId;
}

export function canManage(policy: OrgPolicy, roster: readonly RosterWorker[], workerId: UUID, caller: OrgCaller): boolean {
  return isAdmin(policy, caller) || managesWorker(roster, workerId, caller);
}

export function sharesTeam(policy: OrgPolicy, a: string, b: string): boolean {
  return Object.values(policy.teams).some((members) => members.includes(a) && members.includes(b));
}

// ---- AUDIENCES ------------------------------------------------------------

/// Roles a worker, team or idea can be opened to, beside people and groups.
export type AudienceRole = 'admin' | 'approver' | 'hirer';
export const AUDIENCE_ROLES: Array<[AudienceRole, string]> = [
  ['admin', 'Admins'],
  ['approver', 'Hire approvers'],
  ['hirer', 'People who can hire'],
];

/// Who a worker, team or idea is open to when it's picked rather than "only
/// its manager" or "everyone": any of these people (Slack ids), anyone in
/// these groups (`team:<name>`, the org's people teams) or with these roles.
/// Read live, so joining a group or gaining a role gains access with it.
export interface Audience {
  people?: string[];
  groups?: string[];
  roles?: AudienceRole[];
}

export function inAudience(policy: OrgPolicy, caller: OrgCaller, a: Audience): boolean {
  const roles = a.roles ?? [];
  if (roles.includes('admin') && isAdmin(policy, caller)) return true;
  const id = caller.slackUserId;
  if (!id) return false;
  if ((a.people ?? []).includes(id)) return true;
  if ((a.groups ?? []).some((g) => g.startsWith('team:') && (policy.teams[g.slice(5)] ?? []).includes(id))) return true;
  if (roles.includes('approver') && approversFor(policy).includes(id)) return true;
  if (roles.includes('hirer') && (policy.hirers === '*' || policy.hirers.includes(id))) return true;
  return false;
}

/// An audience from a request, or an error saying what's wrong with it.
export function parseAudience(raw: unknown): { ok: true; audience: Audience } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Pick who can use it.' };
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : []);
  const people = list(r.people);
  const groups = list(r.groups);
  const roles = list(r.roles);
  if (people.some((p) => !isSlackUserId(p))) return { ok: false, error: 'People are picked by their Slack member id.' };
  if (groups.some((g) => !/^team:.{1,80}$/.test(g))) return { ok: false, error: 'That isn’t one of the org’s groups.' };
  if (roles.some((x) => !AUDIENCE_ROLES.some(([k]) => k === x))) return { ok: false, error: 'Roles are admins, hire approvers or people who can hire.' };
  if (people.length + groups.length + roles.length > 200) return { ok: false, error: 'That’s too many to pick one by one: pick a group instead.' };
  return { ok: true, audience: { ...(people.length ? { people } : {}), ...(groups.length ? { groups } : {}), ...(roles.length ? { roles: roles as AudienceRole[] } : {}) } };
}

/// Who may see a worker and ask it things.
export function canSee(policy: OrgPolicy, roster: readonly RosterWorker[], workerId: UUID, caller: OrgCaller): boolean {
  if (canManage(policy, roster, workerId, caller)) return true;
  const worker = roster.find((w) => w.id === workerId);
  if (!worker) return false;
  // Picked people, groups or roles, when set, say it all.
  if (worker.audience) return inAudience(policy, caller, worker.audience);
  const visibility: WorkerVisibility = worker.visibility ?? 'private';
  if (visibility === 'org') return true;
  if (visibility === 'team') {
    const boss = managerFor(roster, workerId)?.slackUserId;
    return !!boss && !!caller.slackUserId && sharesTeam(policy, boss, caller.slackUserId);
  }
  return false;
}

export function canHire(policy: OrgPolicy, caller: OrgCaller): boolean {
  if (isAdmin(policy, caller)) return true;
  if (!caller.slackUserId) return false;
  return policy.hirers === '*' || policy.hirers.includes(caller.slackUserId);
}

/// What a person's workers already cost a month: every worker whose OWN
/// manager is them. A worker that only inherits them through a boss counts
/// against whoever manages that boss's branch directly — the person who
/// hired it.
/// What a person's workers may spend a month: every worker they answer for,
/// directly or up the reporting chain. Paused ones count too — pausing one to
/// fit another hire, then resuming it, must not slip past the allowance.
export function committedBudget(roster: readonly Pick<Worker, 'id' | 'manager' | 'reportsTo' | 'budgetUSDPerMonth' | 'enabled'>[], slackUserId: string): number {
  return roster
    .filter((w) => managerFor(roster, w.id)?.slackUserId === slackUserId)
    .reduce((sum, w) => sum + (Number.isFinite(w.budgetUSDPerMonth) ? w.budgetUSDPerMonth : 0), 0);
}

export function allowanceFor(policy: OrgPolicy, slackUserId: string): number {
  return policy.allowances[slackUserId] ?? policy.budgetAllowanceUSD;
}

/// Whether a hire may go ahead now or needs an approver, and why.
export function hireDecision(
  policy: OrgPolicy,
  roster: readonly Pick<Worker, 'id' | 'manager' | 'reportsTo' | 'budgetUSDPerMonth' | 'enabled'>[],
  caller: OrgCaller,
  hire: { budgetUSDPerMonth: number; visibility?: WorkerVisibility; mcpServers?: string[]; role?: OrgRole },
): { kind: 'allowed' } | { kind: 'needsApproval'; reasons: string[] } | { kind: 'refused'; reason: string } {
  if (!canHire(policy, caller)) {
    return { kind: 'refused', reason: 'You are not on the list of people who may hire workers. Ask an admin to add you to the org policy.' };
  }
  if (isAdmin(policy, caller)) return { kind: 'allowed' };
  const reasons: string[] = [];
  const allowance = allowanceFor(policy, caller.slackUserId!);
  const after = committedBudget(roster, caller.slackUserId!) + hire.budgetUSDPerMonth;
  if (after > allowance) {
    reasons.push(`The requester's workers would cost $${after.toFixed(0)}/month, over their $${allowance.toFixed(0)} allowance.`);
  }
  if (hire.visibility === 'org' && policy.orgVisibilityNeedsAdmin) {
    reasons.push('Making a worker visible to the whole org needs an admin.');
  }
  const allowed = [...(policy.allowedMcpServers ?? []), ...(policy.sharedMcpServers ?? []), ...(hire.role?.tools ?? [])];
  const extra = (hire.mcpServers ?? []).filter((s) => !allowed.includes(s));
  if (extra.length) reasons.push(`It asks for connectors not cleared for workers: ${extra.join(', ')}.`);
  return reasons.length ? { kind: 'needsApproval', reasons } : { kind: 'allowed' };
}

/// Who gets asked about a hire that needs approval.
export function approversFor(policy: OrgPolicy): string[] {
  return policy.approvers.length ? policy.approvers : policy.admins;
}
