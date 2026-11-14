import { describe, expect, it } from 'vitest';
import { CapacityRecorder, assessCapacity, capacityHealth, foldSample, machineLoad, type CapacityHour, type CapacitySample } from './capacity';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 2, 9, 0);

function sample(over: { answers?: number; answersWaiting?: number; code?: number; codeWaiting?: number; cpu?: number; mem?: number } = {}): CapacitySample {
  return {
    answers: { inUse: over.answers ?? 0, waiting: over.answersWaiting ?? 0, cap: 32 },
    code: { running: over.code ?? 0, waiting: over.codeWaiting ?? 0, cap: 8 },
    cpu: over.cpu ?? 0.3,
    mem: over.mem ?? 0.4,
  };
}

/// `days` working days of 8 busy hours, a sample a minute, each made by `make`.
function week(days: number, make: (day: number, hour: number, minute: number) => CapacitySample): { hours: CapacityHour[]; now: number } {
  let hours: CapacityHour[] = [];
  for (let d = 0; d < days; d++) for (let hr = 0; hr < 8; hr++) for (let m = 0; m < 60; m++) hours = foldSample(hours, make(d, hr, m), T0 + d * DAY + hr * HOUR + m * 60_000);
  return { hours, now: T0 + (days - 1) * DAY + 9 * HOUR };
}

describe('folding samples into hours', () => {
  it('keeps one record an hour, with its peaks and how often work waited', () => {
    let hours: CapacityHour[] = [];
    hours = foldSample(hours, sample({ answers: 3, cpu: 0.2 }), T0);
    hours = foldSample(hours, sample({ answers: 7, answersWaiting: 2, cpu: 0.6 }), T0 + 60_000);
    hours = foldSample(hours, sample({ code: 2 }), T0 + HOUR);
    expect(hours).toHaveLength(2);
    expect(hours[0]).toMatchObject({ at: T0, n: 2, answersPeak: 7, answersWaitN: 1, cpuPeak: 0.6, answersCap: 32, codeCap: 8 });
    expect(hours[0].cpuSum).toBeCloseTo(0.8);
    expect(hours[1]).toMatchObject({ n: 1, codePeak: 2 });
  });

  it('forgets what is over a fortnight old', () => {
    let hours = foldSample([], sample(), T0);
    hours = foldSample(hours, sample(), T0 + 15 * DAY);
    expect(hours.map((h) => h.at)).toEqual([T0 + 15 * DAY]);
  });
});

describe('judging the size', () => {
  it('waits for a couple of days before saying anything', () => {
    const { hours, now } = week(1, () => sample({ answers: 30, answersWaiting: 5 }));
    expect(assessCapacity(hours, now).verdict).toBe('learning');
    expect(capacityHealth(assessCapacity(hours, now)).ok).toBeNull();
  });

  it('says raise the limits when work waits and the box has room', () => {
    const { hours, now } = week(3, (_d, _h, m) => sample({ answers: 32, code: 8, codeWaiting: m < 20 ? 2 : 0, cpu: 0.5 }));
    const a = assessCapacity(hours, now);
    expect(a.verdict).toBe('raise');
    expect(a.detail).toMatch(/code runs waited 33%/);
    expect(capacityHealth(a).ok).toBe(false);
  });

  it('says a bigger box when the machine itself is full, whatever the limits', () => {
    const { hours, now } = week(3, (_d, hr) => sample({ answers: 10, code: 8, codeWaiting: 1, cpu: hr < 3 ? 0.95 : 0.5 }));
    const a = assessCapacity(hours, now);
    expect(a.verdict).toBe('more');
    expect(a.title).toMatch(/bigger/);
  });

  it('says a smaller box after a quiet week, and about right in between', () => {
    const quiet = week(4, () => sample({ answers: 4, code: 1, cpu: 0.2, mem: 0.3 }));
    expect(assessCapacity(quiet.hours, quiet.now).verdict).toBe('less');
    expect(capacityHealth(assessCapacity(quiet.hours, quiet.now)).ok).toBe(true);
    const fine = week(4, () => sample({ answers: 20, code: 5, cpu: 0.6, mem: 0.5 }));
    const a = assessCapacity(fine.hours, fine.now);
    expect(a.verdict).toBe('right');
    expect(a.peak).toMatchObject({ answers: 20, answersCap: 32, code: 5, codeCap: 8 });
    expect(a.detail).toMatch(/20 of 32 answers and 5 of 8 code runs/);
  });

  it('judges on busy hours, so a quiet night does not hide a busy day', () => {
    const { hours, now } = week(3, (_d, hr, m) => (hr < 2 ? sample({ answers: 32, answersWaiting: m < 10 ? 1 : 0 }) : sample()));
    expect(assessCapacity(hours, now).verdict).toBe('raise');
  });
});

describe('the recorder', () => {
  it('samples into its store and reads it back', () => {
    let saved: { hours: CapacityHour[] } = { hours: [] };
    let now = T0;
    const rec = new CapacityRecorder({ sample: () => sample({ answers: 2 }), store: { load: () => saved, save: (v) => (saved = v) }, now: () => now });
    rec.tick();
    now += 60_000;
    rec.tick();
    expect(saved.hours[0].n).toBe(2);
    expect(new CapacityRecorder({ sample: () => sample(), store: { load: () => saved, save: () => {} }, now: () => now }).report().hours).toHaveLength(1);
    expect(rec.health().name).toBe('Capacity');
  });
});

describe('reading the machine', () => {
  it('uses the container\'s memory limit when it has one', () => {
    const files: Record<string, string> = { '/sys/fs/cgroup/memory.current': '1073741824\n', '/sys/fs/cgroup/memory.max': '4294967296\n' };
    expect(machineLoad((f) => files[f] ?? null)().mem).toBeCloseTo(0.25);
  });

  it('counts CPU from the container\'s usage against its CPUs', () => {
    let usage = 0;
    const files = (f: string) => (f === '/sys/fs/cgroup/cpu.stat' ? `usage_usec ${usage}\n` : f === '/sys/fs/cgroup/cpu.max' ? '200000 100000\n' : null);
    const read = machineLoad(files);
    expect(read().cpu).toBe(0);
    const started = Date.now();
    while (Date.now() - started < 20) { /* let time pass */ }
    const elapsedUs = (Date.now() - started) * 1000;
    usage = elapsedUs; // one CPU's worth, of two
    expect(read().cpu).toBeGreaterThan(0.3);
    expect(read().cpu).toBeLessThanOrEqual(1);
  });

  it('falls back to the OS, and never says more than full', () => {
    const l = machineLoad(() => null)();
    expect(l.cpu).toBeGreaterThanOrEqual(0);
    expect(l.mem).toBeGreaterThan(0);
    expect(l.mem).toBeLessThanOrEqual(1);
  });
});
