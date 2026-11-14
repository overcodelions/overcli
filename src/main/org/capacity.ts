// Is this server the right size? Once a minute it notes how many answers and
// code runs are going and waiting (flows/pools.ts) and how busy the box is,
// folded into one record per hour and kept a fortnight. From the last week of
// that, Setup → Capacity and Readiness say whether it needs more, could do
// with less, or is about right.

import fs from 'node:fs';
import os from 'node:os';
import type { HealthItem } from './orgService';

export interface CapacitySample {
  answers: { inUse: number; waiting: number; cap: number | null };
  code: { running: number; waiting: number; cap: number | null };
  /// The box: CPU busy and memory used, as shares of what it has (0 to 1).
  cpu: number;
  mem: number;
}

/// One hour, folded. `n` samples; the `...N` fields count samples where it held.
export interface CapacityHour {
  at: number;
  n: number;
  answersPeak: number;
  answersCap: number | null;
  /// Samples with an answer waiting for a place.
  answersWaitN: number;
  codePeak: number;
  codeCap: number | null;
  /// Samples with a code run waiting for a place.
  codeWaitN: number;
  cpuPeak: number;
  cpuSum: number;
  memPeak: number;
}

export type CapacityVerdict = 'learning' | 'more' | 'raise' | 'right' | 'less';

export interface CapacityAssessment {
  verdict: CapacityVerdict;
  title: string;
  detail: string;
  /// The week's busiest: what peaked, against the limit then.
  peak: { answers: number; answersCap: number | null; code: number; codeCap: number | null; cpu: number; mem: number } | null;
}

