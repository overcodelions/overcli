import { describe, expect, it } from 'vitest';

import { buildSharedStack, matchRepos, normalizeRemote, parseSharedStack, specsFromShared } from './stackShare';
import type { ServiceSpec } from './types';

const HOME = '/Users/dana';

function spec(over: Partial<ServiceSpec> & { id: string; name: string }): ServiceSpec {
  return {
    projectId: 'p-billing',
    runner: 'gradle',
    command: ['./gradlew', 'bootRun'],
    ready: { kind: 'tcp', port: 5002 },
    selfReloads: false,
    config: {},
    ...over,
  };
}

const projects = [
  { id: 'p-billing', name: 'billing', path: `${HOME}/code/billing` },
  { id: 'p-web', name: 'web', path: `${HOME}/code/web` },
];
const remotes: Record<string, string> = {
  [`${HOME}/code/billing`]: 'git@github.com:acme/billing.git',
  [`${HOME}/code/web`]: 'https://github.com/acme/web',
};
const remoteOf = (p: string) => remotes[p];
const idFor = (owner: string, name: string) => `${owner}-${name}`;

describe('normalizeRemote', () => {
  it('makes ssh and https clones of one repo the same', () => {
    expect(normalizeRemote('git@github.com:Acme/Billing.git')).toBe('github.com/acme/billing');
    expect(normalizeRemote('https://token@github.com/acme/billing.git')).toBe('github.com/acme/billing');
    expect(normalizeRemote('ssh://git@github.com:22/acme/billing')).toBe('github.com/acme/billing');
    expect(normalizeRemote('')).toBeUndefined();
    expect(normalizeRemote('/some/local/path')).toBeUndefined();
  });
});

