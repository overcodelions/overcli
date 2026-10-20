// The front door: "@overcli add an export button to the reports page", or the
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

import type { Attachment } from '../../shared/types';
import type { OrgCaller } from '../../shared/org/policy';
import type { ErrandProgress } from '../org/orgService';
import type { SlackFile, SlackMessage } from './slackApi';
import { deliverResults, deliverText, finishedText, slug, type DeliverIo, type PostAs } from './deliver';

export { toSlack } from './deliver';

export interface FrontDoorRequest {
  channel: string;
  ts: string;
  /// Set when the message is itself in a thread.
  threadTs?: string;
  user: string;
  text: string;
  files?: SlackFile[];
  dm: boolean;
}

export interface FrontDoorWorker {
  id: string;
  name: string;
  tagline?: string;
  job?: string;
  /// Who approves what it proposes.
  manager?: string;
  /// The tools it can use (a tracker, a CRM, a wiki…): what lets it look a
  /// thing up rather than only talk about it.
  tools?: string[];
  /// Its picture: its replies post under its name and this face.
  avatarUrl?: string;
}

/// A team the person may give work to. It goes to the door as one more
/// candidate, with an id of `team:<id>`.
export interface FrontDoorTeam {
  id: string;
  name: string;
  purpose?: string;
  members: string[];
}

const TEAM_ID = 'team:';

