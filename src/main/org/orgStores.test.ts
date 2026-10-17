import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestHost } from '../testHost';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import { callerForToken, createToken, listTokens, loadOrgPolicy, revokeToken } from './orgStores';

let dir = '';
useTestHost(() => dir);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-org-'));
});

describe('tokens', () => {
  it('stores only a hash and resolves the caller from the token', () => {
    const { token, record } = createToken({ name: 'Pat', slackUserId: 'U0ACMEPAT' });
    const file = fs.readFileSync(path.join(dir, 'org', 'tokens.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(callerForToken(token, DEFAULT_ORG_POLICY)).toEqual({ name: 'Pat', slackUserId: 'U0ACMEPAT', admin: false });
    expect(callerForToken(token + 'x', DEFAULT_ORG_POLICY)).toBeNull();
    expect(callerForToken('not-a-token', DEFAULT_ORG_POLICY)).toBeNull();
    expect(revokeToken(record.id)).toBe(true);
    expect(callerForToken(token, DEFAULT_ORG_POLICY)).toBeNull();
  });

  it('makes a policy admin an admin whatever the token says', () => {
    const { token } = createToken({ name: 'Pat', slackUserId: 'U0ACMEPAT' });
    expect(callerForToken(token, { ...DEFAULT_ORG_POLICY, admins: ['U0ACMEPAT'] })?.admin).toBe(true);
  });

  it('revokes by name', () => {
    createToken({ name: 'ops-bot', admin: true });
    expect(revokeToken('ops-bot')).toBe(true);
    expect(listTokens()).toEqual([]);
  });
});

describe('policy file', () => {
  it('defaults when absent and reloads when edited', () => {
    expect(loadOrgPolicy()).toMatchObject({ fromFile: false, policy: { hirers: [] } });
    const file = path.join(dir, 'org.json');
    fs.writeFileSync(file, JSON.stringify({ hirers: '*' }));
    expect(loadOrgPolicy().policy.hirers).toBe('*');
    fs.writeFileSync(file, JSON.stringify({ hirers: ['U0ACMEPAT'] }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(loadOrgPolicy().policy.hirers).toEqual(['U0ACMEPAT']);
  });

  it('falls back to the defaults on broken JSON', () => {
    fs.writeFileSync(path.join(dir, 'org.json'), '{ hirers: *');
    expect(loadOrgPolicy()).toMatchObject({ fromFile: true, policy: { hirers: [] } });
  });
});
