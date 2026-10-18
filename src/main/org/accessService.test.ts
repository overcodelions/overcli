import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY, parseOrgPolicy, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { AccessService, PAIR_TTL_MS, SETUP_TTL_MS, personRole, type Invite, type JoinRequest } from './accessService';

const ADMIN = 'U0ACMEBOSS';
const PAT = 'U0ACMEPAT';
const admin: OrgCaller = { slackUserId: ADMIN, name: 'Bo', admin: true };
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const BASE = 'https://overcli.acme.example';

function harness(orgFile: Record<string, unknown> = {}, opts: { slack?: boolean; dmGate?: Promise<void>; ssoRequired?: boolean } = {}) {
  let raw: Record<string, unknown> = { name: 'Acme', admins: [ADMIN], hirers: [], ...orgFile };
  let invites: Invite[] = [];
  let requests: JoinRequest[] = [];
  const tokens: Array<{ id: string; name: string; slackUserId?: string; device?: string; admin?: boolean; token: string }> = [];
  const dms: string[] = [];
  const asked: string[] = [];
  const recorded: string[] = [];
  let now = 1_000_000;
  const policy = (): OrgPolicy => parseOrgPolicy(raw).policy;
  const svc = new AccessService({
    policy,
    store: { invites: () => invites, saveInvites: (i) => (invites = structuredClone(i)), requests: () => requests, saveRequests: (r) => (requests = structuredClone(r)) },
    tokens: {
      create: (a) => {
        const token = `ocli_${tokens.length}`;
        tokens.push({ id: `t${tokens.length}`, ...a, token });
        return { token };
      },
      revokeFor: (id) => {
        const before = tokens.length;
        for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].slackUserId === id) tokens.splice(i, 1);
        return before - tokens.length;
      },
      revoke: (id) => {
        const i = tokens.findIndex((t) => t.id === id);
        if (i >= 0) tokens.splice(i, 1);
        return i >= 0;
      },
      list: () => tokens,
    },
    updateOrg: (mutate) => {
      const copy = structuredClone(raw);
      mutate(copy);
      raw = copy;
    },
    ...(opts.slack
      ? {
          slack: {
            dmInvite: async (invite, link) => {
              await opts.dmGate;
              dms.push(`${invite.slackUserId}:${link}`);
              return true;
            },
            askAdmins: (r, admins) => asked.push(`${r.slackUserId}->${admins.join(',')}`),
            tellRequester: (id, text) => dms.push(`${id}:${text}`),
          },
        }
      : {}),
    now: () => now,
    record: (c, what) => recorded.push(`${c.name}: ${what}`),
    ssoRequired: () => !!opts.ssoRequired,
  });
  return { recorded, svc, tokens, dms, asked, raw: () => raw, policy, tick: (ms: number) => (now += ms), invites: () => invites };
}

const codeOf = (link: string) => link.split('/join/')[1];

describe('invites', () => {
  it('lets an admin invite, DMs the link in Slack, and the link signs them in once with their role', async () => {
    const h = harness({}, { slack: true });
    const made = await h.svc.invite(admin, { name: 'Pat Lee', slackUserId: PAT, role: 'hirer', allowanceUSD: 150 }, BASE);
    expect(made).toMatchObject({ ok: true, sentInSlack: true });
    if (!made.ok) return;
    expect(made.link.startsWith(`${BASE}/join/`)).toBe(true);
    expect(h.dms).toEqual([`${PAT}:${made.link}`]);
    expect(JSON.stringify(h.invites())).not.toContain(codeOf(made.link));

    expect(h.svc.inviteInfo(codeOf(made.link))).toMatchObject({ ok: true, org: 'Acme', name: 'Pat Lee', invitedBy: 'Bo', role: 'hirer', allowanceUSD: 150 });
    const joined = h.svc.redeem(codeOf(made.link));
    expect(joined).toMatchObject({ ok: true, name: 'Pat Lee', org: 'Acme' });
    expect(h.tokens[0]).toMatchObject({ name: 'Pat Lee', slackUserId: PAT, device: 'Browser' });
    expect(personRole(h.policy(), PAT)).toBe('hirer');
    expect(h.policy().allowances[PAT]).toBe(150);
    expect(h.svc.redeem(codeOf(made.link)).ok).toBe(false);
  });

  it('is admin-only, and expires', async () => {
    const h = harness();
    expect((await h.svc.invite(pat, { name: 'X', role: 'member' }, BASE)).ok).toBe(false);
    const made = await h.svc.invite(admin, { name: 'Sam', role: 'member' }, BASE);
    if (!made.ok) throw new Error(made.error);
    expect(made.sentInSlack).toBe(false);
    h.tick(8 * 24 * 60 * 60 * 1000);
    expect(h.svc.redeem(codeOf(made.link)).ok).toBe(false);
  });

  it('replaces an earlier invite for the same person', async () => {
    const h = harness();
    const first = await h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'member' }, BASE);
    const second = await h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'hirer' }, BASE);
    if (!first.ok || !second.ok) throw new Error('invite failed');
    expect(h.svc.redeem(codeOf(first.link)).ok).toBe(false);
    expect(h.svc.redeem(codeOf(second.link)).ok).toBe(true);
  });
});