export interface CapacityReport {
  hours: CapacityHour[];
  assessment: CapacityAssessment;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const KEEP_DAYS = 14;

/// The week to judge on, and what counts.
const WEEK = 7 * DAY;
/// Too little to say: under two days seen, or under two hours of samples.
const MIN_DAYS = 2;
const MIN_SAMPLES = 120;
/// Work waited for a place more than this share of the busy time.
const ANSWERS_WAITING = 0.05;
const CODE_WAITING = 0.2;
/// The box was this full in more than `BOX_FULL_HOURS` of the busy hours.
const CPU_FULL = 0.85;
const MEM_FULL = 0.9;
const BOX_FULL_HOURS = 0.1;
/// A week with every peak under a third of its limit, and the box under these: smaller would do.
const QUIET_SHARE = 1 / 3;
const CPU_QUIET = 0.5;
const MEM_QUIET = 0.6;
const MIN_DAYS_FOR_LESS = 3;

export function foldSample(hours: CapacityHour[], s: CapacitySample, now: number): CapacityHour[] {
  const at = Math.floor(now / HOUR) * HOUR;
  const kept = hours.filter((h) => h.at > now - KEEP_DAYS * DAY);
  let cur = kept[kept.length - 1];
  if (!cur || cur.at !== at) {
    cur = { at, n: 0, answersPeak: 0, answersCap: null, answersWaitN: 0, codePeak: 0, codeCap: null, codeWaitN: 0, cpuPeak: 0, cpuSum: 0, memPeak: 0 };
    kept.push(cur);
  }
  cur.n += 1;
  cur.answersPeak = Math.max(cur.answersPeak, s.answers.inUse);
  cur.answersCap = s.answers.cap;
  if (s.answers.waiting > 0) cur.answersWaitN += 1;
  cur.codePeak = Math.max(cur.codePeak, s.code.running);
  cur.codeCap = s.code.cap;
  if (s.code.waiting > 0) cur.codeWaitN += 1;
  cur.cpuPeak = Math.max(cur.cpuPeak, s.cpu);
  cur.cpuSum += s.cpu;
  cur.memPeak = Math.max(cur.memPeak, s.mem);
  return kept;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const of = (n: number, cap: number | null) => (cap === null ? `${n} (no limit)` : `${n} of ${cap}`);

export function assessCapacity(all: CapacityHour[], now: number): CapacityAssessment {
  const hours = all.filter((h) => h.at > now - WEEK && h.n > 0);
  const samples = hours.reduce((a, h) => a + h.n, 0);
  const days = new Set(hours.map((h) => Math.floor(h.at / DAY))).size;
  if (days < MIN_DAYS || samples < MIN_SAMPLES) {
    return { verdict: 'learning', title: 'Learning how busy it gets', detail: 'It notes how much is going once a minute. After a couple of days it says whether this server needs more, could do with less, or is about right.', peak: null };
  }
  const top = hours.reduce((a, h) => (h.answersPeak + h.codePeak > a.answersPeak + a.codePeak ? h : a), hours[0]);
  const peak = {
    answers: Math.max(...hours.map((h) => h.answersPeak)),
    answersCap: top.answersCap,
    code: Math.max(...hours.map((h) => h.codePeak)),
    codeCap: top.codeCap,
    cpu: Math.max(...hours.map((h) => h.cpuPeak)),
    mem: Math.max(...hours.map((h) => h.memPeak)),
  };
  const peaks = `Busiest this week: ${of(peak.answers, peak.answersCap)} answers and ${of(peak.code, peak.codeCap)} code runs at once, CPU ${pct(peak.cpu)}, memory ${pct(peak.mem)}.`;

  // Busy: an hour anything ran in. Nights and weekends would make any wait look rare.
  const busy = hours.filter((h) => h.answersPeak > 0 || h.codePeak > 0);
  const busyN = busy.reduce((a, h) => a + h.n, 0);
  const answersWait = busyN ? busy.reduce((a, h) => a + h.answersWaitN, 0) / busyN : 0;
  const codeWait = busyN ? busy.reduce((a, h) => a + h.codeWaitN, 0) / busyN : 0;
  const fullHours = busy.filter((h) => h.cpuSum / h.n >= CPU_FULL || h.memPeak >= MEM_FULL).length;
  const boxFull = busy.length > 0 && fullHours / busy.length > BOX_FULL_HOURS;
  const waited = [
    answersWait > ANSWERS_WAITING ? `answers waited for a place ${pct(answersWait)} of the busy time` : null,
    codeWait > CODE_WAITING ? `code runs waited ${pct(codeWait)} of it` : null,
  ].filter(Boolean);

  if (boxFull) {
    return {
      verdict: 'more',
      title: 'Needs a bigger box',
      detail: `The machine itself was nearly full (CPU or memory) in ${fullHours} of ${busy.length} busy hours${waited.length ? `, and ${waited.join('; ')}` : ''}. Move to one with more CPUs and memory; raising the limits here would only slow everything down. ${peaks}`,
      peak,
    };
  }
  if (waited.length) {
    return {
      verdict: 'raise',
      title: 'Work is waiting, and the box has room',
      detail: `This week ${waited.join('; ')}, while the machine stayed under ${pct(Math.max(CPU_FULL, peak.cpu))} CPU. Raise the limits below a little at a time and watch it here. ${peaks}`,
      peak,
    };
  }
  const quiet = (n: number, cap: number | null) => cap === null || n <= Math.max(1, cap * QUIET_SHARE);
  if (days >= MIN_DAYS_FOR_LESS && quiet(peak.answers, peak.answersCap) && quiet(peak.code, peak.codeCap) && peak.cpu < CPU_QUIET && peak.mem < MEM_QUIET) {
    return {
      verdict: 'less',
      title: 'Could do with a smaller box',
      detail: `Nothing came close to the limits all week, and the machine stayed under ${pct(CPU_QUIET)} CPU and ${pct(MEM_QUIET)} memory. A machine with about half the CPUs and memory would do, and cost less. ${peaks}`,
      peak,
    };
  }
  return { verdict: 'right', title: 'About right', detail: `Work rarely waited and the machine had room. ${peaks}`, peak };
}

/// What the Readiness line says.
export function capacityHealth(a: CapacityAssessment): HealthItem {
  return { name: 'Capacity', ok: a.verdict === 'learning' ? null : a.verdict === 'right' || a.verdict === 'less', detail: `${a.title}. ${a.detail}` };
}

export class CapacityRecorder {
  private hours: CapacityHour[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      sample: () => CapacitySample;
      store: { load(): { hours: CapacityHour[] }; save(value: { hours: CapacityHour[] }): void };
      now?: () => number;
    },
  ) {
    this.hours = Array.isArray(deps.store.load().hours) ? deps.store.load().hours : [];
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  tick(): void {
    this.hours = foldSample(this.hours, this.deps.sample(), this.now());
    this.deps.store.save({ hours: this.hours });
  }

  start(everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A sample that fails is a gap in the chart, never a crash.
      }
    }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  report(): CapacityReport {
    return { hours: this.hours, assessment: assessCapacity(this.hours, this.now()) };
  }

  health(): HealthItem {
    return capacityHealth(assessCapacity(this.hours, this.now()));
  }
}

/// How busy the machine is. In a container with cgroup v2 limits, against
/// those limits (what the container may use), since the OS's own figures are
/// the whole host's; elsewhere, the OS's. CPU is the share busy since the
/// last reading.
export function machineLoad(read: (file: string) => string | null = readQuiet): () => { cpu: number; mem: number } {
  let last: { usageUs: number; at: number } | null = null;
  const cpus = (): number => {
    const max = read('/sys/fs/cgroup/cpu.max')?.trim().split(/\s+/);
    if (max && max[0] !== 'max' && Number(max[0]) > 0 && Number(max[1]) > 0) return Number(max[0]) / Number(max[1]);
    return os.availableParallelism();
  };
  return () => {
    let cpu: number;
    const stat = read('/sys/fs/cgroup/cpu.stat');
    const usage = stat ? Number(/usage_usec\s+(\d+)/.exec(stat)?.[1]) : NaN;
    if (Number.isFinite(usage)) {
      const at = Date.now();
      cpu = last && at > last.at ? (usage - last.usageUs) / ((at - last.at) * 1000) / cpus() : 0;
      last = { usageUs: usage, at };
    } else {
      cpu = os.loadavg()[0] / os.availableParallelism();
    }
    let mem: number;
    const current = Number(read('/sys/fs/cgroup/memory.current')?.trim());
    const limit = read('/sys/fs/cgroup/memory.max')?.trim();
    if (Number.isFinite(current) && limit && limit !== 'max' && Number(limit) > 0) mem = current / Number(limit);
    else {
      // Free memory leaves out the cache the kernel gives back on demand; what's available counts it.
      const available = Number(/MemAvailable:\s+(\d+) kB/.exec(read('/proc/meminfo') ?? '')?.[1]) * 1024;
      mem = 1 - (Number.isFinite(available) && available > 0 ? available : os.freemem()) / os.totalmem();
    }
    return { cpu: clamp(cpu), mem: clamp(mem) };
  };
}

function clamp(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

function readQuiet(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
