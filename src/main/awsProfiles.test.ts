// The parser feeds names straight into `spawn` argv and an AppleScript
// `do script`, and it reads a file that sits next to the user's secret keys.
// Two properties matter most: only safe names get through, and nothing from
// ~/.aws/credentials below a section header ever travels.

import { describe, expect, it } from 'vitest';
import { AWS_NAME_RE, buildAwsAuthOverview, isSafeAwsName, parseAwsIni } from './awsProfiles';

// Mirrors the shape of a real config: an [sso-session] block declared BEFORE
// the profile that references it, `sso_start_url=` with no spaces around the
// `=` on one line and spaces on another, a `#`-terminated start URL, a
// [services] block we don't model, comments, and a duplicate header.
const CONFIG = [
  '[default]',
  'region = us-east-1',
  '',
  '; a comment',
  '[sso-session d-90676d998c]',
  'sso_start_url=https://d-90676d998c.awsapps.com/start',
  'sso_region=us-east-1',
  '',
  '[profile AWSAdministratorAccess-803597461034]',
  'sso_session = aws-infra-local',
  'sso_account_id = 803597461034',
  'sso_role_name = AWSAdministratorAccess',
  'region = us-east-1',
  '',
  '[sso-session aws-infra-local]',
  'sso_start_url = https://d-9067c44074.awsapps.com/start/#',
  'sso_region = us-east-1',
  '',
  '[sso-session uinfyr-sso]',
  'sso_start_url = https://d-9067c44074.awsapps.com/start/#',
  'sso_region = us-east-1',
  '',
  '# legacy shape: start url inlined on the profile itself',
  '[profile OldSchool]',
  'sso_start_url = https://legacy.awsapps.com/start',
  'sso_region = eu-west-1',
  '',
  '[services my-services]',
  's3 =',
  '',
  '[profile Static]',
  'region = us-west-2',
].join('\n');

const CREDENTIALS = [
  '[default]',
  'aws_access_key_id = AKIAEXAMPLE',
  'aws_secret_access_key = SUPERSECRET',
  '',
  '[Zift]',
  'aws_access_key_id = AKIAZIFT',
  'aws_secret_access_key = ANOTHERSECRET',
].join('\n');

const build = (configText = CONFIG, credentialsText = CREDENTIALS) =>
  buildAwsAuthOverview({
    configText,
    credentialsText,
    cliPath: '/opt/homebrew/bin/aws',
    configPath: '/home/u/.aws/config',
  });

describe('isSafeAwsName', () => {
  it('accepts the names AWS profiles actually use', () => {
    for (const n of ['default', 'Zift', 'AWSAdministratorAccess-803597461034', 'a.b_c-1']) {
      expect(isSafeAwsName(n), n).toBe(true);
    }
  });

  it('allows spaces — `aws configure sso` writes profile names like `EU Prod`', () => {
    expect(isSafeAwsName('EU Prod')).toBe(true);
    // ...but not a leading space or dash, which argv would read as a flag.
    expect(isSafeAwsName(' EU')).toBe(false);
    expect(isSafeAwsName('-EU')).toBe(false);
  });

  it('rejects anything that could escape a shell quote or AppleScript', () => {
    for (const n of ['prod"; rm -rf /', "'EU Prod'", '../x', '-profile', 'a$b', 'a`b`', 'a;b', 'a|b', 'a&b', 'a<b', 'a\\b', '', 'a\nb']) {
      expect(isSafeAwsName(n), n).toBe(false);
    }
  });

  it('rejects names longer than the cap', () => {
    expect(AWS_NAME_RE.test('a'.repeat(128))).toBe(true);
    expect(AWS_NAME_RE.test('a'.repeat(129))).toBe(false);
  });
});

