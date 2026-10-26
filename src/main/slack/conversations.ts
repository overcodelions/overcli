// The console's Slack page: what people asked overgo in Slack, what came of
// each, and the thread itself, read from Slack when it is opened. Everyone
// sees what they asked; an admin sees everyone's.

import type { OrgCaller } from '../../shared/org/policy';
import { dayOf, type DoorDay, type DoorLog, type DoorOutcome } from './frontDoor';
import { fetchThread, type SlackMessage } from './slackApi';

/// A page of the list, and the most one look may ask for.
export const PAGE = 25;
const MAX_LIMIT = 500;

export interface ConversationRow {
  key: string;
  by: string;
  text: string;
  at: number;
  lastAt: number;
  dm: boolean;
  outcome?: string;
  kind?: DoorOutcome;
  who?: string;
  team?: boolean;
  url?: string;
}

export interface ThreadMessage {
  at: number;
  from: string;
  /// Posted by overgo, a worker or a team, not a person.
  bot: boolean;
  /// overgo's own housekeeping ("Checking…", "Asked Product Team", a status
  /// line, where an answer came from): shown quietly beside the answers.
  note: boolean;
  /// Markdown, for the console's renderer.
  text: string;
}

const EMOJI: Record<string, string> = { hourglass_flowing_sand: '⏳', white_check_mark: '✅', writing_hand: '✍️', warning: '⚠️', x: '❌', tada: '🎉', eyes: '👀' };

/// One person's share of the door over a stretch of days.
export interface AskerRow {
  user: string;
  by: string;
  messages: number;
  started: number;
  dm: number;
  /// The last day they asked anything.
  lastDay: string;
}

export interface SlackStats {
  days: number;
  messages: number;
  started: number;
  /// Everyone who asked in the stretch.
  askers: number;
  /// Busiest first, unless sorted otherwise; one page of `peopleTotal`.
  people: AskerRow[];
  /// How many match the search, across every page.
  peopleTotal: number;
  outcomes: Partial<Record<DoorOutcome, number>>;
  /// Per day, oldest first, every day in the stretch.
  daily: Array<{ day: string; messages: number; started: number; askers: number }>;
}

export type AskerSort = 'messages' | 'started' | 'dm' | 'recent' | 'name';

/// Which page of people, found and ordered how.
export interface StatsQuery {
  days?: number;
  q?: string;
  sort?: AskerSort;
  offset?: number;
  limit?: number;
}

/// The longest stretch asked for: every day the door keeps.
export const MAX_STATS_DAYS = 180;
const MAX_PEOPLE_PAGE = 5000;

export interface SlackConversations {
  /// The `limit` most recently active, and whether there are more.
  list(caller: OrgCaller, limit?: number): { ok: true; conversations: ConversationRow[]; more: boolean };
  /// Who asked how much over the stretch, a page of people at a time. An
  /// admin sees everyone; anyone else, their own counts.
  stats(caller: OrgCaller, query?: StatsQuery): { ok: true; stats: SlackStats };
  thread(caller: OrgCaller, key: string): Promise<{ ok: true; messages: ThreadMessage[] } | { ok: false; error: string }>;
  /// The Slack threads the caller follows, and stopping one.
  followed?(caller: OrgCaller): { ok: true; threads: Array<{ key: string; text: string; at: number; url: string }> };
  unfollow?(caller: OrgCaller, key: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

/// Slack's markup as markdown: *bold*, _italic_, • lists, <url|label>
/// links, people as names, :emoji: as the emoji.
export function slackToMarkdown(text: string, names: (id: string) => string | undefined): string {
  return text
    .replace(/<@([A-Z0-9]+)>/g, (_m, id: string) => `@${names(id) ?? id}`)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/gm, '$1**$2**')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/gm, '$1*$2*')
    .replace(/^(\s*)•\s+/gm, '$1- ')
    .replace(/:([a-z_]+):/g, (m, name: string) => EMOJI[name] ?? m)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/// overgo's own housekeeping, as opposed to an answer.
function isNote(m: SlackMessage): boolean {
  if (!m.bot_id) return false;
  if (/^:(?:hourglass_flowing_sand|white_check_mark|writing_hand|warning):/.test(m.text)) return true;
  return !m.username || /^From .+/.test(m.text) || /^(?:Asked|Already asked|Checking what)/.test(m.text);
}

export function threadMessages(messages: SlackMessage[], log: DoorLog, names: (id: string) => string | undefined): ThreadMessage[] {
  return messages.map((m) => ({
    at: Math.round(Number(m.ts) * 1000),
    bot: !!m.bot_id,
    note: isNote(m),
    from: m.bot_id ? m.username || 'overgo' : m.user === log.user ? log.by : names(m.user ?? '') ?? 'Someone',
    text: slackToMarkdown(m.text, names).trim() || (m.files?.length ? `(${m.files.map((f) => f.name).join(', ')})` : ''),
  }));
}

/// The counts over the `days` up to `now`, for those `sees` lets through:
/// the totals over everyone, and one page of people.
export function slackStats(rows: DoorDay[], outcomes: Record<string, Partial<Record<DoorOutcome, number>>>, now: number, sees: (user: string) => boolean, everyone: boolean, query: StatsQuery = {}): SlackStats {
  const days = Math.max(1, Math.min(MAX_STATS_DAYS, Math.floor(query.days ?? 30) || MAX_STATS_DAYS));
  const span = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 24 * 60 * 60 * 1000));
  const from = span[0];
  const mine = rows.filter((r) => r.day >= from && sees(r.user));
  const people = new Map<string, AskerRow>();
  for (const r of mine) {
    const p = people.get(r.user) ?? { user: r.user, by: r.by, messages: 0, started: 0, dm: 0, lastDay: r.day };
    p.messages += r.messages;
    p.started += r.started;
    p.dm += r.dm;
    if (r.day >= p.lastDay) Object.assign(p, { lastDay: r.day, by: r.by });
    people.set(r.user, p);
  }
  const perDay = new Map<string, { messages: number; started: number; askers: number }>();
  for (const r of mine) {
    const d = perDay.get(r.day) ?? { messages: 0, started: 0, askers: 0 };
    d.messages += r.messages;
    d.started += r.started;
    d.askers++;
    perDay.set(r.day, d);
  }
  // What came of conversations is counted for the door as a whole: only
  // someone who sees everyone sees it.
  const sum: Partial<Record<DoorOutcome, number>> = {};
  if (everyone) for (const [d, o] of Object.entries(outcomes)) if (d >= from) for (const [k, n] of Object.entries(o) as Array<[DoorOutcome, number]>) sum[k] = (sum[k] ?? 0) + n;
  const all = [...people.values()];
  const q = query.q?.trim().toLowerCase();
  const found = q ? all.filter((p) => p.by.toLowerCase().includes(q) || p.user.toLowerCase() === q) : all;
  const ORDER: Record<AskerSort, (a: AskerRow, b: AskerRow) => number> = {
    messages: (a, b) => b.messages - a.messages,
    started: (a, b) => b.started - a.started,
    dm: (a, b) => b.dm - a.dm,
    recent: (a, b) => b.lastDay.localeCompare(a.lastDay),
    name: (a, b) => a.by.localeCompare(b.by),
  };
  const by = ORDER[query.sort ?? 'messages'] ?? ORDER.messages;
  found.sort((a, b) => by(a, b) || b.messages - a.messages || a.by.localeCompare(b.by));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(0, Math.min(MAX_PEOPLE_PAGE, Math.floor(query.limit ?? 50)));
  return {
    days,
    messages: all.reduce((n, p) => n + p.messages, 0),
    started: all.reduce((n, p) => n + p.started, 0),
    askers: all.length,
    people: found.slice(offset, offset + limit),
    peopleTotal: found.length,
    outcomes: sum,
    daily: span.map((day) => ({ day, ...(perDay.get(day) ?? { messages: 0, started: 0, askers: 0 }) })),
  };
}

