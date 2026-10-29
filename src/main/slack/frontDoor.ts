// The front door: "@overgo add an export button to the reports page", or the
// same in a DM, and the right worker takes it.
//
// Nobody has to know which worker does what. A request that names a worker
// goes to it; otherwise the words of the request are matched against each
// worker's job, and a model decides when the words alone don't. When neither
// is sure, the person is asked to pick. The thread the request came from, and
// any screenshots in it, travel with it — "add a button here" means nothing
// without the "here".
//
// Everything is said back in the request's own thread: who took it, the
// answer, and — when the answer was to start work (a fix, a report) — what
// that work produced once it ends, a PR link or the report itself attached.
// Work outlives the request, and a restart, so what is being followed is kept
// on disk.

import { GREETING, GREETING_REPLY, SELF_ASK, STATUS_ASK, selfReply, withoutHello } from './statusReply';
import type { Attachment } from '../../shared/types';
import type { OrgCaller } from '../../shared/org/policy';
import type { TeamRoom } from '../../shared/flows/team';
import { usedShortName } from '../../shared/shortName';
import type { ErrandProgress } from '../org/orgService';
import { escapeMrkdwn, type SlackFile, type SlackMessage } from './slackApi';
import { deliverResults, deliverText, finishedText, SLACK_BUDGET, slackMarkup, slug, type DeliverIo, type PostAs } from './deliver';
import { isLookup, whenText, type ExistingHit } from './existingWork';

export { toSlack } from './deliver';
export type { ExistingHit } from './existingWork';

export interface FrontDoorRequest {
  channel: string;
  ts: string;
  /// Set when the message is itself in a thread.
  threadTs?: string;
  user: string;
  text: string;
  files?: SlackFile[];
  dm: boolean;
  /// Earlier messages folded into this one (said while a reply was being
  /// written), left out of the thread it is sent with: they are its text.
  also?: string[];
}

export interface FrontDoorWorker {
  id: string;
  name: string;
  /// A team's or process's short name: "lrb" as the first word picks it.
  shortName?: string;
  /// The short name is its initials, given automatically, not one somebody
  /// chose: it works after `/idea` and `/team`, and as a reply to "which
  /// one?", but a message can't start with it. "See" is the initials of
  /// Support Escalation Engineering, and "see if the export works" is not for it.
  shortNameAuto?: boolean;
  tagline?: string;
  job?: string;
  /// Who approves what it proposes.
  manager?: string;
  /// The tools it can use (a tracker, a CRM, a wiki…): what lets it look a
  /// thing up rather than only talk about it.
  tools?: string[];
  /// Its picture: its replies post under its name and this face.
  avatarUrl?: string;
  /// The code it can read: its repo, or its workspace and the repos in it.
  /// How a module works is read from code, not from tickets about it.
  code?: string;
  /// Slack channel IDs where it takes a request without being named.
  homeChannels?: string[];
}

/// A team the person may give work to. It goes to the door as one more
/// candidate, with an id of `team:<id>`.
export interface FrontDoorTeam {
  id: string;
  name: string;
  shortName?: string;
  shortNameAuto?: boolean;
  purpose?: string;
  members: string[];
}

const TEAM_ID = 'team:';
const PROCESS_ID = 'process:';
/// "idea: …", "new idea - …": something to put into a process.
const IDEA = /^(?:new\s+)?idea\s*[:\-–]\s*([\s\S]+)$/i;

/// A process people can put work into, as the door offers it.
export interface FrontDoorProcess {
  id: string;
  name: string;
  shortName?: string;
  shortNameAuto?: boolean;
  purpose?: string;
  firstStage: string;
}

