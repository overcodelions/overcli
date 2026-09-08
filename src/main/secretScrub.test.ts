// The credential scrubber that guards webhook egress.
//
// Every "secret" in here is synthetic. `AKIAIOSFODNN7EXAMPLE` and
// `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` are AWS's own published
// documentation placeholders; the rest are hand-built to the right shape.
// Nothing in this file is or ever was live.
//
// The prefixed vendor tokens are ASSEMBLED AT RUNTIME rather than written as
// string literals. They are fake, but they are shaped exactly like the real
// thing — which is the point of the fixture and also what makes a scanner
// flag them. GitHub push protection rejected this file's first draft over the
// Slack and Stripe lines. Building them from parts keeps the full token from
// ever appearing contiguously in the source, so the tests still exercise the
// real patterns without leaving strings that trip every scanner downstream.
// Do not re-inline these.

import { describe, expect, it } from 'vitest';

import { collectKnownSecretValues, redactSecrets, shannonEntropy } from './secretScrub';

const AKIA = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('redactSecrets — one true positive per kind', () => {
  it('redacts an AWS access key id, in both AKIA and ASIA spellings', () => {
    const a = redactSecrets(`Deploy failed: the key ${AKIA} is invalid.`);
    expect(a.text).toBe('Deploy failed: the key [REDACTED:aws-access-key-id] is invalid.');
    expect(a.redactedCount).toBe(1);
    expect(a.text).not.toContain(AKIA);

    const b = redactSecrets('ASIAY34FZKBOKMUTVV7A expired');
    expect(b.text).toBe('[REDACTED:aws-access-key-id] expired');
  });

  it('redacts an AWS-secret-shaped base64 blob', () => {
    const r = redactSecrets(`AWS_SECRET_ACCESS_KEY was ${AWS_SECRET}`);
    expect(r.text).toContain('[REDACTED:aws-secret-access-key]');
    expect(r.text).not.toContain(AWS_SECRET);
    expect(r.redactedCount).toBe(1);
  });

  it('redacts GitHub tokens in every prefix', () => {
    const body = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    for (const token of [
      ['ghp', body].join('_'),
      ['gho', body].join('_'),
      ['ghs', body].join('_'),
      ['github', 'pat', '11ABCDEFG0abcdefghijkl', 'A1b2C3d4E5f6G7h8'].join('_'),
    ]) {
      const r = redactSecrets(`remote: rejected using ${token}`);
      expect(r.text).toBe('remote: rejected using [REDACTED:github-token]');
      expect(r.redactedCount).toBe(1);
    }
  });

  it('redacts a Slack token', () => {
    const token = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
    const r = redactSecrets(`${token} failed`);
    expect(r.text).toBe('[REDACTED:slack-token] failed');
    expect(r.redactedCount).toBe(1);
  });

  it('redacts a Stripe key', () => {
    const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('_');
    const r = redactSecrets(`charge failed for ${key}`);
    expect(r.text).toBe('charge failed for [REDACTED:stripe-key]');
  });

  it('redacts a PEM private key block, header and body and footer', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx3Ff1kJ0oXk9Qh2mZ8pLbNvR4tY6uI1oP3aS5dF7gH9jK2lM',
      'NbVcXz0QwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOpAsDfGhJkLzXcVbNmQwEr',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = redactSecrets(`could not read deploy key:\n${pem}\n(check permissions)`);
    expect(r.text).toBe('could not read deploy key:\n[REDACTED:pem-private-key]\n(check permissions)');
    expect(r.redactedCount).toBe(1);
    expect(r.text).not.toContain('MIIEow');
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const r = redactSecrets(`401 for ${jwt}`);
    expect(r.text).toBe('401 for [REDACTED:jwt]');
  });

  it('redacts a bearer token but keeps the word Bearer', () => {
    const r = redactSecrets('curl -H "Authorization: Bearer sk-abc123DEF456ghi789JKL012" failed');
    expect(r.text).toBe('curl -H "Authorization: Bearer [REDACTED:bearer-token]" failed');
    expect(r.redactedCount).toBe(1);
  });

  it('redacts a generic assignment but keeps the label, in every keyword spelling', () => {
    for (const label of ['api_key', 'api-key', 'apikey', 'token', 'secret', 'password']) {
      const r = redactSecrets(`${label}=xK9mQ2vB7nR4tY6uZ1aS3dF5`);
      expect(r.text).toBe(`${label}=[REDACTED:generic-assignment]`);
      expect(r.redactedCount).toBe(1);
    }
  });
});

