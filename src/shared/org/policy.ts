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

import type { UUID } from '../types';
import type { Worker, WorkerVisibility } from '../flows/worker';
import { isSlackUserId } from '../flows/worker';
import { managerFor } from '../flows/org';

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
  /// Whether making a worker visible to the whole org needs an admin.
  orgVisibilityNeedsAdmin: boolean;
  /// Anyone in the org's Slack who asks (`/overcli join`) gets in straight
  /// away, as someone who can ask workers things. Off: an admin lets them in.
  openJoin: boolean;
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
  openJoin: false,
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
      orgVisibilityNeedsAdmin: r.orgVisibilityNeedsAdmin !== false,
      openJoin: r.openJoin === true,
    },
    warnings,
  };
}

export function isAdmin(policy: OrgPolicy, caller: OrgCaller): boolean {
  return caller.admin || (!!caller.slackUserId && policy.admins.includes(caller.slackUserId));
}

type RosterWorker = Pick<Worker, 'id' | 'reportsTo' | 'enabled' | 'manager' | 'visibility'>;

/// The person a worker answers to — its own manager, or the nearest one up
/// the chain. Managing a worker means being that person.
export function managesWorker(roster: readonly RosterWorker[], workerId: UUID, caller: OrgCaller): boolean {
  if (!caller.slackUserId) return false;
  return managerFor(roster, workerId)?.slackUserId === caller.slackUserId;
}

export function canManage(policy: OrgPolicy, roster: readonly RosterWorker[], workerId: UUID, caller: OrgCaller): boolean {
  return isAdmin(policy, caller) || managesWorker(roster, workerId, caller);
}

function sharesTeam(policy: OrgPolicy, a: string, b: string): boolean {
  return Object.values(policy.teams).some((members) => members.includes(a) && members.includes(b));
}

/// Who may see a worker and ask it things.
export function canSee(policy: OrgPolicy, roster: readonly RosterWorker[], workerId: UUID, caller: OrgCaller): boolean {
  if (canManage(policy, roster, workerId, caller)) return true;
  const worker = roster.find((w) => w.id === workerId);
  if (!worker) return false;
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
export function committedBudget(roster: readonly Pick<Worker, 'manager' | 'budgetUSDPerMonth' | 'enabled'>[], slackUserId: string): number {
  return roster
    .filter((w) => w.enabled && w.manager?.slackUserId === slackUserId)
    .reduce((sum, w) => sum + (Number.isFinite(w.budgetUSDPerMonth) ? w.budgetUSDPerMonth : 0), 0);
}

export function allowanceFor(policy: OrgPolicy, slackUserId: string): number {
  return policy.allowances[slackUserId] ?? policy.budgetAllowanceUSD;
}

/// Whether a hire may go ahead now or needs an approver, and why.
export function hireDecision(
  policy: OrgPolicy,
  roster: readonly Pick<Worker, 'manager' | 'budgetUSDPerMonth' | 'enabled'>[],
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
  const allowed = [...(policy.allowedMcpServers ?? []), ...(hire.role?.tools ?? [])];
  const extra = (hire.mcpServers ?? []).filter((s) => !allowed.includes(s));
  if (extra.length) reasons.push(`It asks for connectors not cleared for workers: ${extra.join(', ')}.`);
  return reasons.length ? { kind: 'needsApproval', reasons } : { kind: 'allowed' };
}

/// Who gets asked about a hire that needs approval.
export function approversFor(policy: OrgPolicy): string[] {
  return policy.approvers.length ? policy.approvers : policy.admins;
}