/// A process, as a candidate beside workers and teams: picked only for a new
/// item of the kind it takes in, never for a question.
export function processCandidate(p: FrontDoorProcess): FrontDoorWorker {
  return {
    id: `${PROCESS_ID}${p.id}`,
    name: p.name,
    ...(p.shortName ? { shortName: p.shortName, ...(p.shortNameAuto ? { shortNameAuto: true } : {}) } : {}),
    tagline: `a process${p.purpose ? `: ${p.purpose}` : ''}`,
    job:
      `A PROCESS, not a worker: ${p.purpose ?? p.name}. A new item put into it moves through stages, starting at ${p.firstStage}. ` +
      'Choose it only when the request is a new idea, request or case of the kind it takes in, never for a question, a lookup or a quick fix.',
  };
}
/// "track ACME-412", "also track ACME-412", "stop tracking ACME-412", "untrack ACME-412".
const TRACK = /^(?:also\s+)?(stop\s+|un)?(?:track(?:ing)?|watch(?:ing)?)\s+([A-Za-z][A-Za-z0-9_]*-\d+|#?\d+)(?:\s+(?:too|also))?[.!]?$/i;

/// A reply to "this may already be it" that says it isn't.
const NOT_IT = /^(?:(?:no|nope|nah)[,.!\s]*)?(?:that'?s not it|that is not it|not it|not that(?: one)?|none(?: of (?:these|them|those))?|neither(?: of them)?|something else|no|nope|nah)[.!]?$/i;
/// …that it is, and that's all.
const THANKS = /^(?:thanks?(?: you)?|thx|ty|great|perfect|got it|ok(?:ay)?|cool|nice|that'?s it|that'?s the one|yes|yep|yeah)[.!]*$/i;
/// Only thanks: where the last word may have been a question ("shall we
/// start?"), "yes" and "ok" are answers, not the end of it.
const THANKS_ONLY = /^(?:(?:great|perfect|awesome|ok(?:ay)?|got it)[,!\s]+)?(?:thanks?(?: you)?(?: so much)?|thx|ty|cheers|much appreciated)[.!]*$/i;
const ORDINALS: Array<[RegExp, number]> = [[/^(?:#?1|one|(?:the )?first(?: one)?|(?:the )?top(?: one)?)[.!]?$/i, 0], [/^(?:#?2|two|(?:the )?second(?: one)?)[.!]?$/i, 1], [/^(?:#?3|three|(?:the )?third(?: one)?)[.!]?$/i, 2]];
/// A link button: Slack opens it, and the press it reports is acknowledged and dropped.
const OPEN_LINK = 'overcli_open_link';

/// "Let me know when there's news": DM me when something is posted here.
const SUBSCRIBE = /^(?:please\s+)?(?:let me know|keep me (?:posted|updated|in the loop)|notify me|ping me|dm me|remind me|give me a (?:heads[- ]up|shout)|subscribe|follow(?: this)?|watch(?: this)?)(?:\s+(?:when|if|once|on)\b.*)?[.!]?$/i;
/// …and to stop. Said anywhere ("thanks, unsubscribe me please"): `onlyAsks`
/// checks that nothing but filler surrounds it, so "the unsubscribe link is
/// broken" stays a bug report.
const UNSUBSCRIBE = /\b(?:unsubscribe|unfollow|unwatch)(?:\s+me)?(?:\s+(?:from\s+)?(?:(?:this|the)\s+(?:thread|ticket|one)(?:\s+[a-z][a-z0-9]*-\d+)?|this|it|that|here|[a-z][a-z0-9]*-\d+))?/i;
/// The same said anywhere in a longer message: "that's it — can you let me
/// know when the status changes?"
const NOTIFY = /\b(?:let me know|keep me (?:posted|updated|in the loop)|notify me|ping me|dm me|alert me|tell me|remind me|give me a (?:heads[- ]up|shout))\b[^.!?]*?\b(?:when|if|once|as soon as|whenever)\b/i;
/// "Stop pinging me", "stop following ACME-412", with whatever filler is
/// said around it ("ok stop pinging me", "stop notifying me thank you");
/// `onlyAsks` decides that it is all the message says, so "the digest
/// should stop tracking deleted users" is a request.
const STOP_NOTIFY = /\b(?:(?:stop|quit|don'?t keep|no longer)\s+(?:notifying|pinging|telling|dm'?ing|messaging|following|watching|tracking)(?:\s+me)?|(?:unfollow|unsubscribe|unwatch)(?:\s+me)?)(?:\s+(?:about\s+)?(?:from\s+|on\s+)?(?:(?:this|the)\s+(?:thread|ticket|one)(?:\s+[a-z][a-z0-9]*-\d+)?|this|it|that|here|[a-z][a-z0-9]*-\d+))?/i;
/// What someone adds to a stop request about themselves, asking nothing:
/// "stop pinging me, I'll check myself", "unsubscribe, I've got it".
const SELF_TRAILER = /[,;.!\s]*\b(?:i(?:'ll| will| can|'m| am|'ve| have|'d| got| know| see)|no need|not needed|all good|got it)\b.*$/i;
/// A trailer that goes on to ask for something is a request, not a trailer:
/// "stop pinging me, I have another one: reopen ACME-10". A clause that
/// opens with an order, or one that asks in the person's own voice ("I'd
/// like you to reopen ACME-10", "I need you to rerun it"); "I'll check
/// myself" and "I'd like to check it myself" are neither.
const ASKING_VOICE = /^i(?:'d|'ll| would| will)?\s+(?:also\s+)?(?:like|love|want|need|prefer|ask)\s+you\s+(?:to\s+)?/i;
function trailerAsks(trailer: string): boolean {
  const softeners = new Set(['also', 'please', 'then', 'just', 'can', 'you', 'could']);
  return trailer
    .replace(/^[,;.!\s]+/, '')
    .split(/[:;,.!?]|\b(?:and|but|then|so)\b/i)
    .some((clause) => {
      const words = clause.trim().replace(ASKING_VOICE, '').toLowerCase().split(/[^a-z0-9'-]+/).filter((w) => w && !softeners.has(w));
      return IMPERATIVE.has(words[0] ?? '');
    });
}
/// Words that ask nothing of their own around a "let me know": "can you",
/// "thanks", "that's it".
const FILLER = new Set('thats it thanks thank thx okay great perfect cool also just hey yes yep yeah sure pls plz kindly now anymore more'.split(' '));
/// A sentence end: punctuation followed by a space or the end, so
/// "config.yaml" and "v1.2" stay one word.
const SENTENCE_END = /[.!?]+(?=\s|$)/;
/// What joins two conditions, or a condition and a second request, inside
/// one sentence: "when it's merged and deployed", "when it's done and bump
/// the timeout".
const CONJUNCTION = /(?:,|;|\b(?:and|but|also|then|plus|or)\b)/i;
/// A clause that reads as more of the condition, not a new request: one
/// word ("deployed"), a subject with its verb ("tests pass", "config.yaml is
/// updated", "v1.2 ships", "the PR lands"), or a state ("it's deployed to
/// staging", "merged into main"). A request starts with an order ("bump the
/// timeout", "reopen ACME-9", "make it work") and fits none of these: an
/// order's first word is a verb, and what follows it is not another verb.
const PREDICATE = '(?:is|are|was|were|has|have|gets?|got|goes|went|comes|came|lands?|landed|ships?|shipped|merges?|merged|deploys?|deployed|pass(?:es|ed)?|succeeds?|succeeded|finish(?:es|ed)?|completes?|completed|closes?|closed|resolves?|resolved|changes?|changed|moves?|moved|updates?|updated|arrives?|arrived|works?|worked|fails?|failed|breaks?|broke|returns?|returned|starts?|started|stops?|stopped|ends?|ended|opens?|opened|releases?|released|drops?|dropped|runs?|ran|builds?|built|clears?|cleared|settles?|settled|responds?|responded|replies|replied|answers?|answered|approves?|approved|signs?\\s+off|signed\\s+off|says?|said|looks?|reaches|reached|hits?|exceeds?|turns?|turned|becomes?|became)';
/// The subject is one word ("tests pass"), or up to three after a
/// determiner ("the integration tests pass", "the Safari login fix lands"):
/// without one, "kick off the release" would read as a subject and a verb.
const CONDITION_VERB = new RegExp(`^(?:(?:the|a|an|all|both|every|each|my|our|its|that|this)\\s+[^\\s]+(?:\\s+[^\\s]+){0,2}|[^\\s]+)\\s+${PREDICATE}\\b`, 'i');
const CONDITION_STATE = /^(?:it(?:'s| is| has| was)|they(?:'re| are| have)|that(?:'s| is)|this(?:'s| is)|there(?:'s| is| are)|we(?:'re| are)|you(?:'re| are)|[^\s]+(?:ed|en)\s+(?:to|on|in|into|at|by|for|from|with|and|out|up|off|down)\b)/i;
/// The verbs a request opens with. One of these first, with no predicate
/// right after it ("build passes" is a condition, "build the docs" is not),
/// makes the clause a request whatever else it looks like.
const IMPERATIVE = new Set(('add bump change check close create delete deploy disable do drop email embed enable file find fix get give go have keep kill let look make merge move note open ping post pull push put read rebuild redeploy remove rename reopen rerun reset restart retry review revert run schedule seed see send set ship shorten show start stop switch tag take tell test try turn update use write ' +
  'also please then just go ask bring call clean cut extend flag hold include install investigate link list mark migrate notify pin publish re-run rebase release reply report roll rollback shift ' +
  'skip split squash sync tweak unblock upgrade validate verify wire').split(' '));
/// "What am I following?"
const FOLLOWING_ASK = /^(?:(?:so\s+)?what(?:'s| is| am| are)? (?:i|we|me) (?:following|watching|tracking)|(?:show |list )?(?:my )?(?:follows|followed tickets|tickets i(?:'m| am) following))[?.!]*$/i;
/// A ticket named in a message: "ACME-412", "acme-412".
const TICKET = /\b([A-Za-z][A-Za-z0-9]{1,15}-\d{1,7})\b/;
/// A "notify me" button: pressing it subscribes the presser, and the button
/// stays for the next person.
export const DOOR_SUBSCRIBE_ACTION = 'overcli_door_subscribe';
/// "Show the trace" under an answer: how the work got there, for the presser only.
export const DOOR_TRACE_ACTION = 'overcli_door_trace';
/// "Full write-up" under an answer: the document it wrote, in a pop-up.
export const DOOR_WRITEUP_ACTION = 'overcli_door_writeup';
/// A reply to the front desk's answer asking for a worker after all.
const HAND_OFF = /^(?:hand (?:it|this) (?:off|over|to someone)|give (?:it|this) to (?:someone|a worker)|find someone|ask a worker|someone else)[.!]?$/i;
/// A worker saying the request isn't its job: the door finds someone else.
const DECLINE = /\bNOT_MINE\b:?\s*([^\n]*)/;
/// How many workers may say "not mine" before the door answers itself.
const MAX_DECLINES = 2;
/// A follow-up the worker hasn't answered by then gets a word in the thread,
/// so it doesn't look ignored while the worker thinks.
const ACK_AFTER_MS = 8000;
/// Past this a first reply is more than a line on what's being checked.
const LINE_MAX = 300;

/// A reply to "who should take this?" that leaves it to the door.
const ANYONE = /^(?:any(?:one|body)?|whoever|you (?:pick|choose|decide)|doesn'?t matter|no preference|dunno|not sure)[.!]?$/i;

/// A team, as a candidate beside the workers: named for what it's for, and
/// described so a router only picks it for a real piece of work.
export function teamCandidate(t: FrontDoorTeam): FrontDoorWorker {
  return {
    id: `${TEAM_ID}${t.id}`,
    name: t.name,
    ...(t.shortName ? { shortName: t.shortName, ...(t.shortNameAuto ? { shortNameAuto: true } : {}) } : {}),
    tagline: `a team${t.purpose ? `: ${t.purpose}` : ''}`,
    job:
      `A TEAM of ${t.members.join(', ')}, not one worker. ${t.purpose ?? ''} It asks what it needs to know up front, ` +
      'plans, has the person approve the plan, then several members work on it and the result is reviewed. ' +
      'Choose it only for a substantial deliverable that matches its purpose, never for a quick question or a small fix.',
  };
}

/// A conversation the door started: who took it, or the choice it is waiting on.
interface DoorThread {
  key: string;
  workerId?: string;
  workerName?: string;
  /// The request, held while the person picks who should take it.
  pending?: { text: string; files: SlackFile[]; choices: Array<{ id: string; name: string; shortName?: string }> };
  /// Work that may already answer the request, offered before handing it to
  /// anyone: held until the person says which, or that it isn't.
  existing?: { text: string; files: SlackFile[]; hits: ExistingHit[]; related: Array<{ title: string; who: string }> };
  /// A finished team task this thread put a question to: more said here goes
  /// to the same room.
  room?: { taskId: string; who: string; url?: string; question: string };
  /// A question the door answered itself: held so "hand it off" can still
  /// give it to a worker.
  desk?: { text: string; files: SlackFile[] };
  /// Workers that said the request isn't theirs: not offered it again.
  declined?: string[];
  /// Work handed off from here that has finished: more said here goes to
  /// whoever ran its last step, as the next turn of that conversation
  /// (`FrontDoorDeps.continueRun`).
  done?: { orchestrationId: string; at: number; workerId?: string };
  at: number;
}

/// A question put to a team's room from a thread, followed until the room
/// has answered it, so the answer comes back where it was asked.
export interface RoomFollow {
  taskId: string;
  question: string;
  since: number;
  channel: string;
  threadTs: string;
  who: string;
  url?: string;
  /// The thread's message saying who is on it, edited as the room moves.
  status?: { ts: string; text: string };
}

/// Work started from a thread, followed until it ends.
export interface DoorFollow {
  orchestrationId: string;
  channel: string;
  threadTs: string;
  workerName: string;
  since: number;
  /// The ask that handed the work off: its result goes back to the worker
  /// to finish up (`FrontDoorDeps.handBack`). Absent on follows from before.
  askId?: string;
  workerId?: string;
  /// The worker's picture, to post its answer as it.
  avatarUrl?: string;
  /// The message in the thread that says how the work is going, edited as
  /// it moves, and what it last said.
  status?: { ts: string; text: string; at: number };
  /// The status is the worker's own message from the hand-off, drawn as a
  /// card: what it said it is checking, and how far it has got.
  card?: LiveCard;
}

/// A conversation someone started with the door, and what came of it: what
/// the console's Slack page lists. The thread itself is read from Slack.
export interface DoorLog {
  key: string;
  channel: string;
  threadTs: string;
  /// Who asked, by Slack id and as their name read then.
  user: string;
  by: string;
  text: string;
  at: number;
  dm: boolean;
  /// What the door did with it, in words: "Answered from what Product Team
  /// already worked out", "Asked Product Team", "Dana has it".
  outcome?: string;
  /// Where to open what it went to, in the console.
  url?: string;
  /// When anything last happened in it.
  lastAt?: number;
  /// The outcome as a kind, and who it went to: a worker, or a team or
  /// process when `team`. The Slack page colours each by these.
  kind?: DoorOutcome;
  who?: string;
  team?: boolean;
}

/// Someone who asked to hear, by DM, when something is posted in a thread.
export interface DoorSub {
  key: string;
  channel: string;
  threadTs: string;
  user: string;
  at: number;
}

/// What the door did with a conversation, counted for the Slack page:
/// answered (from known work or by the door itself), offered existing work,
/// handed to someone, asked who should take it, or a worker said not theirs.
export type DoorOutcome = 'answered' | 'offered' | 'handed' | 'asked-who' | 'declined';

/// One person's day at the door. Kept far longer than the conversations,
/// so the counts outlast them.
export interface DoorDay {
  day: string;
  user: string;
  by: string;
  messages: number;
  /// New conversations started.
  started: number;
  /// Messages sent in a DM rather than a channel.
  dm: number;
}

export interface FrontDoorState {
  threads: DoorThread[];
  follows: DoorFollow[];
  /// Absent in state saved before conversations were logged.
  log?: DoorLog[];
  /// Absent in state saved before rooms were followed.
  rooms?: RoomFollow[];
  /// Absent in state saved before threads could be followed by DM.
  subs?: DoorSub[];
  /// Absent in state saved before the door kept counts.
  days?: DoorDay[];
  /// What came of conversations, per day: `{ '2026-10-22': { handed: 3 } }`.
  outcomes?: Record<string, Partial<Record<DoorOutcome, number>>>;
}

type Answered = { ok: true; reply: string; proposed?: number; orchestrationId?: string; choices?: string[]; askId?: string } | { ok: false; error: string };
type Started = { ok: true; done: Promise<Answered> } | { ok: false; error: string };

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/// How much of a write-up a pop-up reads in: Slack takes 100 blocks of ~3000.
const WRITEUP_MAX = 250_000;

/// Messages one person sent in a row, as the one request they make: the
/// first one's place (its thread is where the answer goes), everyone's words.
export function gathered(reqs: FrontDoorRequest[]): FrontDoorRequest {
  if (reqs.length === 1) return reqs[0];
  const files = reqs.flatMap((r) => r.files ?? []);
  return { ...reqs[0], text: reqs.map((r) => r.text.trim()).filter(Boolean).join('\n'), ...(files.length ? { files } : {}), also: reqs.slice(1).map((r) => r.ts) };
}

/// Slack markup cut into section-sized pieces, at a paragraph or a line so
/// markup isn't split down the middle. `rest`: what didn't fit in `max`.
function chunked(text: string, max: number): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let rest = text;
  while (rest && chunks.length < max) {
    let at = rest.length <= 2900 ? rest.length : rest.lastIndexOf('\n\n', 2900);
    if (at < 1000) at = rest.lastIndexOf('\n', 2900);
    if (at < 1000) at = 2900;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  return { chunks, rest };
}

/// A worker's write-up as a Slack pop-up, in Slack's own markup, a block per
/// stretch of it.
export function writeUpView(name: string, body: string | null): unknown {
  const context = { type: 'context', elements: [{ type: 'mrkdwn', text: `Only you can see this · ${escapeMrkdwn(name)}` }] };
  const { chunks, rest } = chunked(body ? slackMarkup(body) : '_This write-up is no longer there._', 98);
  const blocks = [context, ...chunks.map((c) => ({ type: 'section', text: { type: 'mrkdwn', text: c } }))];
  if (rest) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Cut short here: it is longer than Slack shows._' }] });
  return { type: 'modal', title: { type: 'plain_text', text: 'Full write-up' }, close: { type: 'plain_text', text: 'Close' }, blocks };
}

/// The trace behind an answer, as a Slack pop-up: each step and what it
/// found, then what it read and wrote. Kept short: an excerpt of each, not
/// the files whole.
export function traceView(p: ErrandProgress | null): unknown {
  const mark = (s: string) => (s === 'done' ? '✓' : s === 'failed' ? '✗' : '–');
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(text, 2900) } });
  const blocks: unknown[] = [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Only you can see this.' }] }];
  if (!p) blocks.push(section('The steps behind this answer are no longer kept.'));
  else {
    p.items.forEach((i, n) => {
      const said = i.note ?? i.said;
      blocks.push(section(`*${n + 1}. ${escapeMrkdwn(i.title)}* ${mark(i.status)}${said ? `\n${escapeMrkdwn(clip(said.trim(), 600))}` : ''}`));
    });
    if (p.files.length) {
      blocks.push({ type: 'divider' }, section('*Sources*'));
      for (const f of p.files.slice(0, 20)) {
        const where = f.sourcePath ? ` · \`${escapeMrkdwn(f.sourcePath)}\`` : '';
        const excerpt = f.body?.trim() ? `\n>${escapeMrkdwn(clip(f.body.trim(), 400)).replace(/\n/g, '\n>')}` : '';
        blocks.push(section(`*${escapeMrkdwn(f.name)}*${where}${excerpt}`));
      }
    }
    if (p.links.length) blocks.push(section(p.links.slice(0, 10).map((l) => `<${l}>`).join('\n')));
  }
  return { type: 'modal', title: { type: 'plain_text', text: 'How it was worked out' }, close: { type: 'plain_text', text: 'Close' }, blocks: blocks.slice(0, 100) };
}

/// How handed-off work is going, as its status message says it: each piece
/// and where it is, then the last thing it said.
export function progressText(p: ErrandProgress, now: number, since?: number): string {
  const lines = p.items.map((i) => {
    const where =
      i.status === 'running' && i.step ? `step ${i.step.index} of ${i.step.total}, ${i.step.name}${i.startedAt ? ` · ${minutes(now - i.startedAt)}` : ''}`
        : i.status === 'running' ? 'starting'
          : i.status === 'proposed' ? 'waiting for an OK'
            : i.status === 'queued' ? 'next in line'
              : i.status === 'done' ? 'done'
                : i.status === 'failed' ? 'failed'
                  : i.status;
    return `${i.status === 'done' ? '✓' : i.status === 'failed' ? '✗' : '•'} *${i.title}* — ${where}`;
  });
  const said = p.items.find((i) => i.said)?.said;
  return [`:hourglass_flowing_sand: *Working on it*${since ? ` · ${minutes(now - since)} so far` : ''}`, ...lines, said ? `> _${said}_` : ''].filter(Boolean).join('\n');
}

/// What the worker's one message in a thread holds while it works.
export interface LiveCard {
  /// What it said it is checking. Absent: it hasn't said yet.
  line?: string;
  /// Why it has this ("it answers in this channel").
  why?: string;
  /// The "Notify me" button: in a channel, where others may want to hear.
  notify?: boolean;
  /// What the work has said as it went, oldest first: done, done, doing now.
  trail?: string[];
  /// Slack refused the plan block here once: drawn with emoji from then on.
  plain?: boolean;
}

/// Past this a reason reads as the router thinking aloud, not a label.
const WHY_MAX = 60;
/// How many of the things the work said the card keeps.
const TRAIL_MAX = 4;

/// What a run said, as one line on a card: tags out, one line, short.
export function trailLine(said: string): string {
  return clip(said.replace(/<\/?[a-z_]+\b[^>]*>/gi, ' ').replace(/\s+/g, ' ').trim(), 140);
}

/// The worker's one message in the thread while it works: who picked it up,
/// what it is checking, each piece of work and how far along. Edited in place,
/// so the thread holds this and then the answer, not a message per stage.
export function liveCard(c: LiveCard, p: ErrandProgress | null, now: number, since?: number): { text: string; blocks: unknown[] } {
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(text, 2900) } });
  const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(text, 2900) }] });
  const line = c.line ?? '_Looking into it…_';
  const blocks: unknown[] = [];
  if (c.why && c.why.length <= WHY_MAX) blocks.push(context(`Picked up · ${escapeMrkdwn(c.why)}`));
  blocks.push(section(line));
  let text = line;
  if (p?.items.length) {
    // One piece of work is titled with the request itself, and its steps are
    // the flow's own names: what it has said it found reads better.
    const one = p.items.length === 1;
    type Task = { title: string; status: 'complete' | 'in_progress' | 'error' | 'pending' };
    const tasks: Task[] = one
      ? (c.trail?.length ? c.trail : ['Starting']).map((t, n, all) => ({ title: t, status: n < all.length - 1 ? 'complete' : 'in_progress' }))
      : p.items.map((i) => ({
          title: `${i.title}${i.paused ? ` — ${i.paused}` : i.status === 'proposed' ? ' — waiting for an OK' : i.status === 'running' && i.step ? ` — ${i.step.name}` : ''}`,
          status: i.status === 'done' ? 'complete' : i.status === 'failed' ? 'error' : i.status === 'running' ? 'in_progress' : 'pending',
        }));
    // A bar only says something when there's more than one step to go through.
    const step = p.items.find((i) => i.status === 'running' && i.step)?.step;
    const steps = step && step.total > 1 ? `Step ${step.index} of ${step.total}` : '';
    const time = since ? `${minutes(now - since)} so far` : '';
    const last = !one ? c.trail?.at(-1) : undefined;
    const paused = one ? p.items[0].paused : undefined;
    const note = [paused, last].filter(Boolean).map((t) => `_${escapeMrkdwn(t!)}_`).join('\n');
    if (!c.plain) {
      // Slack's own panel for an agent's steps: a spinner on the one under way.
      blocks.push({ type: 'plan', title: clip([steps || 'Working on it', time].filter(Boolean).join(' · '), 150), tasks: tasks.slice(-50).map((t, n) => ({ task_id: `t${n}`, title: clip(t.title, 200), status: t.status })) });
      if (note) blocks.push(context(note));
    } else {
      const mark = { complete: ':white_check_mark:', in_progress: ':hourglass_flowing_sand:', error: ':x:', pending: ':white_circle:' };
      blocks.push(section(tasks.map((t) => `${mark[t.status]} ${t.status === 'in_progress' ? `*${escapeMrkdwn(t.title)}*` : escapeMrkdwn(t.title)}`).join('\n')));
      const filled = step ? Math.max(1, Math.min(9, Math.round(((step.index - 0.5) / step.total) * 10))) : 0;
      const bar = steps ? `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}  ${steps}` : '';
      blocks.push(context([[bar, time].filter(Boolean).join(' · ') || 'Working on it', note].filter(Boolean).join('\n')));
    }
    if (steps) text = `${line} · ${steps}`;
  }
  if (c.notify) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔔 Notify me' }, action_id: DOOR_SUBSCRIBE_ACTION, value: 'subscribe' }] });
  return { text, blocks };
}

/// A one-tap answer under a worker's reply: pressing it sends its words back
/// in the thread as the presser's own follow-up.
export const DOOR_CHOICE_ACTION = 'overcli_door_choice';

