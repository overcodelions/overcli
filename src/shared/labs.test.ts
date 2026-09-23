import { describe, expect, it } from 'vitest';
import { LABS, NEWCOMER_LABS, labOn } from './labs';

describe('labOn', () => {
  it('treats settings from before Labs existed as everything on', () => {
    for (const { key } of LABS) expect(labOn(undefined, key)).toBe(true);
    for (const { key } of LABS) expect(labOn({}, key)).toBe(true);
  });

  it('starts a new install with every lab off', () => {
    for (const { key } of LABS) expect(labOn(NEWCOMER_LABS, key)).toBe(false);
  });

  it('honours one switch without touching the others', () => {
    const labs = { ...NEWCOMER_LABS, workers: true };
    expect(labOn(labs, 'workers')).toBe(true);
    expect(labOn(labs, 'orchestrator')).toBe(false);
  });
});
