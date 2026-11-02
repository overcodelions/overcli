import { describe, expect, it } from 'vitest';
import { holdsAddressCredential, isOptionKey, isSecretFlagValue, isSecretName, loadsCode, missingMachineError, missingNamesFrom, suggestedOptionKey } from './machineValues';

describe('isSecretName', () => {
  it('treats a *_PRIMARY_KEY value as a credential, not a data-structure key', () => {
    expect(isSecretName('AZURE_STORAGE_PRIMARY_KEY')).toBe(true);
  });
});

describe('missingMachineError', () => {
  it('keeps the plain wording when nothing is locked', () => {
    expect(missingMachineError(['DB_USER'], [])).toBe('Missing machine value: DB_USER');
  });

  it('names a stored secret the keychain would not open apart from one never set', () => {
    const error = missingMachineError(['DB_PASSWORD', 'DB_USER', 'REDSHIFT_PASSWORD'], ['DB_PASSWORD', 'REDSHIFT_PASSWORD']);
    expect(error).toBe(
      "Keychain couldn't unlock: DB_PASSWORD, REDSHIFT_PASSWORD. Re-enter them in machine values. Missing machine value: DB_USER",
    );
  });
});

describe('missingNamesFrom', () => {
  it('reads every name back out, locked or missing', () => {
    expect(missingNamesFrom('Missing machine values: DB_USER, DB_PASSWORD')).toEqual(['DB_USER', 'DB_PASSWORD']);
    expect(missingNamesFrom(missingMachineError(['A_PASSWORD'], ['A_PASSWORD']))).toEqual(['A_PASSWORD']);
    expect(missingNamesFrom(missingMachineError(['A_PASSWORD', 'B'], ['A_PASSWORD']))).toEqual(['A_PASSWORD', 'B']);
  });

  it('finds nothing in an unrelated error', () => {
    expect(missingNamesFrom('Port 8080 is in use')).toEqual([]);
    expect(missingNamesFrom(undefined)).toEqual([]);
  });
});

describe('option keys for machine values', () => {
  it('suggests the JVM property a value is most likely read as', () => {
    expect(suggestedOptionKey('DATABASE_PORT')).toBe('-Ddatabase.port');
  });

  it('accepts a flag and refuses one carrying a value or a space', () => {
    expect(isOptionKey('-Ddatabase.port')).toBe(true);
    expect(isOptionKey('--spring.profiles.active')).toBe(true);
    expect(isOptionKey('-Ddatabase.port=5432')).toBe(false);
    expect(isOptionKey('-D database.port')).toBe(false);
    expect(isOptionKey('database.port')).toBe(false);
  });
});

describe('credentials in flags and addresses', () => {
  it('reads --pw, a cookie and a -p that is not a port as secret', () => {
    expect(isSecretName('--pw')).toBe(true);
    expect(isSecretName('DB_PW')).toBe(true);
    expect(isSecretName('Cookie')).toBe(true);
    expect(isSecretName('COOKIE_NAME')).toBe(false);
    expect(isSecretFlagValue('-p', 'hunter2')).toBe(true);
    expect(isSecretFlagValue('-p', '5432')).toBe(false);
    expect(isSecretFlagValue('-p', '127.0.0.1:8080:80')).toBe(false);
    expect(isSecretFlagValue('--port', 'hunter2')).toBe(false);
  });

  it('finds a password in an address, with or without a scheme, and a secret parameter', () => {
    expect(holdsAddressCredential('postgresql://app:pw@db/prod')).toBe(true);
    expect(holdsAddressCredential('app:pw@db.acme.example:5432')).toBe(true);
    expect(holdsAddressCredential('https://hooks.acme.example/x#token=abc')).toBe(true);
    expect(holdsAddressCredential('npm:acme-ui@2')).toBe(false);
    expect(holdsAddressCredential('git@github.com:acme/billing.git')).toBe(false);
    expect(holdsAddressCredential('https://acme.example/x?page=2')).toBe(false);
  });

  it('knows the variables that load code', () => {
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT', 'BASH_ENV', 'GIT_SSH_COMMAND', 'JAVA_TOOL_OPTIONS', 'npm_config_script_shell']) {
      expect(loadsCode(name)).toBe(true);
    }
    for (const name of ['PORT', 'NODE_ENV', 'DATABASE_URL', 'SPRING_PROFILES_ACTIVE']) expect(loadsCode(name)).toBe(false);
  });
});