/// A team, as a candidate beside the workers: named for what it's for, and
/// described so a router only picks it for a real piece of work.
export function teamCandidate(t: FrontDoorTeam): FrontDoorWorker {
  return {
    id: `${TEAM_ID}${t.id}`,
    name: t.name,
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
  pending?: { text: string; files: SlackFile[]; choices: Array<{ id: string; name: string }> };
  at: number;
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
}

export interface FrontDoorState {
  threads: DoorThread[];
  follows: DoorFollow[];
}

type Answered = { ok: true; reply: string; proposed?: number; orchestrationId?: string; choices?: string[]; askId?: string } | { ok: false; error: string };
type Started = { ok: true; done: Promise<Answered> } | { ok: false; error: string };

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
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

/// A one-tap answer under a worker's reply: pressing it sends its words back
/// in the thread as the presser's own follow-up.
export const DOOR_CHOICE_ACTION = 'overcli_door_choice';

export interface FrontDoorDeps {
  /// Who may ask at all. A string is the reason someone may not, said back
  /// to them. Absent: anyone in the workspace.
  mayAsk?(slackUserId: string): true | string;
  caller(slackUserId: string): Promise<OrgCaller>;
  /// The workers this person may ask, running ones only.
  workers(caller: OrgCaller): FrontDoorWorker[];
  /// `conversation`: the thread, as a key, so the worker keeps one conversation per thread.
  ask(caller: OrgCaller, workerId: string, text: string, attachments: Attachment[], conversation?: string, said?: string): Started;
  /// Finished handed-off work back to the worker that handed it off, to
  /// finish what it said it would. Null: nothing to hand back. Absent: the
  /// run's output is posted as it is.
  handBack?(askId: string): { done: Promise<Answered> } | null;
  progress(orchestrationId: string): ErrandProgress | null;
  /// The teams this person may give work to. Absent: requests go to workers only.
  teams?(caller: OrgCaller): FrontDoorTeam[];
  /// Give a team a task. Its questions, plan and progress go to the person in a DM.
  /// `queued`: the team is on another task and starts this one after it.
  briefTeam?(caller: OrgCaller, teamId: string, brief: string): { ok: true; queued?: boolean } | { ok: false; error: string };
  /// A model's pick when the words alone don't settle it. Null: no one fits.
  route(text: string, workers: FrontDoorWorker[]): Promise<{ workerId: string; why: string } | null>;
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
    update?(channel: string, ts: string, text: string): Promise<boolean>;
    /// Post and say where it landed, for a message edited as work moves.
    postTs?(channel: string, text: string, threadTs: string, as?: PostAs): Promise<string | null>;
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
const THREAD_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FOLLOW_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/// How far back a top-level mention looks in its channel.
const RECENT_MESSAGES = 8;
const CONTEXT_HEAD = {
  thread: 'The Slack thread this came from, oldest first:',
  channel: 'The last messages in the channel before this request, oldest first (it may refer to them, e.g. "this ticket"):',
};
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const STOP = new Set('a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these this to us was we what when where which who why will with would you your'.split(' '));

function words(text: string): string[] {
  return text.toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/// A worker named at the start of the request: "Triage, fix …", "ask Triage
/// to …", "@Triage …". Longest name first, so "Ana Lyst" beats "Ana".
export function namedWorker(text: string, workers: FrontDoorWorker[]): { worker: FrontDoorWorker; rest: string } | null {
  const t = text.trim();
  for (const w of [...workers].sort((a, b) => b.name.length - a.name.length)) {
    const name = w.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^(?:ask\\s+|hey\\s+|@)?(?:the\\s+)?${name}(?:\\s+team)?(?:[,:\\s]+(?:to\\s+|please\\s+)?|$)`, 'i').exec(t);
    if (m) return { worker: w, rest: t.slice(m[0].length).trim() || t };
  }
  return null;
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

export class FrontDoor {
  private state: FrontDoorState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
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
    this.deps.store.save(this.state);
  }

  /// Whether a reply in this thread is meant for the door.
  owns(channel: string, threadTs: string): boolean {
    return this.state.threads.some((t) => t.key === `${channel}:${threadTs}`);
  }

  start(pollMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async onMessage(req: FrontDoorRequest): Promise<void> {
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
    // Workers and teams side by side: a team is picked for a real piece of
    // work that fits it, and runs as a team task.
    const workers = [...this.deps.workers(caller), ...(this.deps.briefTeam ? (this.deps.teams?.(caller) ?? []).map(teamCandidate) : [])];
    const known = this.state.threads.find((t) => t.key === key);

    // Answering "who should take this?"
    if (known?.pending) {
      const pick = namedWorker(text, known.pending.choices.map((c) => ({ id: c.id, name: c.name })))?.worker
        ?? known.pending.choices.find((c) => text.toLowerCase().includes(c.name.toLowerCase()));
      const worker = pick && workers.find((w) => w.id === pick.id);
      if (!worker) {
        await say(`Reply with one of: ${known.pending.choices.map((c) => c.name).join(', ')}.`);
        return;
      }
      const { text: original, files } = known.pending;
      delete known.pending;
      return this.hand(req, key, caller, worker, original, files, '');
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
      return this.hand(req, key, caller, worker, text, req.files ?? [], '', true);
    }
    if (!text && !req.files?.length) return;
    if (!workers.length) {
      await say('There are no workers you can ask yet. Someone can hire one with `/hire`, or share one with you.');
      return;
    }
    const named = namedWorker(text, workers);
    if (named) return this.hand(req, key, caller, named.worker, named.rest, req.files ?? [], '');
    const ranked = rankByWords(text, workers);
    const [first, second] = ranked;
    if (first && first.score >= 3 && first.score >= 2 * (second?.score ?? 0)) {
      return this.hand(req, key, caller, first.worker, text, req.files ?? [], `it's the closest match for this`);
    }
    if (workers.length === 1) return this.hand(req, key, caller, workers[0], text, req.files ?? [], '');
    let routed: { workerId: string; why: string } | null = null;
    try {
      routed = await this.deps.route(text, workers);
    } catch (err) {
      this.deps.log(`Front door: routing failed: ${String(err)}`);
    }
    const chosen = routed && workers.find((w) => w.id === routed!.workerId);
    if (chosen) return this.hand(req, key, caller, chosen, text, req.files ?? [], routed!.why);
    const choices = ranked.slice(0, 5).map((r) => r.worker);
    this.state.threads.push({ key, pending: { text, files: req.files ?? [], choices: choices.map((w) => ({ id: w.id, name: w.name })) }, at: this.now() });
    this.save();
    await say(`Who should take this? Reply with a name:\n${choices.map((w) => `• *${w.name}*${w.tagline ? ` — ${w.tagline}` : ''}`).join('\n')}`);
  }

  /// A one-tap answer pressed: its words go back in the thread as the
  /// presser's own reply, and the buttons give way to what was picked.
  async onChoice(args: { channel: string; messageTs: string; threadTs: string; user: string; text: string }): Promise<void> {
    await this.deps.slack.update?.(args.channel, args.messageTs, `<@${args.user}> picked: ${args.text}`);
    await this.onMessage({ channel: args.channel, ts: args.messageTs, threadTs: args.threadTs, user: args.user, text: args.text, dm: args.channel.startsWith('D') });
  }

  /// Give the request to `worker`, with the thread and its screenshots.
  private async hand(req: FrontDoorRequest, key: string, caller: OrgCaller, worker: FrontDoorWorker, text: string, files: SlackFile[], why: string, followUp = false): Promise<void> {
    const root = req.threadTs ?? req.ts;
    const say = (t: string) => this.deps.slack.post(req.channel, t, root);
    const context = await this.context(req, files);
    if (worker.id.startsWith(TEAM_ID)) {
      // A team task: the thread is its brief. Screenshots can't ride along
      // yet, so they're named with their links like any other file.
      const brief = [
        text,
        context.thread ? `\n${CONTEXT_HEAD[context.where]}\n${context.thread}` : '',
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
      await say(
        res.queued
          ? `*${worker.name}* will take this as a team task${why ? ` (${why})` : ''}. It's finishing another one first, so this is next in line. When it starts, its coordinator will DM you anything it needs to know, then a plan to approve.`
          : `*${worker.name}* has this as a team task${why ? ` (${why})` : ''}. Before it starts, its coordinator will DM you anything it needs to know, then a plan to approve. You'll follow it there.`,
      );
      return;
    }
    const prompt = [
      followUp ? `More from ${caller.name} on the same request:` : '',
      text,
      context.thread ? `\n${CONTEXT_HEAD[context.where]}\n${context.thread}` : '',
      context.others.length ? `\nAlso shared there (not attached): ${context.others.join('; ')}` : '',
      '\nYour reply is posted back in that Slack thread for you, so answer here rather than posting to Slack with any Slack tool you have. If this needs work done, start it; what it produces is posted there when it ends.',
      // Without this the worker looks for an upload tool, finds none and says
      // it can't send the file, in the same message the file arrives with.
      'To send a file (a report, a page, data), write it in your own files folder and name its full path in your reply: it is attached to the thread for you, and the path is shown as its name.',
    ].filter(Boolean).join('\n');
    const started = this.deps.ask(caller, worker.id, prompt, context.images, `slack:${key}`, text);
    if (!started.ok) {
      await say(started.error);
      return;
    }
    const existing = this.state.threads.find((t) => t.key === key);
    if (existing) Object.assign(existing, { workerId: worker.id, workerName: worker.name, at: this.now() });
    else this.state.threads.push({ key, workerId: worker.id, workerName: worker.name, at: this.now() });
    this.save();
    if (!followUp) await say(`*${worker.name}* has this${why ? ` (${why})` : ''}. I'll reply here.`);
    // Not awaited: an errand can take minutes, and Slack's other events
    // (approvals, answers) must not wait behind it.
    void started.done
      .then(async (res) => {
        if (!res.ok) {
          await say(`${worker.name} couldn't take it: ${res.error}`);
          return;
        }
        await deliverText(this.io(), req.channel, root, worker.name, res.reply, `${slug(text)}.md`, worker.id, { name: worker.name, ...(worker.avatarUrl ? { iconUrl: worker.avatarUrl } : {}) });
        // The answers it offered, one tap each, as on its page in the console.
        if (res.choices?.length && this.deps.slack.postBlocks) {
          const picks = res.choices.slice(0, 5).map((c) => c.trim()).filter(Boolean);
          await this.deps.slack.postBlocks(req.channel, `Reply to ${worker.name}: ${picks.join(' · ')}`, [
            { type: 'actions', elements: picks.map((c, i) => ({ type: 'button', text: { type: 'plain_text', text: c.length > 75 ? `${c.slice(0, 74)}…` : c }, action_id: `${DOOR_CHOICE_ACTION}_${i}`, value: c.slice(0, 1900) })) },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or reply in this thread.' }] },
          ], root);
        }
        if (res.proposed) {
          await say(`${worker.name} proposed ${res.proposed === 1 ? 'one piece of work' : `${res.proposed} pieces of work`} and is waiting for ${worker.manager ? `${worker.manager}'s` : 'its manager’s'} OK. I'll post the results here when it's done.`);
        }
        if (res.orchestrationId) {
          this.state.follows.push({ orchestrationId: res.orchestrationId, channel: req.channel, threadTs: root, workerName: worker.name, since: this.now(), ...(res.askId ? { askId: res.askId } : {}), workerId: worker.id, ...(worker.avatarUrl ? { avatarUrl: worker.avatarUrl } : {}) });
          this.save();
        }
      })
      .catch((err: unknown) => this.deps.log(`Front door: ${worker.name}'s answer could not be posted: ${String(err)}`));
  }

  /// The thread so far (when the request is in one) and its files: images
  /// attached for the worker to see, everything else named with its link.
  private async context(req: FrontDoorRequest, files: SlackFile[]): Promise<{ thread: string; where: 'thread' | 'channel'; images: Attachment[]; others: string[] }> {
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
      .filter((m) => m.ts !== req.ts)
      .map((m) => (m.bot_id ? `(posted here earlier, by this app) ${m.text}` : `<@${m.user ?? 'someone'}>: ${m.text}`))
      .join('\n');
    const thread = said.length > 6000 ? `…${said.slice(-6000)}` : said;
    const all = [...files, ...messages.flatMap((m) => m.files ?? [])];
    const images: Attachment[] = [];
    const others: string[] = [];
    const seen = new Set<string>();
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
    return { thread, where, images, others };
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
    } finally {
      this.polling = false;
    }
  }

  /// The thread's status message: posted once the work is under way, then
  /// edited as it moves (a step further, something new said). Saved in the
  /// follow, so a restart edits the same message.
  private async showProgress(f: DoorFollow, p: ErrandProgress): Promise<void> {
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
    if (f.status && this.deps.slack.update) {
      const took = minutes(this.now() - (f.since ?? this.now()));
      await this.deps.slack.update(f.channel, f.status.ts, ok ? `:white_check_mark: Done in ${took}. Writing it up…` : `:warning: It ended without finishing. What happened is below.`).catch(() => false);
    }
    const back = f.askId ? this.deps.handBack?.(f.askId) : null;
    if (back) {
      const res = await back.done;
      if (res.ok) {
        await deliverText(this.io(), f.channel, f.threadTs, f.workerName, res.reply, `${slug(f.workerName)}-answer.md`, f.workerId, { name: f.workerName, ...(f.avatarUrl ? { iconUrl: f.avatarUrl } : {}) });
        return;
      }
      this.deps.log(`Front door: ${f.workerName} could not finish up: ${res.error}`);
    }
    await this.deps.slack.post(f.channel, finishedText(f.workerName, p, this.deps.libraryUrl()), f.threadTs);
    await deliverResults(this.io(), f.channel, f.threadTs, f.workerName, p);
  }
}
