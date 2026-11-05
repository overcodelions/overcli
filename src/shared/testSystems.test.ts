import { describe, expect, it } from 'vitest';
import { credentialEnv, extraEnv, mayOpen, parseTestSystem, resolveEnvironment, signedOutPath, slugify, systemEnvNames, type TestSystem } from './testSystems';

const billing: TestSystem = {
  id: 'billing',
  name: 'Billing',
  url: 'https://staging.billing.acme.dev',
  envPattern: 'https://{env}.feature.billing.acme.dev',
  signIn: { kind: 'form', loginPath: '/login', userField: '#email', passwordField: '#password', submit: 'button[type=submit]' },
  guide: 'Check invoices.',
  workers: [],
};

describe('apps to test', () => {
  it('turns a branch or ticket into an environment name', () => {
    expect(slugify('feat/BILL-123 Export button')).toBe('feat-bill-123-export-button');
    expect(slugify('--Hello__World--')).toBe('hello-world');
    expect(slugify('x'.repeat(100)).length).toBe(63);
  });

  it('opens the usual environment, a named one, or a feature address the pattern allows', () => {
    expect(resolveEnvironment(billing)).toEqual({ ok: true, base: 'https://staging.billing.acme.dev' });
    expect(resolveEnvironment(billing, 'BILL-123')).toEqual({ ok: true, base: 'https://bill-123.feature.billing.acme.dev', env: 'bill-123' });
    expect(resolveEnvironment(billing, 'https://bill-9.feature.billing.acme.dev/invoices?x=1')).toEqual({ ok: true, base: 'https://bill-9.feature.billing.acme.dev', env: 'bill-9' });
    expect(resolveEnvironment(billing, 'https://staging.billing.acme.dev/other')).toEqual({ ok: true, base: 'https://staging.billing.acme.dev' });
  });

  it('never resolves to an address outside the app’s own', () => {
    for (const bad of ['https://evil.example/login', 'https://bill-1.feature.billing.acme.dev.evil.example', 'http://bill-1.feature.billing.acme.dev', 'https://a.b.feature.billing.acme.dev', 'notaurl://x']) {
      expect(resolveEnvironment(billing, bad).ok).toBe(false);
    }
    expect(resolveEnvironment({ ...billing, envPattern: undefined }, 'BILL-1').ok).toBe(false);
  });

  it('checks what the console sends, and fills the id from the name', () => {
    const ok = parseTestSystem({ name: 'Billing Admin', url: 'https://staging.billing.acme.dev/', envPattern: 'https://{env}.feature.acme.dev', healthPath: '/health', signIn: { kind: 'endpoint', path: '/test/login', tokenKey: 'authToken' }, workers: [' QA ', ''] });
    expect(ok).toMatchObject({ ok: true, system: { id: 'billing-admin', url: 'https://staging.billing.acme.dev', signIn: { kind: 'endpoint', path: '/test/login', tokenKey: 'authToken' }, workers: ['QA'] } });
    expect(parseTestSystem({ name: 'B', url: 'ftp://x' })).toMatchObject({ ok: false });
    expect(parseTestSystem({ name: 'B', url: 'https://b.acme.dev', envPattern: 'https://acme.dev/{env}' })).toMatchObject({ ok: false });
    expect(parseTestSystem({ name: 'B', url: 'https://b.acme.dev', signIn: { kind: 'form', loginPath: '/login' } })).toMatchObject({ ok: false });
    expect(parseTestSystem({ name: 'B', url: 'https://b.acme.dev', readyTimeoutSec: 5 })).toMatchObject({ ok: false });
  });

  it('names credentials by app, knows where signed out lands, and who may open it', () => {
    expect(credentialEnv('billing-admin')).toEqual({ user: 'OVERCLI_TS_BILLING_ADMIN_USER', password: 'OVERCLI_TS_BILLING_ADMIN_PASSWORD', code: 'OVERCLI_TS_BILLING_ADMIN_TOTP', key: 'OVERCLI_TS_BILLING_ADMIN_KEY' });
    expect(signedOutPath(billing)).toBe('/login');
    expect(signedOutPath({ ...billing, signIn: { kind: 'endpoint', path: '/t' } })).toBeNull();
    expect(mayOpen(billing)).toBe(true);
    expect(mayOpen({ ...billing, workers: ['QA Bot'] }, 'qa bot')).toBe(true);
    expect(mayOpen({ ...billing, workers: ['QA Bot'] }, 'Analyst')).toBe(false);
    expect(mayOpen({ ...billing, workers: ['QA Bot'] })).toBe(false);
  });

  it('takes extra fields and a Next button, keeping a secret one’s value out', () => {
    const form = { kind: 'form', loginPath: '/login', userField: '#e', passwordField: '#p', submit: 'button', nextButton: '#next' };
    const ok = parseTestSystem({
      name: 'B',
      url: 'https://b.acme.dev',
      signIn: { ...form, extra: [
        { label: 'Company code', selector: '#tenant', action: 'select', value: 'acme' },
        { label: 'PIN', selector: '#pin', action: 'fill', secret: true, value: 'never-kept' },
        { label: 'Remember me', selector: '#remember', action: 'check', value: 'ignored' },
        { label: '', selector: '' },
      ] },
    });
    expect(ok).toMatchObject({ ok: true, system: { signIn: { nextButton: '#next', extra: [
      { label: 'Company code', key: 'company-code', selector: '#tenant', action: 'select', value: 'acme' },
      { label: 'PIN', key: 'pin', selector: '#pin', action: 'fill', secret: true },
      { label: 'Remember me', key: 'remember-me', selector: '#remember', action: 'check' },
    ] } } });
    expect(JSON.stringify(ok)).not.toContain('never-kept');
    expect(JSON.stringify(ok)).not.toContain('ignored');
    if (ok.ok) expect(systemEnvNames(ok.system)).toContain(extraEnv('b', 'pin'));
    expect(extraEnv('billing-admin', 'company-code')).toBe('OVERCLI_TS_BILLING_ADMIN_X_COMPANY_CODE');
    const bad = (extra: unknown) => parseTestSystem({ name: 'B', url: 'https://b.acme.dev', signIn: { ...form, extra } });
    expect(bad([{ label: 'Tenant', selector: '#t' }])).toMatchObject({ ok: false });
    expect(bad([{ label: 'Tenant', selector: '' }])).toMatchObject({ ok: false });
    expect(bad([{ label: 'A', selector: '#a', action: 'check' }, { label: 'a', selector: '#b', action: 'check' }])).toMatchObject({ ok: false });
    expect(bad(Array.from({ length: 7 }, (_, i) => ({ label: `F${i}`, selector: `#f${i}`, action: 'check' })))).toMatchObject({ ok: false });
  });

  it('still lets a renamed worker open an app that names its old name', () => {
    const only = { ...billing, workers: ['Robin'] };
    expect(mayOpen(only, 'Quinn', ['Robin'])).toBe(true);
    expect(mayOpen(only, 'Quinn', ['Someone else'])).toBe(false);
    expect(mayOpen(only, undefined, [])).toBe(false);
  });
});
