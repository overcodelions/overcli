import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../shared/types';
import type { ErrandProgress } from '../org/orgService';
import { FrontDoor, namedWorker, rankByWords, toSlack, type FrontDoorState, type FrontDoorTeam, type FrontDoorWorker } from './frontDoor';
import { readRoute, routePrompt } from './frontDoorRoute';
import type { SlackMessage } from './slackApi';

const tick = () => new Promise((r) => setTimeout(r, 0));

const TRIAGE: FrontDoorWorker = { id: 'w-triage', name: 'Triage', tagline: 'Fixes product bugs', job: 'Reproduce bugs in the web app, fix them, and open a pull request with tests.' };
const VANTAGE: FrontDoorWorker = { id: 'w-vantage', name: 'Vantage', tagline: 'Competitive analyst', job: 'Research competitors and write competitive analysis reports on features, pricing and positioning.' };

function harness(opts: { workers?: FrontDoorWorker[]; reply?: string; proposed?: number; orchestrationId?: string; route?: { workerId: string; why: string } | null; thread?: SlackMessage[]; progress?: ErrandProgress | null; owner?: string; workerFile?: (id: string, p: string) => Buffer | null; teams?: FrontDoorTeam[]; recent?: SlackMessage[]; handBack?: (askId: string) => { done: Promise<{ ok: true; reply: string } | { ok: false; error: string }> } | null } = {}) {
  const posts: string[] = [];
  const briefs: Array<{ teamId: string; brief: string }> = [];
  const uploads: string[] = [];
  const edits: Array<{ ts: string; text: string }> = [];
  let statusN = 0;
  const asks: Array<{ workerId: string; text: string; attachments: Attachment[]; conversation?: string; said?: string }> = [];
  let routed = 0;
  let progress: ErrandProgress | null = opts.progress ?? null;
  let state: FrontDoorState = { threads: [], follows: [] };
  const door = new FrontDoor({
    ...(opts.owner ? { mayAsk: (id: string) => (id === opts.owner ? (true as const) : 'Only my owner can ask.') } : {}),
    caller: async (id) => ({ slackUserId: id, name: 'Pat', admin: false }),
    workers: () => opts.workers ?? [TRIAGE, VANTAGE],
    ...(opts.teams
      ? {
          teams: () => opts.teams!,
          briefTeam: (_c: unknown, teamId: string, brief: string) => {
            briefs.push({ teamId, brief });
            return { ok: true as const };
          },
        }
      : {}),
    ask: (_c, workerId, text, attachments, conversation, said) => {
      asks.push({ workerId, text, attachments, conversation, said });
      return { ok: true, done: Promise.resolve({ ok: true as const, reply: opts.reply ?? 'On it.', askId: 'ask-1', ...(opts.proposed ? { proposed: opts.proposed } : {}), ...(opts.orchestrationId ? { orchestrationId: opts.orchestrationId } : {}) }) };
    },
    ...(opts.handBack ? { handBack: opts.handBack } : {}),
    progress: () => progress,
    route: async () => {
      routed++;
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
    },
    libraryUrl: () => 'https://overcli.acme.example',
    readFile: () => Buffer.from('<html>report</html>'),
    ...(opts.workerFile ? { workerFile: opts.workerFile } : {}),
    store: { load: () => structuredClone(state), save: (s) => (state = structuredClone(s)) },
    log: () => {},
  });
  return { door, posts, uploads, edits, asks, briefs, routed: () => routed, setProgress: (p: ErrandProgress) => (progress = p), state: () => state };
}

describe('the front door', () => {
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

  it('attaches a long answer whole and keeps the message short', async () => {
    const h = harness({ reply: 'x'.repeat(5000) });
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
