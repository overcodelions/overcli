// Five-field cron, for the schedules and worker cadences the two preset
// shapes cannot say.
//
// The presets in `schedule.ts` stay the front door — they read back as plain
// English and nobody has to be taught them. But "the 1st and 15th", "every
// Monday in Q1", "twice an hour at :05 and :35" have no preset, and until now
// the answer was "you can't". This is the escape hatch: one standard syntax
// people already know, parsed once here so the engine, the calendar and the
// CI generator all agree on what it means.
//
// Deliberately NOT a dependency. The whole surface is `minute hour dom month
// dow` with `*`, `,`, `-`, `/` and names — a hundred lines — and a scheduler
// this load-bearing should not have a supply-chain edge for it. What we
// don't support (seconds, `L`, `W`, `#`, `?` as anything but `*`) is
// rejected at parse time with a reason, rather than silently mis-fired.
//
// Times are LOCAL, like every other trigger: "0 9 * * 1" means 9am where the
// user is, on both sides of a daylight-saving switch.

/// A parsed expression. Each set holds the values that field matches;
/// `domRestricted`/`dowRestricted` are kept because standard cron's
/// day-of-month/day-of-week pair is an OR when both are restricted and an AND
/// otherwise — the sets alone cannot tell "*" from "0-6".
export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  /// 1–12.
  months: Set<number>;
  /// 0–6, Sunday = 0.
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string };

/// The shorthands people type without thinking, expanded before parsing.
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: string[];
  /// Offset applied to a name's index to get its numeric value (months are
  /// 1-based, weekdays 0-based).
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { label: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

export function parseCron(input: string): CronParse {
  const inputValue = input ?? '';
  if (/[^\S ]/.test(inputValue)) return { ok: false, error: 'Cron expressions may only use spaces as whitespace.' };
  const raw = inputValue.trim().toLowerCase();
  if (!raw) return { ok: false, error: 'Enter a cron expression, like 0 9 * * 1-5.' };
  const expanded = Object.hasOwn(MACROS, raw) ? MACROS[raw] : raw;
  if (expanded.startsWith('@')) {
    return {
      ok: false,
      error: `${raw} isn't a shorthand this understands. Use @hourly, @daily, @weekly, @monthly or @yearly — or write the five fields out.`,
    };
  }
  // `?` is Quartz's "no specific value" and appears in pasted expressions
  // where a `*` would do. Normalized here rather than inside `parseField`,
  // because the day-field restriction flags below read the raw token — a `?`
  // counted as restricted turns the dom/dow AND into an OR and fires the
  // schedule every day.
  const parts = expanded.split(/\s+/).map((p) => (p === '?' ? '*' : p));
  if (parts.length === 6) {
    // Quartz (and Spring) put seconds first. Firing a schedule an hour early
    // because a field shifted is the worst possible way to find that out.
    return {
      ok: false,
      error: 'That looks like a 6-field (seconds) expression. Use five fields: minute hour day-of-month month day-of-week.',
    };
  }
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `A cron expression has five fields (minute hour day-of-month month day-of-week); that has ${parts.length}.`,
    };
  }

  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i], FIELDS[i]);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    sets.push(parsed.values);
  }

  // `7` is a second spelling of Sunday in every cron implementation worth
  // matching, and `0-7` is the idiomatic "every day".
  const daysOfWeek = new Set<number>();
  for (const d of sets[4]) daysOfWeek.add(d === 7 ? 0 : d);

  return {
    ok: true,
    fields: {
      minutes: sets[0],
      hours: sets[1],
      daysOfMonth: sets[2],
      months: sets[3],
      daysOfWeek,
      domRestricted: parts[2] !== '*',
      dowRestricted: parts[4] !== '*',
    },
  };
}