describe('redactSecrets — true negatives', () => {
  it('passes ordinary prose through byte for byte', () => {
    const prose =
      'Shift finished: 3 proposals queued, 1 skipped. The nightly triage flow ran for 4m12s.';
    expect(redactSecrets(prose)).toEqual({ text: prose, redactedCount: 0 });
  });

  it('leaves prose that merely MENTIONS a token or a key alone', () => {
    // The case the generic catch-all exists to not ruin: the words are there,
    // the value is not.
    const prose =
      'Run failed: the API token was missing, so no key could be used. Rotate the secret and retry.';
    expect(redactSecrets(prose)).toEqual({ text: prose, redactedCount: 0 });
  });

  it('leaves a git SHA alone even though it is 40 characters', () => {
    // The reason the base64 rule demands mixed case: this string is all over
    // the error text this scrubber actually sees.
    const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    const line = `failed to fast-forward onto ${sha}`;
    expect(redactSecrets(line)).toEqual({ text: line, redactedCount: 0 });
  });

  it('leaves a low-entropy placeholder assignment alone', () => {
    const line = 'password=aaaaaaaaaaaaaaaaaa';
    expect(redactSecrets(line)).toEqual({ text: line, redactedCount: 0 });
  });

  it('leaves a short value alone — 15 characters is under the floor', () => {
    const line = 'token=abc123DEF456g';
    expect(redactSecrets(line)).toEqual({ text: line, redactedCount: 0 });
  });
});

describe('redactSecrets — known values, whatever they look like', () => {
  it('redacts a credential with no recognisable shape because we hold it', () => {
    // No prefix, no assignment, no entropy signal a pattern could act on. The
    // ONLY reason this is redactable is that it was handed in as known.
    const shapeless = 'hunter2-correct-horse-battery';
    const r = redactSecrets(`db connect failed for ${shapeless} on prod`, [shapeless]);
    expect(r.text).toBe('db connect failed for [REDACTED:known-secret] on prod');
    expect(r.redactedCount).toBe(1);
    expect(r.text).not.toContain(shapeless);
  });

  it('redacts every occurrence and counts each one', () => {
    const v = 'abcdefghijklmnop';
    const r = redactSecrets(`${v} then ${v}`, [v]);
    expect(r.text).toBe('[REDACTED:known-secret] then [REDACTED:known-secret]');
    expect(r.redactedCount).toBe(2);
  });

  it('ignores a known value too short to be worth matching', () => {
    const line = 'the abc thing failed';
    expect(redactSecrets(line, ['abc'])).toEqual({ text: line, redactedCount: 0 });
  });

  it('handles a known value containing regex metacharacters', () => {
    const v = 'a+b/c(d)[e].f*g$';
    const r = redactSecrets(`token for ${v} rejected`, [v]);
    expect(r.text).toBe('token for [REDACTED:known-secret] rejected');
  });
});

describe('redactSecrets — bookkeeping', () => {
  it('counts one per marker across mixed kinds', () => {
    const gh = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const r = redactSecrets(`${AKIA} and ${gh} and password=xK9mQ2vB7nR4tY6u`);
    expect(r.redactedCount).toBe(3);
    expect(r.text.match(/\[REDACTED:/g)).toHaveLength(3);
  });

  it('counts a specific credential once, not once per rule that could match it', () => {
    // `api_key=AKIA…` is matched by the AWS rule AND would be matched by the
    // generic catch-all. Order settles it; the count must not double.
    const r = redactSecrets(`api_key=${AKIA}`);
    expect(r.redactedCount).toBe(1);
    expect(r.text).toBe('api_key=[REDACTED:aws-access-key-id]');
  });

  it('never re-matches its own marker', () => {
    const once = redactSecrets(`token=${AWS_SECRET}`);
    const twice = redactSecrets(once.text);
    expect(twice.redactedCount).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it('is safe on empty and undefined-ish input', () => {
    expect(redactSecrets('')).toEqual({ text: '', redactedCount: 0 });
    expect(redactSecrets(undefined as unknown as string)).toEqual({ text: '', redactedCount: 0 });
  });
});

describe('collectKnownSecretValues', () => {
  it('picks up credential-named env vars with a plausible value', () => {
    const found = collectKnownSecretValues({
      GITHUB_TOKEN: 'A1b2C3d4E5f6G7h8I9j0K1',
      MY_API_KEY: 'zX9wV8uT7sR6qP5oN4mL3k',
      DB_PASSWORD: 'p4ssw0rd-With-Enough-Entropy',
    } as NodeJS.ProcessEnv);
    expect(found).toContain('A1b2C3d4E5f6G7h8I9j0K1');
    expect(found).toContain('zX9wV8uT7sR6qP5oN4mL3k');
    expect(found).toContain('p4ssw0rd-With-Enough-Entropy');
  });

  it('ignores non-credential names, short values, paths, and whitespace', () => {
    const found = collectKnownSecretValues({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/someone',
      // Credential-named but not a credential value.
      TOKEN_FILE_PATH: '/Users/someone/.config/token',
      SECRET_MODE: 'true',
      API_KEY_DESCRIPTION: 'the key used for billing',
      TOKEN_PLACEHOLDER: 'aaaaaaaaaaaaaaaaaaaa',
    } as NodeJS.ProcessEnv);
    expect(found).toEqual([]);
  });

  it('takes extras and sorts longest first so overlaps cannot split', () => {
    const found = collectKnownSecretValues({} as NodeJS.ProcessEnv, [
      'shortish12',
      'a-much-longer-secret-value',
      null,
      undefined,
      '   ',
    ]);
    expect(found).toEqual(['a-much-longer-secret-value', 'shortish12']);
  });
});

describe('shannonEntropy', () => {
  it('is zero for a single repeated character and high for random-looking text', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy(AWS_SECRET)).toBeGreaterThan(3);
  });
});
