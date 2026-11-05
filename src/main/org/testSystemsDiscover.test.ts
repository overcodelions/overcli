import { describe, expect, it } from 'vitest';
import { discoverScript, nameFromHost, planFromScan, type ScreenScan } from './testSystemsDiscover';

const screen = (over: Partial<ScreenScan>): ScreenScan => ({ url: 'https://staging.billing.acme.dev/login', user: null, password: null, submit: null, code: null, extras: [], ...over });

describe('discovering an app’s sign-in', () => {
  it('names an app from the part of its host that says something', () => {
    expect(nameFromHost('staging.billing.acme.dev')).toBe('Billing');
    expect(nameFromHost('customer-portal.acme.dev')).toBe('Customer portal');
    expect(nameFromHost('app.acme.dev')).toBe('App');
    expect(nameFromHost('127.0.0.1:4789')).toBe('App');
  });

  it('reads a one-screen login page, its extras and a health check', () => {
    const f = planFromScan('https://staging.billing.acme.dev/login?next=/', {
      first: screen({ user: '#email', password: '#password', submit: 'button[type="submit"]', code: '#otp', extras: [
        { label: 'Company', selector: '#tenant', action: 'select', options: ['acme', 'other'] },
        { label: 'Remember me', selector: '#remember', action: 'check' },
      ] }),
      second: null,
    }, '/healthz');
    expect(f).toMatchObject({
      name: 'Billing',
      url: 'https://staging.billing.acme.dev',
      healthPath: '/healthz',
      signIn: { kind: 'form', loginPath: '/login', userField: '#email', passwordField: '#password', submit: 'button[type="submit"]', codeField: '#otp',
        extra: [{ label: 'Company', selector: '#tenant', action: 'select', options: ['acme', 'other'] }, { label: 'Remember me', selector: '#remember', action: 'check' }] },
    });
    expect(f.sso).toBeUndefined();
    expect(f.found.join(' ')).toContain('authenticator secret');
    expect(f.warnings.join(' ')).toContain('Give each extra field its value');
  });

  it('follows a login over two screens', () => {
    const f = planFromScan('https://staging.billing.acme.dev/login', {
      first: screen({ user: '#email', submit: '#next', submitText: 'Next' }),
      second: screen({ url: 'https://staging.billing.acme.dev/login/password', password: '#password', submit: '#signin' }),
    });
    expect(f.signIn).toEqual({ kind: 'form', loginPath: '/login', userField: '#email', nextButton: '#next', passwordField: '#password', submit: '#signin' });
    expect(f.found.join(' ')).toContain('two screens');
    expect(f.warnings.join(' ')).toContain('No health check');
  });

  it('says when signing in leaves for another site', () => {
    const f = planFromScan('https://staging.billing.acme.dev/', {
      first: screen({ url: 'https://staging.billing.acme.dev/', user: '#email', submit: '#next' }),
      second: screen({ url: 'https://sso.acme-identity.example/u/login', password: '#pw', submit: '#go' }),
    });
    expect(f.sso).toBe('sso.acme-identity.example');
    expect(f.warnings.join(' ')).toContain('test login endpoint');
  });

  it('says when it found no form, or only part of one', () => {
    expect(planFromScan('https://open.acme.dev/', { first: screen({ url: 'https://open.acme.dev/' }), second: null })).toMatchObject({ signIn: { kind: 'none' } });
    const part = planFromScan('https://b.acme.dev/login', { first: screen({ url: 'https://b.acme.dev/login', password: '#pw' }), second: null });
    expect(part.signIn).toMatchObject({ kind: 'form', passwordField: '#pw', userField: '' });
    expect(part.warnings.join(' ')).toContain('part of a login form');
  });

  it('puts the address and username in the script as data', () => {
    const code = discoverScript('https://b.acme.dev/login?x="1"', 'qa@acme.dev');
    expect(code).toContain(JSON.stringify('https://b.acme.dev/login?x="1"'));
    expect(code).toContain('"qa@acme.dev"');
    expect(code).toContain('return JSON.stringify({ first, second });');
  });
});
