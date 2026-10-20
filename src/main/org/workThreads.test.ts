import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { WorkerJournalEntry } from '../../shared/flows/worker';
import type { AskRecord } from './orgStores';
import { askedWords, buildThreads, nowLine, summarize, type ThreadInputs } from './workThreads';

const NOW = 10_000_000;
const steps = [{ id: 'capture' }, { id: 'compare' }];

const run = (id: string, state: FlowRun['state'], at: number, extra: Partial<FlowRun> = {}): FlowRun =>
  ({ id, workerId: 'w', flowSnapshot: { name: 'Pricing check', steps }, userPrompt: 'Acme pricing snapshot', title: 'Acme pricing snapshot', state, createdAt: at, attempts: [], artifacts: {}, ...extra }) as unknown as FlowRun;

const batch = (id: string, at: number, items: Array<{ id: string; status: string; runId?: string }>, task: 'shift' | 'errand' = 'shift', errand?: string): Orchestration =>
  ({
    id,
    createdAt: at,
    title: 'b',
    origin: { kind: 'worker', workerId: 'w', workerName: 'Marta', task, ...(errand ? { errand } : {}) },
    producer: { prompt: 'p', reply: 'I will snapshot Acme. <candidates>[]</candidates>' },
    items: items.map((i) => ({ candidate: { id: i.id, title: 'Acme pricing snapshot', prompt: 'x', note: 'One page.' }, status: i.status, ...(i.runId ? { runId: i.runId } : {}) })),
  }) as unknown as Orchestration;

const ask = (extra: Partial<AskRecord>): AskRecord => ({ id: 'a1', workerId: 'w', workerName: 'Marta', by: 'Pat', text: 'what does acme charge?', at: 1_000, status: 'answered', via: 'console', ...extra });

const shift = (extra: Partial<WorkerJournalEntry>): WorkerJournalEntry => ({ id: 'shift-w-1', workerId: 'w', kind: 'shift', at: 2_000, title: 'Shift 1', ...extra });

const input = (extra: Partial<ThreadInputs>): ThreadInputs => ({ workerName: 'Marta', asks: [], journal: [], batches: [], runs: [], filed: new Map(), planning: null, now: NOW, ...extra });

