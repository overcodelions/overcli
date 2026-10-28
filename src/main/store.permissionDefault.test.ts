// The built-in default moved from Plan to Auto. Stores written before that
// say `plan` without anyone having chosen it; the move happens once, and a
// Plan picked afterwards stays.

import { describe, expect, it } from 'vitest';
import { useTestHost } from './testHost';
import { migratePermissionDefault } from './store';

useTestHost(() => '/tmp/overcli-permission-default');

describe('migratePermissionDefault', () => {
  it('moves an old store on plan to auto and marks it', () => {
    expect(migratePermissionDefault({ defaultPermissionMode: 'plan' })).toEqual({
      defaultPermissionMode: 'auto',
      permissionDefaultsVersion: 2,
      permissionDefaultMovedFromPlan: true,
    });
  });

  it('keeps any other mode an old store had', () => {
    expect(migratePermissionDefault({ defaultPermissionMode: 'acceptEdits' })).toMatchObject({
      defaultPermissionMode: 'acceptEdits',
      permissionDefaultsVersion: 2,
    });
  });

  it('leaves a migrated store alone, so plan picked later stays', () => {
    const stored = { defaultPermissionMode: 'plan' as const, permissionDefaultsVersion: 2 };
    expect(migratePermissionDefault(stored)).toBe(stored);
    expect(migratePermissionDefault({ defaultPermissionMode: 'plan', permissionDefaultsVersion: 1 })).toEqual({ defaultPermissionMode: 'plan', permissionDefaultsVersion: 2 });
  });

  it('shows the notice once to a nightly store moved to auto without it', () => {
    expect(migratePermissionDefault({ defaultPermissionMode: 'auto', permissionDefaultsVersion: 1 })).toEqual({
      defaultPermissionMode: 'auto',
      permissionDefaultsVersion: 2,
      permissionDefaultMovedFromPlan: true,
    });
    // Dismissed already: it stays dismissed.
    expect(migratePermissionDefault({ defaultPermissionMode: 'auto', permissionDefaultsVersion: 1, permissionDefaultMovedFromPlan: false })).toEqual({
      defaultPermissionMode: 'auto',
      permissionDefaultsVersion: 2,
      permissionDefaultMovedFromPlan: false,
    });
  });
});
