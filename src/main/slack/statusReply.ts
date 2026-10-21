// "How are we doing?" asked of overcli itself, not of a worker: answered
// from the person's Today view with no model turn. What's waiting on them
// first, then who's working, then what landed.

import type { TodayView } from '../org/orgService';
import type { WorkerState } from '../../shared/org/insights';

/// A question about the person's own workers as a whole. Whole-message only,
/// so "what's the status of ACME-412" still goes to a worker.
export const STATUS_ASK =
  /^(?:hey |hi |so |ok )?(?:how(?:'s| is| are|re)? (?:we|we're|things|everything|everyone|it|my workers|the team)(?: all)? (?:doing|going|looking)|how(?:'s| is) it going|what(?:'s| is) (?:going on|happening|up|running|new|waiting(?: on| for) me)|(?:any(?:thing)? )?(?:status|update|updates)(?: update)?|anything (?:waiting )?(?:on|for) me|catch me up|where are we(?: at)?)(?: today| this morning| right now| so far)?[?.!]*$/i;

/// A hello or a ping, with nothing to do in it.
export const GREETING = /^(?:hi|hey|hello|yo|hiya|morning|good (?:morning|afternoon|evening)|are you (?:there|up|on|alive|awake)|you there|anyone (?:there|home)|ping|test(?:ing)?)(?: there| overgo| overcli| all)?[?.!]*$/i;

export const GREETING_REPLY = "I'm here. Ask for anything and I'll hand it to the right worker, name one (\"Forge, …\") to pick it yourself, or ask *how are we doing?* for what's waiting on you.";