describe('parseAwsIni', () => {
  it('handles both `=` spacings', () => {
    const s = parseAwsIni('[sso-session x]\nsso_start_url=https://a\nsso_region = us-east-1');
    expect(s[0].values).toEqual({ sso_start_url: 'https://a', sso_region: 'us-east-1' });
  });

  it('keeps a `#` inside a start URL rather than treating it as a comment', () => {
    const s = parseAwsIni('[sso-session x]\nsso_start_url = https://d.awsapps.com/start/#');
    expect(s[0].values['sso_start_url']).toBe('https://d.awsapps.com/start/#');
  });

  it('tolerates CRLF and skips comment lines', () => {
    const s = parseAwsIni('[default]\r\n# c\r\n; c2\r\nregion = us-east-1\r\n');
    expect(s[0].values['region']).toBe('us-east-1');
  });

  it('merges a duplicate header with later keys winning', () => {
    const s = parseAwsIni('[default]\nregion = us-east-1\n[default]\nregion = eu-west-1');
    expect(s).toHaveLength(1);
    expect(s[0].values['region']).toBe('eu-west-1');
  });

  it('drops every key outside the whitelist', () => {
    const s = parseAwsIni('[default]\naws_secret_access_key = SUPERSECRET\nregion = us-east-1');
    expect(s[0].values).toEqual({ region: 'us-east-1' });
  });

  it('ignores key lines that precede any header', () => {
    expect(parseAwsIni('region = us-east-1\n[default]\nregion = eu-west-1')).toHaveLength(1);
  });
});

describe('buildAwsAuthOverview', () => {
  it('lists SSO profiles first, then orphan sessions only', () => {
    const o = build();
    expect(o.ssoTargets.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'profile:AWSAdministratorAccess-803597461034',
      'profile:OldSchool',
      // aws-infra-local is referenced by the profile above, so it gets no
      // row of its own; these two are referenced by nothing.
      'sso-session:d-90676d998c',
      'sso-session:uinfyr-sso',
    ]);
  });

  it('resolves a profile\'s display fields through its sso_session block', () => {
    const t = build().ssoTargets[0];
    expect(t).toMatchObject({
      name: 'AWSAdministratorAccess-803597461034',
      kind: 'profile',
      ssoSession: 'aws-infra-local',
      startUrl: 'https://d-9067c44074.awsapps.com/start/#',
      ssoRegion: 'us-east-1',
      region: 'us-east-1',
    });
  });

  it('treats an inline sso_start_url as an SSO profile', () => {
    expect(build().ssoTargets[1]).toMatchObject({
      name: 'OldSchool',
      kind: 'profile',
      startUrl: 'https://legacy.awsapps.com/start',
      ssoRegion: 'eu-west-1',
    });
    expect(build().ssoTargets[1].ssoSession).toBeUndefined();
  });

  it('omits profiles with no SSO configuration at all', () => {
    const names = build().ssoTargets.map((t) => t.name);
    expect(names).not.toContain('Static');
    expect(names).not.toContain('default');
  });

  it('ignores [services] and other sections it does not model', () => {
    expect(build().ssoTargets.map((t) => t.name)).not.toContain('my-services');
  });

  it('drops an SSO profile whose name could escape into a command', () => {
    const hostile = ['[profile evil"; rm -rf /]', 'sso_session = s', '', '[sso-session s]', 'sso_start_url = https://a'].join('\n');
    const o = build(hostile, '');
    // The profile is dropped — and because a dropped profile marks no
    // reference, the session it pointed at is still reachable on its own.
    expect(o.ssoTargets.map((t) => `${t.kind}:${t.name}`)).toEqual(['sso-session:s']);
  });

  it('keeps an SSO profile whose name contains a space', () => {
    const cfg = ['[profile EU Prod]', 'sso_session = aws', 'region = eu-north-1', '', '[sso-session aws]', 'sso_start_url = https://a'].join('\n');
    expect(build(cfg, '').ssoTargets.map((t) => `${t.kind}:${t.name}`)).toEqual(['profile:EU Prod']);
  });

  it('lists credentials section names and nothing else from that file', () => {
    const o = build();
    expect(o.staticProfiles).toEqual(['default', 'Zift']);
    const serialized = JSON.stringify(o);
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('ANOTHERSECRET');
    expect(serialized).not.toContain('aws_secret_access_key');
    expect(serialized).not.toContain('AKIAEXAMPLE');
  });

  it('returns an empty overview when both files are missing', () => {
    const o = buildAwsAuthOverview({
      configText: '',
      credentialsText: '',
      cliPath: null,
      configPath: '/home/u/.aws/config',
    });
    expect(o.ssoTargets).toEqual([]);
    expect(o.staticProfiles).toEqual([]);
    expect(o.cliPath).toBeNull();
  });
});
