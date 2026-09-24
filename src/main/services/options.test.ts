import { describe, expect, it } from 'vitest';
import {
  buildCommand,
  copiesOf,
  defaultOptionStyle,
  isSecretName,
  missingMachineValues,
  parseOptions,
  renderOption,
  resolveOptions,
  substitute,
} from './options';
import type { ServiceSpec } from './types';

function spec(over: Partial<ServiceSpec> & { id: string }): ServiceSpec {
  return {
    name: over.id,
    runner: 'gradle',
    command: ['./gradlew', ':AcmeProcessor:bootRun'],
    ready: { kind: 'none' },
    selfReloads: false,
    config: {},
    ...over,
  };
}

/// The real shape this exists for: one module, five services, differing by a
/// flag or two each.
const base = spec({
  id: 'proc',
  name: 'AcmeProcessor',
  options: [
    { key: '-Xms512m' },
    { key: '-Xmx4096m' },
    { key: '-Dspring.profiles.active', value: 'local' },
    { key: '-Ddatabase.userid', value: '${DB_USER}' },
    { key: '-Dprocessor.types', value: 'NONE' },
  ],
});

const procs = spec({
  id: 'proc-procs',
  name: 'acme-proc-procs',
  copyOf: 'proc',
  debugPort: 6002,
  options: [
    { key: '-Dprocessor.types', value: 'PROC,PROC_HIGH' },
    { key: '-Dhibernate.cache.enabled', value: 'true' },
  ],
});

const specs = [base, procs];

describe('resolveOptions', () => {
  it('inherits the shared options and adds the copy’s own', () => {
    const resolved = resolveOptions(specs, procs, { DB_USER: 'root' });
    expect(resolved.map((o) => o.key)).toEqual([
      '-Xms512m',
      '-Xmx4096m',
      '-Dspring.profiles.active',
      '-Ddatabase.userid',
      '-Dprocessor.types',
      '-Dhibernate.cache.enabled',
    ]);
  });

  it('lets the copy win on a key the base also sets, in the base’s position', () => {
    // Keeping the position means a diff between two copies reads as a diff
    // rather than a reordering.
    const resolved = resolveOptions(specs, procs, {});
    const types = resolved.find((o) => o.key === '-Dprocessor.types');
    expect(types).toEqual({
      key: '-Dprocessor.types',
      value: 'PROC,PROC_HIGH',
      origin: 'own',
      overrides: true,
    });
  });

  it('marks what came from the shared set', () => {
    const resolved = resolveOptions(specs, procs, {});
    expect(resolved.find((o) => o.key === '-Xmx4096m')?.origin).toBe('shared');
    expect(resolved.find((o) => o.key === '-Dhibernate.cache.enabled')?.origin).toBe('own');
  });

  it('fills machine values into any option', () => {
    const resolved = resolveOptions(specs, procs, { DB_USER: 'lionel' });
    expect(resolved.find((o) => o.key === '-Ddatabase.userid')?.value).toBe('lionel');
  });

  it('skips a disabled option without forgetting it', () => {
    const withOff = spec({
      ...procs,
      id: 'p2',
      options: [{ key: '-Dprocessor.types', value: 'DM', enabled: false }],
    });
    const resolved = resolveOptions([base, withOff], withOff, {});
    // The base's value survives, because the copy's override is switched off.
    expect(resolved.find((o) => o.key === '-Dprocessor.types')?.value).toBe('NONE');
  });

  it('returns a service’s own options when it is nobody’s copy', () => {
    expect(resolveOptions(specs, base, {}).map((o) => o.origin)).toEqual([
      'own',
      'own',
      'own',
      'own',
      'own',
    ]);
  });

  it('survives a copyOf pointing at a service that is gone', () => {
    const orphan = spec({ id: 'x', copyOf: 'deleted', options: [{ key: '-Da' }] });
    expect(resolveOptions([orphan], orphan, {}).map((o) => o.key)).toEqual(['-Da']);
  });
});