export interface FrontDoorDeps {
  /// How long a new request waits for more from the same person in the same
  /// place, so three lines typed as three messages are one request. Each
  /// message starts the wait again. Absent or 0: taken at once.
  gatherMs?: number;
  /// Who may ask at all. A string is the reason someone may not, said back
  /// to them. Absent: anyone in the workspace.
  mayAsk?(slackUserId: string): true | string;
  caller(slackUserId: string): Promise<OrgCaller>;
  /// The workers this person may ask, running ones only.
  workers(caller: OrgCaller): FrontDoorWorker[];
  /// `conversation`: the thread, as a key, so the worker keeps one conversation per thread.
  ask(caller: OrgCaller, workerId: string, text: string, attachments: Attachment[], conversation?: string, said?: string): Started;
  /// A follow-up in a thread whose handed-off work has finished, said to
  /// whoever ran the work's last step, in its conversation: a chat, not a
  /// new errand. Null: it can't take it (the caller may not drive that work,
  /// or there's nothing to continue), and it goes to the worker as before.
  continueRun?(caller: OrgCaller, orchestrationId: string, text: string, attachments: Attachment[], conversation: string, said: string): Started | null;
  /// Finished handed-off work back to the worker that handed it off, to
  /// finish what it said it would. Null: nothing to hand back. Absent: the
  /// run's output is posted as it is.
  handBack?(askId: string): { done: Promise<Answered> } | null;
  progress(orchestrationId: string): ErrandProgress | null;
  /// "Let me know when ACME-412 changes": the caller is DMed when it moves,
  /// on a change watch of a worker they can see. A string is why it can't.
  /// Absent: only threads can be followed.
  /// `workerId`: who the thread is with, to set a watch up on when there's
  /// none to put it on. `say`: a word in the thread while that runs.
  follow?(caller: OrgCaller, itemId: string, on: boolean, opts: { workerId?: string; say(text: string): void }): Promise<string | { worker: string; trigger: string; everyMinutes: number; status?: string; setUp?: boolean }> | string | { worker: string; trigger: string; everyMinutes: number; status?: string; setUp?: boolean };
  /// The tickets the caller follows, for "what am I following?". Absent: it's
  /// routed like any request.
  following?(caller: OrgCaller): Array<{ item: string; status?: string; worker: string }>;
  /// "Track ACME-412" to a named worker: onto its change watch's list, with
  /// no model turn. A string is why it couldn't. Absent: it's an ordinary ask.
  track?(caller: OrgCaller, workerId: string, itemId: string, on: boolean): string | { worker: string; tracked: number };
  /// The teams this person may give work to. Absent: requests go to workers only.
  teams?(caller: OrgCaller): FrontDoorTeam[];
  /// Give a team a task. Its questions, plan and progress go to the person in a DM.
  /// `queued`: the team is on another task and starts this one after it.
  briefTeam?(caller: OrgCaller, teamId: string, brief: string): { ok: true; queued?: boolean } | { ok: false; error: string };
  /// "How are we doing?": what's waiting on them, who's working, what landed,
  /// said by the door itself. Absent: it's routed like any request.
  status?(caller: OrgCaller): string;
  /// "Which worker is spending the most?", "who's stuck?": an administrative
  /// question about the crew, answered by the door itself. Null, or absent:
  /// it's routed like any request.
  admin?(caller: OrgCaller, text: string): string | null;
  /// The processes this person can put work into. Absent: none offered.
  processes?(caller: OrgCaller): FrontDoorProcess[];
  /// Put the request into a process as a new item.
  submitProcess?(caller: OrgCaller, processId: string, brief: string): { ok: true; title: string; process: string; stage: string } | { ok: false; error: string };
  /// Finished work this person can see that may already answer a question:
  /// strong matches are offered before routing, `weak` ones only tell the
  /// router who made something related. Absent: every request is routed.
  /// `shared`: asked in a channel, where everyone in it reads the reply, so
  /// only work everyone can see counts.
  findExisting?(caller: OrgCaller, text: string, opts: { shared: boolean }): Promise<ExistingHit[]> | ExistingHit[];
  /// A question answered from what's already known (finished work, what
  /// teams know), said under `who`'s name; `hits`: the work it came from.
  /// Null: that doesn't cover it. Absent: matches are only offered.
  /// `shared`: as for `findExisting`.
  answer?(caller: OrgCaller, text: string, opts: { shared: boolean }): Promise<{ text: string; who: string; hits: ExistingHit[]; from: string[] } | null>;
  /// Put a question to a finished team task's team; its answer lands in the
  /// task. `queued`: the room is answering something else first.
  askTeam?(caller: OrgCaller, taskId: string, text: string): { ok: true; queued?: boolean } | { ok: false; error: string };
  /// The room's answer said plainly for Slack: an answer to the question,
  /// the team's internal labels named, its process notes dropped. Null, or
  /// absent: posted as the room said it.
  plain?(question: string, answer: string, taskId: string): Promise<string | null>;
  /// A team task's room, to see whether it has answered (`roomAnswer`).
  /// Absent: the answer stays in the task.
  teamRoom?(taskId: string): TeamRoom | undefined;
  /// A question nobody's job covers, answered by the door itself, naming who
  /// could look things up when it can't. `context`: the thread so far. Null:
  /// it couldn't. Absent: the person is asked who should take it.
  general?(caller: OrgCaller, text: string, context: string, workers: FrontDoorWorker[]): Promise<string | null>;
  /// A model's pick when the words alone don't settle it. Null: no one fits.
  /// `related`: recent work that may be what the request is about.
  /// Null: nobody fits. Throws when the model can't be asked.
  route(text: string, workers: FrontDoorWorker[], related?: Array<{ title: string; who: string }>): Promise<{ workerId: string; why: string } | null>;
  slack: {
    post(channel: string, text: string, threadTs: string, as?: PostAs): Promise<boolean>;
    thread(channel: string, threadTs: string): Promise<SlackMessage[]>;
    /// The last messages in a channel before a top-level mention, oldest first.
    recent?(channel: string, beforeTs: string, limit: number): Promise<SlackMessage[]>;
    download(url: string, maxBytes: number): Promise<Buffer | null>;
    upload(channel: string, threadTs: string, filename: string, bytes: Buffer): Promise<boolean>;
    /// A message with buttons (the one-tap answers). Absent: they aren't offered.
    postBlocks?(channel: string, text: string, blocks: unknown[], threadTs: string): Promise<boolean>;
    /// Replace a message's text and drop its buttons.
    update?(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<boolean>;
    /// Take a message down: a status once the answer it stood in for is posted.
    remove?(channel: string, ts: string): Promise<boolean>;
    /// A pop-up for whoever pressed a button. Absent: no trace is offered.
    openView?(triggerId: string, view: unknown): Promise<boolean>;
    /// Post and say where it landed, for a message edited as work moves.
    postTs?(channel: string, text: string, threadTs: string, as?: PostAs, blocks?: unknown[]): Promise<string | null>;
    /// A direct message from the app. Absent: threads can't be followed by DM.
    dm?(user: string, text: string): Promise<boolean>;
    /// A link to a message, for a DM pointing back at its thread.
    permalink?(channel: string, ts: string): Promise<string | null>;
  };
  /// Where people read what workers delivered, for the closing link.
  libraryUrl(): string | null;
  /// A finished run's file, for attaching to the thread.
  readFile(path: string, maxBytes: number): Buffer | null;
  /// See `DeliverIo.workerFile`.
  workerFile?(workerId: string, path: string, maxBytes: number): Buffer | null;
  store: { load(): FrontDoorState; save(state: FrontDoorState): void };
  log(message: string): void;
  now?(): number;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5_000_000;
/// Text files in a thread (a report this app posted there, notes someone
/// shared) are read into the request: a worker can't open a Slack link.
const MAX_TEXTS = 3;
const MAX_TEXT_BYTES = 60_000;
const TEXT_NAME = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|xml|html?)$/i;
const THREAD_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FOLLOW_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/// How long the door's counts are kept.
const STATS_TTL_DAYS = 180;

/// "2026-10-22", in UTC: the day a count goes under.
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/// How far back a top-level mention looks in its channel.
const RECENT_MESSAGES = 8;
const CONTEXT_HEAD = {
  thread: 'The Slack thread this came from, oldest first:',
  channel: 'The last messages in the channel before this request, oldest first (it may refer to them, e.g. "this ticket"):',
};
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/// The text files read from a thread, each under its name, for a prompt.
function sharedTexts(texts: Array<{ name: string; body: string }>): string {
  return texts.length ? `\nFiles shared there, as read from Slack:\n${texts.map((t) => `--- ${t.name} ---\n${t.body}\n--- end of ${t.name} ---`).join('\n')}` : '';
}

const STOP = new Set('a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these this to us was we what when where which who why will with would you your'.split(' '));

function words(text: string): string[] {
  return text.toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/// A worker named at the start of the request: "Triage, fix …", "ask Triage
/// to …", "@Triage …". Longest name first, so "Ana Lyst" beats "Ana". Then a
/// team's or process's short name, as a whole first word: "lrb let…", "pd: …".
/// Only a short name somebody set, unless `initials` says automatic ones
/// count too: that is for a reply to "which one?", where they were offered.
export function namedWorker(text: string, workers: FrontDoorWorker[], opts: { initials?: boolean } = {}): { worker: FrontDoorWorker; rest: string } | null {
  const t = text.trim();
  for (const w of [...workers].sort((a, b) => b.name.length - a.name.length)) {
    const name = escapeRe(w.name.trim().toLowerCase());
    const m = new RegExp(`^(?:ask\\s+|hey\\s+|get\\s+|have\\s+|let\\s+|@)?(?:the\\s+)?${name}(?:\\s+team)?(?:[,:\\s]+(?:to\\s+|please\\s+)?|$)`, 'i').exec(t);
    if (m) return { worker: w, rest: t.slice(m[0].length).trim() || t };
  }
  for (const w of workers) {
    if (!w.shortName || (w.shortNameAuto && !opts.initials)) continue;
    const m = new RegExp(`^(?:ask\\s+|hey\\s+|@)?${escapeRe(w.shortName)}(?:\\s*:\\s*|\\s+|$)`, 'i').exec(t);
    if (m) return { worker: w, rest: t.slice(m[0].length).trim() || t };
  }
  return null;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// "Next time, `/idea lrb …`": the short way in, for someone who came the long way.
function shortTip(req: FrontDoorRequest, worker: FrontDoorWorker, command: '/idea' | '/team'): string {
  const said = req.text.replace(/<@[^>]+>\s*/g, '').replace(/^(?:new\s+)?idea\s*[:\-–]\s*/i, '');
  return worker.shortName && !usedShortName(said, worker.shortName) ? ` Next time, \`${command} ${worker.shortName} …\` goes straight there.` : '';
}

/// Each worker's overlap with the request's words, best first. A clear
/// winner (well ahead of the next) needs no model.
export function rankByWords(text: string, workers: FrontDoorWorker[]): Array<{ worker: FrontDoorWorker; score: number }> {
  const asked = new Set(words(text));
  return workers
    .map((worker) => {
      const own = new Set(words(`${worker.name} ${worker.tagline ?? ''} ${worker.job ?? ''} ${(worker.tools ?? []).join(' ')}`));
      let score = 0;
      for (const w of asked) if (own.has(w)) score += 1;
      return { worker, score };
    })
    .sort((a, b) => b.score - a.score);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/// Whether a "let me know when…" (or "stop following…") is all the message
/// says: nothing is left once that sentence is taken out but filler. "Fix
/// the Safari case and ping me when it's done" still asks for a fix.
export function onlyAsks(text: string, clauses: RegExp[]): boolean {
  for (const re of clauses) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index);
    if (!words(before).every((w) => FILLER.has(w) || w === 'can' || w === 'you' || w === 'could' || w === 'would')) return false;
    const after = text.slice(m.index + m[0].length);
    if (re === NOTIFY) {
      // "Let me know when it ships. Fix Firefox." — a second sentence that
      // says anything is a second request.
      const sentences = after.split(SENTENCE_END);
      if (sentences.slice(1).some((sentence) => words(sentence).some((w) => !FILLER.has(w)))) return false;
      // Inside the sentence, what follows "and", "," or "then" is either
      // more of the condition ("merged and deployed", "lint and build pass")
      // or a request of its own ("and bump the timeout to 30s").
      const parts = sentences[0].split(CONJUNCTION);
      return parts.slice(1).every((part) => {
        const clause = part.trim().replace(/^(?:when|if|once|whenever|as soon as|after)\s+/i, '');
        if (words(clause).every((w) => FILLER.has(w))) return true;
        if (!/\s/.test(clause)) return true;
        const first = clause.toLowerCase().split(/[^a-z0-9'-]+/)[0];
        if (IMPERATIVE.has(first)) return new RegExp(`^[^\\s]+\\s+${PREDICATE}\\b`, 'i').test(clause);
        return CONDITION_VERB.test(clause) || CONDITION_STATE.test(clause);
      });
    }
    const trailer = SELF_TRAILER.exec(after)?.[0] ?? '';
    return words(trailerAsks(trailer) ? after : after.replace(SELF_TRAILER, '')).every((w) => FILLER.has(w));
  }
  return false;
}

/// Whether the request names a worker, team or process anywhere in it.
function mentionsAny(text: string, workers: FrontDoorWorker[]): boolean {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return workers.some((w) => {
    const name = w.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return name.length > 2 && t.includes(` ${name} `);
  });
}

/// "*Product Team* finished _Q1 2027 roadmap_ today — waiting on your review."
export function existingLine(h: ExistingHit, now: number): string {
  const did = h.kind === 'file' ? 'wrote' : h.kind === 'worker' ? 'delivered' : 'finished';
  return `*${h.who}* ${did} _${h.title}_ ${whenText(h.at, now)}${h.status ? ` — ${h.status}` : ''}.`;
}

/// What a team's room said to `question`, once it's done talking: the
/// coordinator's wrap-up when members talked it through, else everyone who
/// spoke, in turn. Null while the question waits its turn or is being
/// answered.
export function roomAnswer(room: Pick<TeamRoom, 'messages' | 'busy' | 'queue'> | undefined, question: string, since: number): string | null {
  if (!room || room.queue?.some((q) => q.text === question)) return null;
  const asked = [...room.messages].reverse().find((m) => m.speaker.kind === 'you' && m.text === question && m.at >= since);
  if (!asked) return null;
  if (room.busy && room.messages.at(-1)?.exchange === asked.exchange) return null;
  const said = room.messages.filter((m) => m.exchange === asked.exchange && m.at >= asked.at && m.speaker.kind !== 'you');
  if (!said.length) return null;
  const wrap = [...said].reverse().find((m) => m.wrapUp);
  const name = (m: (typeof said)[number]) => (m.speaker.kind === 'member' ? m.speaker.name : 'Coordinator');
  const text = wrap ? wrap.text : said.length === 1 ? said[0].text : said.map((m) => `*${name(m)}:* ${m.text}`).join('\n\n');
  return said.some((m) => m.handoff) ? `${text}\n\n_That's work to start: open the task to approve it._` : text;
}

/// Who in the room is on the question, as the thread's status message says
/// it: who answered, who is speaking now, and for how long. Null once the
/// room is done with it (`roomAnswer` has the answer).
export function roomStatus(room: Pick<TeamRoom, 'messages' | 'busy' | 'queue'> | undefined, question: string, since: number, who: string, now: number): string | null {
  const head = `:hourglass_flowing_sand: *${who}* is on it · ${minutes(now - since)} so far`;
  if (room?.queue?.some((q) => q.text === question)) return `${head}\n• Next in line: they're answering another question first`;
  const asked = room && [...room.messages].reverse().find((m) => m.speaker.kind === 'you' && m.text === question && m.at >= since);
  if (!asked) return `${head}\n• Coordinator is reading the question`;
  const said = room.messages.filter((m) => m.exchange === asked.exchange && m.at >= asked.at && m.speaker.kind === 'member' && !m.failed);
  const busy = room.busy && room.messages.at(-1)?.exchange === asked.exchange ? room.busy : null;
  if (!busy && said.length) return null;
  const done = [...new Set(said.map((m) => (m.speaker.kind === 'member' ? m.speaker.name : '')))].map((n) => `✓ ${n} answered`);
  const doing = !busy
    ? 'Coordinator is picking who should answer'
    : busy.doing === 'pack'
      ? 'Coordinator is updating the pack'
      : busy.speaker === 'Coordinator'
        ? said.length
          ? 'Coordinator is summing up'
          : 'Coordinator is picking who should answer'
        : `${busy.speaker} is ${said.some((m) => m.speaker.kind === 'member' && m.speaker.name === busy.speaker) ? 'responding' : 'answering'} · ${minutes(now - busy.since)}`;
  return [head, ...done, `• ${doing}`].join('\n');
}

/// What asking about it is called: the team for a task (or a file from one),
/// the worker for its own work, nothing for a process item.
function askLabel(h: ExistingHit): string | null {
  if (h.canAsk === false) return null;
  if (h.teamTaskId) return 'Ask the team about it';
  if (h.workerId && h.kind === 'worker') return `Ask ${h.who} about it`;
  return null;
}

/// Which of several the reply means: "the first one", "2", or its title.
function pickHit(text: string, hits: ExistingHit[]): ExistingHit | null {
  const t = text.trim().toLowerCase();
  for (const [re, i] of ORDINALS) if (re.test(t)) return hits[i] ?? null;
  return hits.find((h) => h.title.toLowerCase() === t)
    ?? hits.find((h) => t.length > 3 && h.title.toLowerCase().startsWith(t.replace(/…$/, '')))
    ?? null;
}

export class FrontDoor {
  private state: FrontDoorState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private roomTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /// Replies being written, by thread, and what was said there meanwhile.
  /// A count: a reply handed on (declined, or a run that can't be carried
  /// on) is still the same reply being written.
  private replying = new Map<string, { n: number; queued: FrontDoorRequest[] }>();
  private pollingRooms = false;
  private finishing = new Set<DoorFollow>();

  constructor(private readonly deps: FrontDoorDeps) {
    this.state = deps.store.load();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): void {
    const cutoff = this.now() - THREAD_TTL_MS;
    this.state.threads = this.state.threads.filter((t) => t.at > cutoff).slice(-500);
    if (this.state.log) this.state.log = this.state.log.filter((l) => (l.lastAt ?? l.at) > cutoff).slice(-500);
    if (this.state.subs) this.state.subs = this.state.subs.filter((x) => x.at > cutoff);
    const oldest = dayOf(this.now() - STATS_TTL_DAYS * 24 * 60 * 60 * 1000);
    if (this.state.days) this.state.days = this.state.days.filter((d) => d.day >= oldest);
    if (this.state.outcomes) for (const d of Object.keys(this.state.outcomes)) if (d < oldest) delete this.state.outcomes[d];
    this.deps.store.save(this.state);
  }

  /// The door's counts: each person's days, and what came of conversations.
  stats(): { days: DoorDay[]; outcomes: Record<string, Partial<Record<DoorOutcome, number>>> } {
    return { days: [...(this.state.days ?? [])], outcomes: { ...(this.state.outcomes ?? {}) } };
  }

  /// One more message from `user` today.
  private count(user: string, by: string, started: boolean, dm: boolean): void {
    const day = dayOf(this.now());
    const days = (this.state.days ??= []);
    let d = days.find((x) => x.day === day && x.user === user);
    if (!d) days.push((d = { day, user, by, messages: 0, started: 0, dm: 0 }));
    d.by = by;
    d.messages++;
    if (started) d.started++;
    if (dm) d.dm++;
  }

  /// The conversations people started, newest first.
  conversations(): DoorLog[] {
    return [...(this.state.log ?? [])].sort((a, b) => (b.lastAt ?? b.at) - (a.lastAt ?? a.at));
  }

  /// Say what came of a conversation. Kept even when nothing else is.
  /// `count` false keeps a follow-up out of the counts.
  private note(key: string, outcome: string, kind: DoorOutcome, url?: string, to?: { who: string; team?: boolean }, count = true): void {
    if (count) {
      const day = ((this.state.outcomes ??= {})[dayOf(this.now())] ??= {});
      day[kind] = (day[kind] ?? 0) + 1;
    }
    const l = this.state.log?.find((x) => x.key === key);
    if (!l) {
      this.save();
      return;
    }
    Object.assign(l, { outcome, kind, lastAt: this.now(), ...(url ? { url } : {}) });
    if (to) Object.assign(l, { who: to.who, team: !!to.team });
    else {
      delete l.who;
      delete l.team;
    }
    this.save();
  }

  /// A thread the server posted a worker's work into (a shift's results, an
  /// answer, an approval it settled): a reply there is for that worker, and
  /// reads the thread as its context, rather than starting over with "who
  /// should take this?".
  adopt(channel: string, threadTs: string, worker: { id: string; name: string }): void {
    const key = `${channel}:${threadTs}`;
    const known = this.state.threads.find((t) => t.key === key);
    if (known) {
      // A thread left on "who should take this?" (or "is it one of these?")
      // when nobody picked: it's this worker's now.
      if (!known.workerId && !known.room) {
        known.workerId = worker.id;
        known.workerName = worker.name;
        delete known.pending;
        delete known.existing;
        delete known.desk;
        this.save();
      }
      return;
    }
    this.state.threads.push({ key, workerId: worker.id, workerName: worker.name, at: this.now() });
    this.save();
  }

  /// The Slack threads someone follows, newest first, with what each was
  /// about: for "what am I following?" and the console's Watching page.
  followedThreads(user: string): Array<{ key: string; channel: string; threadTs: string; text: string; at: number }> {
    return (this.state.subs ?? [])
      .filter((x) => x.user === user)
      .map((x) => ({ key: x.key, channel: x.channel, threadTs: x.threadTs, text: this.state.log?.find((l) => l.key === x.key)?.text ?? 'A Slack thread', at: x.at }))
      .sort((a, b) => b.at - a.at);
  }

  /// Whether a reply in this thread is meant for the door.
  owns(channel: string, threadTs: string): boolean {
    return this.state.threads.some((t) => t.key === `${channel}:${threadTs}`);
  }

  start(pollMs = 30_000, roomMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref?.();
    // A room's turns take seconds each: looked at more often while one is
    // answering a thread, so who's speaking shows as it changes.
    this.roomTimer = setInterval(() => {
      if (this.state.rooms?.length) void this.pollRooms();
    }, roomMs);
    this.roomTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.timer = null;
    this.roomTimer = null;
  }

  /// New requests still being typed: by channel and person, what they've
  /// sent so far and the wait for the rest.
  private gathering = new Map<string, { reqs: FrontDoorRequest[]; timer?: ReturnType<typeof setTimeout> }>();

  /// A message for the door. A new request waits until its sender pauses
  /// (`gatherMs`): what they send meanwhile joins it. Returns at once then,
  /// so Slack's other events don't wait behind the pause. A thread gathers
  /// on its own, while its answer is being written (`replying`).
  async onMessage(req: FrontDoorRequest): Promise<void> {
    const wait = this.deps.gatherMs ?? 0;
    if (!wait || req.threadTs) return this.take(req);
    const k = `${req.channel}:${req.user}`;
    const g = this.gathering.get(k) ?? { reqs: [] };
    if (g.timer) clearTimeout(g.timer);
    g.reqs.push(req);
    g.timer = setTimeout(() => {
      this.gathering.delete(k);
      void this.take(gathered(g.reqs)).catch((err: unknown) => this.deps.log(`Front door: a request could not be taken: ${String(err)}`));
    }, wait);
    g.timer.unref?.();
    this.gathering.set(k, g);
  }

  private async take(req: FrontDoorRequest): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const key = `${req.channel}:${root}`;
    const say = (text: string) => this.deps.slack.post(req.channel, text, root);
    // Slack sends a link as <url|label> or <url>: the words as typed.
    const text = req.text
      .replace(/<@[A-Z0-9]+>/g, ' ')
      .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    const allowed = this.deps.mayAsk?.(req.user) ?? true;
    if (allowed !== true) {
      await say(allowed);
      return;
    }
    const caller = await this.deps.caller(req.user);
    // A new conversation goes in the log; a reply in one marks it as moving.
    const logged = this.state.log?.find((l) => l.key === key);
    if (logged) logged.lastAt = this.now();
    else if (text || req.files?.length) (this.state.log ??= []).push({ key, channel: req.channel, threadTs: root, user: req.user, by: caller.name, text: text || '(a file)', at: this.now(), dm: req.dm });
    if (text || req.files?.length) this.count(req.user, caller.name, !logged, req.dm);
    const procs = this.deps.submitProcess ? (this.deps.processes?.(caller) ?? []) : [];
    const workers = this.candidates(caller);
    const known = this.state.threads.find((t) => t.key === key);

    if (this.deps.following && text && FOLLOWING_ASK.test(withoutHello(text))) {
      const mine = this.deps.following(caller);
      const followed = this.followedThreads(req.user);
      const subs = followed.length;
      const threads = subs
        ? `\nAnd ${subs === 1 ? 'one Slack thread' : `${subs} Slack threads`}, by DM when something's posted:\n${followed.slice(0, 10).map((t) => `• <https://slack.com/archives/${t.channel}/p${t.threadTs.replace('.', '')}|${t.text.slice(0, 80).replace(/[<>|]/g, '')}>`).join('\n')}${subs > 10 ? `\n…and ${subs - 10} more, on Reports → Watching.` : ''}\nSay *unfollow* in a thread to stop it.`
        : '';
      await say(mine.length
        ? `You're following ${mine.length === 1 ? 'one ticket' : `${mine.length} tickets`}:\n${mine.slice(0, 25).map((m) => `• *${m.item}*${m.status ? ` — ${m.status}` : ''} · ${m.worker} watches it`).join('\n')}${mine.length > 25 ? `\n…and ${mine.length - 25} more, in Reports → Watching.` : ''}\nSay *stop following <ticket>* to drop one.${threads}`
        : `You're not following any tickets. Say *let me know when ACME-412 changes* and I'll DM you when it moves.${threads}`);
      return;
    }
    // "Let me know when ACME-412 changes", or when there's news here. A
    // ticket named, here or earlier in the thread, is followed where it
    // lives; otherwise the thread is, in a channel. In a DM with no ticket
    // it's for whoever is on it. Said beside a request ("fix it and ping me
    // when it's done"), it's followed and the request still goes on; a
    // "stop following" is only ever one said on its own.
    const stopNews = !!text && (UNSUBSCRIBE.test(text) || STOP_NOTIFY.test(text)) && onlyAsks(text, [STOP_NOTIFY, UNSUBSCRIBE]);
    const wantsNews = !!text && !stopNews && (SUBSCRIBE.test(text) || NOTIFY.test(text));
    if (wantsNews || stopNews) {
      const alone = stopNews || onlyAsks(text, [NOTIFY, SUBSCRIBE]);
      const ticket = this.deps.follow ? this.ticketFor(text, key, known) : null;
      if (ticket) {
        this.save();
        const thread = known?.workerId && !known.workerId.startsWith(TEAM_ID) && !known.workerId.startsWith(PROCESS_ID) ? known.workerId : known?.existing?.hits.find((h) => h.workerId)?.workerId;
        await this.followTicket(req, caller, ticket, !stopNews, thread);
        if (alone) return;
      } else if (known && !req.dm) {
        this.save();
        await this.subscribe(req.channel, root, req.user, !stopNews, req.dm);
        if (alone) return;
      }
    }
    // What was offered as maybe already it, when the person said something
    // else instead: a hint to the router, and no second look.
    let offered: Array<{ title: string; who: string }> | null = null;

    // Answering "who should take this?"
    if (known?.pending) {
      const pick = namedWorker(text, known.pending.choices.map((c) => ({ id: c.id, name: c.name, ...(c.shortName ? { shortName: c.shortName } : {}) })), { initials: true })?.worker
        ?? known.pending.choices.find((c) => text.toLowerCase().includes(c.name.toLowerCase()));
      const { text: original, files, choices } = known.pending;
      let worker = pick && workers.find((w) => w.id === pick.id);
      let why = '';
      // "Anyone": the best of the ones offered, rather than asking again.
      if (!worker && ANYONE.test(text)) {
        worker = choices.map((c) => workers.find((w) => w.id === c.id)).find(Boolean);
        why = 'you said anyone';
      }
      // Not a name: more about the request, so route it again with that.
      // "Which process?" stays among the processes offered: an idea must not
      // turn into an ask of an ordinary worker.
      if (!worker && text) {
        const fuller = `${original}\n${text}`;
        const pool = choices.every((c) => c.id.startsWith(PROCESS_ID)) ? workers.filter((w) => choices.some((c) => c.id === w.id)) : workers;
        const routed = await this.deps.route(fuller, pool).catch(() => null);
        worker = routed ? pool.find((w) => w.id === routed.workerId) : undefined;
        if (worker) {
          delete known.pending;
          return this.hand(req, key, caller, worker, fuller, files, routed!.why);
        }
      }
      if (!worker) {
        await say(`Reply with one of: ${choices.map((c) => c.name).join(', ')}, or say *anyone* and I'll pick.`);
        return;
      }
      delete known.pending;
      return this.hand(req, key, caller, worker, original, files, why);
    }
    // Answering "this may already be it".
    if (known?.existing) {
      const { text: original, files, hits, related } = known.existing;
      if (!text) return;
      const reply = text.replace(/[’‘]/g, "'");
      if (NOT_IT.test(reply)) {
        delete known.existing;
        this.save();
        return this.route(req, key, caller, workers, original, files, related);
      }
      if (THANKS.test(reply)) {
        delete known.existing;
        this.save();
        await say(`Good. It's there whenever you need it${hits[0]?.url ? `: ${hits[0].url}` : ''}.`);
        return;
      }
      if (hits.length > 1) {
        const picked = pickHit(text, hits);
        if (picked) {
          known.existing = { ...known.existing, hits: [picked] };
          known.at = this.now();
          this.save();
          return this.offerExisting(req, [picked]);
        }
      } else if (hits[0] && askLabel(hits[0]) && /^ask\b/i.test(text)) {
        delete known.existing;
        this.save();
        return this.askAbout(req, key, caller, workers, hits[0], original, files);
      } else if (hits[0] && /^open\b/i.test(text)) {
        await say(hits[0].url ? `Here it is: ${hits[0].url}` : `It's in the Library under _${hits[0].title}_.`);
        return;
      } else if (hits[0] && askLabel(hits[0]) && isLookup(text)) {
        // A question typed instead of a tap: it's about what's on offer.
        delete known.existing;
        this.save();
        return this.askAbout(req, key, caller, workers, hits[0], text, req.files ?? []);
      }
      // Something else: a request of its own, taken as any other — but not
      // looked up again: what was just offered is a hint for whoever takes it.
      offered = [...hits.map((h) => ({ title: h.title, who: h.who })), ...related];
      delete known.existing;
      this.save();
    }
    // More for a team's room this thread asked.
    if (known?.room && !known.workerId) {
      const room = known.room;
      if (!text) return;
      if (NOT_IT.test(text.replace(/[’‘]/g, "'"))) {
        delete known.room;
        this.save();
        return this.route(req, key, caller, workers.filter((w) => !w.id.startsWith(TEAM_ID)), room.question, req.files ?? [], []);
      }
      if (/^ask\b.*\babout it$/i.test(text)) {
        await say(`Already asked *${room.who}*. I'll post their answer here.`);
        return;
      }
      // "Thanks!" is the end of it, not another question for the room.
      if (THANKS_ONLY.test(text.replace(/[’‘]/g, "'"))) {
        await say(`Glad it helped. Ask more here and it goes to *${room.who}*.`);
        return;
      }
      return this.askRoom(req, key, caller, room.taskId, room.who, room.url, text);
    }
    // More for a question the door answered itself.
    if (known?.desk && !known.workerId) {
      const desk = known.desk;
      if (!text) return;
      if (HAND_OFF.test(text) || ANYONE.test(text)) {
        delete known.desk;
        this.save();
        return this.route(req, key, caller, workers, desk.text, desk.files, [], false);
      }
      if (THANKS_ONLY.test(text.replace(/[’‘]/g, "'"))) {
        await say('Glad it helped.');
        return;
      }
      if (!namedWorker(text, workers)) return this.desk(req, key, caller, workers, text, req.files ?? []);
      delete known.desk;
      this.save();
    }
    // An item in a process is followed by DM and /idea, not here.
    if (known?.workerId?.startsWith(PROCESS_ID)) {
      if (text) await say(`That's in ${known.workerName ?? 'the process'} now. You'll get a DM as it moves; \`/idea\` shows where it is.`);
      return;
    }
    // A team's task talks to the person in their DMs, not here.
    if (known?.workerId?.startsWith(TEAM_ID)) {
      if (text) await say(`That's ${known.workerName ?? 'the team'}'s task now. Answer its questions and approve its plan in your DMs from me; to change the brief, open the task in the console.`);
      return;
    }
    // More for the worker already on it.
    if (known?.workerId) {
      const worker = workers.find((w) => w.id === known.workerId);
      if (!worker) {
        await say(`${known.workerName ?? 'That worker'} isn't available any more. Start a new message and I'll find someone else.`);
        return;
      }
      if (!text) return;
      // "Triage will need to read the code": brought in by name, another
      // worker takes the thread over, with everything said in it so far.
      const named = namedWorker(text, workers);
      if (named && named.worker.id !== worker.id) {
        return this.hand(req, key, caller, named.worker, `${caller.name} brought you into this thread, after ${worker.name}: ${text}`, req.files ?? [], `${caller.name} asked for ${named.worker.name}`);
      }
      // Said while it is still answering: kept, and sent together once that
      // answer is posted, rather than as a turn each that can't see the rest.
      const busy = this.replying.get(key);
      if (busy) {
        busy.queued.push({ ...req, text });
        return;
      }
      return this.carryOn(req, key, caller, worker, known, text);
    }
    if (!text && !req.files?.length) return;
    // About the door itself: answered here, even with no one to route to.
    if (!known && SELF_ASK.test(withoutHello(text))) {
      await say(selfReply(workers));
      return;
    }
    if (!workers.length) {
      await say('There are no workers you can ask yet. Someone can hire one with `/hire`, or share one with you.');
      return;
    }
    if (!known && GREETING.test(text)) {
      await say(GREETING_REPLY);
      return;
    }
    if (this.deps.status && !known && STATUS_ASK.test(withoutHello(text))) {
      await say(this.deps.status(caller));
      return;
    }
    const admin = this.deps.admin && !known ? this.deps.admin(caller, text) : null;
    if (admin) {
      await say(admin);
      return;
    }
    // "idea: …" goes into a process: the one there is, or the person picks.
    const idea = procs.length ? IDEA.exec(text) : null;
    if (idea) {
      const choices = procs.map(processCandidate);
      const into = namedWorker(idea[1], choices);
      if (into) return this.hand(req, key, caller, into.worker, into.rest || idea[1], req.files ?? [], '');
      if (choices.length === 1) return this.hand(req, key, caller, choices[0], idea[1].trim(), req.files ?? [], '');
      const pending = { text: idea[1].trim(), files: req.files ?? [], choices: choices.map((w) => ({ id: w.id, name: w.name, ...(w.shortName ? { shortName: w.shortName } : {}) })) };
      if (known) Object.assign(known, { pending, at: this.now() });
      else this.state.threads.push({ key, pending, at: this.now() });
      this.save();
      await say(`Which process should it go into? Reply with one of: ${choices.map((c) => `*${c.name}*${c.shortName ? ` (\`${c.shortName}\`)` : ''}`).join(', ')}.`);
      return;
    }
    const named = namedWorker(text, workers);
    const tracking = named && this.deps.track && !named.worker.id.startsWith(TEAM_ID) && !named.worker.id.startsWith(PROCESS_ID) ? TRACK.exec(named.rest) : null;
    if (named && tracking) {
      const on = !tracking[1];
      const got = this.deps.track!(caller, named.worker.id, tracking[2], on);
      await say(typeof got === 'string' ? got : `${on ? 'Tracking' : 'Stopped tracking'} ${tracking[2]}. ${got.worker} tracks ${got.tracked} and messages you when one changes.`);
      return;
    }
    if (named) return this.hand(req, key, caller, named.worker, named.rest, req.files ?? [], '');
    // A question about something that may already exist: look first, so a
    // team's finished work isn't started again from scratch.
    let related: Array<{ title: string; who: string }> = offered ?? [];
    // A question the teams already worked out: answered from that, here.
    // In a channel everyone in it reads the answer, so it comes only from
    // what everyone can see; what's private to the caller stays out of it.
    const shared = !req.dm;
    if (!offered && this.deps.answer && isLookup(text) && !mentionsAny(text, workers)) {
      // A word while it looks, taken down once it has: the answer, or whoever
      // takes the question, says the rest.
      const checking = this.deps.slack.postTs
        ? await this.deps.slack.postTs(req.channel, "Checking what's already been worked out…", req.threadTs ?? req.ts).catch(() => null)
        : (await say("Checking what's already been worked out…"), null);
      let answered: Awaited<ReturnType<NonNullable<FrontDoorDeps['answer']>>> = null;
      try {
        answered = await this.deps.answer(caller, text, { shared });
      } catch (err) {
        this.deps.log(`Front door: answering from existing work failed: ${String(err)}`);
      }
      if (checking) await this.deps.slack.remove?.(req.channel, checking).catch(() => false);
      if (answered) {
        this.note(key, `Answered from what ${answered.who} already worked out`, 'answered', answered.hits[0]?.url);
        const maker = workers.find((w) => w.id === answered!.hits[0]?.workerId) ?? workers.find((w) => w.name === answered!.who);
        return this.answerHere(req, key, text, answered, maker?.avatarUrl);
      }
    }
    if (!offered && this.deps.findExisting && isLookup(text) && !mentionsAny(text, workers)) {
      let found: ExistingHit[] = [];
      try {
        found = await this.deps.findExisting(caller, text, { shared });
      } catch (err) {
        this.deps.log(`Front door: looking up existing work failed: ${String(err)}`);
      }
      const hits = found.filter((h) => !h.weak).slice(0, 3);
      related = found.filter((h) => h.weak).slice(0, 5).map((h) => ({ title: h.title, who: h.who }));
      if (hits.length) {
        const existing = { text, files: req.files ?? [], hits, related };
        if (known) Object.assign(known, { existing, at: this.now() });
        else this.state.threads.push({ key, existing, at: this.now() });
        this.save();
        this.note(key, 'Offered work that may already answer it', 'offered');
        return this.offerExisting(req, hits);
      }
    }
    return this.route(req, key, caller, workers, text, req.files ?? [], related);
  }

  /// Workers, teams and processes side by side: a team is picked for a real
  /// piece of work that fits it, and runs as a team task.
  private candidates(caller: OrgCaller): FrontDoorWorker[] {
    const procs = this.deps.submitProcess ? (this.deps.processes?.(caller) ?? []) : [];
    return [
      ...this.deps.workers(caller),
      ...(this.deps.briefTeam ? (this.deps.teams?.(caller) ?? []).map(teamCandidate) : []),
      ...procs.map(processCandidate),
    ];
  }

  /// Hand a new request to whoever fits: the worker whose home the channel
  /// is, the only worker there is, a model's pick. When nobody fits, a
  /// question is answered by the door itself (`desk`, unless the person
  /// asked for a worker); anything else, the person picks.
  private async route(req: FrontDoorRequest, key: string, caller: OrgCaller, workers: FrontDoorWorker[], text: string, files: SlackFile[], related: Array<{ title: string; who: string }>, desk = true): Promise<void> {
    const lookup = isLookup(text);
    const declined = this.state.threads.find((t) => t.key === key)?.declined ?? [];
    if (declined.length) workers = workers.filter((w) => !declined.includes(w.id));
    // A question wants an answer back here, not a team task with a plan to
    // approve, nor a new item in a process: a team only when nobody else is
    // there to answer and the door can't answer it itself.
    const solo = lookup ? workers.filter((w) => !w.id.startsWith(TEAM_ID) && !w.id.startsWith(PROCESS_ID)) : workers;
    if (solo.length || (desk && this.deps.general)) workers = solo;
    const canDesk = desk && !!this.deps.general;
    if (!workers.length) {
      if (canDesk) return this.desk(req, key, caller, this.candidates(caller), text, files);
      await this.deps.slack.post(req.channel, `Nobody else here can take that. Start a new message and name who should, or ask someone to share a worker with you.`, req.threadTs ?? req.ts);
      return;
    }
    // A channel that is some workers' home is theirs: one of them takes it,
    // whatever the words.
    const home = req.dm ? [] : workers.filter((w) => w.homeChannels?.includes(req.channel));
    if (home.length === 1) return this.hand(req, key, caller, home[0], text, files, 'it answers in this channel');
    if (home.length > 1) workers = home;
    const ranked = rankByWords(text, workers);
    const [first, second] = ranked;
    if (workers.length === 1 && !(canDesk && lookup && !first?.score)) return this.hand(req, key, caller, workers[0], text, files, '');
    // Shared words say what a request is about, not what it wants: "how is
    // the MDF deadline worked out" and "what is the market doing with MDF"
    // share every noun. So a model picks; the words only stand in for it
    // when it can't be reached.
    let routed: { workerId: string; why: string } | null = null;
    let failed = false;
    try {
      routed = await this.deps.route(text, workers, related.length ? related : undefined);
    } catch (err) {
      failed = true;
      this.deps.log(`Front door: routing failed: ${String(err)}`);
    }
    const chosen = routed && workers.find((w) => w.id === routed!.workerId);
    if (chosen) return this.hand(req, key, caller, chosen, text, files, routed!.why);
    if (failed && first && first.score >= 3 && first.score >= 2 * (second?.score ?? 0)) {
      return this.hand(req, key, caller, first.worker, text, files, `it's the closest match for this`);
    }
    // Nobody's job covers it: a question, or a request whose words match no
    // one, is answered here rather than handed to a guess who'd say it isn't
    // theirs.
    if (canDesk && (lookup || !first?.score)) return this.desk(req, key, caller, this.candidates(caller), text, files);
    return this.pick(req, key, ranked.map((r) => r.worker), text, files);
  }

  /// "Who should take this?", with the best few by words to tap.
  private async pick(req: FrontDoorRequest, key: string, ranked: FrontDoorWorker[], text: string, files: SlackFile[]): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const say = (t: string) => this.deps.slack.post(req.channel, t, root);
    const choices = ranked.slice(0, 5);
    const pending = { text, files, choices: choices.map((w) => ({ id: w.id, name: w.name })) };
    const known = this.state.threads.find((t) => t.key === key);
    if (known) Object.assign(known, { pending, at: this.now() });
    else this.state.threads.push({ key, pending, at: this.now() });
    this.save();
    const list = `Who should take this?\n${choices.map((w) => `• *${w.name}*${w.tagline ? ` — ${w.tagline}` : ''}`).join('\n')}`;
    const picks = [...choices.map((w) => w.name), 'Anyone'];
    const tapped =
      this.deps.slack.postBlocks &&
      (await this.deps.slack.postBlocks(req.channel, list, [
        { type: 'section', text: { type: 'mrkdwn', text: list } },
        { type: 'actions', elements: picks.map((name, i) => ({ type: 'button', text: { type: 'plain_text', text: name.slice(0, 75) }, action_id: `${DOOR_CHOICE_ACTION}_${i}`, value: name })) },
      ], root));
    if (!tapped) await say(`${list}\n\nReply with a name, or say *anyone* and I'll pick.`);
    this.note(key, 'Asked who should take it', 'asked-who');
  }

  /// A question nobody's job covers, answered by the door itself, with a way
  /// to hand it to a worker after all. When it can't answer, the person
  /// picks who should take it.
  private async desk(req: FrontDoorRequest, key: string, caller: OrgCaller, workers: FrontDoorWorker[], text: string, files: SlackFile[]): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const context = await this.context(req, files);
    let reply: string | null = null;
    try {
      reply = await this.deps.general!(caller, text, context.thread, workers.filter((w) => !w.id.startsWith(PROCESS_ID)));
    } catch (err) {
      this.deps.log(`Front door: answering at the front desk failed: ${String(err)}`);
    }
    if (!reply?.trim()) {
      // Nothing from the desk: the person picks, among those a question may go to.
      const declined = this.state.threads.find((t) => t.key === key)?.declined ?? [];
      const pool = workers.filter((w) => !declined.includes(w.id) && !w.id.startsWith(PROCESS_ID) && !(isLookup(text) && w.id.startsWith(TEAM_ID)));
      return this.pick(req, key, rankByWords(text, pool.length ? pool : workers).map((r) => r.worker), text, files);
    }
    const desk = { text, files };
    const known = this.state.threads.find((t) => t.key === key);
    if (known) Object.assign(known, { desk, at: this.now() });
    else this.state.threads.push({ key, desk, at: this.now() });
    this.note(key, 'Answered it itself', 'answered');
    await deliverText(this.io(), req.channel, root, 'overgo', reply, `${slug(text)}.md`);
    await this.notify(req.channel, root, 'overgo', reply);
    const hint = 'Ask more here, or hand it to a worker.';
    const tapped =
      this.deps.slack.postBlocks &&
      (await this.deps.slack.postBlocks(req.channel, hint, [
        { type: 'context', elements: [{ type: 'mrkdwn', text: hint }] },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Hand it to someone' }, action_id: `${DOOR_CHOICE_ACTION}_0`, value: 'Hand it to someone' }] },
      ], root));
    if (!tapped) await this.deps.slack.post(req.channel, '_Ask more here, or reply *hand it off* and I\'ll find a worker to take it._', root);
  }

  /// The ticket a "let me know" is about: named in it, or else in what the
  /// thread asked first.
  private ticketFor(text: string, key: string, known: DoorThread | undefined): string | null {
    const said = [text, known?.existing?.text, known?.desk?.text, known?.room?.question, known?.pending?.text, this.state.log?.find((l) => l.key === key)?.text];
    for (const s of said) {
      const m = s ? TICKET.exec(s) : null;
      if (m) return m[1].toUpperCase();
    }
    return null;
  }

  /// Follow a ticket by DM, or stop.
  private async followTicket(req: FrontDoorRequest, caller: OrgCaller, ticket: string, on: boolean, workerId?: string): Promise<void> {
    const say = (t: string) => this.deps.slack.post(req.channel, t, req.threadTs ?? req.ts);
    let res: Awaited<ReturnType<NonNullable<FrontDoorDeps['follow']>>>;
    try {
      res = await this.deps.follow!(caller, ticket, on, { ...(workerId ? { workerId } : {}), say: (t) => void say(t) });
    } catch (err) {
      this.deps.log(`Front door: following ${ticket} failed: ${String(err)}`);
      res = `Couldn't follow ${ticket} just now. Try again in a minute.`;
    }
    if (typeof res === 'string') {
      await say(res);
      return;
    }
    if (!on) {
      await say(`Stopped. No more DMs about *${ticket}*.`);
      return;
    }
    const now = res.status ? ` (now _${res.status}_)` : '';
    await say(res.setUp
      ? `Following *${ticket}*${now}: I'll DM you when its status changes. I set up _${res.trigger}_ on ${res.worker} for it, checking every ${res.everyMinutes} min; it's on ${res.worker}'s Triggers tab, and other tickets you follow will use it too. Say *stop following ${ticket}* to stop.`
      : `Following *${ticket}*${now}: I'll DM you when its status changes. ${res.worker}'s _${res.trigger}_ checks every ${res.everyMinutes} min. Say *stop following ${ticket}* to stop.`);
  }

  /// Follow a thread by DM, or stop. In a DM there's nothing to follow: it's
  /// all said there already.
  async subscribe(channel: string, threadTs: string, user: string, on: boolean, dm = channel.startsWith('D')): Promise<void> {
    const key = `${channel}:${threadTs}`;
    const tell = async (text: string) => {
      if (!(this.deps.slack.dm && (await this.deps.slack.dm(user, text)))) await this.deps.slack.post(channel, `<@${user}> ${text}`, threadTs);
    };
    if (dm) {
      await this.deps.slack.post(channel, "Everything about it comes back here, so there's nothing more to follow.", threadTs);
      return;
    }
    if (!this.deps.slack.dm) {
      await this.deps.slack.post(channel, "I can't send DMs from here, so follow the thread in Slack to hear when there's news.", threadTs);
      return;
    }
    const subs = (this.state.subs ??= []);
    const had = subs.some((x) => x.key === key && x.user === user);
    const link = (await this.deps.slack.permalink?.(channel, threadTs).catch(() => null)) ?? null;
    const thread = link ? `<${link}|that thread>` : 'that thread';
    if (!on) {
      this.state.subs = subs.filter((x) => !(x.key === key && x.user === user));
      this.save();
      await tell(had ? `Stopped. No more DMs about ${thread}.` : `You weren't following ${thread}.`);
      return;
    }
    if (!had) subs.push({ key, channel, threadTs, user, at: this.now() });
    this.save();
    await tell(`${had ? 'Already on it' : 'Will do'}: I'll DM you when there's an answer or results in ${thread}. Reply *unsubscribe* there to stop.`);
  }

  /// Something new was posted in a thread: a DM to each person following it.
  private async notify(channel: string, threadTs: string, who: string, text: string): Promise<void> {
    const key = `${channel}:${threadTs}`;
    const subs = (this.state.subs ?? []).filter((x) => x.key === key);
    if (!subs.length || !this.deps.slack.dm) return;
    const link = (await this.deps.slack.permalink?.(channel, threadTs).catch(() => null)) ?? null;
    const gist = clip(text.replace(/\s+/g, ' ').trim(), 200);
    const where = link ? `<${link}|a thread you're following>` : "a thread you're following";
    for (const sub of subs) {
      await this.deps.slack.dm(sub.user, `*${who}* posted in ${where}:\n> ${gist}`).catch((err: unknown) => this.deps.log(`Front door: could not DM a follower: ${String(err)}`));
      sub.at = this.now();
    }
    this.save();
  }

  /// The answer from what's already known, under its maker's name, then
  /// where it came from and what to do next. The work it came from is held
  /// like an offer: "ask", a further question, or "not it" work as there.
  private async answerHere(req: FrontDoorRequest, key: string, text: string, answered: { text: string; who: string; hits: ExistingHit[]; from: string[] }, avatarUrl?: string): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const hits = answered.hits.slice(0, 1);
    const existing = { text, files: req.files ?? [], hits, related: [] };
    const known = this.state.threads.find((t) => t.key === key);
    if (known) Object.assign(known, { existing, at: this.now() });
    else this.state.threads.push({ key, existing, at: this.now() });
    this.save();
    const as: PostAs = { name: answered.who, ...(avatarUrl ? { iconUrl: avatarUrl } : {}) };
    const h = hits[0];
    const ask = h ? askLabel(h) : null;
    // The main source and a count: the full list is in what it links to.
    const [main, ...rest] = answered.from;
    const from = `From ${main ?? 'earlier work'}${rest.length ? ` and ${rest.length} more` : ''}`;
    const buttons = [
      ...(h?.url ? [{ type: 'button', text: { type: 'plain_text', text: 'Open it' }, url: h.url, action_id: OPEN_LINK, value: 'open' }] : []),
      ...(ask ? [{ type: 'button', text: { type: 'plain_text', text: ask.slice(0, 75) }, action_id: `${DOOR_CHOICE_ACTION}_0`, value: ask }] : []),
      { type: 'button', text: { type: 'plain_text', text: "That's not it" }, action_id: `${DOOR_CHOICE_ACTION}_1`, value: "That's not it" },
    ];
    const source = [{ type: 'context', elements: [{ type: 'mrkdwn', text: clip(from, 2900) }] }, { type: 'actions', elements: buttons }];
    // One message: the answer, where it came from, and what to do next. Too
    // long for one, the answer goes as it always has and these follow it.
    const body = slackMarkup(answered.text.trim() || 'Done.');
    const { chunks, rest: over } = chunked(body, 20);
    if (!over && this.deps.slack.postTs && (await this.deps.slack.postTs(req.channel, body, root, as, [...chunks.map((c) => ({ type: 'section', text: { type: 'mrkdwn', text: c } })), ...source]).catch(() => null))) return;
    await deliverText(this.io(), req.channel, root, answered.who, answered.text, `${slug(text)}.md`, undefined, as);
    const tapped = this.deps.slack.postBlocks && (await this.deps.slack.postBlocks(req.channel, from, source, root));
    if (!tapped) await this.deps.slack.post(req.channel, `_${from}_\nAsk more here${ask ? ', reply *ask* to put it to the team,' : ''} or *not it* and I'll find someone to take it.`, root);
  }