describe('invites, racing', () => {
  it('keeps a link redeemed while the Slack DM was still being sent spent', async () => {
    let open!: () => void;
    const h = harness({}, { slack: true, dmGate: new Promise<void>((r) => (open = r)) });
    const first = await h.svc.invite(admin, { name: 'Sam', role: 'member' }, BASE);
    if (!first.ok) throw new Error(first.error);
    const pending = h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'member' }, BASE);
    expect(h.svc.redeem(codeOf(first.link)).ok).toBe(true);
    open();
    expect((await pending).ok).toBe(true);
    expect(h.svc.redeem(codeOf(first.link)).ok).toBe(false);
  });

  it('keeps one first-admin link, which lives a day', async () => {
    const h = harness();
    const a = await h.svc.invite(admin, { name: 'Admin', role: 'admin', setup: true }, BASE);
    const b = await h.svc.invite(admin, { name: 'Admin', role: 'admin', setup: true }, BASE);
    if (!a.ok || !b.ok) throw new Error('invite failed');
    expect(h.svc.redeem(codeOf(a.link)).ok).toBe(false);
    h.tick(SETUP_TTL_MS + 1);
    expect(h.svc.redeem(codeOf(b.link)).ok).toBe(false);
  });
});

describe('keys for tools', () => {
  it('makes a key of the caller\'s own, listed as its own sign-in', () => {
    const h = harness();
    expect(h.svc.createDeviceKey(pat, 'Claude Code')).toMatchObject({ ok: true });
    expect(h.tokens[0]).toMatchObject({ slackUserId: PAT, device: 'Claude Code' });
    expect(h.svc.createDeviceKey({ name: 'Ops script', admin: true }, 'x').ok).toBe(false);
  });
});

describe('roles', () => {
  it('moves someone between roles in org.json', () => {
    const h = harness();
    expect(h.svc.setRole(admin, PAT, 'approver')).toMatchObject({ ok: true, role: 'approver' });
    expect(h.raw()).toMatchObject({ approvers: [PAT], hirers: [PAT] });
    expect(h.svc.setRole(admin, PAT, 'member')).toMatchObject({ ok: true, role: 'member' });
    expect(h.raw()).toMatchObject({ approvers: [], hirers: [] });
  });

  it('says so when "everyone may hire" keeps a member hiring', () => {
    const h = harness({ hirers: '*' });
    const res = h.svc.setRole(admin, PAT, 'member');
    expect(res).toMatchObject({ ok: true, role: 'hirer' });
    if (res.ok) expect(res.note).toMatch(/Everyone/);
  });

  it('will not demote the last admin', () => {
    const h = harness();
    expect(h.svc.setRole(admin, ADMIN, 'member').ok).toBe(false);
  });
});

