import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));
vi.mock('../health', () => ({
  probeBackendHealth: vi.fn(async () => ({ kind: 'ready' })),
  healthyBackends: vi.fn(async () => new Set(['claude'])),
}));
vi.mock('../diagnostics', () => ({ log: vi.fn() }));

import { parseRoute, routeErrand, routePrompt } from './workerRouter';
import type { DraftDeps } from './drafter';
import type { Worker } from '../../shared/flows/worker';
import { tierDefault } from '../../shared/modelCatalog';

const crew = [
  { id: 'w1', name: 'Soraya', tagline: 'watches your upcoming trips', jobDescription: 'Plan trips, find booking gaps.', enabled: true },
  { id: 'w2', name: 'Triage', tagline: 'ticket triage', jobDescription: 'Fix tickets end to end.', enabled: true },
  { id: 'w3', name: 'Bench', tagline: '', jobDescription: 'Paused.', enabled: false },
] as unknown as Worker[];

const deps = {
  settings: { preferredBackend: 'claude', disabledBackends: {}, backendPaths: {}, claudeTransport: 'sdk' },
  runner: {},
} as unknown as DraftDeps;

function reply(text: string) {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    yield { type: 'result' };
  })();
}

describe('parseRoute', () => {
  it('resolves the named worker, case aside', () => {
    expect(parseRoute('<route>{"worker":"soraya","sure":true,"why":"travel"}</route>', crew)).toEqual({
      workerId: 'w1',
      why: 'travel',
      confident: true,
    });
    // Unsure, or silent about it, means ask first.
    expect(parseRoute('<route>{"worker":"soraya","why":"travel"}</route>', crew)?.confident).toBe(false);
  });

  it('treats null, or a name not on the crew, as nobody', () => {
    expect(parseRoute('<route>{"worker":null,"sure":true,"why":"no fit"}</route>', crew)).toEqual({
      workerId: null,
      why: 'no fit',
      confident: false,
    });
    expect(parseRoute('<route>{"worker":"Sorayah","why":"x"}</route>', crew)?.workerId).toBeNull();
  });

  it('is null for a reply with no pick in it', () => {
    expect(parseRoute('I think Soraya.', crew)).toBeNull();
  });
});

describe('routeErrand', () => {
  beforeEach(() => mockQuery.mockReset());

  it('asks the fast model to pick among the active crew only', async () => {
    mockQuery.mockReturnValueOnce(reply('<route>{"worker":"Triage","why":"a ticket"}</route>'));
    const res = await routeErrand('Fix WOW-1', crew, deps);
    expect(res).toEqual({ ok: true, workerId: 'w2', why: 'a ticket', confident: false });
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.systemPrompt).toContain('- Soraya (watches your upcoming trips)');
    expect(call.options.systemPrompt).not.toContain('Bench');
    // Whatever the catalog calls fast — a lookup, not a design.
    expect(call.options.model).toBe(tierDefault('claude', 'fast'));
  });

  it('skips the model when only one worker is on duty', async () => {
    const res = await routeErrand('anything', [crew[0], crew[2]], deps);
    expect(res).toMatchObject({ ok: true, workerId: 'w1', confident: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('says nobody when the model finds no fit', async () => {
    mockQuery.mockReturnValueOnce(reply('<route>{"worker":null,"why":"no one does taxes"}</route>'));
    expect(await routeErrand('Do my taxes', crew, deps)).toEqual({
      ok: true,
      workerId: null,
      why: 'no one does taxes',
      confident: false,
    });
  });

  it('keeps the whole prompt readable', () => {
    expect(routePrompt(crew)).toContain('<route>');
  });
});
