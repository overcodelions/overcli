// Regression tests for the tool-call loop's generation bounds.
//
// The failure these pin down: with no `tools` on the wire the model gets no
// stop token at the tool-call boundary, so it emits a call, invents the
// result, emits the next call, and collapses into verbatim repetition —
// filling the context and applying edits derived from a fiction.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { streamChat, modelCapabilities } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  // Mocked so the suite never opens a socket to a local Ollama — the real
  // one POSTs /api/show.
  modelCapabilities: vi.fn(async () => new Set<string>()),
}));
vi.mock('./ollama', async (orig) => ({
  ...(await orig<typeof import('./ollama')>()),
  streamChat,
  modelCapabilities,
}));

import {
  buildOllamaToolSystemPrompt,
  resolveNativeTools,
  runOllamaToolLoop,
} from './ollamaTools';

/// Feed `chunks` as content tokens, honouring the abort signal the way the
/// real streamChat does — stop delivering once the caller aborts.
/// Defensive on its arguments: vitest invokes a lingering implementation
/// once with no arguments when a later test swaps it out, which would
/// otherwise throw inside the mock and mask the real assertion.
function respondWith(chunks: string[]) {
  return async (args?: any, onEvent?: (ev: any) => void) => {
    if (!args || !onEvent) return;
    for (const text of chunks) {
      if (args.signal?.aborted) return;
      onEvent({ type: 'token', text });
    }
    onEvent({ type: 'done', promptEvalCount: 10, evalCount: 5 });
  };
}

const CALL = (path: string) =>
  `{"name": "read_file", "arguments": {"path": "${path}"}}`;

