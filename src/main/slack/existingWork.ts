// "What's the roadmap for Q1 2027?" — when a team finished exactly that this
// morning, the answer is that, not a worker starting it again from scratch.
//
// Pure: which messages read as a lookup, the words worth matching on, and how
// well a finished piece of work (a team task, a kept file, a worker's report
// or answer, a process item) matches them. The front door asks first; the
// Library behind it already holds only what the person may see.

import type { LibraryItem } from '../org/orgService';

/// A finished piece of work that may already answer the request.
export interface ExistingHit {
  kind: 'team' | 'worker' | 'process' | 'file';
  title: string;
  /// The team or worker (or process) that made it.
  who: string;
  at: number;
  /// Two or three sentences of what it says.
  summary: string;
  /// Where to open it in the console, when the org has a public address.
  url?: string;
  teamTaskId?: string;
  workerId?: string;
  teamId?: string;
  /// Where it stands, in words: "waiting on your review".
  status?: string;
  /// Related but not a match: never shown, only a hint to the router.
  weak?: boolean;
}

/// A piece of work as the matcher sees it.
export interface WorkCandidate {
  hit: Omit<ExistingHit, 'summary' | 'weak'>;
  /// The full text behind it (a pack's summary, a report, an answer): matched
  /// on, and cut down for the summary.
  body?: string;
  /// The same task, seen twice (a task and a file kept from it): the task wins.
  group?: string;
}

