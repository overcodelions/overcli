// A safe fetch whose name is refused at the lookup: the card first went out
// marked allowed and stayed that way, though the call was refused.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import { setLookup, setSafeFetch } from '../safeFetch';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'run-fetch' as UUID;

function harness() {
  const emitted: MainToRendererEvent[] = [];
  const answers: Array<[string, boolean]> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    respondPermission: (_c: string, requestId: string, approved: boolean) => answers.push([requestId, approved]),
  };
  const rt = new FlowRuntimeImpl(runner as never, (e) => emitted.push(e), () => [], () => ({ backends: {} }) as unknown as AppSettings);
  const r = {
    id: RUN_ID,
    flowId: 'f',
    flowSnapshot: { id: 'f', name: 'F', input: 'user_prompt', participants: [], steps: [], source: 'user', filePath: '/tmp/f.yaml' },
    projectPath: '/tmp/does-not-matter',
    userPrompt: 'read https://rebind.example/page and https://vendor.example/docs',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'running', currentStepId: 's' },
    createdAt: Date.now(),
    attempts: [],
  } as unknown as FlowRun;
  (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  (rt as never as { convIdToRun: Map<UUID, UUID> }).convIdToRun.set('conv-1' as UUID, RUN_ID);
  const ask = (requestId: string, url: string) => {
    const ev = { id: `ev-${requestId}`, timestamp: Date.now(), kind: { type: 'permissionRequest', info: { requestId, toolName: 'WebFetch', description: '', toolInput: { url } } } };
    rt.observeEvent({ type: 'stream', conversationId: 'conv-1' as UUID, events: [ev as never] });
    return ev.kind.info as { decided?: string; decisionNote?: string };
  };
  return { emitted, answers, ask };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('a safe fetch refused at the lookup', () => {
  afterEach(() => {
    setSafeFetch(null);
    setLookup(null);
  });

  it('sends the card again with the settled decision', async () => {
    setSafeFetch({ mode: () => 'safe', ownDomains: () => [] });
    setLookup(async (host) => ({ 'rebind.example': ['10.0.0.5'], 'vendor.example': ['93.184.216.34'] })[host] ?? []);
    const h = harness();

    const refused = h.ask('r-in', 'https://rebind.example/page');
    const allowed = h.ask('r-out', 'https://vendor.example/docs');
    await flush();

    expect(h.answers).toEqual([['r-in', false], ['r-out', true]]);
    expect(refused.decided).toBe('deny');
    expect(refused.decisionNote).toMatch(/^Refused: rebind\.example points at 10\.0\.0\.5/);
    expect(allowed.decided).toBe('allow');
    expect(allowed.decisionNote).not.toMatch(/once its name resolves/);
    const resent = h.emitted.flatMap((e) => (e.type === 'stream' ? e.events.map((x) => x.id) : []));
    expect(resent).toEqual(['ev-r-in', 'ev-r-out']);
  });
});
