import { describe, expect, it } from 'vitest';
import { LABS, NEWCOMER_LABS, labOn } from './labs';

describe('labOn', () => {
  it('treats settings from before Labs existed as everything on, except labs added since', () => {
    for (const { key } of LABS) expect(labOn(undefined, key)).toBe(key !== 'processes');
    for (const { key } of LABS) expect(labOn({}, key)).toBe(key !== 'processes');
  });

  it('keeps Processes off until it is switched on', () => {
    expect(labOn({ workers: true }, 'processes')).toBe(false);
    expect(labOn({ processes: true }, 'processes')).toBe(true);
  });

  it('starts a new install with Workers on and every other lab off', () => {
    for (const { key } of LABS) expect(labOn(NEWCOMER_LABS, key)).toBe(key === 'workers');
  });

  it('honours one switch without touching the others', () => {
    const labs = { ...NEWCOMER_LABS, compare: true };
    expect(labOn(labs, 'compare')).toBe(true);
    expect(labOn(labs, 'orchestrator')).toBe(false);
  });
});
