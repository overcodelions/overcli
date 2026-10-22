// The console's Slack page: what people asked overgo in Slack, what came of
// each, and the thread itself, read from Slack when it is opened. Everyone
// sees what they asked; an admin sees everyone's.

import type { OrgCaller } from '../../shared/org/policy';
import type { DoorLog } from './frontDoor';
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

export interface SlackConversations {
  /// The `limit` most recently active, and whether there are more.
  list(caller: OrgCaller, limit?: number): { ok: true; conversations: ConversationRow[]; more: boolean };
  thread(caller: OrgCaller, key: string): Promise<{ ok: true; messages: ThreadMessage[] } | { ok: false; error: string }>;
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

export function slackConversations(deps: { log(): DoorLog[]; botToken(): string | null | undefined; admin(caller: OrgCaller): boolean }): SlackConversations {
  const sees = (caller: OrgCaller, l: DoorLog) => deps.admin(caller) || (!!caller.slackUserId && caller.slackUserId === l.user);
  // Names as the door read them when each person asked.
  const names = (id: string) => deps.log().find((l) => l.user === id)?.by;
  return {
    list: (caller, limit = PAGE) => {
      const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || PAGE));
      const mine = deps.log().filter((l) => sees(caller, l));
      return {
        ok: true,
        more: mine.length > n,
        conversations: mine
          .slice(0, n)
          .map((l) => ({ key: l.key, by: l.by, text: l.text, at: l.at, lastAt: l.lastAt ?? l.at, dm: l.dm, ...(l.outcome ? { outcome: l.outcome } : {}), ...(l.url ? { url: l.url } : {}) })),
      };
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
