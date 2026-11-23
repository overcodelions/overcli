// Is this server the right size? Once a minute it notes how many answers and
// code runs are going and waiting (flows/pools.ts) and how busy the box is,
// folded into one record per hour and kept a fortnight. From the last week of
// that, Setup → Capacity and Readiness say whether it needs more, could do
// with less, or is about right.
//
// Samples are shares of what the machine has, so a week from before a resize
// says nothing about the size it is now. Each hour notes the machine's size;
// when it changes, only the hours since count. An admin can also start over
// by hand ("Judge from now on"), for a change the size doesn't show.

import fs from 'node:fs';
import os from 'node:os';
import type { HealthItem } from './orgService';

export interface CapacitySample {
  answers: { inUse: number; waiting: number; cap: number | null };
  code: { running: number; waiting: number; cap: number | null };
  /// The box: CPU busy and memory used, as shares of what it has (0 to 1).
  cpu: number;
  mem: number;
  /// What the machine has: CPUs and memory, the container's limits when it has them.
  size?: { cpus: number; memBytes: number };
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
  /// The machine's size that hour. Absent on hours from before it was noted.
  cpus?: number;
  memBytes?: number;
}

export type CapacityVerdict = 'learning' | 'more' | 'raise' | 'right' | 'less';

export interface CapacityAssessment {
  verdict: CapacityVerdict;
  title: string;
  detail: string;
  /// The week's busiest: what peaked, against the limit then.
  peak: { answers: number; answersCap: number | null; code: number; codeCap: number | null; cpu: number; mem: number } | null;
  /// Judged only from here: the machine was resized, or an admin started
  /// over. `before`: what the hours before it said, when they said anything.
  since?: { at: number; why: 'resized' | 'reset'; before?: { verdict: CapacityVerdict; title: string } };
}

/// What the recorder keeps: the hours, and when an admin last started over.
export interface CapacityStore {
  hours: CapacityHour[];
  since?: number;
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
  if (s.size) {
    cur.cpus = s.size.cpus;
    cur.memBytes = s.size.memBytes;
  }
  return kept;
}

/// The first hour on the size the machine has now, when it changed size in
/// what's kept. Hours from before sizes were noted are no evidence of a change.
export function lastResize(hours: readonly CapacityHour[]): number | null {
  const sized = hours.filter((h) => h.cpus !== undefined && h.memBytes !== undefined);
  for (let i = sized.length - 1; i > 0; i--) if (!sameSize(sized[i], sized[i - 1])) return sized[i].at;
  return null;
}

function sameSize(a: CapacityHour, b: CapacityHour): boolean {
  return Math.abs(a.cpus! - b.cpus!) < 0.05 && Math.abs(a.memBytes! - b.memBytes!) <= 0.05 * Math.max(a.memBytes!, b.memBytes!);
}

function agoText(ms: number): string {
  const hours = Math.round(ms / HOUR);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/// The verdict, from the last week, or only from a resize or a start-over
/// inside it (`since`, an admin's). The later of the two wins.
export function assessCapacity(all: CapacityHour[], now: number, opts: { since?: number } = {}): CapacityAssessment {
  const resized = lastResize(all);
  const start =
    opts.since !== undefined && (resized === null || opts.since >= resized)
      ? { at: opts.since, why: 'reset' as const, from: Math.ceil(opts.since / HOUR) * HOUR }
      : resized !== null
        ? // The hour it changed in mixes both sizes: start after it.
          { at: resized, why: 'resized' as const, from: resized + HOUR }
        : null;
  // A start before the week leaves the whole week on the size it is now.
  if (!start || start.at <= now - WEEK) return judge(all, now);
  // Before: up to the change. The hour a resize happened in counts for neither size.
  const prior = judge(all.filter((h) => h.at < start.at), start.at);
  const since = { at: start.at, why: start.why, ...(prior.verdict !== 'learning' ? { before: { verdict: prior.verdict, title: prior.title } } : {}) };
  const a = judge(all.filter((h) => h.at >= start.from), now);
  if (a.verdict !== 'learning') return { ...a, since };
  const what = start.why === 'resized' ? 'The machine was resized' : 'Judging started afresh';
  return {
    verdict: 'learning',
    title: start.why === 'resized' ? 'Resized: learning how the new size does' : 'Starting afresh: learning how busy it gets',
    detail: `${what} ${agoText(now - start.at)}, so only what has happened since counts. After a couple of days it says whether this size is right.${since.before ? ` Before that it said: ${since.before.title}.` : ''}`,
    peak: null,
    since,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const of = (n: number, cap: number | null) => (cap === null ? `${n} (no limit)` : `${n} of ${cap}`);

function judge(all: CapacityHour[], now: number): CapacityAssessment {
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
  private since: number | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      sample: () => CapacitySample;
      store: { load(): CapacityStore; save(value: CapacityStore): void };
      now?: () => number;
    },
  ) {
    const stored = deps.store.load();
    this.hours = Array.isArray(stored.hours) ? stored.hours : [];
    this.since = typeof stored.since === 'number' ? stored.since : undefined;
  }

  private save(): void {
    this.deps.store.save({ hours: this.hours, ...(this.since !== undefined ? { since: this.since } : {}) });
  }

  /// Judge only what happens from now on: "Judge from now on" on Setup →
  /// Capacity. The hours stay, for the chart.
  startOver(): void {
    this.since = this.now();
    this.save();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  tick(): void {
    this.hours = foldSample(this.hours, this.deps.sample(), this.now());
    this.save();
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
    return { hours: this.hours, assessment: assessCapacity(this.hours, this.now(), { since: this.since }) };
  }

  health(): HealthItem {
    return capacityHealth(assessCapacity(this.hours, this.now(), { since: this.since }));
  }
}

/// How busy the machine is. In a container with cgroup v2 limits, against
/// those limits (what the container may use), since the OS's own figures are
/// the whole host's; elsewhere, the OS's. CPU is the share busy since the
/// last reading.
export function machineLoad(read: (file: string) => string | null = readQuiet): () => { cpu: number; mem: number; size: { cpus: number; memBytes: number } } {
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
    let memBytes = os.totalmem();
    const current = Number(read('/sys/fs/cgroup/memory.current')?.trim());
    const limit = read('/sys/fs/cgroup/memory.max')?.trim();
    if (Number.isFinite(current) && limit && limit !== 'max' && Number(limit) > 0) {
      // memory.current counts the file cache too, which the kernel takes back
      // under pressure; a git- and build-heavy box would read as full. Leave
      // out the inactive part of it, as `docker stats` does.
      const inactive = Number(/^inactive_file\s+(\d+)/m.exec(read('/sys/fs/cgroup/memory.stat') ?? '')?.[1]);
      mem = Math.max(0, current - (Number.isFinite(inactive) ? inactive : 0)) / Number(limit);
      memBytes = Number(limit);
    }
    else {
      // Free memory leaves out the cache the kernel gives back on demand; what's available counts it.
      const available = Number(/MemAvailable:\s+(\d+) kB/.exec(read('/proc/meminfo') ?? '')?.[1]) * 1024;
      mem = 1 - (Number.isFinite(available) && available > 0 ? available : os.freemem()) / os.totalmem();
    }
    return { cpu: clamp(cpu), mem: clamp(mem), size: { cpus: cpus(), memBytes } };
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
