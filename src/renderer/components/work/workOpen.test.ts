import { describe, expect, it } from 'vitest';

import type { FlowRun } from '@shared/flows/schema';
import type { WorkRecord } from '@shared/workRecords';
import { alternateTarget, liveness, primaryTarget } from './workOpen';

function record(p: Partial<WorkRecord>): WorkRecord {
  return {
    key: 'k',
    kind: 'chat',
    title: 't',
    placePath: '/p',
    placeName: 'p',
    startedAt: 1,
    updatedAt: 2,
    status: 'chat',
    runs: [],
    chats: [],
    jobs: [],
    repoBranches: [],
    repoGit: [],
    body: '',
    ...p,
  };
}

const run = (id: string, kind: string, extra: Record<string, unknown> = {}, createdAt = Date.now()) =>
  ({ id, state: { kind, ...extra }, createdAt, attempts: [] }) as unknown as FlowRun;
const part = (id: string, at = 1) => ({ id, flowName: 'F', title: 't', at, retained: true, live: false });
const chat = (id: string, at = 1) => ({ id, name: 'c', at, archived: false });
const none = new Set<string>();

describe('liveness', () => {
  it('a paused run needs you, ahead of anything running', () => {
    const r = record({ runs: [part('a'), part('b')], chats: [chat('c')] });
    const runs = { a: run('a', 'running'), b: run('b', 'paused') };
    expect(liveness(r, runs, new Set(['c']))).toEqual({ state: 'needs-you', target: { type: 'run', id: 'b' } });
  });

  it('a run you paused, or one left for weeks, is paused — not waiting on you', () => {
    const r = record({ runs: [part('a')] });
    expect(liveness(r, { a: run('a', 'paused', { reason: 'held' }) }, none).state).toBe('paused');
    const stale = run('a', 'paused', { reason: 'preStep' }, Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(liveness(r, { a: stale }, none).state).toBe('paused');
  });

  it('a streaming chat is running', () => {
    const r = record({ chats: [chat('c')] });
    expect(liveness(r, {}, new Set(['c']))).toEqual({ state: 'running', target: { type: 'chat', id: 'c' } });
  });

  it('a finished run whose step is answering you is running', () => {
    const r = record({ runs: [part('a')] });
    const done = run('a', 'done', {});
    (done as unknown as { conversationIds: Record<string, string> }).conversationIds = { planner: 'pc' };
    expect(liveness(r, { a: done }, new Set(['pc']))).toEqual({ state: 'running', target: { type: 'run', id: 'a' } });
  });

  it('finished work is not live', () => {
    const r = record({ runs: [part('a')] });
    expect(liveness(r, { a: run('a', 'done') }, none).state).toBeNull();
  });
});

describe('primaryTarget', () => {
  it('opens the live part of a many-part record', () => {
    const r = record({ runs: [part('a')], chats: [chat('c'), chat('d')], pr: { number: 1, url: 'u', state: 'OPEN', title: 't', headRefName: 'b' } });
    const live = liveness(r, {}, new Set(['d']));
    expect(primaryTarget(r, live, {})).toEqual({ type: 'chat', id: 'd' });
  });

  it('opens a lone chat, and a lone run the app still keeps', () => {
    expect(primaryTarget(record({ chats: [chat('c')] }), { state: null }, {})).toEqual({ type: 'chat', id: 'c' });
    const runs = { a: run('a', 'done') };
    expect(primaryTarget(record({ runs: [part('a')] }), { state: null }, runs)).toEqual({ type: 'run', id: 'a' });
  });

  it('sends several parts, a PR, a batch or an evicted run to the record page', () => {
    expect(primaryTarget(record({ chats: [chat('c'), chat('d')] }), { state: null }, {})).toEqual({ type: 'record' });
    expect(primaryTarget(record({ runs: [part('gone')] }), { state: null }, {})).toEqual({ type: 'record' });
    const withPr = record({ chats: [chat('c')], pr: { number: 1, url: 'u', state: 'MERGED', title: 't', headRefName: 'b' } });
    expect(primaryTarget(withPr, { state: null }, {})).toEqual({ type: 'record' });
    const batch = record({ runs: [part('a')], jobs: [{ orchestrationId: 'o', title: 'b' }] });
    expect(primaryTarget(batch, { state: null }, { a: run('a', 'done') })).toEqual({ type: 'record' });
  });
});

describe('a team task', () => {
  it('opens the team desk on the task, live or not', () => {
    const r = record({ runs: [part('a')], jobs: [{ orchestrationId: 'o', title: 'b' }], team: { teamId: 't', teamName: 'T', taskId: 'k' } });
    const live = liveness(r, { a: run('a', 'running') }, new Set());
    expect(primaryTarget(r, live, { a: run('a', 'running') })).toEqual({ type: 'team', teamId: 't', taskId: 'k' });
    expect(alternateTarget(r, { type: 'team', teamId: 't', taskId: 'k' }, {})).toEqual({ type: 'record' });
  });
});

describe('alternateTarget', () => {
  it('is the record page when the click goes straight in', () => {
    expect(alternateTarget(record({ chats: [chat('c')] }), { type: 'chat', id: 'c' }, {})).toEqual({ type: 'record' });
  });

  it('is the newest openable part when the click goes to the record page', () => {
    const r = record({ chats: [chat('old', 1), chat('new', 5)], runs: [part('gone', 9)] });
    expect(alternateTarget(r, { type: 'record' }, {})).toEqual({ type: 'chat', id: 'new' });
  });
});

describe('the stall clock counts your side', () => {
  it('a run started weeks ago that you talked to today still needs you', () => {
    const r = record({ runs: [part('a')] });
    const old = run('a', 'paused', { reason: 'preStep' }, Date.now() - 20 * 24 * 60 * 60 * 1000);
    expect(liveness(r, { a: old }, none).state).toBe('paused');
    expect(liveness(r, { a: old }, none, Date.now(), () => Date.now() - 60_000).state).toBe('needs-you');
  });
});
