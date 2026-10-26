import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../../shared/types';
import type { TeamRoom } from '../../shared/flows/team';
import type { ErrandProgress } from '../org/orgService';
import { FrontDoor, namedWorker, rankByWords, roomStatus, toSlack, type ExistingHit, type FrontDoorState, type FrontDoorProcess, type FrontDoorTeam, type FrontDoorWorker } from './frontDoor';
import { readRoute, routePrompt } from './frontDoorRoute';
import type { SlackMessage } from './slackApi';

const tick = () => new Promise((r) => setTimeout(r, 0));

const TRIAGE: FrontDoorWorker = { id: 'w-triage', name: 'Triage', tagline: 'Fixes product bugs', job: 'Reproduce bugs in the web app, fix them, and open a pull request with tests.' };
const VANTAGE: FrontDoorWorker = { id: 'w-vantage', name: 'Vantage', tagline: 'Competitive analyst', job: 'Research competitors and write competitive analysis reports on features, pricing and positioning.' };

function harness(opts: { workers?: FrontDoorWorker[]; reply?: string; proposed?: number; orchestrationId?: string; route?: { workerId: string; why: string } | null; thread?: SlackMessage[]; progress?: ErrandProgress | null; owner?: string; workerFile?: (id: string, p: string) => Buffer | null; teams?: FrontDoorTeam[]; processes?: FrontDoorProcess[]; recent?: SlackMessage[]; track?: boolean; findExisting?: (text: string) => ExistingHit[]; askTeam?: boolean; plain?: (q: string, a: string) => string | null; answer?: (text: string) => { text: string; who: string; hits: ExistingHit[]; from: string[] } | null; room?: () => TeamRoom | undefined; blocks?: boolean; status?: (caller: { name: string }) => string; handBack?: (askId: string) => { done: Promise<{ ok: true; reply: string } | { ok: false; error: string }> } | null; general?: (text: string) => string | null; replies?: Record<string, string>; dm?: boolean; now?: () => number; follow?: (item: string, on: boolean, workerId?: string, say?: (t: string) => void) => string | { worker: string; trigger: string; everyMinutes: number; status?: string; setUp?: boolean } | Promise<string | { worker: string; trigger: string; everyMinutes: number; status?: string; setUp?: boolean }>; following?: Array<{ item: string; status?: string; worker: string }>; slow?: boolean; continueRun?: (orchestrationId: string, text: string) => { ok: true; reply: string } | { ok: false; error: string } | null } = {}) {
  const posts: string[] = [];
  const briefs: Array<{ teamId: string; brief: string }> = [];
  const items: Array<{ processId: string; brief: string }> = [];
  const tracks: string[] = [];
  const uploads: string[] = [];
  const edits: Array<{ ts: string; text: string }> = [];
  let statusN = 0;
  const asks: Array<{ workerId: string; text: string; attachments: Attachment[]; conversation?: string; said?: string }> = [];
  let routed = 0;
  const related: Array<Array<{ title: string; who: string }> | undefined> = [];
  const candidates: string[][] = [];
  const looked: string[] = [];
  /// `shared` as each lookup and answer was asked it.
  const audiences: boolean[] = [];
  const teamAsks: Array<{ taskId: string; text: string }> = [];
  const blocks: Array<{ text: string; blocks: unknown[] }> = [];
  const dms: Array<{ user: string; text: string }> = [];
  const desked: string[] = [];
  const continued: Array<{ orchestrationId: string; text: string; conversation: string; said: string }> = [];
  let progress: ErrandProgress | null = opts.progress ?? null;
  let state: FrontDoorState = { threads: [], follows: [] };
  const door = new FrontDoor({
    ...(opts.owner ? { mayAsk: (id: string) => (id === opts.owner ? (true as const) : 'Only my owner can ask.') } : {}),
    caller: async (id) => ({ slackUserId: id, name: 'Pat', admin: false }),
    workers: () => opts.workers ?? [TRIAGE, VANTAGE],
    ...(opts.track
      ? {
          track: (_c: unknown, workerId: string, itemId: string, on: boolean) => {
            tracks.push(`${workerId}:${itemId}:${on}`);
            return { worker: 'Triage', tracked: 3 };
          },
        }
      : {}),
    ...(opts.teams
      ? {
          teams: () => opts.teams!,
          briefTeam: (_c: unknown, teamId: string, brief: string) => {
            briefs.push({ teamId, brief });
            return { ok: true as const };
          },
        }
      : {}),
    ...(opts.processes
      ? {
          processes: () => opts.processes!,
          submitProcess: (_c: unknown, processId: string, brief: string) => {
            items.push({ processId, brief });
            const p = opts.processes!.find((x) => x.id === processId)!;
            return { ok: true as const, title: brief.split('\n')[0], process: p.name, stage: p.firstStage };
          },
        }
      : {}),
    ask: (_c, workerId, text, attachments, conversation, said) => {
      asks.push({ workerId, text, attachments, conversation, said });
      if (opts.slow && asks.length > 1) return { ok: true, done: new Promise<never>(() => {}) };
      return { ok: true, done: Promise.resolve({ ok: true as const, reply: opts.replies?.[workerId] ?? opts.reply ?? 'On it.', askId: 'ask-1', ...(opts.proposed ? { proposed: opts.proposed } : {}), ...(opts.orchestrationId ? { orchestrationId: opts.orchestrationId } : {}) }) };
    },
    ...(opts.handBack ? { handBack: opts.handBack } : {}),
    ...(opts.continueRun
      ? {
          continueRun: (_c: unknown, orchestrationId: string, text: string, _a: Attachment[], conversation: string, said: string) => {
            continued.push({ orchestrationId, text, conversation, said });
            const res = opts.continueRun!(orchestrationId, text);
            return res ? { ok: true as const, done: Promise.resolve(res.ok ? { ok: true as const, reply: res.reply } : res) } : null;
          },
        }
      : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.findExisting
      ? {
          findExisting: (_c: unknown, text: string, o: { shared: boolean }) => {
            looked.push(text);
            audiences.push(o.shared);
            return opts.findExisting!(text);
          },
        }
      : {}),
    ...(opts.askTeam
      ? {
          askTeam: (_c: unknown, taskId: string, text: string) => {
            teamAsks.push({ taskId, text });
            return { ok: true as const };
          },
        }
      : {}),
    ...(opts.room ? { teamRoom: () => opts.room!() } : {}),
    ...(opts.plain ? { plain: async (q: string, a: string) => opts.plain!(q, a) } : {}),
    ...(opts.answer
      ? {
          answer: async (_c: unknown, text: string, o: { shared: boolean }) => {
            audiences.push(o.shared);
            return opts.answer!(text);
          },
        }
      : {}),
    ...(opts.general
      ? {
          general: async (_c: unknown, text: string) => {
            desked.push(text);
            return opts.general!(text);
          },
        }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.follow ? { follow: (_c: unknown, item: string, on: boolean, o: { workerId?: string; say(t: string): void }) => opts.follow!(item, on, o.workerId, o.say) } : {}),
    ...(opts.following ? { following: () => opts.following! } : {}),
    progress: () => progress,
    route: async (_text, offered, rel) => {
      routed++;
      related.push(rel);
      candidates.push(offered.map((w) => w.id));
      return opts.route ?? null;
    },
    slack: {
      post: async (channel, text, threadTs, as) => {
        posts.push(`${channel}@${threadTs}: ${as ? `[as ${as.name}${as.iconUrl ? ` ${as.iconUrl}` : ''}] ` : ''}${text}`);
        return true;
      },
      postTs: async (channel, text, threadTs, as) => {
        posts.push(`${channel}@${threadTs}: ${as ? `[as ${as.name}] ` : ''}${text}`);
        return `status.${++statusN}`;
      },
      update: async (_c, ts, text) => {
        edits.push({ ts, text });
        return true;
      },
      thread: async () => opts.thread ?? [],
      recent: async () => opts.recent ?? [],
      download: async () => Buffer.from('png-bytes'),
      upload: async (_c, _t, filename) => {
        uploads.push(filename);
        return true;
      },
      ...(opts.dm
        ? {
            dm: async (user: string, text: string) => {
              dms.push({ user, text });
              return true;
            },
            permalink: async (channel: string, ts: string) => `https://acme.slack.example/archives/${channel}/p${ts.replace('.', '')}`,
          }
        : {}),
      ...(opts.blocks
        ? {
            postBlocks: async (_c: string, text: string, b: unknown[]) => {
              blocks.push({ text, blocks: b });
              return true;
            },
          }
        : {}),
    },
    libraryUrl: () => 'https://overcli.acme.example',
    readFile: () => Buffer.from('<html>report</html>'),
    ...(opts.workerFile ? { workerFile: opts.workerFile } : {}),
    store: { load: () => structuredClone(state), save: (s) => (state = structuredClone(s)) },
    log: () => {},
  });
  return { door, posts, uploads, edits, asks, continued, briefs, items, tracks, related, candidates, looked, audiences, teamAsks, blocks, dms, desked, routed: () => routed, setProgress: (p: ErrandProgress) => (progress = p), state: () => state };
}

