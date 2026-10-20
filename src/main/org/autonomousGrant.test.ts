import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { autonomousWithoutGrant } from './orgService';

const w = (name: string, trust: Worker['trust'], allowExternalActions?: boolean) =>
  ({ id: name, name, trust, caps: { maxItemsPerShift: 3, ...(allowExternalActions ? { allowExternalActions } : {}) } }) as unknown as Worker;

describe('autonomousWithoutGrant', () => {
  it('gives the grant only to autonomous workers missing it', () => {
    const fixed = autonomousWithoutGrant([w('Vantage', 'autonomous'), w('Forge', 'trusted'), w('Hugo', 'autonomous', true)]);
    expect(fixed.map((x) => x.name)).toEqual(['Vantage']);
    expect(fixed[0].caps.allowExternalActions).toBe(true);
    expect(fixed[0].caps.maxItemsPerShift).toBe(3);
  });
});