describe('work threads', () => {
  it('shows a question being worked on as deciding, and says so up top', () => {
    const t = buildThreads(input({ asks: [ask({ status: 'working', reply: undefined })] }));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'ask', stage: 'deciding', prompt: 'what does acme charge?', by: 'Pat' });
    expect(t[0].progress[0]).toMatchObject({ state: 'now' });
    expect(nowLine(t, 'Marta')?.sentence).toBe('Marta is working out how to answer “what does acme charge?”.');
  });

  it('keeps work a question handed off before its reply came back on that question, not as an errand of its own', () => {
    const errand = 'what does acme charge?\n\nYour reply is posted back in that Slack thread for you, so answer here.';
    const threads = buildThreads(input({ asks: [ask({ status: 'working', via: 'slack' })], batches: [batch('b1', 1_500, [{ id: 'c1', status: 'running', runId: 'r1' }], 'errand', errand)], runs: [run('r1', { kind: 'running', currentStepId: 's1' } as FlowRun['state'], 1_600)] }));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: 'ask:a1', prompt: 'what does acme charge?', stage: 'deciding' });
    expect(threads[0].runs.map((r) => r.runId)).toEqual(['r1']);
  });

  it('never gives a question the work a later reply in its Slack thread started', () => {
    const first = ask({ id: 'a1', text: 'who is our biggest competitor', via: 'slack', at: 1_000, doneAt: 1_500 });
    const second = ask({ id: 'a2', text: 'Add Introw to the weekly check too', via: 'slack', at: 2_000, doneAt: 2_600, orchestrationId: 'b2' });
    const own = batch('b1', 1_100, [], 'errand', 'who is our biggest competitor\n\nYour reply is posted back in that Slack thread for you.');
    const later = batch('b2', 2_100, [{ id: 'c1', status: 'running', runId: 'r1' }], 'errand', 'Add Introw to the weekly check too\n\nThe Slack thread this came from, oldest first:\n<@U1>: who is our biggest competitor');
    const threads = buildThreads(input({ asks: [first, second], batches: [own, later], runs: [run('r1', { kind: 'running', currentStepId: 's1' } as FlowRun['state'], 2_200)] }));
    expect(threads.map((t) => t.id).sort()).toEqual(['ask:a1', 'ask:a2']);
    expect(threads.find((t) => t.id === 'ask:a1')!.runs).toEqual([]);
    expect(threads.find((t) => t.id === 'ask:a2')!.runs.map((r) => r.runId)).toEqual(['r1']);
  });

  it('finds the errand of a turn overcli asked for itself by its prompt, so it hangs on its question', () => {
    const asked = ask({ id: 'a1', text: 'Add Introw to the weekly check too', at: 1_000, doneAt: 1_500 });
    const finishing = ask({ id: 'a2', text: 'Finishing up now that "Introw baseline" is done', prompt: 'The work you handed off for Pat\'s request has finished: Introw baseline.', replyTo: 'ask:a1', at: 5_000, doneAt: 5_400 });
    const own = batch('b2', 5_100, [], 'errand', 'The work you handed off for Pat\'s request has finished: Introw baseline.');
    const threads = buildThreads(input({ asks: [asked, finishing], batches: [own] }));
    expect(threads.map((t) => t.id)).toEqual(['ask:a1']);
    expect(threads[0].followUps?.map((f) => f.id)).toEqual(['ask:a2']);
  });

  it('shows a question asked in Slack as typed, not as Slack’s link markup', () => {
    const threads = buildThreads(input({ asks: [ask({ text: 'audit <http://northwind.example|northwind.example> and <https://acme.example>' })] }));
    expect(threads[0].prompt).toBe('audit northwind.example and https://acme.example');
  });

  it('titles work no question covers by what was asked, not the directions sent with it', () => {
    expect(askedWords('who is our biggest competitor\n\nYour reply is posted back in that Slack thread for you, so answer here.')).toBe('who is our biggest competitor');
    expect(askedWords('More from Pat on the same request:\nand Introw\n\nThe Slack thread this came from, oldest first:\n<@U1>: hi')).toBe('and Introw');
  });

  it('joins a question to what it proposed, and asks for the OK in plain words', () => {
    const t = buildThreads(input({ asks: [ask({ doneAt: 9_000, reply: 'I need my snapshot flow for that.', orchestrationId: 'b1' })], batches: [batch('b1', 8_000, [{ id: 'c1', status: 'proposed' }], 'errand')] }));
    expect(t).toHaveLength(1);
    expect(t[0].stage).toBe('waiting');
    expect(t[0].headline).toBe('Marta wants to run “Acme pricing snapshot”. OK?');
    expect(t[0].proposal).toMatchObject({ batchId: 'b1', waiting: true, items: [{ candidateId: 'c1', status: 'waiting', detail: 'One page.' }] });
    expect(t[0].progress.map((p) => [p.label, p.state])).toEqual([
      ['Marta decided', 'done'],
      ['Your OK', 'need'],
      ['Run', 'next'],
      ['Answer', 'next'],
    ]);
  });

  it('finds the batch for a question asked before asks recorded it, by its words and time', () => {
    const t = buildThreads(input({ asks: [ask({ doneAt: 9_000, reply: 'Sending it out.' })], batches: [batch('b1', 8_500, [{ id: 'c1', status: 'proposed' }], 'errand', 'what does acme charge?')] }));
    expect(t).toHaveLength(1);
    expect(t[0].proposal?.batchId).toBe('b1');
  });

  it('follows Run now through approval to the run, step by step', () => {
    const r = run('r1', { kind: 'running', currentStepId: 'compare' } as FlowRun['state'], 3_000, {
      attempts: [{ stepId: 'capture', startedAt: 3_000, endedAt: 51_000, conversationId: 'c' }] as FlowRun['attempts'],
      costUSD: 0.15,
    });
    const t = buildThreads(
      input({
        journal: [shift({ manual: true, orchestrationId: 'b1' }), { id: 'ap', workerId: 'w', kind: 'approved', at: 2_500, title: 'x', orchestrationId: 'b1' }],
        batches: [batch('b1', 1_500, [{ id: 'c1', status: 'running', runId: 'r1' }])],
        runs: [r],
        runNow: [{ at: 2_000, by: 'Pat' }],
      }),
    );
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: 'runNow', prompt: 'Run now', by: 'Pat', stage: 'running', at: 1_500, costUSD: 0.15 });
    expect(t[0].headline).toBe('Compare: step 2 of 2 of “Acme pricing snapshot”.');
    expect(t[0].runs[0].steps.map((s) => [s.label, s.state, s.tookMs])).toEqual([
      ['Capture', 'done', 48_000],
      ['Compare', 'now', undefined],
    ]);
    expect(t[0].progress.map((p) => p.state)).toEqual(['done', 'done', 'now', 'next']);
    expect(nowLine(t, 'Marta')).toMatchObject({ sentence: 'Marta is on step 2 of 2, compare, of “Acme pricing snapshot” because of Run now.', threadId: 'shift:shift-w-1', since: 3_000 });
  });

  it('leads a finished thread with what it found', () => {
    const r = run('r1', { kind: 'done', success: true } as FlowRun['state'], 3_000, {
      attempts: [{ stepId: 'compare', startedAt: 3_000, endedAt: 123_000, conversationId: 'c' }] as FlowRun['attempts'],
      artifacts: { 'update.md': { name: 'update.md', kind: 'text', body: '# Acme — this week\n\n**Pricing:**\n\nAcme doesn’t publish prices. The pricing page is a 404.', producedByStepId: 'compare', producedAt: 120_000 } } as unknown as FlowRun['artifacts'],
    });
    const t = buildThreads(input({ journal: [shift({ orchestrationId: 'b1' })], batches: [batch('b1', 1_500, [{ id: 'c1', status: 'done', runId: 'r1' }])], runs: [r], filed: new Map([['r1', { entryId: 'e1', title: 'Acme pricing snapshot' }]]) }));
    expect(t[0].stage).toBe('done');
    expect(t[0].source).toBe('schedule');
    expect(t[0].headline).toBe('Acme doesn’t publish prices.');
    expect(t[0].runs[0]).toMatchObject({ summary: 'Acme doesn’t publish prices. The pricing page is a 404.', entryId: 'e1', result: { name: 'update.md' } });
    expect(nowLine(t, 'Marta')).toBeNull();
  });

  it('prefers the line the run filed in the journal when it says more than the title', () => {
    const r = run('r1', { kind: 'done', success: true } as FlowRun['state'], 3_000);
    const t = buildThreads(input({ runs: [r], filed: new Map([['r1', { entryId: 'e1', title: 'Acme hides its prices behind a form' }]]) }));
    expect(t[0]).toMatchObject({ source: 'run', stage: 'done', headline: 'Acme hides its prices behind a form' });
  });

  it('says a check that found nothing in plain words, with its reasoning kept for Why', () => {
    const t = buildThreads(input({ journal: [shift({ note: 'Nothing worth proposing this shift.', orchestrationId: 'b0' })], batches: [batch('b0', 1_900, [])] }));
    expect(t[0]).toMatchObject({ stage: 'nothing', headline: 'Looked, and found nothing new worth doing.', reply: { text: 'I will snapshot Acme.' } });
  });

  it('shows a shift still deciding before it has a journal line', () => {
    const t = buildThreads(input({ planning: { since: 5_000, task: 'shift', manual: true } }));
    expect(t[0]).toMatchObject({ id: 'deciding', source: 'runNow', stage: 'deciding', headline: 'Marta is deciding what to work on.' });
    expect(nowLine(t, 'Marta')?.sentence).toMatch(/^Marta is deciding what to work on because of Run now/);
  });

  it('marks work that was skipped, and a stop older than a day is not "now"', () => {
    const stopped = run('r9', { kind: 'paused', nextStepId: 'compare', reason: 'interrupted' } as FlowRun['state'], NOW - 2 * 86_400_000);
    const t = buildThreads(input({ journal: [shift({ orchestrationId: 'b1' })], batches: [batch('b1', 1_500, [{ id: 'c1', status: 'cancelled' }])], runs: [stopped] }));
    const skipped = t.find((x) => x.id === 'shift:shift-w-1')!;
    expect(skipped).toMatchObject({ stage: 'declined', headline: 'You skipped “Acme pricing snapshot”.' });
    const old = t.find((x) => x.id === 'run:r9')!;
    expect(old.stage).toBe('stopped');
    expect(old.runs[0].steps[1].state).toBe('failed');
    expect(nowLine(t, 'Marta', NOW)).toBeNull();
  });

  it('never lists a run twice', () => {
    const r = run('r1', { kind: 'done', success: true } as FlowRun['state'], 3_000);
    const t = buildThreads(
      input({
        asks: [ask({ doneAt: 9_000, orchestrationId: 'b1' })],
        journal: [shift({ orchestrationId: 'b1' })],
        batches: [batch('b1', 8_000, [{ id: 'c1', status: 'done', runId: 'r1' }], 'errand')],
        runs: [r],
      }),
    );
    expect(t.flatMap((x) => x.runs.map((y) => y.runId))).toEqual(['r1']);
  });
});