function parseField(field: string, spec: FieldSpec): { values: Set<number> } | { error: string } {
  const values = new Set<number>();
  for (const term of field.split(',')) {
    if (!term) return { error: `Empty ${spec.label} field.` };
    const [rangePart, stepPart, ...rest] = term.split('/');
    if (rest.length > 0) return { error: `Too many / in the ${spec.label} field: "${term}".` };
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        return { error: `Step must be a whole number above zero in the ${spec.label} field: "${term}".` };
      }
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      const from = fieldValue(a, spec);
      const to = fieldValue(b, spec);
      if (from === null || to === null) {
        return { error: `"${rangePart}" isn't a ${spec.label} this understands.` };
      }
      if (from > to) {
        // A descending range is the wrapping window people expect from our
        // own `window:` shape, and cron simply has no such thing. Say so
        // rather than quietly matching nothing.
        return { error: `The ${spec.label} range "${rangePart}" runs backwards. Write it as two terms: "${rangePart.split('-')[0]}-${spec.max},${spec.min}-${rangePart.split('-')[1]}".` };
      }
      lo = from;
      hi = to;
    } else {
      const v = fieldValue(rangePart, spec);
      if (v === null) return { error: `"${rangePart}" isn't a ${spec.label} this understands.` };
      lo = v;
      // A bare value with a step means "from here to the end of the field",
      // the standard reading of `*/n`'s sibling `5/15`.
      hi = stepPart === undefined ? v : spec.max;
    }
    if (lo < spec.min || hi > spec.max) {
      return { error: `The ${spec.label} field takes ${spec.min}–${spec.max}; "${term}" is outside that.` };
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) return { error: `The ${spec.label} field "${field}" matches nothing.` };
  return { values };
}

function fieldValue(token: string, spec: FieldSpec): number | null {
  const t = token.trim();
  if (!t) return null;
  if (spec.names) {
    const idx = spec.names.indexOf(t);
    if (idx >= 0) return idx + (spec.nameBase ?? 0);
  }
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/// How far ahead `nextCronOccurrence` will look before giving up. Four years
/// clears a leap day, so the only expressions that exhaust it are the ones
/// that genuinely never match (31 February).
const MAX_SEARCH_DAYS = 366 * 4;

/// Next matching minute strictly after `afterMs`, in local time.
///
/// `Infinity` when the expression cannot match — same contract as
/// `nextOccurrenceAfter` for a clockless trigger, so the engine's nearest-due
/// reduction leaves it alone rather than arming a timer for it.
export function nextCronOccurrence(fields: CronFields, afterMs: number): number {
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);
  const from = new Date(afterMs);
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    if (!fields.months.has(day.getMonth() + 1)) continue;
    if (!matchesDay(fields, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
        // Strictly after: an occurrence landing exactly on the anchor is the
        // one that just fired.
        if (at > afterMs) return at;
      }
    }
  }
  return Number.POSITIVE_INFINITY;
}

/// Standard cron's day rule: when BOTH day fields are restricted a date
/// matches if EITHER does ("0 0 1,15 * 1" is the 1st, the 15th, and every
/// Monday). When only one is restricted it alone decides.
function matchesDay(fields: CronFields, day: Date): boolean {
  const dom = fields.daysOfMonth.has(day.getDate());
  const dow = fields.daysOfWeek.has(day.getDay());
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

/// Parse-and-check, for validation: the error string, or `null` if the
/// expression is usable. An expression that parses but can never match (31
/// February) is an error too — saving it would produce a schedule that looks
/// armed and never fires.
export function cronError(expr: string, now: number = Date.now()): string | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return parsed.error;
  if (!Number.isFinite(nextCronOccurrence(parsed.fields, now))) {
    return 'That expression has no next occurrence — check the day and month fields.';
  }
  return null;
}

/// The gap between the next two occurrences, in minutes. Used to keep a
/// worker off a cadence too fast to be a shift; `Infinity` for an expression
/// with fewer than two occurrences ahead.
export function cronIntervalMinutes(fields: CronFields, now: number = Date.now()): number {
  let previous = nextCronOccurrence(fields, now - 1);
  if (!Number.isFinite(previous)) return Number.POSITIVE_INFINITY;
  const end = previous + 24 * 60 * 60_000;
  let minimum = Number.POSITIVE_INFINITY;
  while (previous < end) {
    const next = nextCronOccurrence(fields, previous);
    if (!Number.isFinite(next)) break;
    minimum = Math.min(minimum, (next - previous) / 60_000);
    previous = next;
  }
  return minimum;
}
