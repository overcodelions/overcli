// "What is this?" as a Slack card: a worker, a team or a process, what it's
// for, who is in it and how to reach it. Built from what's stored, with no
// model call, so it's instant, free and always current.
//
// A card can be shared into a channel, so it holds nothing a channel shouldn't
// see: no budgets or spend, and a process only says who does a stage when the
// person asking may know.

import { slackIcon } from '../../shared/flows/avatars';
import { escapeMrkdwn } from './slackApi';
import { slackMarkup } from './deliver';

export interface AboutCard {
  text: string;
  blocks: unknown[];
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });
const section = (text: string) => ({ type: 'section', text: mrkdwn(text) });
const faint = (text: string) => ({ type: 'context', elements: [mrkdwn(text)] });
const image = (url: string, alt: string) => ({ type: 'image', image_url: slackIcon(url), alt_text: alt });
/// Slack's own limit on one block of text.
const BLOCK_CHARS = 2900;

/// What a command names, in "<name> about" or "about <name>". A name that
/// turns out to be no one's is the caller's to treat as ordinary text.
export function aboutTarget(text: string): string | null {
  const m = /^about\s+(.+)$/i.exec(text.trim()) ?? /^(.+?)[:,]?\s+about$/i.exec(text.trim());
  return m ? m[1].trim() : null;
}

/// What a plain question names: "what is Launch Team?", "how does Idea to launch
/// work?", "tell me about Ada". Null for anything else.
export function askedAbout(text: string): string | null {
  const m = /^(?:what(?:'s|’s| is| does)|who(?:'s|’s| is)|tell me about|how does)\s+(.+?)(?:\s+(?:work|do))?\s*[?.!]*$/i.exec(text.trim());
  return m ? m[1].trim() : null;
}

/// A name as people say it: "the launch team" for a team called "Launch".
export function looseName(name: string): string {
  return name.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+(?:team|process|worker)$/, '');
}

export function workerCard(w: {
  name: string;
  tagline?: string;
  job: string;
  manager?: string;
  tools: string[];
  paused?: boolean;
  picture?: string;
  recent: string[];
}): AboutCard {
  const head = section(`*${escapeMrkdwn(w.name)}*${w.tagline ? `\n${escapeMrkdwn(clip(w.tagline, 200))}` : ''}${w.paused ? '\n_Paused right now._' : ''}`);
  const facts = [w.manager ? `Manager: ${escapeMrkdwn(w.manager)}` : null, w.tools.length ? `Tools: ${escapeMrkdwn(w.tools.slice(0, 8).join(', '))}` : null].filter(Boolean).join(' · ');
  return {
    text: `About ${w.name}`,
    blocks: [
      w.picture ? { ...head, accessory: image(w.picture, w.name) } : head,
      ...(facts ? [faint(facts)] : []),
      ...(w.job.trim() ? [section(`*What it does*\n${slackMarkup(clip(w.job, 600))}`)] : []),
      ...(w.recent.length ? [section(`*Lately*\n${w.recent.slice(0, 3).map((r) => `• ${escapeMrkdwn(clip(r, 120))}`).join('\n')}`)] : []),
      faint(`*Try:* \`@overgo ${escapeMrkdwn(w.name)}, …\``),
    ],
  };
}

export function teamCard(t: {
  name: string;
  shortName?: string;
  purpose?: string;
  picture?: string;
  members: Array<{ name: string; role?: string; picture?: string }>;
  asksFirst: boolean;
  reviews: boolean;
  working?: string;
  latest: Array<{ title: string; at: number }>;
}): AboutCard {
  const head = section(`*${escapeMrkdwn(t.name)}*${t.purpose ? `\n${escapeMrkdwn(clip(t.purpose, 300))}` : ''}`);
  const faces = t.members.filter((m) => m.picture).slice(0, 10).map((m) => image(m.picture!, m.name));
  const steps = [t.asksFirst ? '❓ Asks what it needs' : null, '📋 You approve a plan', '🔨 It works', t.reviews ? '✅ You accept the result' : '✅ It delivers'].filter(Boolean).join('  →  ');
  const reach = t.shortName ? `/team ${t.shortName}` : `/team ${t.name}:`;
  return {
    text: `About ${t.name}`,
    blocks: [
      t.picture ? { ...head, accessory: image(t.picture, t.name) } : head,
      ...(faces.length ? [{ type: 'context', elements: faces }] : []),
      section(t.members.map((m) => `*${escapeMrkdwn(m.name)}*${m.role?.trim() ? ` · ${escapeMrkdwn(clip(m.role, 80))}` : ''}`).join('\n').slice(0, BLOCK_CHARS)),
      section(`*How it works*\n${steps}`),
      ...(t.working ? [section(`*Working on*\n${escapeMrkdwn(clip(t.working, 120))}`)] : []),
      ...(t.latest.length ? [section(`*Latest*\n${t.latest.slice(0, 3).map((l) => `• ${escapeMrkdwn(clip(l.title, 100))} · ${new Date(l.at).toISOString().slice(0, 10)}`).join('\n')}`)] : []),
      faint(`*Try:* \`${escapeMrkdwn(reach)} …\` or \`@overgo ${escapeMrkdwn(t.name)}, …\``),
    ],
  };
}

const STAGE_MARK = { team: '👥', worker: '🤖', decide: '🙋', input: '✍️' } as const;

export function processCard(p: {
  name: string;
  shortName?: string;
  purpose?: string;
  owner?: string;
  active: number;
  canStart: boolean;
  stages: Array<{ name: string; kind: 'team' | 'worker' | 'people'; input?: boolean; who?: string; lead?: string; here: number }>;
}): AboutCard {
  const mark = (s: (typeof p.stages)[number]) => (s.kind === 'people' ? (s.input ? STAGE_MARK.input : STAGE_MARK.decide) : STAGE_MARK[s.kind]);
  const strip = ['💡 Comes in', ...p.stages.map((s) => `${mark(s)} *${escapeMrkdwn(clip(s.name, 40))}*`), '🏁 Done'].join('  →  ');
  const lines = p.stages.map((s, i) => {
    const who = [s.who ? escapeMrkdwn(s.who) : null, s.lead ? `led by ${escapeMrkdwn(s.lead)}` : null, s.here ? `*${s.here} here now*` : null].filter(Boolean).join(' · ');
    return `${i + 1}. ${mark(s)} *${escapeMrkdwn(clip(s.name, 60))}*${who ? ` · ${who}` : ''}`;
  });
  const reach = p.shortName ? `/idea ${p.shortName} …` : `/idea ${p.name}: …`;
  return {
    text: `About ${p.name}`,
    blocks: [
      section(`*${escapeMrkdwn(p.name)}*${p.purpose ? `\n${escapeMrkdwn(clip(p.purpose, 300))}` : ''}`),
      section(strip.slice(0, BLOCK_CHARS)),
      section(lines.join('\n').slice(0, BLOCK_CHARS)),
      faint([p.owner ? `Owner: ${escapeMrkdwn(p.owner)}` : null, p.active ? `${p.active} in progress` : null].filter(Boolean).join(' · ') || 'Nothing in progress'),
      faint(
        p.canStart
          ? `*Try:* \`@overgo ${escapeMrkdwn(p.name)}: …\` works in the thread, in front of everyone there. \`${escapeMrkdwn(reach)}\` keeps it to DMs.`
          : `Only some people can start this. Ask ${p.owner ? escapeMrkdwn(p.owner) : 'its owner'}.`,
      ),
    ],
  };
}
