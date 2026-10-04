import { describe, expect, it } from 'vitest';
import { isOptionKey, isSecretName, missingMachineError, missingNamesFrom, suggestedOptionKey } from './machineValues';

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