describe('buildSharedStack', () => {
  const services = [
    spec({
      id: 'p-billing-api',
      name: 'billing-api',
      pinnedRef: 'main',
      importedFrom: { source: 'intellij', project: 'billing', excerpt: 'password=hunter2' },
      options: [
        { key: '-Ddb.password', value: 'hunter2' },
        { key: '-Ddb.user', value: '${DB_USER}' },
        { key: '-Dlogs.dir', value: `${HOME}/logs` },
      ],
      config: { inject: { STRIPE_SECRET_KEY: 'sk_test_1' }, link: { 'a.yml': '/x/a.yml' } },
      deps: ['p-billing-auth'],
    }),
    spec({ id: 'p-billing-auth', name: 'auth', options: [{ key: '-Ddb.password', value: 'hunter2' }] }),
    spec({ id: 'p-billing-auth-eu', name: 'auth-eu', copyOf: 'p-billing-auth' }),
    spec({ id: 'p-web-app', name: 'web-app', projectId: 'p-web', runner: 'npm', command: ['npm', 'start'] }),
  ];

  const build = (serviceIds?: string[]) =>
    buildSharedStack({ name: 'acme', services, bindings: [], projects, serviceIds, remoteOf, home: HOME, now: new Date(0) });

  it('names repos by remote and drops what only means something here', () => {
    const { stack, dropped } = build();
    expect(stack.repos).toEqual({
      billing: { name: 'billing', remote: 'github.com/acme/billing' },
      web: { name: 'web', remote: 'github.com/acme/web' },
    });
    const api = stack.services[0];
    expect(api).not.toHaveProperty('id');
    expect(api).not.toHaveProperty('projectId');
    expect(api).not.toHaveProperty('pinnedRef');
    expect(api).not.toHaveProperty('importedFrom');
    expect(api.config).not.toHaveProperty('link');
    expect(api.deps).toEqual(['auth']);
    expect(stack.services[2].copyOf).toBe('auth');
    expect(dropped).toEqual(['linked or rendered config files on 1 service', 'branch pins on 1 service']);
  });

  it('keeps pins only when asked', () => {
    const pinned = buildSharedStack({ name: 'acme', services, bindings: [], projects, remoteOf, home: HOME, includePins: true });
    expect(pinned.stack.services[0].pinnedRef).toBe('main');
    expect(pinned.dropped).not.toContain('branch pins on 1 service');
  });

  it('turns typed credentials into one named blank each, and lists every value needed', () => {
    const { stack, scrubbed, text } = build();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('sk_test_1');
    expect(text).not.toContain(HOME);
    const [api, auth] = stack.services;
    expect(api.options).toEqual([
      { key: '-Ddb.password', value: '${DB_PASSWORD}' },
      { key: '-Ddb.user', value: '${DB_USER}' },
      { key: '-Dlogs.dir', value: '${HOME}/logs' },
    ]);
    // The same password in two services is one blank.
    expect(auth.options).toEqual([{ key: '-Ddb.password', value: '${DB_PASSWORD}' }]);
    expect(api.config.inject).toEqual({ STRIPE_SECRET_KEY: '${STRIPE_SECRET_KEY}' });
    expect(scrubbed).toEqual([
      {
        name: 'DB_PASSWORD',
        from: [
          { service: 'billing-api', key: '-Ddb.password' },
          { service: 'auth', key: '-Ddb.password' },
        ],
      },
      { name: 'STRIPE_SECRET_KEY', from: [{ service: 'billing-api', key: 'STRIPE_SECRET_KEY' }] },
    ]);
    expect(stack.values).toEqual(['DB_PASSWORD', 'DB_USER', 'STRIPE_SECRET_KEY']);
  });

  it('scrubs a password holding a $, and credentials passed as arguments', () => {
    const one = spec({
      id: 'p-billing-api',
      name: 'billing-api',
      command: ['java', '-Ddb.password=Pa$sword1', '-Dapi.key=ak_live_9', '--spring.profiles.active=local', `--logs=${HOME}/logs`],
      options: [{ key: '-Ddb.password', value: 'Pa$sword1' }, { key: '-Dtoken', value: 'Bearer ${API_TOKEN}' }, { key: '-Dsecret', value: '$SECRET' }],
    });
    const { stack, text } = buildSharedStack({ name: 'acme', services: [one], bindings: [], projects, remoteOf, home: HOME });
    expect(text).not.toContain('Pa$sword1');
    expect(text).not.toContain('ak_live_9');
    expect(stack.services[0].command).toEqual(['java', '-Ddb.password=${DB_PASSWORD}', '-Dapi.key=${API_KEY}', '--spring.profiles.active=local', '--logs=${HOME}/logs']);
    // The same password as an argument and an option is one blank; a value
    // that is or holds a reference is left as it is.
    expect(stack.services[0].options).toEqual([
      { key: '-Ddb.password', value: '${DB_PASSWORD}' },
      { key: '-Dtoken', value: 'Bearer ${API_TOKEN}' },
      { key: '-Dsecret', value: '$SECRET' },
    ]);
  });

  it('replaces the home folder only where it ends', () => {
    const one = spec({ id: 'p-billing-api', name: 'billing-api', options: [{ key: '-Da', value: '/home/alex/x' }, { key: '-Db', value: '/home/al/x' }, { key: '-Dc', value: '/home/al' }] });
    const { stack } = buildSharedStack({ name: 'acme', services: [one], bindings: [], projects, remoteOf, home: '/home/al' });
    expect(stack.services[0].options?.map((o) => o.value)).toEqual(['/home/alex/x', '${HOME}/x', '${HOME}']);
  });

  it('brings a copy’s base along and drops deps outside the selection', () => {
    const { stack } = build(['p-billing-api', 'p-billing-auth-eu']);
    expect(stack.services.map((s) => s.name)).toEqual(['billing-api', 'auth', 'auth-eu']);
    const narrow = build(['p-billing-api']);
    expect(narrow.stack.services[0].deps).toBeUndefined();
  });

  it('round-trips through parse and onto another machine', () => {
    const { text } = build();
    const parsed = parseSharedStack(text);
    if ('error' in parsed) throw new Error(parsed.error);
    const theirs = [
      { id: 'q-bill', name: 'billing', path: '/home/sam/src/billing' },
      { id: 'q-web', name: 'web', path: '/home/sam/src/web' },
    ];
    const theirRemotes: Record<string, string> = {
      '/home/sam/src/billing': 'https://github.com/acme/billing.git',
    };
    const matches = matchRepos(parsed.stack, theirs, (p) => theirRemotes[p]);
    expect(matches).toEqual([
      expect.objectContaining({ key: 'billing', services: 3, match: { projectId: 'q-bill', path: '/home/sam/src/billing' } }),
      expect.objectContaining({ key: 'web', services: 1 }),
    ]);
    // Has a remote, and none of theirs carries it: a same-named folder is not trusted.
    expect(matches[1].match).toBeUndefined();

    const { specs, skipped } = specsFromShared({
      stack: parsed.stack,
      places: { billing: matches[0].match },
      existing: [],
      home: '/home/sam',
      idFor,
    });
    expect(skipped).toEqual([{ name: 'web-app', reason: 'web is not on this machine' }]);
    const byName = Object.fromEntries(specs.map((s) => [s.spec.name, s.spec]));
    expect(byName['billing-api'].id).toBe('q-bill-billing-api');
    expect(byName['billing-api'].deps).toEqual(['q-bill-auth']);
    expect(byName['auth-eu'].copyOf).toBe('q-bill-auth');
    expect(byName['billing-api'].options?.[2]).toEqual({ key: '-Dlogs.dir', value: '/home/sam/logs' });
    expect(specs.every((s) => s.path === '/home/sam/src/billing')).toBe(true);
  });

  it('leaves out what the stack already has, and a copy whose base did not come', () => {
    const { text } = build();
    const parsed = parseSharedStack(text);
    if ('error' in parsed) throw new Error(parsed.error);
    const { specs, skipped } = specsFromShared({
      stack: parsed.stack,
      places: { billing: { path: '/x' } },
      existing: [spec({ id: 'mine-auth', name: 'auth' })],
      home: '/home/sam',
      idFor,
    });
    // The copy's base is the existing `auth`, so it still has one.
    expect(specs.map((s) => s.spec.name)).toEqual(['billing-api', 'auth-eu']);
    expect(specs[1].spec.copyOf).toBe('mine-auth');
    expect(specs[0].spec.deps).toEqual(['mine-auth']);
    expect(skipped.map((s) => s.reason)).toContain('already in this stack');
  });
});