describe('replies in a thread', () => {
  it('hangs a reply on its thread, takes its outcome, and moves the thread to now', () => {
    const t = buildThreads(
      input({
        asks: [
          ask({ id: 'a1', at: 1_000, doneAt: 2_000, reply: 'Introw is a co-selling tool. Want me to track it?\n<replies><reply>Yes, track Introw</reply><reply>No thanks</reply></replies>' }),
          ask({ id: 'a2', at: 5_000, text: 'Yes, track Introw', status: 'working', replyTo: 'ask:a1', reply: undefined }),
        ],
        journal: [shift({ at: 3_000, note: 'Nothing worth proposing this shift.' })],
      }),
    );
    expect(t.map((x) => x.id)).toEqual(['ask:a1', 'shift:shift-w-1']);
    const [thread] = t;
    expect(thread).toMatchObject({ stage: 'deciding', selfStage: 'answered', lastAt: 5_000, choices: ['Yes, track Introw', 'No thanks'] });
    expect(thread.reply?.text).toBe('Introw is a co-selling tool. Want me to track it?');
    expect(thread.followUps?.map((f) => [f.id, f.prompt, f.stage])).toEqual([['ask:a2', 'Yes, track Introw', 'deciding']]);
    expect(nowLine(t, 'Marta')).toMatchObject({ threadId: 'ask:a2' });
  });

  it('keeps a reply to a reply in the same thread, and its work with it', () => {
    const t = buildThreads(
      input({
        asks: [ask({ id: 'a1', at: 1_000, doneAt: 2_000, reply: 'ok' }), ask({ id: 'a2', at: 3_000, doneAt: 4_000, reply: 'sure', replyTo: 'ask:a1' }), ask({ id: 'a3', at: 5_000, doneAt: 6_000, reply: 'On it.', replyTo: 'ask:a2', orchestrationId: 'b1' })],
        batches: [batch('b1', 5_500, [{ id: 'c1', status: 'proposed' }], 'errand')],
      }),
    );
    expect(t).toHaveLength(1);
    expect(t[0].followUps?.map((f) => f.id)).toEqual(['ask:a2', 'ask:a3']);
    expect(t[0]).toMatchObject({ stage: 'waiting', headline: 'Marta wants to run “Acme pricing snapshot”. OK?' });
  });

  it('stands a reply alone when its thread is gone', () => {
    const t = buildThreads(input({ asks: [ask({ id: 'a2', replyTo: 'ask:gone', reply: 'hi', doneAt: 2_000 })] }));
    expect(t.map((x) => x.id)).toEqual(['ask:a2']);
  });
});

describe('summarize', () => {
  it('skips headings, rules and labels, and takes the markdown off', () => {
    expect(summarize('# Title\n\n---\n**Findings:**\n- Prices are **up 10%**, see [the page](https://acme.test).\n- Second point')).toBe('Prices are up 10%, see the page. Second point');
  });
});