/// "what/whats/where/which…", "show me", "find", "latest", "status of", "do we have", "is there", or a "?".
const LOOKUP = /^(?:(?:so|ok|okay|hey|hi|and|also|quick q(?:uestion)?)[,:!\s]+)?(?:what(?:'s|’s|s| is| are| was| were)?|where(?:'s|’s|s)?|which|who(?:'s|’s)? (?:made|wrote|did|has)|show me|find(?: me)?|look up|latest|status of|do we have|is there|are there|have we|did we|did (?:anyone|someone|the)|has (?:anyone|someone|the)|any (?:news|update)s? on)\b/i;
/// A request to make something, even phrased as a question: "can you write me a plan?"
const MAKE = /^(?:(?:can|could|would|will) (?:you|someone|somebody)|please|pls|go|let'?s)\s+(?:please\s+)?(?:write|draft|make|build|create|fix|add|start|plan|prepare|put together|design|research|analy[sz]e|review|update|change|run)\b/i;

/// Whether a message reads as a question or a lookup, not a request to make something.
export function isLookup(text: string): boolean {
  const t = text.trim();
  if (!t || MAKE.test(t)) return false;
  return LOOKUP.test(t) || /\?\s*$/.test(t);
}

/// Words that carry no subject: question words, filler, and what everyone says about work.
const STOP = new Set(
  ('a about an and any anyone are as at be been but by can could did do does doing done for from get got had has have hey hi how i if in into is it its ' +
    'just know latest let like look me my need new of ok okay on or our out please pls quick see should show so some someone something status ' +
    'tell than thanks that the their them then there these they this those to up us was we were what whats when where which who why will with ' +
    'would you your find made make wrote current currently').split(' '),
);

/// "roadmaps" and "roadmap" are the same word here.
function stem(w: string): string {
  return w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function tokens(text: string): string[] {
  return rawTokens(text).map(stem);
}

/// The request's words worth matching: no question words or filler; years,
/// quarters and other short words with a digit kept ("q1", "2027", "v2").
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of rawTokens(text)) {
    const w = stem(raw);
    if (STOP.has(raw) || STOP.has(w) || out.includes(w)) continue;
    if (w.length > 2 || /\d/.test(w)) out.push(w);
  }
  return out.slice(0, 12);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/// Older than this, it's history, not an answer.
export const RECENT_DAYS = 30;
/// Shown only when it covers at least this much of the request, in at least this many words.
export const STRONG_COVERAGE = 2 / 3;
export const STRONG_WORDS = 2;
/// Passed to the router as related when it covers at least this much.
export const WEAK_COVERAGE = 1 / 3;
export const MAX_SHOWN = 3;
export const MAX_RELATED = 5;

export interface Scored {
  candidate: WorkCandidate;
  /// Content words found anywhere in it.
  matched: number;
  coverage: number;
  rank: number;
}

/// How well one piece of work matches the request's words: a word in its
/// title counts twice what a word only in its body does, newer counts more,
/// and a team task or a file someone kept is preferred to a passing answer.
export function score(words: string[], c: WorkCandidate, now: number): Scored | null {
  const age = (now - c.hit.at) / DAY_MS;
  if (!words.length || age > RECENT_DAYS) return null;
  const title = new Set(tokens(`${c.hit.title} ${c.hit.who}`));
  const body = new Set(tokens(c.body ?? ''));
  let inTitle = 0;
  let matched = 0;
  for (const w of words) {
    if (title.has(w)) inTitle++;
    if (title.has(w) || body.has(w)) matched++;
  }
  if (!matched) return null;
  const coverage = matched / words.length;
  const weighted = (inTitle * 2 + (matched - inTitle)) / (words.length * 2);
  const fresh = 1 - Math.max(0, age) / (RECENT_DAYS * 2);
  const kind = c.hit.kind === 'team' ? 0.1 : c.hit.kind === 'file' ? 0.05 : c.hit.kind === 'process' ? 0.03 : 0;
  return { candidate: c, matched, coverage, rank: weighted * fresh + kind };
}

/// What to show (strong matches, best first, one per task) and what to hint
/// at (weaker ones). Few content words, nothing shown: "what's up?" isn't a lookup of anything.
export function matchExisting(text: string, candidates: WorkCandidate[], now: number): ExistingHit[] {
  const words = contentWords(text);
  if (!words.length) return [];
  const scored = candidates
    .map((c) => score(words, c, now))
    .filter((s): s is Scored => !!s && s.coverage >= WEAK_COVERAGE)
    .sort((a, b) => b.rank - a.rank);
  const seen = new Set<string>();
  const strong: Scored[] = [];
  const weak: Scored[] = [];
  for (const s of scored) {
    const group = s.candidate.group;
    if (group && seen.has(group)) continue;
    if (group) seen.add(group);
    if (s.coverage >= STRONG_COVERAGE && s.matched >= STRONG_WORDS) {
      if (strong.length < MAX_SHOWN) strong.push(s);
    } else if (weak.length < MAX_RELATED) weak.push(s);
  }
  return [
    ...strong.map((s) => ({ ...s.candidate.hit, summary: summarize(s.candidate.body ?? '') })),
    ...weak.map((s) => ({ ...s.candidate.hit, summary: '', weak: true })),
  ];
}

/// The first two or three sentences of a body, as plain text.
export function summarize(body: string, max = 360): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-=*_]{3,}$/.test(l) && !/^\|/.test(l))
    .map((l) => l.replace(/^[-*+]\s+|^\d+[.)]\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
  let out = '';
  for (const s of sentences.slice(0, 3)) {
    const next = `${out} ${s.trim()}`.trim();
    if (out && next.length > max) break;
    out = next;
  }
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/// "today", "yesterday", "3 days ago".
export function whenText(at: number, now: number): string {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return 'today';
  if (at >= startOfToday.getTime() - DAY_MS) return 'yesterday';
  return `${Math.max(2, Math.ceil((startOfToday.getTime() - at) / DAY_MS))} days ago`;
}

/// The Library's items as candidates: a team task as its team's, a kept file
/// as its task's (the task wins when both match), the rest as their
/// worker's. Failed work answers nothing. `consoleUrl`: links when the org
/// has a public address.
export function libraryCandidates(items: LibraryItem[], opts: { consoleUrl?: string; taskStatus?: (taskId: string) => string | undefined } = {}): WorkCandidate[] {
  const base = opts.consoleUrl?.replace(/\/+$/, '');
  const out: WorkCandidate[] = [];
  for (const x of items) {
    if (x.status === 'failed' || x.status === 'skipped' || !x.title.trim()) continue;
    const body = x.body?.slice(0, 20_000);
    const team = x.source.kind === 'team' ? x.source : null;
    if (x.kind === 'task' && team) {
      const status = opts.taskStatus?.(team.taskId);
      out.push({
        hit: { kind: 'team', title: x.title, who: team.teamName, at: x.at, teamTaskId: team.taskId, teamId: team.teamId, ...(base ? { url: `${base}/#teamtask/${encodeURIComponent(team.taskId)}` } : {}), ...(status ? { status } : {}) },
        ...(body ? { body } : {}),
        group: `task:${team.taskId}`,
      });
    } else if (x.kind === 'file' && team) {
      out.push({
        hit: { kind: 'file', title: x.title, who: team.teamName, at: x.at, teamTaskId: team.taskId, teamId: team.teamId, ...(base ? { url: `${base}/#read/${encodeURIComponent(x.id)}` } : {}) },
        ...(body ? { body } : {}),
        group: `task:${team.taskId}`,
      });
    } else if (x.workerId) {
      out.push({
        hit: { kind: 'worker', title: x.title, who: x.workerName, at: x.at, workerId: x.workerId, ...(base ? { url: `${base}/#read/${encodeURIComponent(x.id)}` } : {}) },
        ...(body ? { body } : {}),
      });
    }
  }
  return out;
}