describe('parseSharedStack', () => {
  it('refuses what is not one', () => {
    expect(parseSharedStack('nope')).toEqual({ error: expect.stringContaining('not JSON') });
    expect(parseSharedStack('{"format":"other"}')).toEqual({ error: expect.stringContaining('overcli-stack/1') });
    expect(
      parseSharedStack(JSON.stringify({ format: 'overcli-stack/1', repos: {}, services: [{ name: 'x', repo: 'r', command: [], runner: 'npm' }] })),
    ).toEqual({ error: 'x names a repo the file does not list.' });
    expect(
      parseSharedStack(JSON.stringify({ format: 'overcli-stack/1', repos: { r: { name: 'r' } }, services: [{ name: 'x', repo: 'r', command: 'rm -rf /', runner: 'npm' }] })),
    ).toEqual({ error: 'x has no command.' });
  });

  it('refuses nested fields that would crash the import', () => {
    const parse = (service: Record<string, unknown>) =>
      parseSharedStack(JSON.stringify({ format: 'overcli-stack/1', repos: { r: { name: 'r' } }, services: [{ name: 'x', repo: 'r', command: ['npm', 'start'], runner: 'npm', ...service }] }));
    expect(parse({ ready: { kind: 'command' } })).toEqual({ error: 'x has a "command" ready check with parts missing.' });
    expect(parse({ ready: { kind: 'tcp', port: '80' } })).toEqual({ error: 'x has a "tcp" ready check with parts missing.' });
    expect(parse({ options: [{ value: 'x' }] })).toEqual({ error: 'x has options that are not name and value.' });
    expect(parse({ config: { inject: { A: 1 } } })).toEqual({ error: 'x has variables that are not text.' });
    expect(parse({ deps: 'auth' })).toEqual({ error: 'x has dependencies that are not names.' });
    expect(parse({ ready: { kind: 'http', port: 8080, path: '/health' }, options: [{ key: '--flag' }] })).toHaveProperty('stack');
  });
});