  /// "This may already be it": one piece of work with what to do about it,
  /// or a short list to pick from. Buttons when Slack takes them; the same
  /// words work as a reply, after a restart too.
  private async offerExisting(req: FrontDoorRequest, hits: ExistingHit[]): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const now = this.now();
    if (hits.length === 1) {
      const h = hits[0];
      const ask = askLabel(h);
      const text = [existingLine(h, now), h.summary ? `> ${h.summary}` : ''].filter(Boolean).join('\n');
      const buttons = [
        ...(h.url ? [{ type: 'button', text: { type: 'plain_text', text: 'Open it' }, url: h.url, action_id: OPEN_LINK, value: 'open' }] : []),
        ...(ask ? [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: ask.slice(0, 75) }, action_id: `${DOOR_CHOICE_ACTION}_0`, value: ask }] : []),
        { type: 'button', text: { type: 'plain_text', text: "That's not it" }, action_id: `${DOOR_CHOICE_ACTION}_1`, value: "That's not it" },
      ];
      const tapped = this.deps.slack.postBlocks && (await this.deps.slack.postBlocks(req.channel, text, [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements: buttons }], root));
      if (!tapped) {
        const how = [h.url ? `Open it: ${h.url}` : '', `Reply ${ask ? `*ask* to put your question to ${h.teamTaskId ? 'the team' : h.who}, or ` : ''}*not it* and I'll find someone to take it.`].filter(Boolean).join('\n');
        await this.deps.slack.post(req.channel, `${text}\n\n${how}`, root);
      }
      return;
    }
    const list = `This may already exist:\n${hits.map((h, i) => `${i + 1}. _${h.title}_ · *${h.who}* · ${whenText(h.at, now)}${h.status ? ` · ${h.status}` : ''}`).join('\n')}`;
    const picks = [...hits.map((h) => h.title), 'None of these'];
    const tapped =
      this.deps.slack.postBlocks &&
      (await this.deps.slack.postBlocks(req.channel, list, [
        { type: 'section', text: { type: 'mrkdwn', text: list } },
        { type: 'actions', elements: picks.map((t, i) => ({ type: 'button', text: { type: 'plain_text', text: i < hits.length ? `${i + 1}. ${clip(t, 70)}` : t }, action_id: `${DOOR_CHOICE_ACTION}_${i}`, value: clip(t, 1900) })) },
      ], root));
    if (!tapped) await this.deps.slack.post(req.channel, `${list}\n\nReply with its number, or *none* and I'll find someone to take it.`, root);
  }

  /// "Ask the team about it": the question goes to the finished task's team,
  /// or to the worker that made it with what it made named.
  private async askAbout(req: FrontDoorRequest, key: string, caller: OrgCaller, workers: FrontDoorWorker[], h: ExistingHit, question: string, files: SlackFile[]): Promise<void> {
    const say = (t: string) => this.deps.slack.post(req.channel, t, req.threadTs ?? req.ts);
    if (h.teamTaskId) {
      if (!this.deps.askTeam) {
        await say(`I can't ask ${h.who} from here.${h.url ? ` Open the task and ask there: ${h.url}` : ''}`);
        return;
      }
      return this.askRoom(req, key, caller, h.teamTaskId, h.who, h.url, question);
    }
    const worker = h.workerId ? workers.find((w) => w.id === h.workerId) : undefined;
    if (!worker) {
      await say(`${h.who} isn't available to ask any more. Say what you need and I'll find someone else.`);
      return;
    }
    const about = `This is about what you delivered ${whenText(h.at, this.now())}: "${h.title}".${h.summary ? ` It said: ${h.summary}` : ''} Start from it rather than from scratch.`;
    return this.hand(req, key, caller, worker, `${question}\n\n${about}`, files, `it made ${clip(h.title, 60)}`);
  }

  /// Put a question to a finished team task's room. When the room can be
  /// watched its answer comes back to this thread; otherwise it stays in the task.
  private async askRoom(req: FrontDoorRequest, key: string, caller: OrgCaller, taskId: string, who: string, url: string | undefined, question: string): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const say = (t: string) => this.deps.slack.post(req.channel, t, root);
    if (!this.deps.askTeam) {
      await say(`I can't ask ${who} from here.${url ? ` Open the task and ask there: ${url}` : ''}`);
      return;
    }
    const since = this.now();
    const res = this.deps.askTeam(caller, taskId, question);
    if (!res.ok) {
      await say(`Couldn't ask ${who}: ${res.error}`);
      return;
    }
    this.note(key, `Asked ${who}`, 'handed', url, { who, team: true });
    if (!this.deps.teamRoom) {
      await say(`Asked *${who}* — their answer will land in the task${url ? `: ${url}` : '.'}`);
      return;
    }
    const room = { taskId, who, ...(url ? { url } : {}), question };
    const known = this.state.threads.find((t) => t.key === key);
    if (known) Object.assign(known, { room, at: this.now() });
    else this.state.threads.push({ key, room, at: this.now() });
    (this.state.rooms ??= []).push({ taskId, question, since, channel: req.channel, threadTs: root, who, ...(url ? { url } : {}) });
    this.save();
    await say(`Asked *${who}*${res.queued ? ", after the question they're on" : ''}. I'll post their answer here.`);
  }

  /// A one-tap answer pressed: its words go back in the thread as the
  /// presser's own reply, and the buttons give way to what was picked.
  async onChoice(args: { channel: string; messageTs: string; threadTs: string; user: string; text: string }): Promise<void> {
    await this.deps.slack.update?.(args.channel, args.messageTs, `<@${args.user}> picked: ${args.text}`);
    await this.onMessage({ channel: args.channel, ts: args.messageTs, threadTs: args.threadTs, user: args.user, text: args.text, dm: args.channel.startsWith('D') });
  }

  /// More for the worker on a thread: the work it handed off has finished,
  /// so whoever did it carries on; otherwise the worker itself.
  private async carryOn(req: FrontDoorRequest, key: string, caller: OrgCaller, worker: FrontDoorWorker, known: DoorThread, text: string): Promise<void> {
    if (known.done && this.deps.continueRun && (!known.done.workerId || known.done.workerId === worker.id)) {
      const went = await this.continueRun(req, key, caller, worker, known.done.orchestrationId, text, req.files ?? []);
      if (went) return;
    }
    return this.hand(req, key, caller, worker, text, req.files ?? [], '', true);
  }

  private begin(key: string): void {
    const r = this.replying.get(key);
    if (r) r.n++;
    else this.replying.set(key, { n: 1, queued: [] });
  }

  /// A reply posted, or failed. The last one out sends what was said
  /// meanwhile, as one message, to whoever has the thread now.
  private end(key: string): void {
    const r = this.replying.get(key);
    if (!r || --r.n > 0) return;
    this.replying.delete(key);
    if (r.queued.length) void this.sendQueued(key, r.queued).catch((err: unknown) => this.deps.log(`Front door: what was said meanwhile could not be passed on: ${String(err)}`));
  }

  private async sendQueued(key: string, queued: FrontDoorRequest[]): Promise<void> {
    const last = queued[queued.length - 1];
    const caller = await this.deps.caller(last.user);
    const known = this.state.threads.find((t) => t.key === key);
    const worker = known?.workerId ? this.candidates(caller).find((w) => w.id === known.workerId) : undefined;
    if (!known || !worker) {
      this.deps.log(`Front door: ${queued.length} message(s) in ${key} had no one to go to.`);
      return;
    }
    // In a channel more than one person may have spoken: each line says who.
    const several = new Set(queued.map((q) => q.user)).size > 1;
    const text = queued.map((q) => (several ? `<@${q.user}>: ${q.text}` : q.text)).join('\n\n');
    const req: FrontDoorRequest = { ...last, text, files: queued.flatMap((q) => q.files ?? []), also: queued.slice(0, -1).map((q) => q.ts) };
    return this.carryOn(req, key, caller, worker, known, text);
  }

  /// `/worker Ada ask …`: asked in the DM thread the command opened, so it
  /// is answered, the work it starts followed, and carried on, like any ask
  /// made here. False when the worker isn't one the caller may ask.
  async askIn(channel: string, threadTs: string, user: string, workerId: string, text: string): Promise<boolean> {
    const caller = await this.deps.caller(user);
    const worker = this.candidates(caller).find((w) => w.id === workerId);
    if (!worker) return false;
    const req: FrontDoorRequest = { channel, ts: threadTs, threadTs, user, text, dm: channel.startsWith('D') };
    await this.hand(req, `${channel}:${threadTs}`, caller, worker, text, [], '', false, true);
    return true;
  }

  /// Give the request to `worker`, with the thread and its screenshots.
  /// `announced`: the thread already says who has it.
  private async hand(req: FrontDoorRequest, key: string, caller: OrgCaller, worker: FrontDoorWorker, text: string, files: SlackFile[], why: string, followUp = false, announced = false): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const say = (t: string) => this.deps.slack.post(req.channel, t, root);
    const context = await this.context(req, files);
    if (worker.id.startsWith(PROCESS_ID)) {
      const brief = [
        text,
        context.thread ? `\n${CONTEXT_HEAD[context.where]}\n${context.thread}` : '',
        sharedTexts(context.texts),
        context.others.length ? `\nAlso shared there: ${context.others.join('; ')}` : '',
      ].filter(Boolean).join('\n');
      const res = this.deps.submitProcess!(caller, worker.id.slice(PROCESS_ID.length), brief);
      if (!res.ok) {
        await say(res.error);
        return;
      }
      const existing = this.state.threads.find((t) => t.key === key);
      if (existing) Object.assign(existing, { workerId: worker.id, workerName: res.process, pending: undefined, at: this.now() });
      else this.state.threads.push({ key, workerId: worker.id, workerName: res.process, at: this.now() });
      this.save();
      this.note(key, `Put into ${res.process}`, 'handed', undefined, { who: res.process, team: true });
      await say(`In: _${res.title}_ goes into *${res.process}*${why ? ` (${why})` : ''}, starting at *${res.stage}*. You'll get a DM each time it moves; \`/idea\` shows where it is.${shortTip(req, worker, '/idea')}`);
      return;
    }
    if (worker.id.startsWith(TEAM_ID)) {
      // A team task: the thread is its brief. Screenshots can't ride along
      // yet, so they're named with their links like any other file.
      const brief = [
        text,
        context.thread ? `\n${CONTEXT_HEAD[context.where]}\n${context.thread}` : '',
        sharedTexts(context.texts),
        context.others.length || context.images.length ? `\nAlso shared there: ${[...context.others, ...files.filter((f) => IMAGE_TYPES.has(f.mimetype ?? '')).map((f) => f.name ?? 'a screenshot')].join('; ')}` : '',
      ].filter(Boolean).join('\n');
      const res = this.deps.briefTeam!(caller, worker.id.slice(TEAM_ID.length), brief);
      if (!res.ok) {
        await say(res.error);
        return;
      }
      const existing = this.state.threads.find((t) => t.key === key);
      if (existing) Object.assign(existing, { workerId: worker.id, workerName: worker.name, pending: undefined, at: this.now() });
      else this.state.threads.push({ key, workerId: worker.id, workerName: worker.name, at: this.now() });
      this.save();
      this.note(key, `${worker.name} took it as a team task`, 'handed', undefined, { who: worker.name });
      await say(
        (res.queued
          ? `*${worker.name}* will take this as a team task${why ? ` (${why})` : ''}. It's finishing another one first, so this is next in line. When it starts, its coordinator will DM you anything it needs to know, then a plan to approve.`
          : `*${worker.name}* has this as a team task${why ? ` (${why})` : ''}. Before it starts, its coordinator will DM you anything it needs to know, then a plan to approve. You'll follow it there.`) + (followUp ? '' : shortTip(req, worker, '/team')),
      );
      return;
    }
    const prompt = [
      followUp ? `More from ${caller.name} on the same request:` : '',
      text,
      context.thread ? `\n${CONTEXT_HEAD[context.where]}\n${context.thread}` : '',
      sharedTexts(context.texts),
      context.others.length ? `\nAlso shared there (not attached): ${context.others.join('; ')}` : '',
      '\nYour reply is posted back in that Slack thread for you, so answer here rather than posting to Slack with any Slack tool you have. If this needs work done, start it; what it produces is posted there when it ends.',
      // Without this the thread gets the question read back to it and the
      // plan narrated, before an answer longer than anyone reads.
      SLACK_BUDGET,
      'If you start work, your reply is posted while it runs: make it one short line (15 words at most) on what you are checking. Don\'t restate the request or explain your plan.',
      // Without this the worker looks for an upload tool, finds none and says
      // it can't send the file, in the same message the file arrives with.
      'To send a file (a report, a page, data), write it in your own files folder and name its full path in your reply: it is attached to the thread for you, and the path is shown as its name. With a file attached, keep the reply to a short summary of it rather than repeating it.',
      // Without this a misrouted question ends at "that isn't my job" and the
      // person is left to find someone else themselves.
      followUp ? '' : 'If this plainly isn\'t something your job or tools cover, reply with only `NOT_MINE:` and one short line on why, and the request goes to someone else. If you can help at all, help.',
    ].filter(Boolean).join('\n');
    this.begin(key);
    const started = this.deps.ask(caller, worker.id, prompt, context.images, `slack:${key}`, text);
    if (!started.ok) {
      this.end(key);
      await say(started.error);
      return;
    }
    const existing = this.state.threads.find((t) => t.key === key);
    if (existing) Object.assign(existing, { workerId: worker.id, workerName: worker.name, at: this.now() });
    else this.state.threads.push({ key, workerId: worker.id, workerName: worker.name, at: this.now() });
    this.save();
    const as: PostAs = { name: worker.name, ...(worker.avatarUrl ? { iconUrl: worker.avatarUrl } : {}) };
    // The worker's own message, posted as it picks this up and edited as it
    // goes: what it is checking, then how far along. In a channel, others in
    // the thread can ask to hear when it's done.
    const card: LiveCard = { ...(why && !followUp ? { why } : {}), notify: !req.dm && !!this.deps.slack.dm };
    let live: Promise<string | null> | null = null;
    const showCard = () => this.postCard(req.channel, root, as, card, null);
    if (!followUp && !announced) {
      if (this.deps.slack.postTs) live = showCard();
      else await say(`*${worker.name}* has this${why ? ` (${why})` : ''}. I'll reply here.`);
    }
    this.note(key, `${worker.name} has it`, 'handed', undefined, { who: worker.name }, !followUp);
    let answered = false;
    if (followUp) {
      const ack = setTimeout(() => {
        if (answered) return;
        if (this.deps.slack.postTs) live = showCard();
        else void say(`_${worker.name} is on it…_`);
      }, ACK_AFTER_MS);
      ack.unref?.();
    }
    // Not awaited: an errand can take minutes, and Slack's other events
    // (approvals, answers) must not wait behind it.
    void started.done
      .finally(() => {
        answered = true;
      })
      .then(async (res) => {
        const liveTs = live ? await live : null;
        const drop = async () => {
          if (liveTs) await this.deps.slack.remove?.(req.channel, liveTs).catch(() => false);
        };
        if (!res.ok) {
          await drop();
          await say(`${worker.name} couldn't take it: ${res.error}`);
          return;
        }
        const no = !followUp && !res.orchestrationId && res.reply.length < 600 ? DECLINE.exec(res.reply) : null;
        if (no) {
          await drop();
          return this.declined(req, key, caller, worker, text, files, no[1].trim());
        }
        // Work started, and the reply is the line on what it's checking: it
        // goes on the card, which then follows the work. An answer, or
        // anything longer, is a message of its own and the card goes.
        const inCard = !!(liveTs && res.orchestrationId && this.deps.slack.update && res.reply.trim().length <= LINE_MAX);
        if (inCard) {
          card.line = slackMarkup(res.reply.trim());
          await this.editCard(req.channel, liveTs!, card, null);
        } else {
          await drop();
          await deliverText(this.io(), req.channel, root, worker.name, res.reply, `${slug(text)}.md`, worker.id, as);
        }
        await this.notify(req.channel, root, worker.name, res.reply);
        await this.offer(req.channel, root, worker.name, res.choices);
        if (res.proposed) {
          await say(`${worker.name} proposed ${res.proposed === 1 ? 'one piece of work' : `${res.proposed} pieces of work`} and is waiting for ${worker.manager ? `${worker.manager}'s` : 'its manager’s'} OK. I'll post the results here when it's done.`);
        }
        if (res.orchestrationId) {
          const t = this.state.threads.find((x) => x.key === key);
          if (t) delete t.done;
          this.state.follows.push({ orchestrationId: res.orchestrationId, channel: req.channel, threadTs: root, workerName: worker.name, since: this.now(), ...(res.askId ? { askId: res.askId } : {}), workerId: worker.id, ...(worker.avatarUrl ? { avatarUrl: worker.avatarUrl } : {}), ...(inCard ? { status: { ts: liveTs!, text: '', at: this.now() }, card } : {}) });
          this.save();
        }
      })
      .catch((err: unknown) => this.deps.log(`Front door: ${worker.name}'s answer could not be posted: ${String(err)}`))
      .finally(() => this.end(key));
  }

  /// A follow-up to finished work, said to whoever ran its last step. Answers
  /// come back like a chat: no "has this" line, a word only if it's slow.
  /// False when that can't take it, for `hand` to.
  private async continueRun(req: FrontDoorRequest, key: string, caller: OrgCaller, worker: FrontDoorWorker, orchestrationId: string, text: string, files: SlackFile[]): Promise<boolean> {
    const root = req.threadTs ?? req.ts;
    const say = (t: string) => this.deps.slack.post(req.channel, t, root);
    const context = await this.context(req, files);
    // The conversation already holds the work; only what's new rides along.
    const prompt = [
      `${caller.name}, in the Slack thread where this work was asked for, now that it's done:`,
      text,
      sharedTexts(context.texts),
      context.others.length ? `\nAlso shared there (not attached): ${context.others.join('; ')}` : '',
      '\nAnswer them as the next message of this conversation, briefly and in plain words. Your reply is posted in the thread for you; to send a file, write it in your files folder and name its full path.',
    ].filter(Boolean).join('\n');
    this.begin(key);
    const started = this.deps.continueRun!(caller, orchestrationId, prompt, context.images, `slack:${key}`, text);
    if (!started || !started.ok) {
      this.end(key);
      return false;
    }
    const t = this.state.threads.find((x) => x.key === key);
    if (t) {
      t.at = this.now();
      if (t.done) t.done.at = this.now();
    }
    this.note(key, `${worker.name} carried on`, 'handed', undefined, { who: worker.name }, false);
    let answered = false;
    const ack = setTimeout(() => {
      if (!answered) void say(`_${worker.name} is on it…_`);
    }, ACK_AFTER_MS);
    ack.unref?.();
    void started.done
      .finally(() => {
        answered = true;
        clearTimeout(ack);
      })
      .then(async (res) => {
        if (!res.ok) {
          // The conversation couldn't be continued (gone, timed out): the
          // worker takes it the usual way rather than the person hearing why.
          this.deps.log(`Front door: could not continue ${worker.name}'s finished work: ${res.error}`);
          const gone = this.state.threads.find((x) => x.key === key);
          if (gone) delete gone.done;
          return this.hand(req, key, caller, worker, text, files, '', true);
        }
        await deliverText(this.io(), req.channel, root, worker.name, res.reply, `${slug(text)}.md`, worker.id, { name: worker.name, ...(worker.avatarUrl ? { iconUrl: worker.avatarUrl } : {}) });
        await this.notify(req.channel, root, worker.name, res.reply);
      })
      .catch((err: unknown) => this.deps.log(`Front door: ${worker.name}'s answer could not be posted: ${String(err)}`))
      .finally(() => this.end(key));
    return true;
  }

  /// A worker said the request isn't its job: someone else, without it. After
  /// a couple of those the door answers itself, or the person picks.
  private async declined(req: FrontDoorRequest, key: string, caller: OrgCaller, worker: FrontDoorWorker, text: string, files: SlackFile[], why: string): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const known = this.state.threads.find((t) => t.key === key);
    const declined = [...(known?.declined ?? []), worker.id];
    if (known) {
      Object.assign(known, { declined, at: this.now() });
      delete known.workerId;
      delete known.workerName;
    } else this.state.threads.push({ key, declined, at: this.now() });
    this.note(key, `${worker.name} said it isn't theirs`, 'declined', undefined, { who: worker.name });
    await this.deps.slack.post(req.channel, `*${worker.name}* says this isn't theirs${why ? ` (${clip(why, 140)})` : ''}. Finding someone else…`, root);
    const workers = this.candidates(caller);
    if (declined.length >= MAX_DECLINES && this.deps.general) return this.desk(req, key, caller, workers, text, files);
    return this.route(req, key, caller, workers, text, files, []);
  }

  /// The thread so far (when the request is in one) and its files: images
  /// attached for the worker to see, small text files read in (newest
  /// first: a follow-up is usually about the last report), everything else
  /// named with its link.
  private async context(req: FrontDoorRequest, files: SlackFile[]): Promise<{ thread: string; where: 'thread' | 'channel'; images: Attachment[]; texts: Array<{ name: string; body: string }>; others: string[] }> {
    let messages: SlackMessage[] = [];
    // In a thread, the thread. A top-level mention in a channel ("what's the
    // status of this ticket?") points at what was said just before it.
    const where: 'thread' | 'channel' = req.threadTs || req.dm ? 'thread' : 'channel';
    try {
      if (req.threadTs) messages = await this.deps.slack.thread(req.channel, req.threadTs);
      else if (!req.dm && this.deps.slack.recent) messages = await this.deps.slack.recent(req.channel, req.ts, RECENT_MESSAGES);
    } catch {
      messages = [];
    }
    // Its own replies too, marked as such: without them a thread picked up
    // later reads as people talking to someone who never answered. The
    // newest part when it is long: that is what a follow-up refers to.
    const said = messages
      .filter((m) => m.ts !== req.ts && !req.also?.includes(m.ts))
      .map((m) => (m.bot_id ? `(posted here earlier, by this app) ${m.text}` : `<@${m.user ?? 'someone'}>: ${m.text}`))
      .join('\n');
    const thread = said.length > 6000 ? `…${said.slice(-6000)}` : said;
    const all = [...files, ...messages.flatMap((m) => m.files ?? [])];
    const images: Attachment[] = [];
    const texts: Array<{ name: string; body: string }> = [];
    const others: string[] = [];
    const seen = new Set<string>();
    const readable = (f: SlackFile) => !!f.url_private && (f.mimetype?.startsWith('text/') || f.mimetype === 'application/json' || TEXT_NAME.test(f.name ?? '')) && (f.size ?? 0) <= MAX_TEXT_BYTES;
    for (const f of [...all].reverse()) {
      if (texts.length >= MAX_TEXTS || seen.has(f.id) || !readable(f)) continue;
      const bytes = await this.deps.slack.download(f.url_private!, MAX_TEXT_BYTES);
      if (!bytes) continue;
      seen.add(f.id);
      texts.unshift({ name: f.name ?? 'file', body: bytes.toString('utf8') });
    }
    for (const f of all) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      if (f.mimetype && IMAGE_TYPES.has(f.mimetype) && f.url_private && images.length < MAX_IMAGES && (f.size ?? 0) <= MAX_IMAGE_BYTES) {
        const bytes = await this.deps.slack.download(f.url_private, MAX_IMAGE_BYTES);
        if (bytes) {
          images.push({ id: f.id, mimeType: f.mimetype, dataBase64: bytes.toString('base64'), label: f.name, size: bytes.length });
          continue;
        }
      }
      others.push(f.permalink ? `${f.name} (${f.permalink})` : f.name);
    }
    return { thread, where, images, texts, others };
  }

  /// The answers a worker offered, one tap each, as on its page in the
  /// console: a press says it in the thread as the presser's own reply.
  async offer(channel: string, threadTs: string, workerName: string, choices: string[] | undefined): Promise<void> {
    const picks = (choices ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 5);
    if (!picks.length || !this.deps.slack.postBlocks) return;
    await this.deps.slack.postBlocks(channel, `Reply to ${workerName}: ${picks.join(' · ')}`, [
      { type: 'actions', elements: picks.map((c, i) => ({ type: 'button', text: { type: 'plain_text', text: c.length > 75 ? `${c.slice(0, 74)}…` : c }, action_id: `${DOOR_CHOICE_ACTION}_${i}`, value: c.slice(0, 1900) })) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or reply in this thread.' }] },
    ], threadTs);
  }

  /// Check the work being followed; post what's finished.
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const keep: DoorFollow[] = [];
      for (const f of this.state.follows) {
        const p = this.deps.progress(f.orchestrationId);
        if (!p) {
          if (this.now() - f.since < FOLLOW_TTL_MS) keep.push(f);
          continue;
        }
        if (!p.done) {
          keep.push(f);
          await this.showProgress(f, p).catch((err: unknown) => this.deps.log(`Front door: could not show progress in ${f.channel}: ${String(err)}`));
          continue;
        }
        // Not awaited: finishing up is a worker's turn, minutes perhaps, and
        // the other follows shouldn't wait behind it.
        keep.push(f);
        if (this.finishing.has(f)) continue;
        this.finishing.add(f);
        void this.finished(f, p)
          .then(() => { this.state.follows = this.state.follows.filter((x) => x !== f); this.save(); })
          .catch((err: unknown) => this.deps.log(`Front door: could not post results to ${f.channel}: ${String(err)}`))
          .finally(() => this.finishing.delete(f));
      }
      if (keep.length !== this.state.follows.length) {
        this.state.follows = keep;
        this.save();
      }
      await this.pollRooms();
    } finally {
      this.polling = false;
    }
  }

  /// Post what team rooms have answered; give up on a question after a while.
  private async pollRooms(): Promise<void> {
    const rooms = this.state.rooms ?? [];
    if (!rooms.length || !this.deps.teamRoom || this.pollingRooms) return;
    this.pollingRooms = true;
    try {
      await this.checkRooms(rooms);
    } finally {
      this.pollingRooms = false;
    }
  }

  private async checkRooms(rooms: RoomFollow[]): Promise<void> {
    const keep: RoomFollow[] = [];
    for (const r of rooms) {
      const room = this.deps.teamRoom!(r.taskId);
      const answer = roomAnswer(room, r.question, r.since);
      if (answer === null) {
        if (this.now() - r.since < FOLLOW_TTL_MS) keep.push(r);
        const status = roomStatus(room, r.question, r.since, r.who, this.now());
        if (status) await this.showRoomStatus(r, status).catch((err: unknown) => this.deps.log(`Front door: could not show ${r.who}'s progress: ${String(err)}`));
        continue;
      }
      await this.showRoomStatus(r, `:writing_hand: *${r.who}* answered · writing it up for here…`).catch(() => undefined);
      let said = answer;
      try {
        said = (await this.deps.plain?.(r.question, answer, r.taskId)) ?? answer;
      } catch (err) {
        this.deps.log(`Front door: could not say ${r.who}'s answer plainly: ${String(err)}`);
      }
      try {
        await deliverText(this.io(), r.channel, r.threadTs, r.who, `${said}${r.url ? `\n\n[Open the task](${r.url})` : ''}`, `${slug(r.who)}-answer.md`, undefined, { name: r.who });
        await this.showRoomStatus(r, `:white_check_mark: *${r.who}* answered in ${minutes(this.now() - r.since)}.`).catch(() => undefined);
        await this.notify(r.channel, r.threadTs, r.who, said);
      } catch (err) {
        this.deps.log(`Front door: ${r.who}'s answer could not be posted: ${String(err)}`);
        keep.push(r);
      }
    }
    if (keep.length !== rooms.length) {
      this.state.rooms = keep;
      this.save();
    }
  }

  /// The room's status message in the thread: posted once, then edited.
  private async showRoomStatus(r: RoomFollow, text: string): Promise<void> {
    if (r.status?.text === text) return;
    if (!r.status) {
      const ts = await this.deps.slack.postTs?.(r.channel, text, r.threadTs, { name: r.who });
      if (ts) r.status = { ts, text };
    } else if (this.deps.slack.update && (await this.deps.slack.update(r.channel, r.status.ts, text))) {
      r.status = { ...r.status, text };
    }
    this.save();
  }

  /// The thread's status message: posted once the work is under way, then
  /// edited as it moves (a step further, something new said). Saved in the
  /// follow, so a restart edits the same message.
  private async showProgress(f: DoorFollow, p: ErrandProgress): Promise<void> {
    if (f.card && f.status) {
      const said = p.items.find((i) => i.status === 'running' && i.said)?.said;
      const line = said ? trailLine(said) : '';
      if (line && f.card.trail?.at(-1) !== line) f.card.trail = [...(f.card.trail ?? []), line].slice(-TRAIL_MAX);
      if (f.status.text === JSON.stringify(liveCard(f.card, p, this.now(), f.since).blocks) || !this.deps.slack.update) return;
      const seen = await this.editCard(f.channel, f.status.ts, f.card, p, f.since);
      if (seen) {
        f.status = { ...f.status, text: seen, at: this.now() };
        this.save();
      }
      return;
    }
    const text = progressText(p, this.now(), f.since);
    if (f.status?.text === text) return;
    const as: PostAs = { name: f.workerName, ...(f.avatarUrl ? { iconUrl: f.avatarUrl } : {}) };
    if (!f.status) {
      const ts = await this.deps.slack.postTs?.(f.channel, text, f.threadTs, as);
      if (ts) f.status = { ts, text, at: this.now() };
    } else if (this.deps.slack.update && (await this.deps.slack.update(f.channel, f.status.ts, text))) {
      f.status = { ...f.status, text, at: this.now() };
    }
    this.save();
  }

  /// "Show the trace" pressed: the steps the work took, in a pop-up only the
  /// presser sees, so the thread keeps just the answer.
  async showTrace(triggerId: string, orchestrationId: string): Promise<void> {
    if (!this.deps.slack.openView) return;
    await this.deps.slack.openView(triggerId, traceView(this.deps.progress(orchestrationId))).catch(() => false);
  }

  /// Put the card up, as Slack's plan block where it takes one, else drawn
  /// with emoji (an older workspace, a block it doesn't know).
  /// "Full write-up" pressed: the document the worker wrote, read again from
  /// its own files (nothing outside them), in a pop-up for the presser.
  async showWriteUp(triggerId: string, value: string): Promise<void> {
    if (!this.deps.slack.openView || !this.deps.workerFile) return;
    let ref: { w?: string; p?: string } = {};
    try {
      ref = JSON.parse(value) as typeof ref;
    } catch {
      return;
    }
    const bytes = ref.w && ref.p ? this.deps.workerFile(ref.w, ref.p, WRITEUP_MAX) : null;
    await this.deps.slack.openView(triggerId, writeUpView(ref.p?.split('/').pop() ?? 'write-up', bytes?.toString('utf8') ?? null)).catch(() => false);
  }

  private async postCard(channel: string, threadTs: string, as: PostAs, card: LiveCard, p: ErrandProgress | null, since?: number): Promise<string | null> {
    const c = liveCard(card, p, this.now(), since);
    const ts = await this.deps.slack.postTs!(channel, c.text, threadTs, as, c.blocks).catch(() => null);
    if (ts || card.plain) return ts;
    card.plain = true;
    const plain = liveCard(card, p, this.now(), since);
    return this.deps.slack.postTs!(channel, plain.text, threadTs, as, plain.blocks).catch(() => null);
  }

  private async editCard(channel: string, ts: string, card: LiveCard, p: ErrandProgress | null, since?: number): Promise<string | null> {
    const c = liveCard(card, p, this.now(), since);
    if (await this.deps.slack.update!(channel, ts, c.text, c.blocks).catch(() => false)) return JSON.stringify(c.blocks);
    if (card.plain) return null;
    card.plain = true;
    const plain = liveCard(card, p, this.now(), since);
    return (await this.deps.slack.update!(channel, ts, plain.text, plain.blocks).catch(() => false)) ? JSON.stringify(plain.blocks) : null;
  }

  private io(): DeliverIo {
    return {
      post: (c, t, ts, as) => this.deps.slack.post(c, t, ts, as),
      upload: (c, ts, n, b) => this.deps.slack.upload(c, ts, n, b),
      readFile: (p, max) => this.deps.readFile(p, max),
      ...(this.deps.workerFile ? { workerFile: (id: string, p: string, max: number) => this.deps.workerFile!(id, p, max) } : {}),
    };
  }

  /// The work it handed off has ended. Back to the worker first, to finish
  /// what it said it would (a chart, a write-up): its reply is the answer,
  /// with the files it names. The run's own output, as it is, only when that
  /// can't happen or fails.
  private async finished(f: DoorFollow, p: ErrandProgress): Promise<void> {
    const ok = p.items.some((i) => i.status === 'done');
    const thread = ok ? this.state.threads.find((t) => t.key === `${f.channel}:${f.threadTs}`) : undefined;
    if (thread) {
      thread.done = { orchestrationId: f.orchestrationId, at: this.now(), ...(f.workerId ? { workerId: f.workerId } : {}) };
      thread.at = this.now();
      this.save();
    }
    const took = minutes(this.now() - (f.since ?? this.now()));
    if (f.status && this.deps.slack.update) {
      await this.deps.slack.update(f.channel, f.status.ts, ok ? `:white_check_mark: Done in ${took}. Writing it up…` : `:warning: It ended without finishing. What happened is below.`).catch(() => false);
    }
    const back = f.askId ? this.deps.handBack?.(f.askId) : null;
    if (back) {
      const res = await back.done;
      if (res.ok) {
        // The answer in the thread, and any file it names, was written in the
        // thread's own conversation, not the run's: a follow-up goes there,
        // or it reaches a step that never saw what the person read.
        if (thread?.done) {
          delete thread.done;
          this.save();
        }
        // With a footer to hang it on, a written-up document opens from there
        // rather than unfolding its whole self under the answer it repeats.
        const footer = !!(this.deps.slack.openView && this.deps.slack.postTs);
        const held = await deliverText(this.io(), f.channel, f.threadTs, f.workerName, res.reply, `${slug(f.workerName)}-answer.md`, f.workerId, { name: f.workerName, ...(f.avatarUrl ? { iconUrl: f.avatarUrl } : {}) }, footer);
        // "Writing it up…" has nothing left to say once the answer is under it.
        if (f.status && (await this.deps.slack.remove?.(f.channel, f.status.ts).catch(() => false))) delete f.status;
        // How it got there stays out of the answer, a tap away.
        if (this.deps.slack.openView && this.deps.slack.postTs) {
          const steps = p.items.filter((i) => i.status === 'done').length;
          const line = `Worked out in ${took} · ${steps} ${steps === 1 ? 'step' : 'steps'}${p.files.length ? ` · ${p.files.length} ${p.files.length === 1 ? 'source' : 'sources'}` : ''}`;
          await this.deps.slack
            .postTs(f.channel, line, f.threadTs, { name: f.workerName, ...(f.avatarUrl ? { iconUrl: f.avatarUrl } : {}) }, [
              { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
              { type: 'actions', elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Show the trace' }, action_id: DOOR_TRACE_ACTION, value: f.orchestrationId },
                ...held.slice(0, 3).map((h, n) => ({ type: 'button', text: { type: 'plain_text', text: held.length === 1 ? 'Full write-up' : clip(h.name, 40) }, action_id: `${DOOR_WRITEUP_ACTION}_${n}`, value: JSON.stringify({ w: f.workerId, p: h.path }).slice(0, 2000) })),
              ] },
            ])
            .catch(() => null);
        }
        await this.notify(f.channel, f.threadTs, f.workerName, res.reply);
        await this.offer(f.channel, f.threadTs, f.workerName, res.choices);
        return;
      }
      this.deps.log(`Front door: ${f.workerName} could not finish up: ${res.error}`);
    }
    const done = finishedText(f.workerName, p, this.deps.libraryUrl());
    await this.deps.slack.post(f.channel, done, f.threadTs);
    await deliverResults(this.io(), f.channel, f.threadTs, f.workerName, p);
    await this.notify(f.channel, f.threadTs, f.workerName, done);
  }
}
