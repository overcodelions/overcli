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
      permissionDefaultsVersion: 1,
    });
  });

  it('keeps any other mode an old store had', () => {
    expect(migratePermissionDefault({ defaultPermissionMode: 'acceptEdits' })).toMatchObject({
      defaultPermissionMode: 'acceptEdits',
      permissionDefaultsVersion: 1,
    });
  });

  it('leaves a migrated store alone, so plan picked later stays', () => {
    const stored = { defaultPermissionMode: 'plan' as const, permissionDefaultsVersion: 1 };
    expect(migratePermissionDefault(stored)).toBe(stored);
  });
});
