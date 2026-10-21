// "How are we doing?" asked of overcli itself, not of a worker: answered
// from the person's Today view with no model turn. What's waiting on them
// first, then who's working, then what landed.

import type { TodayView } from '../org/orgService';

/// A question about the person's own workers as a whole. Whole-message only,
/// so "what's the status of ACME-412" still goes to a worker.
export const STATUS_ASK =
  /^(?:hey |hi |so |ok )?(?:how(?:'s| is| are|re)? (?:we|we're|things|everything|everyone|it|my workers|the team)(?: all)? (?:doing|going|looking)|how(?:'s| is) it going|what(?:'s| is) (?:going on|happening|up|running|new|waiting(?: on| for) me)|(?:any(?:thing)? )?(?:status|update|updates)(?: update)?|anything (?:waiting )?(?:on|for) me|catch me up|where are we(?: at)?)(?: today| this morning| right now| so far)?[?.!]*$/i;

/// A hello or a ping, with nothing to do in it.
export const GREETING = /^(?:hi|hey|hello|yo|hiya|morning|good (?:morning|afternoon|evening)|are you (?:there|up|on|alive|awake)|you there|anyone (?:there|home)|ping|test(?:ing)?)(?: there| overcli| all)?[?.!]*$/i;

export const GREETING_REPLY = "I'm here. Ask for anything and I'll hand it to the right worker, name one (\"Forge, …\") to pick it yourself, or ask *how are we doing?* for what's waiting on you.";

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function money(n: number): string {
  return `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, '')}`;
}

function names(list: string[]): string {
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function statusReply(view: TodayView, consoleUrl?: string | null, decisions: Array<{ title: string; process: string; stage: string }> = []): string {
  const yours: string[] = [
    ...decisions.map((d) => `*${d.process}* needs your call at ${d.stage}: ${clip(d.title, 80)}`),
    ...view.waiting.map((w) => (w.kind === 'approval' ? `*${w.workerName}* wants an OK: ${clip(w.title, 80)}` : `*${w.workerName}* asks: ${clip(w.question ?? w.title, 100)}`)),
    ...view.proposals.map((p) => `*${p.workerName}* proposes ${p.items.length === 1 ? clip(p.items[0].title, 80) : `${p.items.length} pieces of work`}`),
    ...view.teamTasks.filter((t) => t.waitingOnYou).map((t) => `*${t.teamName}* needs ${t.needs === 'answers' ? 'your answers' : t.needs === 'plan' ? 'its plan approved' : 'you'} on ${clip(t.title, 70)}`),
    ...view.hireApprovals.map((h) => `A hire to approve: *${h.contract?.name ?? 'a new worker'}* for ${h.requestedBy}`),
  ];
  const working = view.crew.filter((c) => c.state === 'working').map((c) => c.name);
  const stuck = view.crew.filter((c) => c.state === 'stuck').map((c) => c.name);
  const teams = view.teamTasks.filter((t) => !t.waitingOnYou && ['running', 'waiting', 'review', 'queued'].includes(t.status));
  const lines: string[] = [];
  if (yours.length) {
    lines.push(`*Waiting on you (${yours.length})*`, ...yours.slice(0, 5).map((y) => `• ${y}`));
    if (yours.length > 5) lines.push(`• …and ${yours.length - 5} more`);
  } else lines.push('Nothing is waiting on you.');
  const now: string[] = [];
  if (working.length) now.push(`${names(working)} ${working.length === 1 ? 'is' : 'are'} working`);
  if (teams.length) now.push(teams.map((t) => `${t.teamName} is on ${clip(t.title, 60)}`).join('; '));
  if (now.length) lines.push('', `*Now:* ${now.join('. ')}.`);
  if (stuck.length) lines.push(`*Stuck:* ${names(stuck)}. Open ${stuck.length === 1 ? 'it' : 'them'} in the console to see why.`);
  if (view.delivered.length) {
    lines.push('', '*Finished lately*', ...view.delivered.slice(0, 3).map((d) => `• *${d.workerName}*: ${clip(d.title, 90)}`));
  }
  if (!view.crew.length && !yours.length) return "You don't manage any workers yet. Hire one with `/hire`, or ask one by name.";
  if (!working.length && !teams.length && !stuck.length && !view.delivered.length && !yours.length) lines.push('Everyone is idle right now.');
  lines.push('', `${money(view.spend.spentUSD)} spent this month.${consoleUrl ? ` <${consoleUrl}|Open the console>` : ''} Ask a worker by name for more.`);
  return lines.join('\n');
}
