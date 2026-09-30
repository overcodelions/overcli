// The crew's away mode, in the words and dates the rail and the banner share.
//
// Return dates are always a MORNING — 9am local — because "back Monday" means
// the crew is working when you sit down on Monday, not at midnight while you
// are still asleep, and not at whatever minute of the day you happened to
// press the button.

import type { WorkersAway } from '@shared/flows/worker';

const RETURN_HOUR = 9;

/// 9am on the day `days` after `now`'s day, local time.
export function morningAfter(now: number, days: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(RETURN_HOUR, 0, 0, 0);
  return d.getTime();
}

/// 9am on the next Monday strictly after today.
export function nextMondayMorning(now: number): number {
  const day = new Date(now).getDay(); // 0 = Sunday
  const ahead = ((8 - day) % 7) || 7;
  return morningAfter(now, ahead);
}

/// A `<input type="date">` value (YYYY-MM-DD) as 9am that day, local time.
export function morningOf(dateValue: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), RETURN_HOUR, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/// The reverse, for pre-filling the date input.
export function dateValueOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/// "Mon 6 Oct", or "tomorrow" when it is.
export function returnLabel(until: number, now: number): string {
  if (dateValueOf(until) === dateValueOf(morningAfter(now, 1))) return 'tomorrow';
  return new Date(until).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/// The one line both the rail and the banner lead with.
export function awayLine(away: WorkersAway, now: number): string {
  return away.until === undefined ? 'Away until you’re back' : `Away · back ${returnLabel(away.until, now)}`;
}
