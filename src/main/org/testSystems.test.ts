import { describe, expect, it } from 'vitest';
import type { OrgCaller } from '../../shared/org/policy';
import { TEST_SYSTEMS_TOOL, credentialEnv, extraEnv, type TestSystemsFile } from '../../shared/testSystems';
import { TestSystemsService } from './testSystems';
import type { ToolInput } from './tools';

const admin: OrgCaller = { name: 'Robin', admin: true };
const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };
const app = { name: 'Billing', url: 'https://staging.billing.acme.dev', signIn: { kind: 'form', loginPath: '/login', userField: '#e', passwordField: '#p', submit: 'button' } };

function harness() {
  let file: TestSystemsFile = { version: 1, systems: [] };
  let installed: ToolInput | null = null;
  const recorded: string[] = [];
  const svc = new TestSystemsService({
    load: () => file,
    save: (f) => (file = structuredClone(f)),
    file: () => '/data/org/test-systems.json',
    isAdmin: (c) => c.admin,
    tools: {
      install: (input) => {
        installed = structuredClone(input);
        return { ok: true };
      },
      uninstall: () => {
        installed = null;
      },
      env: () => installed?.env ?? {},
    },
    serverScript: () => '/app/dist/main/org/testSystemsServer.js',
    check: async (s, env, secrets) => ({ ok: true, detail: `${s.name} ${env ?? ''} ${Object.keys(secrets).length}` }),
    record: (_c, what) => recorded.push(what),
  });
  return { svc, file: () => file, installed: () => installed, recorded };
}

describe('Setup → Apps to test', () => {
  it('installs the tool with the credentials sealed in its env, and shows only that they’re set', () => {
    const h = harness();
    const res = h.svc.save(admin, { system: app, credentials: { user: 'qa@acme.dev', password: 'hunter2-secret' } });
    expect(res).toMatchObject({ ok: true, system: { id: 'billing', has: { user: true, password: true, code: false, key: false } } });
    expect(JSON.stringify(res)).not.toContain('hunter2-secret');
    const e = credentialEnv('billing');
    expect(h.installed()).toMatchObject({ name: TEST_SYSTEMS_TOOL, kind: 'command', args: ['/app/dist/main/org/testSystemsServer.js', '--systems', '/data/org/test-systems.json'], env: { [e.user]: 'qa@acme.dev', [e.password]: 'hunter2-secret' } });
    expect(JSON.stringify(h.file())).not.toContain('hunter2-secret');
    expect(h.recorded).toEqual(['Added the app to test Billing.']);
  });

  it('keeps a credential left blank, clears an emptied one, and moves them with a rename', () => {
    const h = harness();
    h.svc.save(admin, { system: app, credentials: { user: 'qa@acme.dev', password: 'hunter2-secret' } });
    h.svc.save(admin, { system: app, credentials: { user: '' } });
    expect(h.installed()!.env).toEqual({ [credentialEnv('billing').password]: 'hunter2-secret' });
    h.svc.save(admin, { system: { ...app, name: 'Billing Admin' }, previousId: 'billing' });
    expect(h.installed()!.env).toEqual({ [credentialEnv('billing-admin').password]: 'hunter2-secret' });
    expect(h.file().systems.map((s) => s.id)).toEqual(['billing-admin']);
  });

  it('seals a secret extra field’s value, moves it with a rename, and drops it with the field', () => {
    const h = harness();
    const withPin = { ...app, signIn: { ...app.signIn, extra: [{ label: 'PIN', selector: '#pin', action: 'fill', secret: true }, { label: 'Tenant', selector: '#t', action: 'select', value: 'acme' }] } };
    const res = h.svc.save(admin, { system: withPin, credentials: { password: 'p-secret', extra: { PIN: '98765' } } });
    expect(res).toMatchObject({ ok: true, system: { has: { extra: { pin: true } } } });
    expect(h.installed()!.env).toMatchObject({ [extraEnv('billing', 'pin')]: '98765' });
    expect(JSON.stringify(h.file())).not.toContain('98765');
    h.svc.save(admin, { system: { ...withPin, name: 'Portal' }, previousId: 'billing' });
    expect(h.installed()!.env).toEqual({ [credentialEnv('portal').password]: 'p-secret', [extraEnv('portal', 'pin')]: '98765' });
    h.svc.save(admin, { system: { ...app, name: 'Portal' } });
    expect(h.installed()!.env).toEqual({ [credentialEnv('portal').password]: 'p-secret' });
  });

  it('refuses a bad authenticator secret, and anyone but an admin', () => {
    const h = harness();
    expect(h.svc.save(admin, { system: app, credentials: { code: 'not base32!' } })).toMatchObject({ ok: false });
    expect(h.svc.save(pat, { system: app })).toMatchObject({ ok: false });
    expect(h.svc.list(pat)).toMatchObject({ ok: false });
    expect(h.installed()).toBeNull();
  });

  it('drops a removed app’s credentials, and the tool with the last app', () => {
    const h = harness();
    h.svc.save(admin, { system: app, credentials: { password: 'one-secret' } });
    h.svc.save(admin, { system: { ...app, name: 'Portal' }, credentials: { password: 'two-secret' } });
    h.svc.remove(admin, 'billing');
    expect(h.installed()!.env).toEqual({ [credentialEnv('portal').password]: 'two-secret' });
    h.svc.remove(admin, 'portal');
    expect(h.installed()).toBeNull();
  });

  it('tests an app as a worker would open it', async () => {
    const h = harness();
    h.svc.save(admin, { system: app, credentials: { password: 'x-secret' } });
    expect(await h.svc.test(admin, 'billing', ' BILL-1 ')).toMatchObject({ ok: true, detail: 'Billing BILL-1 1', lastTest: { ok: true, environment: 'BILL-1', text: 'Billing BILL-1 1' } });
    // Kept for the list, until the app goes.
    expect(h.svc.list(admin)).toMatchObject({ ok: true, systems: [{ id: 'billing', lastTest: { ok: true, environment: 'BILL-1' } }] });
    h.svc.remove(admin, 'billing');
    h.svc.save(admin, { system: app });
    expect(JSON.stringify(h.svc.list(admin))).not.toContain('lastTest');
    expect(await h.svc.test(pat, 'billing')).toMatchObject({ ok: false });
  });
});