describe('/overcli join', () => {
  it('asks the admins, and letting them in DMs an invite', async () => {
    const h = harness({}, { slack: true });
    expect(await h.svc.requestJoin({ slackUserId: PAT, name: 'Pat Lee' }, BASE)).toEqual({ ok: true, outcome: 'asked' });
    expect(await h.svc.requestJoin({ slackUserId: PAT, name: 'Pat Lee' }, BASE)).toEqual({ ok: true, outcome: 'already' });
    expect(h.asked).toEqual([`${PAT}->${ADMIN}`]);
    const req = h.svc.requests(admin);
    if (!req.ok) throw new Error(req.error);
    expect(await h.svc.decideRequest(admin, req.requests[0].id, true, BASE)).toMatchObject({ ok: true, sentInSlack: true });
    expect(h.dms[0].startsWith(`${PAT}:${BASE}/join/`)).toBe(true);
  });

  it('sends someone already in a fresh link instead of asking the admins', async () => {
    const h = harness({ hirers: [PAT] }, { slack: true });
    expect(await h.svc.requestJoin({ slackUserId: PAT, name: 'Pat Lee' }, BASE)).toEqual({ ok: true, outcome: 'invited' });
    expect(h.asked).toEqual([]);
    expect(h.dms[0].startsWith(`${PAT}:${BASE}/join/`)).toBe(true);
    expect((await h.svc.requestJoin({ slackUserId: PAT, name: 'Pat Lee' }, '')).ok).toBe(false);
  });

  it('lets them straight in when the org is open', async () => {
    const h = harness({ openJoin: true }, { slack: true });
    expect(await h.svc.requestJoin({ slackUserId: PAT, name: 'Pat Lee' }, BASE)).toEqual({ ok: true, outcome: 'invited' });
    expect(h.dms).toHaveLength(1);
  });
});

describe('pairing the overcli app', () => {
  it('hands the app a token once a signed-in person confirms the code', () => {
    const h = harness();
    const start = h.svc.pairStart("Pat's MacBook", BASE);
    if (!start.ok) throw new Error(start.error);
    expect(start.verifyUrl).toBe(`${BASE}/pair?code=${start.userCode}`);
    expect(start.userCode).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(h.svc.pairPoll(start.pairId, start.pollSecret)).toEqual({ ok: true, status: 'waiting' });
    expect(h.svc.pairPoll(start.pairId, 'wrong').ok).toBe(false);
    expect(h.svc.pairInfo(pat, start.userCode)).toMatchObject({ ok: true, device: "Pat's MacBook" });
    expect(h.svc.pairDecide(pat, start.userCode, true)).toEqual({ ok: true });
    expect(h.svc.pairPoll(start.pairId, start.pollSecret)).toMatchObject({ ok: true, status: 'signedIn', name: 'Pat', org: 'Acme' });
    expect(h.tokens[0]).toMatchObject({ slackUserId: PAT, device: "overcli app: Pat's MacBook", admin: false });
    // Handed over once.
    expect(h.svc.pairPoll(start.pairId, start.pollSecret)).toEqual({ ok: true, status: 'expired' });
  });

  it('tells the app when it was refused or ran out of time', () => {
    const h = harness();
    const a = h.svc.pairStart('A', BASE);
    const b = h.svc.pairStart('B', BASE);
    if (!a.ok || !b.ok) throw new Error('start failed');
    h.svc.pairDecide(pat, a.userCode, false);
    expect(h.svc.pairPoll(a.pairId, a.pollSecret)).toEqual({ ok: true, status: 'denied' });
    h.tick(PAIR_TTL_MS + 1);
    expect(h.svc.pairPoll(b.pairId, b.pollSecret)).toEqual({ ok: true, status: 'expired' });
    expect(h.svc.pairDecide(pat, b.userCode, true).ok).toBe(false);
  });
});

describe('signing people out', () => {
  it('signs one device out, or a person everywhere', async () => {
    const h = harness();
    const made = await h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'member' }, BASE);
    if (!made.ok) throw new Error(made.error);
    h.svc.redeem(codeOf(made.link));
    const p = h.svc.pairStart('Mac', BASE);
    if (!p.ok) throw new Error(p.error);
    h.svc.pairDecide(pat, p.userCode, true);
    expect(h.tokens).toHaveLength(2);
    expect(h.svc.signOutDevice(pat, h.tokens[1].id)).toEqual({ ok: true });
    expect(h.svc.signOutEverywhere(pat, PAT).ok).toBe(false);
    expect(h.svc.signOutEverywhere(admin, PAT)).toEqual({ ok: true, count: 1 });
    expect(h.tokens).toHaveLength(0);
  });
});

