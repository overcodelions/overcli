import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY, canHire, canManage, canSee, committedBudget, hireDecision, parseOrgPolicy, type OrgCaller, type OrgPolicy, inAudience, parseAudience } from './policy';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const LEE = 'U0ACMELEE';

const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const lee: OrgCaller = { slackUserId: LEE, name: 'Lee', admin: false };

const policy = (over: Partial<OrgPolicy> = {}): OrgPolicy => ({ ...DEFAULT_ORG_POLICY, ...over });

const w = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  budgetUSDPerMonth: 20,
  ...over,
});

describe('parseOrgPolicy', () => {
  it('reads a full policy', () => {
    const { policy: p, warnings } = parseOrgPolicy({
      admins: [PAT],
      hirers: '*',
      budgetAllowanceUSD: 50,
      allowances: { [SAM]: 200 },
      teams: { product: [PAT, SAM] },
      allowedMcpServers: ['acme-feedback'],
    });
    expect(warnings).toEqual([]);
    expect(p).toMatchObject({ admins: [PAT], hirers: '*', budgetAllowanceUSD: 50, allowances: { [SAM]: 200 } });
  });

  it('falls back narrow on a typo rather than wide', () => {
    const { policy: p, warnings } = parseOrgPolicy({ hirers: 'everyone', budgetAllowanceUSD: 'lots', admins: ['pat'] });
    expect(p.hirers).toEqual([]);
    expect(p.budgetAllowanceUSD).toBe(0);
    expect(p.admins).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('permissions', () => {
  const roster = [
    w('chief', { manager: { name: 'Pat', slackUserId: PAT } }),
    w('analyst', { reportsTo: 'chief' }),
    w('public', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'org' }),
    w('teamy', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'team' }),
    w('secret', { manager: { name: 'Sam', slackUserId: SAM } }),
  ] as never[];
  const p = policy({ teams: { product: [SAM, LEE] } });

  it('lets a manager manage their branch, inherited down the chain', () => {
    expect(canManage(p, roster, 'analyst', pat)).toBe(true);
    expect(canManage(p, roster, 'analyst', sam)).toBe(false);
  });

  it('shows org workers to all, team workers to teammates, private to the manager', () => {
    expect(canSee(p, roster, 'public', pat)).toBe(true);
    expect(canSee(p, roster, 'teamy', lee)).toBe(true);
    expect(canSee(p, roster, 'teamy', pat)).toBe(false);
    expect(canSee(p, roster, 'secret', lee)).toBe(false);
    expect(canSee(p, roster, 'secret', sam)).toBe(true);
  });

  it('lets an admin do anything', () => {
    const admin = { name: 'ops', admin: true };
    expect(canManage(p, roster, 'secret', admin)).toBe(true);
    expect(canSee(p, roster, 'secret', admin)).toBe(true);
    expect(canHire(p, admin)).toBe(true);
  });

  it('allows nobody to hire by default', () => {
    expect(canHire(DEFAULT_ORG_POLICY, pat)).toBe(false);
  });
});

describe('committedBudget', () => {
  it('counts paused workers and workers managed through their boss', () => {
    const roster = [
      w('boss', { manager: { name: 'Pat', slackUserId: PAT }, budgetUSDPerMonth: 30 }),
      w('paused', { manager: { name: 'Pat', slackUserId: PAT }, budgetUSDPerMonth: 20, enabled: false }),
      w('under', { reportsTo: 'boss', budgetUSDPerMonth: 10 }),
      w('other', { manager: { name: 'Sam', slackUserId: SAM }, budgetUSDPerMonth: 99 }),
    ] as never[];
    expect(committedBudget(roster, PAT)).toBe(60);
  });
});

describe('hireDecision', () => {
  const roster = [w('a', { manager: { name: 'Pat', slackUserId: PAT }, budgetUSDPerMonth: 40 })] as never[];

  it('refuses someone who may not hire', () => {
    expect(hireDecision(policy(), roster, pat, { budgetUSDPerMonth: 5 }).kind).toBe('refused');
  });

  it('allows a hire inside the allowance', () => {
    expect(hireDecision(policy({ hirers: '*', budgetAllowanceUSD: 50 }), roster, pat, { budgetUSDPerMonth: 10 })).toEqual({
      kind: 'allowed',
    });
  });

  it('sends a hire past the allowance to an approver', () => {
    const d = hireDecision(policy({ hirers: '*', budgetAllowanceUSD: 50 }), roster, pat, { budgetUSDPerMonth: 20 });
    expect(d.kind).toBe('needsApproval');
    if (d.kind === 'needsApproval') expect(d.reasons[0]).toMatch(/\$60\/month/);
  });

  it('honours a personal allowance', () => {
    const p = policy({ hirers: '*', budgetAllowanceUSD: 10, allowances: { [PAT]: 500 } });
    expect(hireDecision(p, roster, pat, { budgetUSDPerMonth: 100 }).kind).toBe('allowed');
  });

  it('needs approval for org-wide visibility and uncleared connectors', () => {
    const p = policy({ hirers: '*', budgetAllowanceUSD: 1000, allowedMcpServers: ['acme-feedback'] });
    const d = hireDecision(p, roster, pat, { budgetUSDPerMonth: 1, visibility: 'org', mcpServers: ['acme-feedback', 'warehouse'] });
    expect(d.kind).toBe('needsApproval');
    if (d.kind === 'needsApproval') {
      expect(d.reasons.join(' ')).toMatch(/whole org/);
      expect(d.reasons.join(' ')).toMatch(/warehouse/);
      expect(d.reasons.join(' ')).not.toMatch(/acme-feedback/);
    }
  });
});

describe('who a worker, team or idea is open to, when picked', () => {
  const policy = parseOrgPolicy({ name: 'Acme', admins: ['U0ADMIN1'], approvers: ['U0APPR01'], hirers: ['U0HIRE01'], teams: { Product: ['U0PAT001', 'U0SAM001'] } }).policy;
  const as = (slackUserId: string) => ({ slackUserId, name: slackUserId, admin: false });

  it('lets in the people, groups and roles picked, and no one else', () => {
    const a = { people: ['U0LEE001'], groups: ['team:Product'], roles: ['approver' as const] };
    expect(inAudience(policy, as('U0LEE001'), a)).toBe(true);
    expect(inAudience(policy, as('U0SAM001'), a)).toBe(true);
    expect(inAudience(policy, as('U0APPR01'), a)).toBe(true);
    expect(inAudience(policy, as('U0HIRE01'), a)).toBe(false);
    expect(inAudience(policy, as('U0ADMIN1'), a)).toBe(false);
    expect(inAudience(policy, as('U0ADMIN1'), { roles: ['admin'] })).toBe(true);
    expect(inAudience(policy, as('U0HIRE01'), { roles: ['hirer'] })).toBe(true);
  });

  it('decides over visibility for a worker that has one', () => {
    const roster = [{ id: 'w', enabled: true, manager: { name: 'Pat', slackUserId: 'U0PAT001' }, visibility: 'org' as const, audience: { people: ['U0LEE001'] } }];
    expect(canSee(policy, roster as never, 'w', as('U0LEE001'))).toBe(true);
    expect(canSee(policy, roster as never, 'w', as('U0SAM001'))).toBe(false);
    expect(canSee(policy, roster as never, 'w', as('U0PAT001'))).toBe(true);
  });

  it('reads one from a request, and refuses what it can’t be', () => {
    expect(parseAudience({ people: ['U0LEE001', 'U0LEE001'], groups: ['team:Product'], roles: ['hirer'] })).toEqual({ ok: true, audience: { people: ['U0LEE001'], groups: ['team:Product'], roles: ['hirer'] } });
    expect(parseAudience({ people: ['lee'] }).ok).toBe(false);
    expect(parseAudience({ roles: ['owner'] }).ok).toBe(false);
  });
});