describe('substitute', () => {
  it('leaves an unknown name alone rather than blanking it', () => {
    // A service that starts with a literal ${DB_USER} fails with a message
    // naming what is missing. One that silently connects as no user does not.
    expect(substitute('${DB_USER}', {})).toBe('${DB_USER}');
    expect(substitute('${DB_USER}', { DB_USER: 'root' })).toBe('root');
  });

  it('fills several in one value', () => {
    expect(substitute('${A}-${B}', { A: '1', B: '2' })).toBe('1-2');
  });

  it('fills a machine value that refers to another', () => {
    // What an import of `-Ddatabase.password=${DB_PASSWORD}` left behind.
    const machine = { DATABASE_PASSWORD: '${DB_PASSWORD}', DB_PASSWORD: 'hunter2hunter2' };
    expect(substitute('${DATABASE_PASSWORD}', machine)).toBe('hunter2hunter2');
    expect(substitute('${DATABASE_PASSWORD}', { DATABASE_PASSWORD: '${DB_PASSWORD}' })).toBe('${DB_PASSWORD}');
  });

  it('ends a cycle as an unresolved name instead of hanging', () => {
    expect(substitute('${A}', { A: '${B}', B: '${A}' })).toBe('${A}');
    expect(substitute('${A}', { A: 'x${A}' })).toBe('x${A}');
  });
});

describe('missingMachineValues', () => {
  it('names what is still unfilled, before the service is started', () => {
    const resolved = resolveOptions(specs, procs, {});
    expect(missingMachineValues(resolved)).toEqual(['DB_USER']);
  });

  it('is empty once everything resolves', () => {
    expect(missingMachineValues(resolveOptions(specs, procs, { DB_USER: 'root' }))).toEqual([]);
  });
});

describe('buildCommand', () => {
  it('packs options into -PjvmArgs for gradle, which ignores them otherwise', () => {
    // Silent when wrong: bootRun simply does not see plain arguments.
    const argv = buildCommand(procs, resolveOptions(specs, procs, { DB_USER: 'root' }));
    expect(argv[0]).toBe('./gradlew');
    expect(argv[1]).toBe(':AcmeProcessor:bootRun');
    expect(argv[2]).toMatch(/^-PjvmArgs=/);
    expect(argv[2]).toContain('-Dprocessor.types=PROC,PROC_HIGH');
    expect(argv[2]).toContain('-Ddatabase.userid=root');
    expect(argv).toHaveLength(3);
  });

  it('appends them as plain arguments for everything else', () => {
    const node = spec({
      id: 'web',
      runner: 'npm',
      command: ['npm', 'run', 'dev'],
      options: [{ key: '--port', value: '4300' }],
    });
    expect(buildCommand(node, resolveOptions([node], node, {}))).toEqual([
      'npm',
      'run',
      'dev',
      '--port=4300',
    ]);
  });

  it('renders a bare flag without a trailing equals', () => {
    expect(renderOption({ key: '-Xmx4096m' })).toBe('-Xmx4096m');
    expect(renderOption({ key: '-Da', value: '' })).toBe('-Da');
  });

  it('leaves debugger injection to the runner-specific launch adapter', () => {
    const plain = buildCommand(procs, resolveOptions(specs, procs, {}));
    expect(plain[2]).not.toContain('jdwp');
  });

  it('leaves the command alone when there is nothing to add', () => {
    const bare = spec({ id: 'b', command: ['./gradlew', 'bootRun'] });
    expect(buildCommand(bare, [])).toEqual(['./gradlew', 'bootRun']);
  });
});

describe('defaultOptionStyle', () => {
  it('knows gradle is the one that differs', () => {
    expect(defaultOptionStyle({ runner: 'gradle' })).toBe('gradle-jvm-args');
    expect(defaultOptionStyle({ runner: 'npm' })).toBe('argv');
  });
});

