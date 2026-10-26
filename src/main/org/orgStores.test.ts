import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestHost } from '../testHost';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import { callerForToken, createToken, listTokens, loadOrgPolicy, orgPolicyPath, revokeOwnToken, revokeToken, updateOrgFile } from './orgStores';
import { resolveWorkPlace } from './defaultProject';

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

describe('signing a device out', () => {
  it('revokes only the token it is given', () => {
    const a = createToken({ name: 'Pat', slackUserId: 'U0ACMEPAT', device: 'Browser' });
    const b = createToken({ name: 'Pat', slackUserId: 'U0ACMEPAT', device: 'Claude Code' });
    expect(revokeOwnToken(a.token)).toBe(true);
    expect(callerForToken(a.token, DEFAULT_ORG_POLICY)).toBeNull();
    expect(callerForToken(b.token, DEFAULT_ORG_POLICY)).not.toBeNull();
    expect(revokeOwnToken(a.token)).toBe(false);
  });
});

describe('editing org.json', () => {
  it('never writes over a file someone broke by hand', () => {
    fs.writeFileSync(orgPolicyPath(), '{ "name": "Acme", "admins": ["U0ACMEBOSS"], }');
    expect(() => updateOrgFile((raw) => (raw.openJoin = true))).toThrow(/not valid JSON/);
    expect(fs.readFileSync(orgPolicyPath(), 'utf8')).toContain('"name": "Acme"');
  });

  it('keeps keys it does not know', () => {
    fs.writeFileSync(orgPolicyPath(), JSON.stringify({ name: 'Acme', futureThing: 1 }));
    updateOrgFile((raw) => (raw.openJoin = true));
    expect(JSON.parse(fs.readFileSync(orgPolicyPath(), 'utf8'))).toEqual({ name: 'Acme', futureThing: 1, openJoin: true });
  });
});

describe('where org workers may work', () => {
  const store = { workspaces: [{ rootPath: '/srv/acme' }], projects: [{ path: '/data/projects/Workers' }] };

  it('takes only a registered place, never an arbitrary path', () => {
    expect(resolveWorkPlace(store, '/data/projects/Workers')).toEqual({ ok: true, path: '/data/projects/Workers' });
    expect(resolveWorkPlace(store, '/data').ok).toBe(false);
    expect(resolveWorkPlace(store, '/data/projects/Workers/../..').ok).toBe(false);
  });

  it('falls back to the default when the drafter guessed a place that is not registered', () => {
    expect(resolveWorkPlace(store, undefined, '/etc')).toEqual({ ok: true, path: '/srv/acme' });
    expect(resolveWorkPlace({ workspaces: [], projects: [] }).ok).toBe(false);
  });

  it('puts a hire nobody placed in the everyday folder, not the first repo', () => {
    const withEveryday = { workspaces: [{ rootPath: '/srv/acme' }], projects: [{ path: '/srv/acme-api' }, { path: '/data/projects/Workers', everyday: true }] };
    expect(resolveWorkPlace(withEveryday)).toEqual({ ok: true, path: '/data/projects/Workers' });
    expect(resolveWorkPlace(withEveryday, undefined, '/etc')).toEqual({ ok: true, path: '/data/projects/Workers' });
    // A place the job named still wins.
    expect(resolveWorkPlace(withEveryday, undefined, '/srv/acme')).toEqual({ ok: true, path: '/srv/acme' });
  });
});