describe('runOllamaToolLoop generation bounds', () => {
  // mockClear, not mockReset: reset strips the implementation each test
  // sets, leaving a no-op that gets invoked with no arguments.
  beforeEach(() => streamChat.mockClear());

  it('stops the round at the first complete tool call', async () => {
    // The model keeps going after call #1, as gemma4 did in the wild.
    const chunks = [CALL('a.ts'), ' ', CALL('b.ts'), ' ', CALL('c.ts')];
    streamChat.mockImplementation(respondWith(chunks));

    const events: any[] = [];
    const messages: any[] = [{ role: 'user', content: 'go' }];
    await runOllamaToolLoop(
      {
        model: 'm',
        cwd: process.cwd(),
        signal: new AbortController().signal,
        systemPrompt: 'sys',
        messages,
        turnStartIndex: 0,
        maxRounds: 1,
        enabledTools: new Set(['read_file']),
      },
      (ev) => events.push(ev),
    );

    const complete = events.filter((e) => e.type === 'roundComplete');
    // Exactly one call dispatched — the fabricated follow-ups are dropped.
    expect(complete[0].toolCalls).toHaveLength(1);
    expect(complete[0].toolCalls[0].arguments.path).toBe('a.ts');
    const results = events.filter((e) => e.type === 'toolResult');
    expect(results).toHaveLength(1);
  });

  it('does not mistake its own stop for a stream failure', async () => {
    streamChat.mockImplementation(respondWith([CALL('a.ts'), CALL('b.ts')]));
    const outcome = await runOllamaToolLoop(
      {
        model: 'm',
        cwd: process.cwd(),
        signal: new AbortController().signal,
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        turnStartIndex: 0,
        maxRounds: 1,
        enabledTools: new Set(['read_file']),
      },
      () => {},
    );
    // maxRounds: 1 means it runs out of rounds rather than erroring on abort.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('tool-call limit');
  });

  it('still reports a caller-driven abort as an error', async () => {
    const controller = new AbortController();
    streamChat.mockImplementation(async (_args?: any, onEvent?: (ev: any) => void) => {
      if (!onEvent) return;
      controller.abort();
      onEvent({ type: 'error', message: 'aborted' });
    });
    const outcome = await runOllamaToolLoop(
      {
        model: 'm',
        cwd: process.cwd(),
        signal: controller.signal,
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        turnStartIndex: 0,
        maxRounds: 3,
      },
      () => {},
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('aborted');
  });

  it('passes a num_predict ceiling so a runaway round cannot be unbounded', async () => {
    streamChat.mockImplementation(respondWith(['all done']));
    await runOllamaToolLoop(
      {
        model: 'm',
        cwd: process.cwd(),
        signal: new AbortController().signal,
        systemPrompt: '',
        messages: [{ role: 'user', content: 'go' }],
        turnStartIndex: 0,
        maxRounds: 1,
      },
      () => {},
    );
    // The bound lives in streamChat's defaults; assert the loop doesn't
    // override it away.
    expect(streamChat).toHaveBeenCalled();
    expect(streamChat.mock.calls[0][0].options).toBeUndefined();
  });
});

describe('native tool wiring', () => {
  beforeEach(() => {
    streamChat.mockClear();
    modelCapabilities.mockClear();
    streamChat.mockImplementation(respondWith(['all done']));
  });

  const run = (nativeTools?: any) =>
    runOllamaToolLoop(
      {
        model: 'gemma4:26b',
        cwd: process.cwd(),
        signal: new AbortController().signal,
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        turnStartIndex: 0,
        maxRounds: 1,
        nativeTools,
      },
      () => {},
    );

  it('forwards the resolved schemas onto the wire', async () => {
    const tools = await resolveNativeToolsWith(new Set(['completion', 'tools']), new Set(['read_file', 'grep']));
    await run(tools);
    const sent = streamChat.mock.calls[0][0].tools;
    expect(sent.map((t: any) => t.function.name).sort()).toEqual(['grep', 'read_file']);
  });

  it('sends no tools when the caller resolved none', async () => {
    await run(undefined);
    expect(streamChat.mock.calls[0][0].tools).toBeUndefined();
  });
});

async function resolveNativeToolsWith(caps: Set<string>, enabled?: Set<string>) {
  modelCapabilities.mockResolvedValue(caps);
  return resolveNativeTools('gemma4:26b', enabled);
}

describe('resolveNativeTools', () => {
  beforeEach(() => modelCapabilities.mockClear());

  it('returns the allowlisted schemas when the pulled model declares tool support', async () => {
    const tools = await resolveNativeToolsWith(
      new Set(['completion', 'tools', 'thinking']),
      new Set(['read_file', 'grep']),
    );
    expect(tools?.map((t) => t.function.name).sort()).toEqual(['grep', 'read_file']);
  });

  it('returns undefined when the model declares no tool support', async () => {
    expect(await resolveNativeToolsWith(new Set(['completion']), new Set(['read_file']))).toBeUndefined();
  });

  it('returns undefined when the probe fails, falling back to the in-prompt path', async () => {
    expect(await resolveNativeToolsWith(new Set(), undefined)).toBeUndefined();
  });

  it('returns undefined when the allowlist excludes every tool', async () => {
    expect(await resolveNativeToolsWith(new Set(['tools']), new Set(['nonexistent']))).toBeUndefined();
  });
});

// The regression this pins: teaching a text call-format while the model's
// own template is driving tool calls makes gemma4 render our shape with its
// control-token vocabulary — `{"name":<|"|>grep<|"|>, …}`, which never
// parses, so no tool is ever dispatched.
describe('system prompt matches the active protocol', () => {
  it('teaches no text format when native tools are on', () => {
    const prompt = buildOllamaToolSystemPrompt('/proj', new Set(['read_file', 'grep']), {
      nativeTools: true,
    });
    expect(prompt).not.toContain('<tool_call>');
    expect(prompt).not.toContain('WORKED EXAMPLES');
    // The behavioural rules still earn their place.
    expect(prompt).toContain('Never fabricate');
    expect(prompt).toContain('/proj');
  });

  it('still teaches the wrapper format when falling back to the in-prompt path', () => {
    const prompt = buildOllamaToolSystemPrompt('/proj', new Set(['read_file']), {
      nativeTools: false,
    });
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain('WORKED EXAMPLES');
  });

  it('defaults to the in-prompt path when no mode is given', () => {
    expect(buildOllamaToolSystemPrompt('/proj')).toContain('<tool_call>');
  });
});
