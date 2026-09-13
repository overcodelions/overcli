import { describe, expect, it } from 'vitest';
import { countLevels, filterLog } from './logFilter';

const log = [
  '  .   ____          _',
  '[INFO ] 2026-09-12T14:44:08,630 [main] [] [c.z.r.Application:597] - Starting',
  '[DEBUG] 2026-09-12T14:44:08,631 [main] [] [o.s.b.ConfigFileApplicationListener:172] - Loaded config file',
  '\tat org.example.Debugging.frame(Debugging.java:1)',
  '[ERROR] 2026-09-12T14:44:09,001 [main] [] [o.s.b.SpringApplication:771] - Application startup failed',
  '\tat org.example.Broken.frame(Broken.java:9)',
  '[WARN ] 2026-09-12T14:44:09,500 [main] [] [o.h.UUIDHexGenerator:58] - Deprecated generator',
];

const texts = (hidden: string[]) =>
  filterLog(log, { hidden: new Set(hidden as never[]) }).map((l) => l.text);

describe('filtering by level', () => {
  it('hides the records of a level', () => {
    expect(texts(['debug'])).not.toContain(log[2]);
    expect(texts(['debug'])).toContain(log[1]);
  });

  it('takes a record’s continuation lines with it', () => {
    // A frame has no level of its own. Left behind, it reads as part of
    // whatever record is still showing above it.
    const shown = texts(['debug']);
    expect(shown).not.toContain(log[3]);
    // …and keeps them with a record that is still showing.
    expect(shown).toContain(log[5]);
  });

  it('always shows what comes before the first record', () => {
    expect(texts(['info', 'debug', 'error', 'warn'])).toEqual([log[0]]);
  });

  it('shows everything when nothing is hidden', () => {
    expect(texts([])).toHaveLength(log.length);
  });

  it('combines with the problems filter', () => {
    const shown = filterLog(log, { level: 'problems', hidden: new Set(['error'] as const) });
    expect(shown.map((l) => l.text)).not.toContain(log[4]);
  });
});

describe('counting levels', () => {
  it('counts records, not the lines inside them', () => {
    expect(countLevels(log)).toEqual({ error: 1, warn: 1, info: 1, debug: 1, trace: 0 });
  });
});
