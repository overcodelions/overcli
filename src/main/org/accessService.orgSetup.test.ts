import { describe, expect, it } from 'vitest';
import { parseOrgPolicy, type OrgCaller } from '../../shared/org/policy';
import { AccessService } from './accessService';

const linkedAdmin: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };
const firstAdmin: OrgCaller = { name: 'Admin', admin: true };
const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

function harness(start: Record<string, unknown> | null, team: string | null = null) {
  let raw: Record<string, unknown> | null = start;
  const recorded: string[] = [];
  const svc = new AccessService({
    policy: () => parseOrgPolicy(raw ?? {}).policy,
    store: { invites: () => [], saveInvites: () => {}, requests: () => [], saveRequests: () => {} },
    tokens: { create: () => ({ token: 't' }), revokeFor: () => 0, revoke: () => false, list: () => [], link: () => 1 },
    updateOrg: (mutate) => {
      const copy = structuredClone(raw ?? {});
      mutate(copy);
      raw = copy;
    },
    orgFileExists: () => raw !== null,
    slackTeamId: () => team,
    record: (_c, what) => recorded.push(what),
  });
  return { svc, raw: () => raw, recorded, setTeam: (t: string | null) => (team = t) };
}

describe('setting up who the org is from the console', () => {
  it('writes a new org.json that starts narrow, from the first admin with no Slack yet', () => {
    const h = harness(null);
    const view = h.svc.orgSetup(firstAdmin);
    expect(view.ok && view.org).toMatchObject({ exists: false, slackConnectedTo: null, meInSlack: false });

    const res = h.svc.setupOrg(firstAdmin, { name: ' Acme ', timezone: 'America/New_York', publicUrl: 'https://overgo.acme.internal/' });
    expect(res.ok && res.org).toMatchObject({ exists: true, name: 'Acme', timezone: 'America/New_York', publicUrl: 'https://overgo.acme.internal' });
    expect(h.raw()).toMatchObject({ name: 'Acme', hirers: [], budgetAllowanceUSD: 50, approvers: [], roles: [], admins: [] });
    expect(h.raw()).not.toHaveProperty('slackTeamId');
    expect(h.recorded).toEqual(['Set up the org: Acme.']);
  });

  it('pins the connected Slack workspace and adds the admin saving it, keeping the rest', () => {
    const h = harness({ name: 'Old', admins: ['U0ACMEOTHER'], hirers: '*', budgetAllowanceUSD: 200 }, 'T0ACMEORG');
    const res = h.svc.setupOrg(linkedAdmin, { name: 'Acme' });
    expect(res.ok && res.org).toMatchObject({ slackTeamId: 'T0ACMEORG', slackMismatch: false, admins: 2, meInSlack: true });
    expect(h.raw()).toMatchObject({ name: 'Acme', slackTeamId: 'T0ACMEORG', admins: ['U0ACMEOTHER', 'U0ACMEBOSS'], hirers: '*', budgetAllowanceUSD: 200 });
    expect(h.recorded[0]).toContain('pinned to Slack workspace T0ACMEORG');
  });

  it('never re-pins a workspace, and says when Slack is a different one', () => {
    const h = harness({ name: 'Acme', admins: [], slackTeamId: 'T0ACMEORG' }, 'T0ACMEOTHER');
    const res = h.svc.setupOrg(linkedAdmin, { name: 'Acme' });
    expect(h.raw()).toMatchObject({ slackTeamId: 'T0ACMEORG' });
    expect(res.ok && res.org.slackMismatch).toBe(true);
  });

  it('refuses a bad name, time zone or address, and anyone but an admin', () => {
    const h = harness(null);
    expect(h.svc.setupOrg(firstAdmin, { name: '  ' })).toMatchObject({ ok: false, error: 'Give the org a name.' });
    expect(h.svc.setupOrg(firstAdmin, { name: 'Acme', timezone: 'Mars/Olympus' })).toMatchObject({ ok: false });
    expect(h.svc.setupOrg(firstAdmin, { name: 'Acme', publicUrl: 'overgo.acme' })).toMatchObject({ ok: false });
    expect(h.svc.setupOrg(firstAdmin, { name: 'Acme', publicUrl: 'ftp://overgo.acme' })).toMatchObject({ ok: false });
    expect(h.svc.setupOrg(pat, { name: 'Acme' })).toMatchObject({ ok: false });
    expect(h.svc.orgSetup(pat)).toMatchObject({ ok: false });
    expect(h.raw()).toBeNull();
  });

  it('clears the address and time zone when left empty', () => {
    const h = harness({ name: 'Acme', admins: [], timezone: 'Europe/London', publicUrl: 'https://a.acme' });
    h.svc.setupOrg(firstAdmin, { name: 'Acme', timezone: '', publicUrl: '' });
    expect(h.raw()).not.toHaveProperty('timezone');
    expect(h.raw()).not.toHaveProperty('publicUrl');
  });
});

describe('linking an admin’s Slack', () => {
  it('makes them an admin in org.json, so Slack knows', async () => {
    const h = harness({ name: 'Acme', admins: [] }, 'T0ACMEORG');
    const svc = h.svc as unknown as { pendingLinks: Map<string, { name: string; admin: boolean; slackUserId: string; until: number }> };
    svc.pendingLinks.set('L1', { name: 'Admin', admin: true, slackUserId: 'U0ACMEBOSS', until: Date.now() + 60_000 });
    expect(h.svc.linkSlackConfirm('U0ACMEBOSS', 'L1')).toMatchObject({ ok: true });
    expect(h.raw()).toMatchObject({ admins: ['U0ACMEBOSS'] });
  });

  it('leaves admins alone for someone who isn’t one', () => {
    const h = harness({ name: 'Acme', admins: [] }, 'T0ACMEORG');
    const svc = h.svc as unknown as { pendingLinks: Map<string, { name: string; admin: boolean; slackUserId: string; until: number }> };
    svc.pendingLinks.set('L2', { name: 'Pat', admin: false, slackUserId: 'U0ACMEPAT', until: Date.now() + 60_000 });
    h.svc.linkSlackConfirm('U0ACMEPAT', 'L2');
    expect(h.raw()).toMatchObject({ admins: [] });
  });
});