describe('parseOptions', () => {
  it('parses a pasted block of flags', () => {
    // How anyone actually moves an existing setup in: paste the args from the
    // script that has them today.
    expect(parseOptions("-Xms512m -Dspring.profiles.active=local\n-Ddatabase.name=acme")).toEqual([
      { key: '-Xms512m' },
      { key: '-Dspring.profiles.active', value: 'local' },
      { key: '-Ddatabase.name', value: 'acme' },
    ]);
  });

  it('keeps a quoted value together and drops the quotes', () => {
    expect(parseOptions('-Dtypes="PROC, DM"')).toEqual([{ key: '-Dtypes', value: 'PROC, DM' }]);
  });

  it('ignores comment lines', () => {
    expect(parseOptions('# heap\n-Xmx1g')).toEqual([{ key: '-Xmx1g' }]);
  });
});

describe('isSecretName', () => {
  it('masks the obvious ones', () => {
    expect(isSecretName('DB_PASSWORD')).toBe(true);
    expect(isSecretName('API_TOKEN')).toBe(true);
    expect(isSecretName('SQS_PREFIX')).toBe(false);
  });

  it('skips locators and still catches run-together names', () => {
    for (const n of [
      'KEYCLOAK_URL', 'AUTH_URL', 'PASSENGER_ROOT', 'SSH_KEY_PATH', 'AWS_ACCESS_KEY_ID',
      'SORT_KEY', 'ROUTING_KEY', 'PARTITION_KEY', 'CACHE_KEY', 'PASS_THRESHOLD',
    ]) {
      expect(isSecretName(n)).toBe(false);
    }
    for (const n of [
      'DB_PASSWORD', 'GITHUB_TOKEN', 'AWS_SECRETKEY', 'apiKey', 'dbPassword', 'MYSQL_PWD',
      'AUTHORIZATION', 'HTTP_AUTHORIZATION', 'BEARER_TOKEN',
    ]) {
      expect(isSecretName(n)).toBe(true);
    }
  });

  // A name that only a masker sees is a name that reaches the log file
  // verbatim, so the words that unambiguously mean "credential" have to beat
  // the locator rule rather than defer to it.
  it('keeps a passphrase and a Vault secret id secret, locator suffix or not', () => {
    for (const n of ['GPG_PASSPHRASE', 'SSH_PASSPHRASE', 'PASSPHRASE', 'encryptionPassphrase', 'KEY_PASSPHRASE']) {
      expect(isSecretName(n)).toBe(true);
    }
    // `secret` and `password` win outright; `token` and `auth` still defer.
    expect(isSecretName('SECRET_ID')).toBe(true);
    expect(isSecretName('PASSWORD_FILE')).toBe(true);
    expect(isSecretName('TOKEN_NAME')).toBe(false);
  });

  // Every one of these reached plain text, the log file and the Ask AI prompt
  // when a bare `key` needed a second credential word to count.
  it('treats a trailing key as a credential unless it names a data key', () => {
    for (const n of [
      'STRIPE_KEY', 'ENCRYPTION_KEY', 'JWT_KEY', 'JWT_SIGNING_KEY', 'SIGNING_KEY', 'MASTER_KEY',
      'SESSION_KEY', 'HMAC_KEY', 'OPENAI_KEY', 'ACME_KEY', 'KEY', 'signingKey', 'acme-license-key',
    ]) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of [
      'SORT_KEY', 'ROUTING_KEY', 'PARTITION_KEY', 'CACHE_KEY', 'PRIMARY_KEY', 'FOREIGN_KEY',
      'IDEMPOTENCY_KEY', 'SHARD_KEY', 'cacheKey', 'STRIPE_PUBLIC_KEY', 'KEY_PREFIX', 'CACHE_KEY_PREFIX',
      'SIGNING_KEY_PATH', 'AWS_ACCESS_KEY_ID',
    ]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });

  it('keeps AUTHORIZATION and BEARER secret whatever follows them', () => {
    for (const n of ['AUTHORIZATION', 'AUTHORIZATION_HEADER', 'BEARER', 'BEARER_URL', 'X_AUTHORIZATION_KEY']) {
      expect(isSecretName(n), n).toBe(true);
    }
  });
});

describe('copiesOf', () => {
  it('finds the copies that nest under a base', () => {
    expect(copiesOf(specs, 'proc').map((s) => s.id)).toEqual(['proc-procs']);
    expect(copiesOf(specs, 'proc-procs')).toEqual([]);
  });
});