void DEFAULT_ORG_POLICY;

describe('rules from the console', () => {
  it('changes what it is given, refuses what would not read back, and logs it', () => {
    const h = harness({ teams: { old: [PAT] } });
    expect(h.svc.setRules(pat, { hirers: '*' }).ok).toBe(false);
    const res = h.svc.setRules(admin, { hirers: '*', budgetAllowanceUSD: 75, orgBudgetUSD: 900, retentionDays: 90 });
    expect(res).toMatchObject({ ok: true, rules: { hirers: '*', budgetAllowanceUSD: 75, orgBudgetUSD: 900, retentionDays: 90 } });
    expect(h.raw()).toMatchObject({ teams: { old: [PAT] }, name: 'Acme' });
    expect(h.recorded).toEqual(['Bo: Changed the rules: hirers, budgetAllowanceUSD, orgBudgetUSD, retentionDays.']);
    expect(h.svc.setRules(admin, { timezone: 'Mars/Olympus' })).toMatchObject({ ok: false, error: expect.stringMatching(/timezone/) });
    expect(h.svc.setRules(admin, { retentionDays: 2 }).ok).toBe(false);
    expect(h.raw().retentionDays).toBe(90);
    expect(h.svc.setRules(admin, { orgBudgetUSD: null }).ok).toBe(true);
    expect('orgBudgetUSD' in h.raw()).toBe(false);
  });

  it('ignores keys the Admin page may not change', () => {
    const h = harness();
    expect(h.svc.setRules(admin, { admins: [PAT] }).ok).toBe(false);
    expect(h.raw().admins).toEqual([ADMIN]);
  });
});

describe('offboarding', () => {
  it('closes every way in and takes them off every rule', async () => {
    const h = harness({ hirers: [PAT], approvers: [PAT], allowances: { [PAT]: 90 }, teams: { product: [PAT, ADMIN] }, people: { 'pat@acme.com': PAT } });
    const made = await h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'hirer' }, BASE);
    if (!made.ok) throw new Error(made.error);
    h.svc.redeem(codeOf(made.link));
    await h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'hirer' }, BASE);
    expect(h.svc.removePerson(admin, PAT)).toEqual({ ok: true, signedOut: 1 });
    expect(h.raw()).toMatchObject({ hirers: [], approvers: [], allowances: {}, teams: { product: [ADMIN] }, people: {} });
    expect(h.invites().filter((i) => !i.usedAt)).toEqual([]);
    expect(h.svc.removePerson(admin, ADMIN).ok).toBe(false);
    expect(h.svc.removePerson(pat, ADMIN).ok).toBe(false);
  });
});

describe('company sign-in', () => {
  it('stops invite links signing people in, but their role applies when they sign in', async () => {
    const h = harness({}, { ssoRequired: true });
    const made = await h.svc.invite(admin, { name: 'Pat', slackUserId: PAT, role: 'hirer', allowanceUSD: 40 }, BASE);
    if (!made.ok) throw new Error(made.error);
    expect(h.svc.inviteInfo(codeOf(made.link))).toMatchObject({ ok: true, ssoRequired: true });
    expect(h.svc.redeem(codeOf(made.link)).ok).toBe(false);
    h.svc.signInWithSso({ slackUserId: PAT, name: 'Pat Lee', email: 'pat@acme.com' });
    expect(personRole(h.policy(), PAT)).toBe('hirer');
    expect(h.policy().allowances[PAT]).toBe(40);
    expect(h.tokens[0]).toMatchObject({ slackUserId: PAT, device: 'Browser (company sign-in)' });
    const setup = await h.svc.invite(admin, { name: 'Admin', role: 'admin', setup: true }, BASE);
    if (!setup.ok) throw new Error(setup.error);
    expect(h.svc.redeem(codeOf(setup.link)).ok).toBe(true);
  });
});
