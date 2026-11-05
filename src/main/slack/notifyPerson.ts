// A worker's message to a person or a channel, sent by the server (the tool
// gateway's built-in notify): the bot's token never reaches a worker.

import type { SlackPerson, SlackPost, SlackResult } from './slackApi';

export type NotifyPerson = (req: { conversationId: string; workerName?: string; to: string; message: string }) => Promise<{ ok: true; sentTo: string } | { ok: false; error: string }>;

export interface NotifyPersonDeps {
  botToken: () => string | null | undefined;
  teamId: () => string | null | undefined;
  /// The worker whose run owns this conversation, if it is a worker's run.
  workerFor: (conversationId: string) => { id: string; name: string; avatarUrl?: string } | undefined;
  managerSlackId: (workerId: string) => string | null | undefined;
  listPeople: (bot: string) => Promise<SlackResult<SlackPerson[]>>;
  postMessage: (bot: string, post: SlackPost) => Promise<SlackResult<unknown>>;
  audit: (entry: { at: number; by: string; what: string }) => void;
}

export function makeNotifyPerson(deps: NotifyPersonDeps): NotifyPerson {
  return async (req) => {
    const bot = deps.botToken();
    if (!bot || !deps.teamId()) return { ok: false, error: 'Slack isn’t connected on this server, so nothing was sent. Say in your reply who should hear, and what.' };
    const w = deps.workerFor(req.conversationId);
    if (!w) return { ok: false, error: 'Only a worker’s run may send messages.' };
    const to = req.to.trim().replace(/^@/, '');
    let channel = '';
    let label = '';
    if (/^(my )?manager$/i.test(to)) {
      const id = deps.managerSlackId(w.id);
      if (!id) return { ok: false, error: `${w.name}’s manager isn’t linked to Slack, so they can’t be messaged there.` };
      channel = id;
      label = 'your manager';
    } else if (/^[UW][A-Z0-9]{6,}$/.test(to)) {
      channel = to;
      label = `<@${to}>`;
    } else if (/^[CG][A-Z0-9]{6,}$/.test(to)) {
      channel = to;
      label = `<#${to}>`;
    } else if (to.startsWith('#')) {
      return { ok: false, error: 'Give the channel’s id (it starts with C), not its name.' };
    } else {
      const people = await deps.listPeople(bot);
      if (!people.ok) return { ok: false, error: 'Slack’s people list couldn’t be read, so the name couldn’t be matched. Use their Slack member id.' };
      const key = to.toLowerCase();
      const exact = people.data.filter((p) => p.name.toLowerCase() === key || p.handle.toLowerCase() === key);
      const found = exact.length ? exact : people.data.filter((p) => p.name.toLowerCase().startsWith(key));
      if (found.length !== 1) {
        return { ok: false, error: found.length ? `More than one person matches “${to}”: ${found.slice(0, 5).map((p) => p.name).join(', ')}. Use their Slack member id.` : `Nobody in Slack is called “${to}”.` };
      }
      channel = found[0].id;
      label = found[0].name;
    }
    let res = await deps.postMessage(bot, { channel, text: req.message, username: w.name, ...(w.avatarUrl ? { iconUrl: w.avatarUrl } : {}) });
    // An app installed before it could post under another name: as itself, the worker's name in front.
    if (!res.ok && res.error === 'missing_scope') res = await deps.postMessage(bot, { channel, text: `*${w.name}:* ${req.message}` });
    if (!res.ok) return { ok: false, error: `Slack didn’t take it (${res.error}). For a channel, the bot may need inviting.` };
    deps.audit({ at: Date.now(), by: w.name, what: `${w.name} messaged ${label} in Slack: “${req.message.split(/\s+/).join(' ').slice(0, 120)}”` });
    return { ok: true, sentTo: label };
  };
}
