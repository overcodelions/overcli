import { describe, expect, it } from 'vitest';

import { AccessService } from '../../main/org/accessService';
import { parseOrgPolicy, type OrgCaller } from './policy';
import { STARTER_ROLES, asCatalogRole, starterRole } from './starterRoles';

const admin: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };
const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

function harness(start: Record<string, unknown>) {
  let raw = start;
  const recorded: string[] = [];
  const svc = new AccessService({
    policy: () => parseOrgPolicy(raw).policy,
    store: { invites: () => [], saveInvites: () => {}, requests: () => [], saveRequests: () => {} },
    tokens: { create: () => ({ token: 't' }), revokeFor: () => 0, revoke: () => false, list: () => [] },
    updateOrg: (mutate) => {
      const copy = structuredClone(raw);
      mutate(copy);
      raw = copy;
    },
    record: (_c, what) => recorded.push(what),
  });
  return { svc, raw: () => raw, recorded };
}

describe('starter roles', () => {
  it('are valid catalog roles', () => {
    expect(STARTER_ROLES.map((r) => r.name)).toEqual(['Developer', 'QA', 'Analyst', 'PR Fixer', 'Test Automation']);
    const { policy, warnings } = parseOrgPolicy({ name: 'Acme', admins: [], roles: STARTER_ROLES.map(asCatalogRole) });
    expect(warnings).toEqual([]);
    expect(policy.roles).toHaveLength(5);
    // The PR Fixer's catalog entry keeps what makes it one.
    expect(policy.roles.find((r) => r.name === 'PR Fixer')?.teamPullRequests).toBe(true);
    expect(policy.roles.find((r) => r.name === 'Developer')).not.toHaveProperty('teamPullRequests');
    expect(starterRole('qa')?.tools).toEqual(['test-systems']);
    expect(starterRole('analyst')?.tools).toEqual(['overdb']);
    expect(asCatalogRole(STARTER_ROLES[1])).not.toHaveProperty('pitch');
  });

  it('are added to the catalog by an admin, once, as the org’s own role', () => {
    const h = harness({ name: 'Acme', admins: ['U0ACMEBOSS'], roles: [{ name: 'Writer', job: 'Writes the release notes each week.', tools: [], budgetUSDPerMonth: 20 }] });
    expect(h.svc.starterRoles().roles.map((r) => [r.name, r.inCatalog])).toEqual([['Developer', false], ['QA', false], ['Analyst', false], ['PR Fixer', false], ['Test Automation', false]]);
    expect(h.svc.addStarterRole(admin, 'qa')).toEqual({ ok: true, role: 'QA' });
    expect((h.raw().roles as Array<{ name: string }>).map((r) => r.name)).toEqual(['Writer', 'QA']);
    expect(h.svc.starterRoles().roles.find((r) => r.name === 'QA')?.inCatalog).toBe(true);
    expect(h.svc.addStarterRole(admin, 'QA')).toMatchObject({ ok: false });
    expect(h.recorded).toEqual(['Added the starter role QA to the role catalog.']);
  });

  it('are refused to anyone but an admin, and by a name that isn’t one', () => {
    const h = harness({ name: 'Acme', admins: ['U0ACMEBOSS'] });
    expect(h.svc.addStarterRole(pat, 'Developer')).toMatchObject({ ok: false });
    expect(h.svc.addStarterRole(admin, 'Astronaut')).toMatchObject({ ok: false });
    expect(h.raw().roles).toBeUndefined();
  });
});