/// "What is overgo?", "who are you?", "help": a question about the door
/// itself, never work for a worker. Whole-message only, so "what is overgo's
/// pricing vs Acme's" still goes to someone.
export const SELF_ASK = /^(?:(?:so|ok|hey|hi) )?(?:(?:what|who)(?:'s| is| are|re)? (?:overgo|overcli|you|this(?: bot| app)?)|what (?:can|do) (?:you|overgo|overcli|i) (?:do|ask(?: you)?)(?: here)?|how (?:do i|does (?:this|it|overgo|overcli)) (?:use (?:you|this|overgo|overcli)|work)|help|\?)(?: me)?[?.!]*$/i;

/// What the door is, and who it can hand work to.
export function selfReply(who: Array<{ name: string; tagline?: string }>): string {
  const crew = who.slice(0, 8).map((w) => `• *${w.name}*${w.tagline ? ` — ${w.tagline}` : ''}`);
  const more = who.length > crew.length ? `\n…and ${who.length - crew.length} more.` : '';
  return [
    "I'm overgo, the front door to your org's AI workers. Tell me what you need and I'll hand it to the worker or team that fits, then post their answer, files and pull requests back here.",
    '',
    '• Just ask: _"add an export button to the reports page"_',
    '• Name a worker to pick it yourself: _"Forge, …"_',
    '• *how are we doing?* shows what\'s waiting on you and who\'s working',
    '• *idea: …* puts something into a process',
    '• `/hire` adds a worker',
    ...(crew.length ? ['', `You can ask:\n${crew.join('\n')}${more}`] : ['', "You don't have any workers yet. Someone can hire one with `/hire`, or share one with you."]),
  ].join('\n');
}

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

/// "Which worker is spending the most?", "how much have we spent?": spend
/// across the crew, not the cost of some piece of work.
const SPEND_ASK = [
  /^(?:(?:which|what) (?:workers?|agents?|ones?|teams?)|who)(?:'s| is| are|re| has| have)? (?:been )?(?:(?:spending|spent|costing|costs?|burning|using)\b|(?:the )?(?:most|least|more|less) expensive|over(?: (?:its|their|the))? budget)/i,
  /^how much (?:have|has|did|are|is|do) (?:we|i|my workers|our workers|the workers|the team|everyone|they)(?: (?:been|all))? (?:spent|spend|spending|cost|costing|burned|burnt|burning)\b/i,
  /^(?:what(?:'s| is| are)|show(?: me)?|give me)? ?(?:our|my|the|total)? ?(?:spend|spending|costs?|burn)(?: (?:so far|this month|by worker|per worker|breakdown))*[?.!]*$/i,
  /^(?:the )?(?:most|least) expensive (?:workers?|agents?)\b/i,
  /^(?:spend|spending|costs?) (?:by|per) worker\b/i,
];

/// "Who's working?", "who is stuck?", "list my workers": the crew's state as a whole.
const CREW_ASK =
  /^(?:(?:who(?:'s| is| are)|which (?:workers?|ones?|agents?) (?:are|is))(?: currently| right now)? (working|busy|stuck|idle|free|paused|waiting)|(?:list|show)(?: me)? (?:all )?(?:my |the |our )?workers|who are (?:my|the|our) workers|how many workers(?: do i have| are there| have i got)?)(?: right now| now| today)?[?.!]*$/i;

/// "you there? which worker…", "hey, how are we doing": the hello in front
/// of a question, so the question is matched on its own.
const HELLO_FIRST = /^(?:(?:hi|hey|hello|yo|ok|so|morning|good (?:morning|afternoon|evening))(?: there| overgo| overcli| all)?|(?:are )?you (?:there|up|around))\s*[,?.!:;-]+\s*(?=\S)/i;

export function withoutHello(text: string): string {
  return text.replace(HELLO_FIRST, '');
}

/// "Which worker is doing the most work?", "who's the busiest?": workload
/// across the crew.
const WORK_ASK = [
  /^(?:(?:which|what) (?:workers?|agents?|ones?|teams?)|who)(?:'s| is| are|re| has| have)? (?:been )?(?:doing|done|did|does|handl(?:ing|ed|es)|finish(?:ing|ed|es)|getting|got|working|delivered|deliver(?:ing|s)?|ship(?:ping|ped|s)?) (?:the )?(?:most|least|more|less)\b/i,
  /^(?:(?:which|what) (?:workers?|agents?|ones?|teams?)|who)(?:'s| is| are|re| has| have)? (?:been )?(?:the )?(?:busiest|laziest|most (?:active|productive|busy)|least (?:active|productive|busy)|hardest working)\b/i,
  /^(?:the )?(?:busiest|most active|most productive) (?:workers?|agents?)\b/i,
];

export interface WorkRow {
  name: string;
  itemsDone: number;
  runs: number;
  workedMs: number;
}

export interface AdminSources {
  today(): TodayView;
  /// Each worker's last 30 days. Null: the timesheet isn't available.
  work?(): WorkRow[] | null;
}

/// An administrative question about the crew, answered from the Today view
/// and the timesheet with no model turn. Null: not one, so it's routed like
/// any request. The sources are only read when the question is one.
export function adminReply(text: string, from: AdminSources, consoleUrl?: string | null): string | null {
  const q = withoutHello(text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim());
  if (SPEND_ASK.some((re) => re.test(q))) return spendReply(from.today(), consoleUrl);
  if (from.work && WORK_ASK.some((re) => re.test(q))) {
    const rows = from.work();
    if (rows) return workReply(rows, consoleUrl);
  }
  const crew = CREW_ASK.exec(q);
  if (crew) return crewReply(from.today(), crew[1]?.toLowerCase());
  return null;
}

function hours(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

export function workReply(rows: WorkRow[], consoleUrl?: string | null): string {
  const link = consoleUrl ? ` <${consoleUrl}|Open the console>` : '';
  if (!rows.length) return "You don't have any workers to report on yet.";
  const ranked = rows
    .filter((r) => r.itemsDone > 0 || r.runs > 0 || r.workedMs > 0)
    .sort((a, b) => b.itemsDone - a.itemsDone || b.runs - a.runs || b.workedMs - a.workedMs);
  if (!ranked.length) return `No one has done any work in the last 30 days.${link}`;
  const lines = [
    '*Most work, last 30 days*',
    ...ranked.slice(0, 8).map((r, i) => {
      const parts = [`${r.itemsDone} done`, `${r.runs} run${r.runs === 1 ? '' : 's'}`, ...(r.workedMs > 0 ? [`${hours(r.workedMs)} working`] : [])];
      return `${i + 1}. *${r.name}* ${parts.join(' · ')}`;
    }),
  ];
  if (ranked.length > 8) lines.push(`…and ${ranked.length - 8} more`);
  const idle = rows.length - ranked.length;
  if (idle) lines.push(`${idle === 1 ? "One other worker hasn't" : `${idle} others haven't`} done anything.`);
  if (link) lines.push('', link.trim());
  return lines.join('\n');
}

export function spendReply(view: TodayView, consoleUrl?: string | null): string {
  if (!view.crew.length) return "You don't manage any workers yet, so nothing is being spent.";
  const link = consoleUrl ? ` <${consoleUrl}|Open the console>` : '';
  const ranked = view.crew.filter((c) => (c.spentUSD ?? 0) > 0).sort((a, b) => (b.spentUSD ?? 0) - (a.spentUSD ?? 0));
  if (!ranked.length) return `Nothing spent yet this month.${link}`;
  const pace = view.spend.projectedUSD > view.spend.spentUSD ? ` (on pace for ${money(view.spend.projectedUSD)})` : '';
  const lines = [`*${money(view.spend.spentUSD)} spent this month*${pace}`];
  lines.push(
    ...ranked.slice(0, 8).map((c, i) => {
      const budget = c.budgetUSDPerMonth;
      const of = budget ? ` of ${money(budget)}${(c.spentUSD ?? 0) > budget ? ' — *over budget*' : ''}` : '';
      return `${i + 1}. *${c.name}* ${money(c.spentUSD ?? 0)}${of}`;
    }),
  );
  if (ranked.length > 8) lines.push(`…and ${ranked.length - 8} more`);
  const idle = view.crew.length - ranked.length;
  if (idle) lines.push(`${idle === 1 ? 'One other worker hasn\'t' : `${idle} others haven't`} spent anything.`);
  if (link) lines.push('', link.trim());
  return lines.join('\n');
}

const STATE_WORDS: Record<string, WorkerState[]> = {
  working: ['working'],
  busy: ['working'],
  stuck: ['stuck'],
  idle: ['idle'],
  free: ['idle'],
  paused: ['paused'],
  waiting: ['waiting'],
};

export function crewReply(view: TodayView, asked?: string): string {
  if (!view.crew.length) return "You don't manage any workers yet. Hire one with `/hire`.";
  const want = asked ? STATE_WORDS[asked] : undefined;
  if (want) {
    const hits = view.crew.filter((c) => want.includes(c.state)).map((c) => c.name);
    const word = asked === 'waiting' ? 'waiting on someone' : want[0];
    return hits.length ? `${names(hits)} ${hits.length === 1 ? 'is' : 'are'} ${word}.` : `No one is ${word} right now.`;
  }
  return [`*${view.crew.length} worker${view.crew.length === 1 ? '' : 's'}*`, ...view.crew.map((c) => `• *${c.name}* — ${c.state}`)].join('\n');
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