export function slackConversations(deps: {
  log(): DoorLog[];
  stats?(): { days: DoorDay[]; outcomes: Record<string, Partial<Record<DoorOutcome, number>>> };
  botToken(): string | null | undefined;
  admin(caller: OrgCaller): boolean;
  now?(): number;
  followed?(user: string): Array<{ key: string; channel: string; threadTs: string; text: string; at: number }>;
  unfollow?(channel: string, threadTs: string, user: string): Promise<void>;
}): SlackConversations {
  const sees = (caller: OrgCaller, l: DoorLog) => deps.admin(caller) || (!!caller.slackUserId && caller.slackUserId === l.user);
  // Names as the door read them when each person asked.
  const names = (id: string) => deps.log().find((l) => l.user === id)?.by;
  const followed = (caller: OrgCaller) => (caller.slackUserId ? deps.followed?.(caller.slackUserId) ?? [] : []);
  return {
    followed: (caller) => ({
      ok: true,
      threads: followed(caller).map((t) => ({ key: t.key, text: t.text, at: t.at, url: `https://slack.com/archives/${t.channel}/p${t.threadTs.replace('.', '')}` })),
    }),
    unfollow: async (caller, key) => {
      const t = followed(caller).find((x) => x.key === key);
      if (!t || !deps.unfollow) return { ok: false, error: "You don't follow that thread." };
      await deps.unfollow(t.channel, t.threadTs, caller.slackUserId!);
      return { ok: true };
    },
    list: (caller, limit = PAGE) => {
      const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || PAGE));
      const mine = deps.log().filter((l) => sees(caller, l));
      return {
        ok: true,
        more: mine.length > n,
        conversations: mine
          .slice(0, n)
          .map((l) => ({ key: l.key, by: l.by, text: l.text, at: l.at, lastAt: l.lastAt ?? l.at, dm: l.dm, ...(l.outcome ? { outcome: l.outcome } : {}), ...(l.kind ? { kind: l.kind } : {}), ...(l.who ? { who: l.who, team: !!l.team } : {}), ...(l.url ? { url: l.url } : {}) })),
      };
    },
    stats: (caller, query = {}) => {
      const all = deps.stats?.() ?? { days: [], outcomes: {} };
      const everyone = deps.admin(caller);
      const sees = (user: string) => everyone || (!!caller.slackUserId && caller.slackUserId === user);
      return { ok: true, stats: slackStats(all.days, all.outcomes, deps.now?.() ?? Date.now(), sees, everyone, query) };
    },
    thread: async (caller, key) => {
      const l = deps.log().find((x) => x.key === key);
      if (!l || !sees(caller, l)) return { ok: false, error: 'No conversation with that id that you can see.' };
      const token = deps.botToken();
      if (!token) return { ok: false, error: 'Slack is not connected on this server.' };
      const res = await fetchThread(token, l.channel, l.threadTs);
      if (!res.ok) return { ok: false, error: `Slack would not give the thread: ${res.error}` };
      return { ok: true, messages: threadMessages(res.data, l, names) };
    },
  };
}