describe('the front door', () => {
  it('puts "idea: …" into a process, asking which when there are several', async () => {
    const IDEAS = { id: 'p-ideas', name: 'Idea to launch', purpose: 'New product ideas', firstStage: 'PR/FAQ' };
    const BUGS = { id: 'p-bugs', name: 'Bug report to fix', purpose: 'Bugs', firstStage: 'Triage' };
    const one = harness({ processes: [IDEAS] });
    await one.door.onMessage({ channel: 'C0ACME', ts: '1.0', user: 'U1', text: '<@B0BOT> idea: CSV export for reports', dm: false });
    expect(one.items).toEqual([{ processId: 'p-ideas', brief: 'CSV export for reports' }]);
    expect(one.posts[0]).toContain('goes into *Idea to launch*, starting at *PR/FAQ*');
    await one.door.onMessage({ channel: 'C0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'and PDF too', dm: false });
    expect(one.items).toHaveLength(1);
    expect(one.posts.at(-1)).toContain("That's in Idea to launch now.");

    const two = harness({ processes: [IDEAS, BUGS] });
    await two.door.onMessage({ channel: 'C0ACME', ts: '2.0', user: 'U1', text: 'new idea - dark mode', dm: false });
    expect(two.posts[0]).toContain('Which process should it go into?');
    await two.door.onMessage({ channel: 'C0ACME', ts: '2.1', threadTs: '2.0', user: 'U1', text: 'idea to launch', dm: false });
    expect(two.items).toEqual([{ processId: 'p-ideas', brief: 'dark mode' }]);

    const named = harness({ processes: [IDEAS, BUGS] });
    await named.door.onMessage({ channel: 'C0ACME', ts: '3.0', user: 'U1', text: 'Bug report to fix: export button greyed out', dm: false });
    expect(named.items).toEqual([{ processId: 'p-bugs', brief: 'export button greyed out' }]);
    expect(named.asks).toHaveLength(0);
  });

  it('keeps a "which process?" answer among the processes, never handing the idea to a worker', async () => {
    const IDEAS = { id: 'p-ideas', name: 'Idea to launch', purpose: 'New product ideas', firstStage: 'PR/FAQ' };
    const BUGS = { id: 'p-bugs', name: 'Bug report to fix', purpose: 'Bugs', firstStage: 'Triage' };
    // The router would pick an ordinary worker if it could see one.
    const h = harness({ processes: [IDEAS, BUGS], route: { workerId: 'w-triage', why: 'it fixes things' } });
    await h.door.onMessage({ channel: 'C0ACME', ts: '4.0', user: 'U1', text: 'idea: a faster export', dm: false });
    expect(h.posts[0]).toContain('Which process should it go into?');
    await h.door.onMessage({ channel: 'C0ACME', ts: '4.1', threadTs: '4.0', user: 'U1', text: 'the launch one I guess', dm: false });
    await tick();
    expect(h.candidates.at(-1)).toEqual(['process:p-ideas', 'process:p-bugs']);
    expect(h.asks).toHaveLength(0);
    expect(h.items).toHaveLength(0);
    expect(h.posts.at(-1)).toBe('C0ACME@4.0: Reply with one of: Idea to launch, Bug report to fix, or say *anyone* and I\'ll pick.');

    // A pick among the processes still goes in, with the answer added.
    const ok = harness({ processes: [IDEAS, BUGS], route: { workerId: 'process:p-ideas', why: 'it takes new ideas' } });
    await ok.door.onMessage({ channel: 'C0ACME', ts: '5.0', user: 'U1', text: 'idea: a faster export', dm: false });
    await ok.door.onMessage({ channel: 'C0ACME', ts: '5.1', threadTs: '5.0', user: 'U1', text: 'the launch one I guess', dm: false });
    expect(ok.asks).toHaveLength(0);
    expect(ok.items).toEqual([{ processId: 'p-ideas', brief: 'a faster export\nthe launch one I guess' }]);
    expect(ok.posts.at(-1)).toContain('goes into *Idea to launch* (it takes new ideas)');
  });

  it('answers "how are we doing?" itself when it can, and routes it like any request when it can\'t', async () => {
    const h = harness({ status: (c) => `${c.name}: 2 waiting on you, Triage is working.` });
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.0', user: 'U1', text: 'How are we doing?', dm: true });
    await tick();
    expect(h.posts).toEqual(['D0ACME@6.0: Pat: 2 waiting on you, Triage is working.']);
    expect(h.asks).toHaveLength(0);
    expect(h.routed()).toBe(0);
    expect(h.state().threads).toEqual([]);

    // In a thread a worker already has, it's more for that worker.
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.0', user: 'U1', text: 'Triage, look at the export bug', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.1', threadTs: '7.0', user: 'U1', text: 'status update', dm: true });
    await tick();
    expect(h.asks.map((a) => a.workerId)).toEqual(['w-triage', 'w-triage']);
    expect(h.asks[1].text).toContain('status update');

    const none = harness();
    await none.door.onMessage({ channel: 'D0ACME', ts: '8.0', user: 'U1', text: 'How are we doing?', dm: true });
    await tick();
    expect(none.routed()).toBe(1);
    expect(none.posts[0]).toContain('Who should take this?');
  });

  it('answers "what is overgo?" itself instead of routing it', async () => {
    const h = harness({ route: { workerId: 'w-vantage', why: 'can research an unfamiliar product' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '5.0', user: 'U1', text: 'what is overgo', dm: true });
    await tick();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("I'm overgo");
    expect(h.posts[0]).toContain('*Vantage* — Competitive analyst');
    expect(h.asks).toHaveLength(0);
    expect(h.routed()).toBe(0);
  });

  it('gives a request that names a worker to it, and answers in the thread', async () => {
    const h = harness({ reply: 'Done — the button is in.' });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U0ACMEPAT', text: 'Triage, add an export button to the reports page', dm: true });
    await tick();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ workerId: 'w-triage' });
    expect(h.asks[0].text).toContain('add an export button to the reports page');
    expect(h.posts).toEqual(['D0ACME@1.0: *Triage* has this. I\'ll reply here.', 'D0ACME@1.0: [as Triage] Done — the button is in.']);
    expect(h.routed()).toBe(0);
  });

  it('routes by job when the words point clearly at one worker, else asks a model, else asks the person', async () => {
    const clear = harness();
    await clear.door.onMessage({ channel: 'C0ACME', ts: '2.0', user: 'U1', text: '<@B0BOT> competitive analysis of pricing for the reports feature against competitors', dm: false });
    expect(clear.asks[0].workerId).toBe('w-vantage');
    expect(clear.routed()).toBe(0);

    const modeled = harness({ route: { workerId: 'w-triage', why: 'it fixes the web app' } });
    await modeled.door.onMessage({ channel: 'C0ACME', ts: '3.0', user: 'U1', text: 'the login page looks off', dm: false });
    expect(modeled.routed()).toBe(1);
    expect(modeled.asks[0].workerId).toBe('w-triage');
    expect(modeled.posts[0]).toContain('*Triage* has this (it fixes the web app)');

    const unsure = harness({ route: null });
    await unsure.door.onMessage({ channel: 'C0ACME', ts: '4.0', user: 'U1', text: 'can someone look at this', dm: false });
    expect(unsure.asks).toHaveLength(0);
    expect(unsure.posts[0]).toContain('Who should take this?');
    await unsure.door.onMessage({ channel: 'C0ACME', ts: '4.1', threadTs: '4.0', user: 'U1', text: 'vantage', dm: false });
    expect(unsure.asks[0]).toMatchObject({ workerId: 'w-vantage' });
    expect(unsure.asks[0].text).toContain('can someone look at this');

    const anyone = harness({ route: null });
    await anyone.door.onMessage({ channel: 'C0ACME', ts: '6.0', user: 'U1', text: 'how are we doing today', dm: false });
    await anyone.door.onMessage({ channel: 'C0ACME', ts: '6.1', threadTs: '6.0', user: 'U1', text: 'anyone', dm: false });
    expect(anyone.asks).toHaveLength(1);
    expect(anyone.posts.join('\n')).toContain('(you said anyone)');
  });

  it('brings the thread and its screenshots along, and keeps a thread with its worker', async () => {
    const thread: SlackMessage[] = [
      { ts: '5.0', user: 'U2', text: 'The export on the reports page is greyed out', files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 9, url_private: 'https://files.slack.com/x/shot.png' }] },
      { ts: '5.1', user: 'U1', text: '<@B0BOT> Triage fix this' },
    ];
    const h = harness({ thread });
    await h.door.onMessage({ channel: 'C0ACME', ts: '5.1', threadTs: '5.0', user: 'U1', text: '<@B0BOT> Triage fix this', dm: false });
    expect(h.asks[0].text).toContain('<@U2>: The export on the reports page is greyed out');
    expect(h.asks[0].attachments).toMatchObject([{ id: 'F1', mimeType: 'image/png', label: 'shot.png' }]);
    expect(h.door.owns('C0ACME', '5.0')).toBe(true);
    await h.door.onMessage({ channel: 'C0ACME', ts: '5.2', threadTs: '5.0', user: 'U1', text: 'and make it blue', dm: false });
    expect(h.asks[1]).toMatchObject({ workerId: 'w-triage' });
    expect(h.asks[1].text).toContain('More from Pat on the same request:\nand make it blue');
  });

  it('follows work the answer started, and posts the PR and files when it ends', async () => {
    const h = harness({ reply: 'Starting the fix.', orchestrationId: 'orch-1', progress: { done: false, items: [{ title: 'Fix export', status: 'running' }], files: [], links: [] } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.0', user: 'U1', text: 'Triage fix the export button', dm: true });
    await tick();
    expect(h.state().follows).toHaveLength(1);
    await h.door.poll();
    // The two replies, then the status message.
    expect(h.posts).toHaveLength(3);
    h.setProgress({
      done: true,
      items: [{ title: 'Fix export', status: 'done' }],
      files: [{ name: 'answer', body: 'Opened https://github.com/acme/app/pull/77' }, { name: 'report.html', sourcePath: '/data/out/report.html' }],
      links: ['https://github.com/acme/app/pull/77'],
    });
    await h.door.poll();
    await tick();
    expect(h.posts[3]).toContain('*Triage* finished:\n✓ Fix export\nPull request: https://github.com/acme/app/pull/77');
    expect(h.posts[3]).toContain('https://overcli.acme.example');
    expect(h.uploads).toEqual(['report.html']);
    expect(h.state().follows).toHaveLength(0);
  });

  it('hands finished work back to the worker and posts what it makes of it, not the raw output', async () => {
    const handed: string[] = [];
    const h = harness({
      reply: 'Pulling the counts, then I will chart them.',
      orchestrationId: 'orch-9',
      workerFile: (_id, p) => (p === '/data/worker-files/w-vantage/tickets.html' ? Buffer.from('<html>chart</html>') : null),
      handBack: (askId) => {
        handed.push(askId);
        return { done: Promise.resolve({ ok: true as const, reply: 'You closed 429 tickets this year, most in September. The chart: /data/worker-files/w-vantage/tickets.html' }) };
      },
      progress: { done: true, items: [{ title: 'Ticket tally', status: 'done' }], files: [{ name: 'result.json', body: '{"total":429}' }], links: [] },
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.0', user: 'U1', text: 'Vantage graph my tickets', dm: true });
    await tick();
    await h.door.poll();
    await tick();
    await tick();
    expect(handed).toEqual(['ask-1']);
    expect(h.posts.at(-1)).toBe('D0ACME@7.0: [as Vantage] You closed 429 tickets this year, most in September. The chart: tickets.html (attached)');
    expect(h.posts.join('\n')).not.toContain('"total"');
    expect(h.uploads).toEqual(['tickets.html']);
  });

  it('carries a reply after finished work on with whoever ran its last step, like a chat', async () => {
    const h = harness({
      reply: 'Pulling the counts.',
      orchestrationId: 'orch-11',
      progress: { done: true, items: [{ title: 'Ticket tally', status: 'done' }], files: [{ name: 'result.json', body: '429 tickets' }], links: [] },
      continueRun: () => ({ ok: true, reply: 'September had 61 of them, mostly billing.' }),
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.7', user: 'U1', text: 'Vantage count my tickets', dm: true });
    await tick();
    await h.door.poll();
    await tick();
    expect(h.state().threads[0].done).toMatchObject({ orchestrationId: 'orch-11', workerId: 'w-vantage' });
    const before = h.asks.length;
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.9', threadTs: '7.7', user: 'U1', text: 'which month was worst?', dm: true });
    await tick();
    await tick();
    expect(h.continued).toHaveLength(1);
    expect(h.continued[0]).toMatchObject({ orchestrationId: 'orch-11', conversation: 'slack:D0ACME:7.7', said: 'which month was worst?' });
    expect(h.continued[0].text).toContain('which month was worst?');
    // Not a new errand for the worker.
    expect(h.asks).toHaveLength(before);
    expect(h.posts.at(-1)).toBe('D0ACME@7.7: [as Vantage] September had 61 of them, mostly billing.');
  });

  it('gives the follow-up to the worker when the finished work can\'t be carried on', async () => {
    const h = harness({
      reply: 'Pulling the counts.',
      orchestrationId: 'orch-12',
      progress: { done: true, items: [{ title: 'Ticket tally', status: 'done' }], files: [], links: [] },
      continueRun: () => null,
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.1', user: 'U1', text: 'Vantage count my tickets', dm: true });
    await tick();
    await h.door.poll();
    await tick();
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.2', threadTs: '8.1', user: 'U1', text: 'and last year?', dm: true });
    await tick();
    expect(h.continued).toHaveLength(1);
    expect(h.asks.at(-1)?.text).toContain('More from Pat on the same request:\nand last year?');
  });

  it('falls back to the worker when carrying on fails partway', async () => {
    const h = harness({
      reply: 'Pulling the counts.',
      orchestrationId: 'orch-13',
      progress: { done: true, items: [{ title: 'Ticket tally', status: 'done' }], files: [], links: [] },
      continueRun: () => ({ ok: false, error: 'session gone' }),
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '9.1', user: 'U1', text: 'Vantage count my tickets', dm: true });
    await tick();
    await h.door.poll();
    await tick();
    await h.door.onMessage({ channel: 'D0ACME', ts: '9.2', threadTs: '9.1', user: 'U1', text: 'and last year?', dm: true });
    await tick();
    await tick();
    expect(h.asks.at(-1)?.text).toContain('and last year?');
    expect(h.state().threads[0].done).toBeUndefined();
  });

  it('posts the raw output when the worker can\'t finish up', async () => {
    const h = harness({
      reply: 'Pulling the counts.',
      orchestrationId: 'orch-10',
      handBack: () => ({ done: Promise.resolve({ ok: false as const, error: 'paused' }) }),
      progress: { done: true, items: [{ title: 'Ticket tally', status: 'done' }], files: [{ name: 'result.json', body: '429 tickets' }], links: [] },
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.5', user: 'U1', text: 'Vantage graph my tickets', dm: true });
    await tick();
    await h.door.poll();
    await tick();
    await tick();
    expect(h.posts.some((p) => p.includes('*Vantage* finished:'))).toBe(true);
  });

  it('answers as the worker, under its own picture', async () => {
    const h = harness({ workers: [{ ...TRIAGE, avatarUrl: 'https://api.dicebear.com/9.x/thumbs/png?seed=abc' }, VANTAGE], reply: 'Done.' });
    await h.door.onMessage({ channel: 'D0ACME', ts: '12.0', user: 'U1', text: 'Triage fix the export', dm: true });
    await tick();
    expect(h.posts.at(-1)).toBe('D0ACME@12.0: [as Triage https://api.dicebear.com/9.x/thumbs/png?seed=abc] Done.');
  });

  it('keeps one status message in the thread up to date while the work runs, and settles it when it ends', async () => {
    const h = harness({ reply: 'Starting the audit.', orchestrationId: 'orch-s', progress: { done: false, items: [{ title: 'SEO audit', status: 'running', step: { index: 1, total: 2, name: 'crawl' }, startedAt: Date.now() - 6 * 60_000, said: 'Crawling 49 pages now.' }], files: [], links: [] } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '13.0', user: 'U1', text: 'Vantage audit <http://acme.example|acme.example>', dm: true });
    await tick();
    expect(h.asks[0].said).toBe('audit acme.example');
    await h.door.poll();
    const status = h.posts.find((p) => p.includes('Working on it'))!;
    expect(status).toContain('[as Vantage]');
    expect(status).toContain('*SEO audit* — step 1 of 2, crawl · 6 min');
    expect(status).toContain('> _Crawling 49 pages now._');
    await h.door.poll();
    expect(h.edits).toEqual([]);
    h.setProgress({ done: false, items: [{ title: 'SEO audit', status: 'running', step: { index: 2, total: 2, name: 'audit report' }, startedAt: Date.now() - 9 * 60_000 }], files: [], links: [] });
    await h.door.poll();
    expect(h.edits.at(-1)).toMatchObject({ ts: 'status.1' });
    expect(h.edits.at(-1)!.text).toContain('step 2 of 2, audit report');
    expect(h.posts.filter((p) => p.includes('Working on it'))).toHaveLength(1);
    h.setProgress({ done: true, items: [{ title: 'SEO audit', status: 'done' }], files: [{ name: 'report.md', body: 'Ranked changes.' }], links: [] });
    await h.door.poll();
    await tick();
    expect(h.edits.some((e) => e.ts === 'status.1' && /Done in \d+ min/.test(e.text))).toBe(true);
  });

  it('takes requests only from the owner on a personal install', async () => {
    const h = harness({ owner: 'U0ACMEPAT' });
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.0', user: 'U0ACMESAM', text: 'Triage fix the export', dm: true });
    expect(h.asks).toHaveLength(0);
    expect(h.posts).toEqual(['D0ACME@8.0: Only my owner can ask.']);
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.1', user: 'U0ACMEPAT', text: 'Triage fix the export', dm: true });
    expect(h.asks).toHaveLength(1);
  });

  it('hands back the link to open a pull request from a pushed branch', async () => {
    const h = harness({ reply: 'Starting.', orchestrationId: 'o', progress: {
      done: true,
      items: [{ title: 'Fix export', status: 'done' }],
      files: [{ name: 'branch', body: 'Changed the export button. Tests pass.\nOpen a pull request: https://bitbucket.org/acme/app/pull-requests/new?source=overcli/fix-export&dest=main' }],
      links: ['https://bitbucket.org/acme/app/pull-requests/new?source=overcli/fix-export&dest=main'],
    } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '9.0', user: 'U1', text: 'Triage fix the export', dm: true });
    await tick();
    await h.door.poll();
    await tick();
    expect(h.posts[2]).toContain('Branch pushed. Open a pull request: https://bitbucket.org/acme/app/pull-requests/new?source=overcli/fix-export&dest=main');
    expect(h.posts[3]).toContain('Changed the export button. Tests pass.');
  });

  it('says when the work waits on its manager, and keeps following it', async () => {
    const h = harness({ workers: [{ ...TRIAGE, manager: 'Pat' }, VANTAGE], reply: 'I proposed the fix.', proposed: 1, orchestrationId: 'o-2' });
    await h.door.onMessage({ channel: 'C0ACME', ts: '10.0', user: 'U2', text: 'Triage fix the export', dm: false });
    await tick();
    expect(h.posts[2]).toBe("C0ACME@10.0: Triage proposed one piece of work and is waiting for Pat's OK. I'll post the results here when it's done.");
    expect(h.state().follows).toMatchObject([{ orchestrationId: 'o-2' }]);
  });

  it('posts an answer whole up to a point, and past it attaches it and keeps the message short', async () => {
    const whole = harness({ reply: 'x'.repeat(5000) });
    await whole.door.onMessage({ channel: 'D0ACME', ts: '7.0', user: 'U1', text: 'Vantage: compare pricing for company A', dm: true });
    await tick();
    expect(whole.posts[1]).toContain('x'.repeat(5000));
    expect(whole.uploads).toEqual([]);
    const h = harness({ reply: 'x'.repeat(12000) });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.0', user: 'U1', text: 'Vantage: compare pricing for company A', dm: true });
    await tick();
    expect(h.posts[1].length).toBeLessThan(1400);
    expect(h.posts[1]).toContain('The full answer is attached.');
    expect(h.uploads).toEqual(['compare-pricing-for-company-a.md']);
  });
});

describe('reading a request', () => {
  it('finds a named worker at the start, longest name first', () => {
    const ws = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Ana Lyst' }];
    expect(namedWorker('Ana Lyst: compare pricing', ws)).toMatchObject({ worker: { id: 'b' }, rest: 'compare pricing' });
    expect(namedWorker('ask Ana to look', ws)).toMatchObject({ worker: { id: 'a' }, rest: 'look' });
    expect(namedWorker('Banana bread', ws)).toBeNull();
  });

  it('ranks workers by the words of their job', () => {
    expect(rankByWords('fix the bug on the web app', [VANTAGE, TRIAGE])[0].worker.id).toBe('w-triage');
  });

  it('reads the model\'s pick leniently', () => {
    expect(routePrompt('fix it', [TRIAGE])).toContain('1. Triage — Fixes product bugs');
    expect(readRoute('Sure: {"worker": 2, "why": "competitive research"}', [TRIAGE, VANTAGE])).toEqual({ workerId: 'w-vantage', why: 'competitive research' });
    expect(readRoute('{"worker": null, "why": "nobody"}', [TRIAGE])).toBeNull();
    expect(readRoute('no idea', [TRIAGE])).toBeNull();
  });
});

describe('answers in Slack', () => {
  it('speak Slack markup, not markdown', () => {
    expect(toSlack('## Result\n- **Too soon:** see [the run](https://overcli.acme.example/r/1)\n```\n**kept**\n```')).toBe(
      '*Result*\n• *Too soon:* see <https://overcli.acme.example/r/1|the run>\n```\n**kept**\n```',
    );
  });

  it('turn a table into a bold header and one bullet per row', () => {
    expect(toSlack('| When | Item | Owner |\n|---|:---:|---|\n| **10-31** | Stop unverified senders | M. Ito |\n| Now | Release 26.10 | — |\nafter')).toBe(
      '*When · Item · Owner*\n• *10-31* — Stop unverified senders — M. Ito\n• Now — Release 26.10\nafter',
    );
  });
});

describe('a conversation in a thread', () => {
  it('keeps one conversation per thread, and the worker sees its own earlier replies', async () => {
    const h = harness({
      thread: [
        { ts: '5.0', user: 'U0ACMEPAT', text: 'Vantage, summarize acme' },
        { ts: '5.1', bot_id: 'B0BOT', text: '*Vantage:* Acme leads on partner AI.' },
        { ts: '5.2', user: 'U0ACMEPAT', text: 'and their pricing?' },
      ] as SlackMessage[],
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '5.0', user: 'U0ACMEPAT', text: 'Vantage, summarize acme', dm: true });
    await tick();
    await h.door.onMessage({ channel: 'D0ACME', ts: '5.2', threadTs: '5.0', user: 'U0ACMEPAT', text: 'and their pricing?', dm: true });
    await tick();
    expect(h.asks.map((a) => a.conversation)).toEqual(['slack:D0ACME:5.0', 'slack:D0ACME:5.0']);
    // Shown in the console as what was typed, not the wrapping for the worker.
    expect(h.asks.map((a) => a.said)).toEqual(['summarize acme', 'and their pricing?']);
    expect(h.asks[1].text).toContain('(posted here earlier, by this app) *Vantage:* Acme leads on partner AI.');
  });

  it('attaches a file the reply names in the worker’s own files, and names it instead of the path', async () => {
    const path = '/data/worker-files/w-vantage/2026-10-19-errand/acme-summary.html';
    const h = harness({
      reply: `Built it: ${path}\n**Caveat:** vendor-sourced.`,
      workerFile: (id, p) => (id === 'w-vantage' && p === path ? Buffer.from('<html>acme</html>') : null),
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.0', user: 'U0ACMEPAT', text: 'Vantage, make it an html report', dm: true });
    await tick();
    expect(h.posts.at(-1)).toBe('D0ACME@6.0: [as Vantage] Built it: acme-summary.html (attached)\n*Caveat:* vendor-sourced.');
    expect(h.uploads).toEqual(['acme-summary.html']);
  });

  it('leaves a path it may not send as text, and sends nothing', async () => {
    const h = harness({ reply: 'See /etc/hosts.txt and /data/other/x.html', workerFile: () => null });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.0', user: 'U0ACMEPAT', text: 'Vantage, anything', dm: true });
    await tick();
    expect(h.posts.at(-1)).toContain('/etc/hosts.txt');
    expect(h.uploads).toEqual([]);
  });
});

describe('teams at the front door', () => {
  const PRODUCT: FrontDoorTeam = { id: 'tm-product', name: 'Product', purpose: 'Writes PR/FAQs and product briefs for new features.', members: ['Vantage', 'Lena', 'Forge'] };

  it('gives a request that names a team to it as a team task, and says the questions come by DM', async () => {
    const h = harness({ teams: [PRODUCT] });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.0', user: 'U1', text: '<@B0BOT> the Product team, write a PR/FAQ for offline mode', dm: false });
    expect(h.asks).toHaveLength(0);
    expect(h.briefs).toEqual([{ teamId: 'tm-product', brief: 'write a PR/FAQ for offline mode' }]);
    expect(h.posts[0]).toContain('*Product* has this as a team task');
    expect(h.posts[0]).toContain('DM you anything it needs to know');
    // A later reply in the thread is pointed at the DMs, not sent to a worker.
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'also cover pricing', dm: false });
    expect(h.asks).toHaveLength(0);
    expect(h.posts[1]).toContain("That's Product's task now");
  });

  it('lets the router pick a team, and the thread travels as its brief', async () => {
    const h = harness({ teams: [PRODUCT], route: { workerId: 'team:tm-product', why: 'a PR/FAQ is its job' }, thread: [{ user: 'U2', text: 'customers keep asking for offline', ts: '0.9' } as SlackMessage] });
    await h.door.onMessage({ channel: 'C0ACME', ts: '2.0', threadTs: '0.9', user: 'U1', text: 'can we get something written up on this', dm: false });
    expect(h.briefs[0].teamId).toBe('tm-product');
    expect(h.briefs[0].brief).toContain('customers keep asking for offline');
    expect(h.posts[0]).toContain('(a PR/FAQ is its job)');
  });

  it('offers no teams without a way to brief them', async () => {
    const h = harness({ route: null });
    await h.door.onMessage({ channel: 'C0ACME', ts: '3.0', user: 'U1', text: 'Product, write a PR/FAQ', dm: false });
    expect(h.briefs).toHaveLength(0);
  });
});

describe('one-tap answers in Slack', () => {
  it('offers the answers a worker gave as buttons, and a press goes back in the thread as the presser', async () => {
    const blocks: unknown[] = [];
    const updated: string[] = [];
    const asks: Array<{ text: string; said?: string }> = [];
    const door = new FrontDoor({
      caller: async (id) => ({ slackUserId: id, name: 'Pat', admin: false }),
      workers: () => [VANTAGE],
      ask: (_c, _w, text, _a, _conv, said) => {
        asks.push({ text, said });
        return { ok: true, done: Promise.resolve({ ok: true as const, reply: 'The tracker refused the call.', choices: ['Retry now', 'Skip the tracker'] }) };
      },
      progress: () => null,
      route: async () => null,
      slack: {
        post: async () => true,
        thread: async () => [],
        download: async () => null,
        upload: async () => true,
        postBlocks: async (_c, _t, b) => (blocks.push(b), true),
        update: async (_c, _ts, t) => (updated.push(t), true),
      },
      libraryUrl: () => null,
      readFile: () => null,
      store: { load: () => ({ threads: [], follows: [] }), save: () => {} },
      log: () => {},
    });
    await door.onMessage({ channel: 'D0ACME', ts: '8.0', user: 'U0ACMEPAT', text: 'Vantage, recheck the tracker', dm: true });
    await tick();
    expect(JSON.stringify(blocks[0])).toContain('"value":"Retry now"');
    await door.onChoice({ channel: 'D0ACME', messageTs: '8.2', threadTs: '8.0', user: 'U0ACMEPAT', text: 'Retry now' });
    await tick();
    expect(updated).toEqual(['<@U0ACMEPAT> picked: Retry now']);
    expect(asks.at(-1)?.said).toBe('Retry now');
  });
});

describe('a mention in a channel', () => {
  const TRACKER: FrontDoorWorker = { id: 'w-desk', name: 'Desk', tagline: 'Answers questions about our work', job: 'Answers questions.', tools: ['acme-tracker'] };
  const TALKER: FrontDoorWorker = { id: 'w-talk', name: 'Talk', tagline: 'Answers questions about our work', job: 'Answers questions.' };

  it('reads the last messages before a top-level mention, so “this ticket” means the one just posted', async () => {
    const h = harness({ recent: [{ user: 'U2', text: 'ACME-412 is blocking the release', ts: '9.0' } as SlackMessage] });
    await h.door.onMessage({ channel: 'C0ACME', ts: '10.0', user: 'U1', text: 'Triage, what is the status of this ticket', dm: false });
    expect(h.asks[0].text).toContain('The last messages in the channel before this request');
    expect(h.asks[0].text).toContain('ACME-412 is blocking the release');
  });

  it('tells the router what each worker can reach, and the words count a tool too', () => {
    const prompt = routePrompt('status of ticket ACME-412', [TRACKER, TALKER]);
    expect(prompt).toContain('Tools: acme-tracker');
    expect(prompt).toContain('Tools: none beyond files and the web');
    expect(rankByWords('what does the acme tracker say', [TALKER, TRACKER])[0].worker.id).toBe('w-desk');
  });
});

describe('tracking a ticket from Slack', () => {
  it('puts it on a named worker’s list with no model turn, and takes it off again', async () => {
    const h = harness({ track: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'Triage, track ACME-412 too', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.0', user: 'U1', text: 'Triage, stop tracking ACME-412', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '3.0', user: 'U1', text: 'Triage, untrack ACME-412', dm: true });
    expect(h.tracks).toEqual(['w-triage:ACME-412:true', 'w-triage:ACME-412:false', 'w-triage:ACME-412:false']);
    expect(h.asks).toHaveLength(0);
    expect(h.routed()).toBe(0);
    expect(h.posts[0]).toContain('Tracking ACME-412. Triage tracks 3');
  });
});

describe('looking up existing work first', () => {
  const NOW = Date.now();
  const ROADMAP: ExistingHit = {
    kind: 'team',
    title: 'Q1 2027 roadmap: company announcement and customer-facing version',
    who: 'Product Team',
    at: NOW,
    summary: 'Three themes for Q1: reporting, the mobile app, integrations.',
    url: 'https://overcli.acme.example/#teamtask/t-1',
    teamTaskId: 't-1',
    teamId: 'team-product',
    status: 'waiting on your review',
  };
  const HUGO: FrontDoorWorker = { id: 'w-hugo', name: 'Hugo', tagline: 'Product planning', job: 'Writes plans and roadmaps.' };
  const CHURN: ExistingHit = { kind: 'worker', title: 'Churn report for September', who: 'Hugo', at: NOW, summary: 'Churn fell to 2%.', workerId: 'w-hugo' };

  it('answers a question with the work that already exists, and does not route it', async () => {
    const h = harness({ blocks: true, askTeam: true, findExisting: () => [ROADMAP], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'whats the roadmap for q1 2027', dm: true });
    expect(h.looked).toEqual(['whats the roadmap for q1 2027']);
    expect(h.routed()).toBe(0);
    expect(h.asks).toHaveLength(0);
    expect(h.blocks[0].text).toBe('*Product Team* finished _Q1 2027 roadmap: company announcement and customer-facing version_ today — waiting on your review.\n> Three themes for Q1: reporting, the mobile app, integrations.');
    const buttons = (h.blocks[0].blocks[1] as { elements: Array<{ text: { text: string }; url?: string; value: string }> }).elements;
    expect(buttons.map((b) => b.text.text)).toEqual(['Open it', 'Ask the team about it', "That's not it"]);
    expect(buttons[0].url).toBe('https://overcli.acme.example/#teamtask/t-1');
    expect(h.state().threads[0].existing?.hits).toHaveLength(1);
    // The button, pressed: the question goes to the task's team.
    await h.door.onChoice({ channel: 'D0ACME', messageTs: '1.1', threadTs: '1.0', user: 'U1', text: buttons[1].value });
    expect(h.teamAsks).toEqual([{ taskId: 't-1', text: 'whats the roadmap for q1 2027' }]);
    expect(h.posts.at(-1)).toBe('D0ACME@1.0: Asked *Product Team* — their answer will land in the task: https://overcli.acme.example/#teamtask/t-1');
    expect(h.edits.at(-1)?.text).toBe('<@U1> picked: Ask the team about it');
    expect(h.routed()).toBe(0);
  });

  it('routes the question as usual on "That\'s not it", with the near misses as hints', async () => {
    const weak: ExistingHit = { kind: 'worker', title: 'Roadmap themes', who: 'Hugo', at: NOW, summary: '', workerId: 'w-hugo', weak: true };
    const h = harness({ findExisting: () => [ROADMAP, weak], route: { workerId: 'w-triage', why: 'it fits' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.0', user: 'U1', text: 'whats the roadmap for q1 2027', dm: true });
    // No buttons here: the same, in words.
    expect(h.posts[0]).toContain('Open it: https://overcli.acme.example/#teamtask/t-1');
    expect(h.posts[0]).toContain("Reply *ask* to put your question to the team, or *not it* and I'll find someone to take it.");
    expect(h.door.owns('D0ACME', '2.0')).toBe(true);
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.1', threadTs: '2.0', user: 'U1', text: 'That’s not it', dm: true });
    expect(h.routed()).toBe(1);
    expect(h.related[0]).toEqual([{ title: 'Roadmap themes', who: 'Hugo' }]);
    expect(h.asks[0]).toMatchObject({ workerId: 'w-triage' });
    expect(h.asks[0].text).toContain('whats the roadmap for q1 2027');
    expect(h.state().threads[0].existing).toBeUndefined();
  });

  it('routes as before when nothing matches, telling the router what was close', async () => {
    const none = harness({ findExisting: () => [], route: { workerId: 'w-vantage', why: 'research' } });
    await none.door.onMessage({ channel: 'D0ACME', ts: '3.0', user: 'U1', text: 'what are competitors charging?', dm: true });
    expect(none.looked).toHaveLength(1);
    expect(none.routed()).toBe(1);
    expect(none.related[0]).toBeUndefined();
    expect(none.posts[0]).toContain('*Vantage* has this (research)');

    const close = harness({ findExisting: () => [{ ...ROADMAP, weak: true }], route: { workerId: 'w-vantage', why: 'research' } });
    await close.door.onMessage({ channel: 'D0ACME', ts: '3.1', user: 'U1', text: 'what is in the roadmap?', dm: true });
    expect(close.related[0]).toEqual([{ title: ROADMAP.title, who: 'Product Team' }]);
    expect(close.asks).toHaveLength(1);
  });

  it('never looks for a request to make something, or one that names a worker', async () => {
    const h = harness({ findExisting: () => [ROADMAP], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '4.0', user: 'U1', text: 'write me a plan for the q1 2027 roadmap', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '4.1', user: 'U1', text: 'Vantage, what is the q1 2027 roadmap?', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '4.2', user: 'U1', text: 'what does Triage think of the q1 2027 roadmap?', dm: true });
    expect(h.looked).toEqual([]);
    expect(h.asks.map((a) => a.workerId)).toEqual(['w-triage', 'w-vantage', 'w-triage']);
  });

  it('offers several as a list to pick from, by button or by "the second one"', async () => {
    const h = harness({ blocks: true, workers: [TRIAGE, HUGO], findExisting: () => [ROADMAP, CHURN], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '5.0', user: 'U1', text: 'what did we ship?', dm: true });
    expect(h.blocks[0].text).toMatch(/^This may already exist:\n1\. _Q1 2027 roadmap: .+_ · \*Product Team\* · today · waiting on your review\n2\. _Churn report for September_ · \*Hugo\* · today$/);
    const buttons = (h.blocks[0].blocks[1] as { elements: Array<{ text: { text: string } }> }).elements;
    expect(buttons.map((b) => b.text.text).at(-1)).toBe('None of these');
    await h.door.onMessage({ channel: 'D0ACME', ts: '5.1', threadTs: '5.0', user: 'U1', text: 'the second one', dm: true });
    expect(h.blocks[1].text).toBe('*Hugo* delivered _Churn report for September_ today.\n> Churn fell to 2%.');
    expect((h.blocks[1].blocks[1] as { elements: Array<{ text: { text: string } }> }).elements.map((b) => b.text.text)).toEqual(['Ask Hugo about it', "That's not it"]);
    // Asking a worker about its own work starts from it.
    await h.door.onMessage({ channel: 'D0ACME', ts: '5.2', threadTs: '5.0', user: 'U1', text: 'Ask Hugo about it', dm: true });
    expect(h.asks[0].workerId).toBe('w-hugo');
    expect(h.asks[0].text).toContain('what did we ship?');
    expect(h.asks[0].text).toContain('This is about what you delivered today: "Churn report for September". It said: Churn fell to 2%.');
    expect(h.routed()).toBe(0);

    const no = harness({ workers: [TRIAGE, HUGO], findExisting: () => [ROADMAP, CHURN], route: { workerId: 'w-triage', why: 'x' } });
    await no.door.onMessage({ channel: 'D0ACME', ts: '6.0', user: 'U1', text: 'what did we ship?', dm: true });
    expect(no.posts[0]).toContain("Reply with its number, or *none* and I'll find someone to take it.");
    await no.door.onMessage({ channel: 'D0ACME', ts: '6.1', threadTs: '6.0', user: 'U1', text: 'None of these', dm: true });
    expect(no.routed()).toBe(1);
    expect(no.asks[0].workerId).toBe('w-triage');
  });

  it('takes a question typed under an offer as one about it, and posts the room\'s answer back here', async () => {
    let room: TeamRoom | undefined = { messages: [] };
    const h = harness({ blocks: true, askTeam: true, room: () => room, findExisting: () => [ROADMAP], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.0', user: 'U1', text: 'whats the roadmap for q1 2027', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.1', threadTs: '7.0', user: 'U1', text: 'what is the mobile app doing', dm: true });
    // Not looked up again, not routed: put to the team that made it.
    expect(h.looked).toHaveLength(1);
    expect(h.routed()).toBe(0);
    expect(h.teamAsks).toEqual([{ taskId: 't-1', text: 'what is the mobile app doing' }]);
    expect(h.posts.at(-1)).toBe("D0ACME@7.0: Asked *Product Team*. I'll post their answer here.");
    // The stale button: already asked.
    await h.door.onChoice({ channel: 'D0ACME', messageTs: '7.2', threadTs: '7.0', user: 'U1', text: 'Ask the team about it' });
    expect(h.teamAsks).toHaveLength(1);
    expect(h.posts.at(-1)).toBe("D0ACME@7.0: Already asked *Product Team*. I'll post their answer here.");

    const asked = { id: 'm1', speaker: { kind: 'you' as const }, text: 'what is the mobile app doing', at: Date.now(), exchange: 0 };
    room = { messages: [asked], busy: { speaker: 'Coordinator', since: Date.now() } };
    await h.door.poll();
    // Who's on it, in the thread, while the room works.
    expect(h.posts.at(-1)).toContain('[as Product Team] :hourglass_flowing_sand: *Product Team* is on it');
    expect(h.posts.at(-1)).toContain('• Coordinator is picking who should answer');
    room = { messages: [asked, { id: 'm2', speaker: { kind: 'coordinator' }, text: 'It ships in February.', at: Date.now(), exchange: 0 }], busy: null };
    await h.door.poll();
    expect(h.posts.at(-1)).toBe('D0ACME@7.0: [as Product Team] It ships in February.\n\n<https://overcli.acme.example/#teamtask/t-1|Open the task>');
    expect(h.edits.at(-1)?.text).toMatch(/^:white_check_mark: \*Product Team\* answered in \d+ min\.$/);
    await h.door.poll();
    expect(h.posts.filter((p) => p.includes('February'))).toHaveLength(1);
    // More in the thread: the same room.
    await h.door.onMessage({ channel: 'D0ACME', ts: '7.3', threadTs: '7.0', user: 'U1', text: 'and integrations?', dm: true });
    expect(h.teamAsks.at(-1)).toEqual({ taskId: 't-1', text: 'and integrations?' });
  });

  it('answers a question from what is already known, under the team\'s name', async () => {
    const h = harness({ blocks: true, askTeam: true, findExisting: () => [ROADMAP], answer: () => ({ text: 'Reporting ships first in Q1, then the mobile app.', who: 'Product Team', hits: [ROADMAP], from: ['Product Team\'s task', 'What Product Team knows'] }), route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '9.0', user: 'U1', text: 'whats next on the roadmap', dm: true });
    expect(h.looked).toHaveLength(0);
    expect(h.routed()).toBe(0);
    expect(h.posts).toEqual(["D0ACME@9.0: Checking what's already been worked out…", 'D0ACME@9.0: [as Product Team] Reporting ships first in Q1, then the mobile app.']);
    expect(h.blocks[0].text).toBe("From Product Team's task and 1 more");
    expect((h.blocks[0].blocks[1] as { elements: Array<{ text: { text: string } }> }).elements.map((b) => b.text.text)).toEqual(['Open it', 'Ask the team about it', "That's not it"]);
    // "Not it": to a worker, as before.
    await h.door.onMessage({ channel: 'D0ACME', ts: '9.1', threadTs: '9.0', user: 'U1', text: 'not it', dm: true });
    expect(h.asks[0].workerId).toBe('w-triage');

    // Nothing known covers it: offered and routed as before.
    const none = harness({ findExisting: () => [], answer: () => null, route: { workerId: 'w-vantage', why: 'research' } });
    await none.door.onMessage({ channel: 'D0ACME', ts: '9.2', user: 'U1', text: 'what are competitors charging?', dm: true });
    expect(none.looked).toHaveLength(1);
    expect(none.asks[0].workerId).toBe('w-vantage');
  });

  it('says a room\'s answer plainly in Slack, or as it was when that fails', async () => {
    const asked = { id: 'm1', speaker: { kind: 'you' as const }, text: 'what is next', at: Date.now() + 60_000, exchange: 0 };
    const said = { id: 'm2', speaker: { kind: 'coordinator' as const }, text: 'C1 first. Agreed: C1.', at: Date.now() + 60_000, exchange: 0 };
    for (const [plain, want] of [[() => 'The MDF Programs pilot comes first.', 'The MDF Programs pilot comes first.'], [() => null, 'C1 first. Agreed: C1.']] as const) {
      const h = harness({ blocks: true, askTeam: true, plain, room: () => ({ messages: [asked, said], busy: null }), findExisting: () => [ROADMAP] });
      await h.door.onMessage({ channel: 'D0ACME', ts: '10.0', user: 'U1', text: 'whats the roadmap for q1 2027', dm: true });
      await h.door.onMessage({ channel: 'D0ACME', ts: '10.1', threadTs: '10.0', user: 'U1', text: 'what is next', dm: true });
      await h.door.poll();
      expect(h.posts.at(-1)).toContain(`[as Product Team] ${want}`);
    }
  });

  it('answers in a channel only from what everyone in it can see', async () => {
    const h = harness({ blocks: true, askTeam: true, findExisting: () => [], answer: () => null, route: { workerId: 'w-vantage', why: 'research' } });
    await h.door.onMessage({ channel: 'C0ACME', ts: '9.0', user: 'U1', text: 'whats next on the roadmap', dm: false });
    await h.door.onMessage({ channel: 'D0ACME', ts: '9.1', user: 'U1', text: 'whats next on the roadmap', dm: true });
    // The answer, then the lookup, for each: shared in the channel, not in the DM.
    expect(h.audiences).toEqual([true, true, false, false]);
  });

  it('offers to ask the team only to someone the room would take a question from', async () => {
    const h = harness({ blocks: true, askTeam: true, findExisting: () => [{ ...ROADMAP, canAsk: false }], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.0', user: 'U1', text: 'whats the roadmap for q1 2027', dm: true });
    expect((h.blocks[0].blocks[1] as { elements: Array<{ text: { text: string } }> }).elements.map((b) => b.text.text)).toEqual(['Open it', "That's not it"]);
    // "ask" typed anyway: not put to the room, which would refuse it.
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.1', threadTs: '8.0', user: 'U1', text: 'ask them about it', dm: true });
    expect(h.teamAsks).toEqual([]);
  });

  it('takes "thanks" in a room thread as the end of it, not another question', async () => {
    const h = harness({ blocks: true, askTeam: true, room: () => ({ messages: [] }), findExisting: () => [ROADMAP], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.0', user: 'U1', text: 'whats the roadmap for q1 2027', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.1', threadTs: '6.0', user: 'U1', text: 'what is the mobile app doing', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.2', threadTs: '6.0', user: 'U1', text: 'thanks!', dm: true });
    expect(h.teamAsks).toEqual([{ taskId: 't-1', text: 'what is the mobile app doing' }]);
    expect(h.posts.at(-1)).toContain('Glad it helped.');
    // "Yes" may answer the room: it still goes there.
    await h.door.onMessage({ channel: 'D0ACME', ts: '6.3', threadTs: '6.0', user: 'U1', text: 'yes', dm: true });
    expect(h.teamAsks.at(-1)).toEqual({ taskId: 't-1', text: 'yes' });
  });

  it('logs each conversation and what came of it', async () => {
    const h = harness({ blocks: true, askTeam: true, findExisting: () => [ROADMAP], answer: () => ({ text: 'Reporting first.', who: 'Product Team', hits: [ROADMAP], from: ['x'] }), route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '11.0', user: 'U1', text: 'whats next on the roadmap', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '12.0', user: 'U1', text: 'add an export button', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '11.1', threadTs: '11.0', user: 'U1', text: 'what about mobile?', dm: true });
    expect(h.state().log?.map((l) => [l.key, l.by, l.text, l.outcome])).toEqual([
      ['D0ACME:11.0', 'Pat', 'whats next on the roadmap', 'Asked Product Team'],
      ['D0ACME:12.0', 'Pat', 'add an export button', 'Triage has it'],
    ]);
    expect(h.state().log?.[0].url).toBe(ROADMAP.url);
    expect(h.state().log?.map((l) => [l.kind, l.who, l.team])).toEqual([
      ['handed', 'Product Team', true],
      ['handed', 'Triage', false],
    ]);
    expect(h.door.conversations()[0].key).toBe('D0ACME:11.0');
  });

  it('says who in the room is on the question', () => {
    const t0 = 1_000_000;
    const q = { id: 'q', speaker: { kind: 'you' as const }, text: 'what next', at: t0, exchange: 2 };
    const hugo = { id: 'h', speaker: { kind: 'member' as const, workerId: 'w-h', name: 'Hugo' }, text: 'Reporting.', at: t0 + 1, exchange: 2 };
    const at = t0 + 3 * 60_000;
    expect(roomStatus({ messages: [], queue: [{ text: 'what next', at: t0 }] }, 'what next', t0, 'Product Team', at)).toBe(':hourglass_flowing_sand: *Product Team* is on it · 3 min so far\n• Next in line: they\'re answering another question first');
    expect(roomStatus({ messages: [q], busy: { speaker: 'Hugo', since: t0 + 60_000 } }, 'what next', t0, 'Product Team', at)).toContain('• Hugo is answering · 2 min');
    expect(roomStatus({ messages: [q, hugo], busy: { speaker: 'Lena', since: at } }, 'what next', t0, 'Product Team', at)).toBe(':hourglass_flowing_sand: *Product Team* is on it · 3 min so far\n✓ Hugo answered\n• Lena is answering · 1 min');
    expect(roomStatus({ messages: [q, hugo], busy: { speaker: 'Hugo', since: at } }, 'what next', t0, 'Product Team', at)).toContain('• Hugo is responding');
    expect(roomStatus({ messages: [q, hugo], busy: { speaker: 'Coordinator', since: at } }, 'what next', t0, 'Product Team', at)).toContain('• Coordinator is summing up');
    // Done talking: the answer takes over.
    expect(roomStatus({ messages: [q, hugo], busy: null }, 'what next', t0, 'Product Team', at)).toBeNull();
  });

  it('never makes a question a team task', async () => {
    const PRODUCT: FrontDoorTeam = { id: 'team-product', name: 'Product Team', purpose: 'Roadmaps and plans', members: ['Hugo'] };
    const h = harness({ teams: [PRODUCT], route: { workerId: 'w-triage', why: 'x' } });
    await h.door.onMessage({ channel: 'D0ACME', ts: '8.0', user: 'U1', text: 'whats next on the roadmap?', dm: true });
    expect(h.candidates[0]).not.toContain('team:team-product');
    expect(h.briefs).toHaveLength(0);
  });

  it('lists recent related work for the router', () => {
    expect(routePrompt('whats the roadmap', [TRIAGE], [{ title: 'Q1 2027 roadmap', who: 'Product Team' }])).toContain('Recent work that may be related:\n- Q1 2027 roadmap — by Product Team');
    expect(routePrompt('whats the roadmap', [TRIAGE])).not.toContain('Recent work');
  });
});

describe('the front desk', () => {
  it('answers a question nobody fits itself, instead of asking who should take it', async () => {
    const h = harness({ route: null, general: () => 'Expense reports are due on the 5th.' });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.0', user: 'U1', text: 'when are expense reports due?', dm: false });
    await tick();
    expect(h.asks).toHaveLength(0);
    expect(h.desked).toEqual(['when are expense reports due?']);
    expect(h.posts.join('\n')).toContain('Expense reports are due on the 5th.');
    expect(h.posts.join('\n')).not.toContain('Who should take this?');
    expect(h.state().outcomes?.[Object.keys(h.state().outcomes ?? {})[0]]).toEqual({ answered: 1 });

    // More in the thread goes back to the desk; "hand it off" finds a worker.
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'and mileage?', dm: false });
    expect(h.desked).toEqual(['when are expense reports due?', 'and mileage?']);
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.2', threadTs: '1.0', user: 'U1', text: 'hand it off', dm: false });
    expect(h.desked).toHaveLength(2);
    expect(h.posts.at(-1)).toContain('Who should take this?');
  });

  it('never offers a team or a process for a question, and asks the person when the desk has nothing', async () => {
    const h = harness({ route: null, teams: [{ id: 'product', name: 'Product Team', purpose: 'Roadmap and PR/FAQs', members: ['Dana'] }], general: () => null });
    await h.door.onMessage({ channel: 'C0ACME', ts: '2.0', user: 'U1', text: 'what is our refund policy?', dm: false });
    await tick();
    expect(h.candidates[0]).toEqual(['w-triage', 'w-vantage']);
    expect(h.posts.join('\n')).toContain('Who should take this?');
    expect(h.posts.join('\n')).not.toContain('Product Team');
  });

  it('finds someone else when a worker says the request is not theirs', async () => {
    let picks = 0;
    const h = harness({ general: () => 'Ask HR; it is in the handbook.', replies: { 'w-triage': 'NOT_MINE: I fix bugs, not HR questions' } });
    const route = { workerId: 'w-triage', why: 'guess' };
    (h.door as unknown as { deps: { route: unknown } }).deps.route = async (_t: string, offered: FrontDoorWorker[]) => {
      picks++;
      return offered.some((w) => w.id === route.workerId) ? route : { workerId: 'w-vantage', why: 'next best' };
    };
    await h.door.onMessage({ channel: 'C0ACME', ts: '3.0', user: 'U1', text: 'set up my parental leave', dm: false });
    await tick();
    await tick();
    expect(h.asks.map((a) => a.workerId)).toEqual(['w-triage', 'w-vantage']);
    expect(h.posts.join('\n')).toContain("*Triage* says this isn't theirs (I fix bugs, not HR questions). Finding someone else…");
    expect(h.posts.join('\n')).not.toContain('NOT_MINE');
    // Only Vantage left: no model needed for the second pick.
    expect(picks).toBe(1);
    expect(h.asks[0].text).toContain('NOT_MINE:');
  });
});

describe('following a thread', () => {
  it('DMs whoever asked to be told when something is posted, until they stop', async () => {
    const h = harness({ dm: true, reply: 'Fixed in #412.', route: { workerId: 'w-triage', why: 'bugs' } });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.0', user: 'U1', text: 'the export button is broken', dm: false });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.1', threadTs: '1.0', user: 'U2', text: 'let me know when this is fixed', dm: false });
    expect(h.dms[0]).toMatchObject({ user: 'U2' });
    expect(h.dms[0].text).toContain("Will do: I'll DM you");
    expect(h.dms[0].text).toContain('https://acme.slack.example/archives/C0ACME/p10');
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.2', threadTs: '1.0', user: 'U1', text: 'it happens on Safari too', dm: false });
    await tick();
    expect(h.dms.at(-1)).toMatchObject({ user: 'U2' });
    expect(h.dms.at(-1)!.text).toContain('*Triage* posted in');
    expect(h.dms.at(-1)!.text).toContain('Fixed in #412.');
    expect(h.asks).toHaveLength(2);

    await h.door.onMessage({ channel: 'C0ACME', ts: '1.3', threadTs: '1.0', user: 'U2', text: 'unsubscribe', dm: false });
    expect(h.state().subs).toEqual([]);
    expect(h.dms.at(-1)!.text).toContain('Stopped.');
  });

  it('follows a thread and still passes on the request said with "ping me when"', async () => {
    const h = harness({ dm: true, reply: 'On it.', route: { workerId: 'w-triage', why: 'bugs' } });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.0', user: 'U1', text: 'the export button is broken', dm: false });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: "fix the Safari case and ping me when it's done", dm: false });
    expect(h.state().subs?.map((x) => x.user)).toEqual(['U1']);
    expect(h.asks.at(-1)?.text).toContain('fix the Safari case');
    expect(h.asks).toHaveLength(2);
    // A second sentence asks for more too.
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.2', threadTs: '1.0', user: 'U2', text: 'Let me know when it ships. Also check Firefox.', dm: false });
    expect(h.asks.at(-1)?.text).toContain('check Firefox');
    expect(h.state().subs?.map((x) => x.user)).toEqual(['U1', 'U2']);
  });

  it('takes "unsubscribe" inside a request as part of the request', async () => {
    const followed: string[] = [];
    const h = harness({
      dm: true,
      route: { workerId: 'w-triage', why: 'bugs' },
      follow: (item, on) => {
        followed.push(`${item}:${on}`);
        return { worker: 'Watcher', trigger: 'Ticket moves', everyMinutes: 15 };
      },
    });
    await h.door.onMessage({ channel: 'C0ACME', ts: '2.0', user: 'U1', text: 'the export button is broken', dm: false });
    await h.door.subscribe('C0ACME', '2.0', 'U1', true);
    await h.door.onMessage({ channel: 'C0ACME', ts: '2.1', threadTs: '2.0', user: 'U1', text: 'the unsubscribe link in ACME-412 is broken', dm: false });
    await h.door.onMessage({ channel: 'C0ACME', ts: '2.2', threadTs: '2.0', user: 'U1', text: 'the digest should stop tracking deleted users', dm: false });
    expect(followed).toEqual([]);
    expect(h.state().subs?.map((x) => x.user)).toEqual(['U1']);
    expect(h.asks.map((a) => a.text)).toEqual(expect.arrayContaining([expect.stringContaining('unsubscribe link'), expect.stringContaining('stop tracking deleted users')]));
  });

  it('leaves "keep me posted" in a DM to whoever is on it, with no ticket named', async () => {
    const h = harness({ dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'Triage, look at the export bug', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'keep me posted', dm: true });
    expect(h.asks.at(-1)?.text).toContain('keep me posted');
    expect(h.state().subs ?? []).toEqual([]);
  });

  it('follows the ticket the thread asked about, even said in passing after an offer', async () => {
    const followed: string[] = [];
    const hit = { kind: 'team', who: 'Product Team', title: 'Q1 roadmap', at: 0, teamTaskId: 'task-1' } as unknown as ExistingHit;
    const h = harness({
      findExisting: () => [hit],
      follow: (item, on) => {
        followed.push(`${item}:${on}`);
        return { worker: 'Watcher', trigger: 'Ticket moves', everyMinutes: 15 };
      },
      askTeam: true,
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'whats the status with acme-412', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: "thats it - can you let me know when the status changes?", dm: true });
    expect(followed).toEqual(['ACME-412:true']);
    expect(h.teamAsks).toEqual([]);
    expect(h.posts.at(-1)).toContain("Following *ACME-412*: I'll DM you when its status changes. Watcher's _Ticket moves_ checks every 15 min.");
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.2', threadTs: '1.0', user: 'U1', text: 'stop following ACME-412', dm: true });
    expect(followed).toEqual(['ACME-412:true', 'ACME-412:false']);
    expect(h.posts.at(-1)).toContain('Stopped. No more DMs about *ACME-412*.');
  });

  it('follows a ticket asked for as "remind me when … transitions", not handing it to a worker as a task', async () => {
    const followed: string[] = [];
    const h = harness({
      follow: (item, on) => {
        followed.push(`${item}:${on}`);
        return { worker: 'Watcher', trigger: 'Ticket moves', everyMinutes: 15 };
      },
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.0', user: 'U1', text: 'can you remind me when ACME-412 transitions', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '3.0', user: 'U1', text: 'give me a heads up once ACME-413 is done', dm: true });
    expect(followed).toEqual(['ACME-412:true', 'ACME-413:true']);
  });

  it('lists the threads someone follows, and drops one they stop following', async () => {
    const h = harness({});
    (h.door as unknown as { deps: { slack: { dm?: unknown } } }).deps.slack.dm = async () => true;
    await h.door.subscribe('C0ACME', '5.0', 'U1', true);
    expect(h.door.followedThreads('U1').map((t) => t.key)).toEqual(['C0ACME:5.0']);
    expect(h.door.followedThreads('U2')).toEqual([]);
    await h.door.subscribe('C0ACME', '5.0', 'U1', false);
    expect(h.door.followedThreads('U1')).toEqual([]);
  });

  it('says why it cannot follow a ticket', async () => {
    const h = harness({ follow: () => 'Nobody watches tickets for changes yet.' });
    await h.door.onMessage({ channel: 'C0ACME', ts: '1.0', user: 'U1', text: 'ping me when ACME-9 is done', dm: false });
    expect(h.posts).toEqual(['C0ACME@1.0: Nobody watches tickets for changes yet.']);
    expect(h.asks).toEqual([]);
  });
});

describe('the door\'s counts', () => {
  it('counts each person\'s messages and conversations per day', async () => {
    const h = harness({ reply: 'ok', now: () => Date.UTC(2026, 9, 22, 12) });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'Triage, fix the export', dm: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'and the import', dm: true });
    await h.door.onMessage({ channel: 'C0ACME', ts: '2.0', user: 'U2', text: 'Vantage, compare pricing', dm: false });
    await tick();
    expect(h.state().days).toEqual([
      { day: '2026-10-22', user: 'U1', by: 'Pat', messages: 2, started: 1, dm: 2 },
      { day: '2026-10-22', user: 'U2', by: 'Pat', messages: 1, started: 1, dm: 0 },
    ]);
    expect(h.state().outcomes).toEqual({ '2026-10-22': { handed: 2 } });
  });
});

describe('what am I following', () => {
  it('lists the tickets the person follows, or says how to follow one', async () => {
    const h = harness({ following: [{ item: 'ACME-412', status: 'In review', worker: 'Watcher' }] });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'what am I following?', dm: true });
    expect(h.posts[0]).toContain("You're following one ticket:\n• *ACME-412* — In review · Watcher watches it");
    expect(h.asks).toEqual([]);
    const none = harness({ following: [] });
    await none.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: "what's I following", dm: true });
    await none.door.onMessage({ channel: 'D0ACME', ts: '2.0', user: 'U1', text: 'my follows', dm: true });
    expect(none.posts.at(-1)).toContain("You're not following any tickets.");
  });
});

describe('following a ticket nothing watches yet', () => {
  it('sets a watch up with the worker on the thread, saying so while it does', async () => {
    const seen: Array<string | undefined> = [];
    const h = harness({
      reply: 'It is in progress.',
      follow: async (item, _on, workerId, say) => {
        seen.push(workerId);
        say?.(`Setting up a watch for *${item}* with Triage. It takes a minute.`);
        await tick();
        return { worker: 'Triage', trigger: 'Ticket changes (ACME)', everyMinutes: 15, status: 'In Progress', setUp: true };
      },
    });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'Triage, can you tell me about ACME-412', dm: true });
    await tick();
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'can you let me know if the status changes', dm: true });
    await tick();
    expect(seen).toEqual(['w-triage']);
    expect(h.posts.join('\n')).toContain('Setting up a watch for *ACME-412* with Triage.');
    expect(h.posts.at(-1)).toContain('Following *ACME-412* (now _In Progress_)');
    expect(h.posts.at(-1)).toContain("I set up _Ticket changes (ACME)_ on Triage");
  });
});

describe('a follow-up the worker is slow to answer', () => {
  it('hands the thread to another worker named in a reply, with the thread so far', async () => {
    const h = harness();
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.0', user: 'U1', text: 'Vantage, how does the old campaigns module work?', dm: true });
    await tick();
    expect(h.asks.at(-1)?.workerId).toBe(VANTAGE.id);
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.1', threadTs: '2.0', user: 'U1', text: 'Triage will need to scan the code', dm: true });
    await tick();
    expect(h.asks.at(-1)).toMatchObject({ workerId: TRIAGE.id, text: expect.stringContaining('brought you into this thread, after Vantage') });
    expect(h.posts.join('\n')).toContain('*Triage* has this');
    // And the thread is Triage's now.
    await h.door.onMessage({ channel: 'D0ACME', ts: '2.2', threadTs: '2.0', user: 'U1', text: 'focus on sending', dm: true });
    await tick();
    expect(h.asks.at(-1)?.workerId).toBe(TRIAGE.id);
  });

  it('says it is on it after a moment, rather than nothing', async () => {
    const h = harness({ slow: true });
    await h.door.onMessage({ channel: 'D0ACME', ts: '1.0', user: 'U1', text: 'Triage, look at the export bug', dm: true });
    await tick();
    vi.useFakeTimers();
    try {
      await h.door.onMessage({ channel: 'D0ACME', ts: '1.1', threadTs: '1.0', user: 'U1', text: 'you can look it up in the tracker right?', dm: true });
      const before = h.posts.length;
      await vi.advanceTimersByTimeAsync(9000);
      expect(h.posts.slice(before)).toEqual(['D0ACME@1.0: _Triage is on it…_']);
    } finally {
      vi.useRealTimers();
    }
  });
});
