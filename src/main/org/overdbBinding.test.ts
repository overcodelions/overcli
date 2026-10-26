import { describe, expect, it } from 'vitest';
import { bindOverdbInConfig, boundOverdbTool, useOverdbWorkerLookup } from './overdbBinding';

const overdb = { command: 'node', args: ['/opt/overdb/dist/mcp/headless.js'], env: { OVERDB_SHOP_PASSWORD: 'pw' } };

describe('the overdb tool, told whose run it serves', () => {
  it('adds the worker and the run to the env, keeping the passwords', () => {
    useOverdbWorkerLookup((id) => (id === 'conv-1' ? 'Triage' : undefined));
    expect(boundOverdbTool(() => ({ overdb, other: { command: 'x' } }), 'conv-1')).toEqual({
      overdb: { ...overdb, env: { OVERDB_SHOP_PASSWORD: 'pw', OVERCLI_CONVERSATION: 'conv-1', OVERCLI_WORKER: 'Triage' } },
    });
    // A run that is no worker's still gets its conversation.
    expect(boundOverdbTool(() => ({ overdb }), 'conv-2').overdb.env).toEqual({ OVERDB_SHOP_PASSWORD: 'pw', OVERCLI_CONVERSATION: 'conv-2' });
  });

  it('binds an allowlisted config in place and leaves every other one alone', () => {
    useOverdbWorkerLookup(() => 'Triage');
    const bound = JSON.parse(bindOverdbInConfig(JSON.stringify({ mcpServers: { overdb, gmail: { url: 'https://x' } } }), 'c'));
    expect(bound.mcpServers.overdb.env.OVERCLI_WORKER).toBe('Triage');
    expect(bound.mcpServers.gmail).toEqual({ url: 'https://x' });
    const none = JSON.stringify({ mcpServers: { gmail: { url: 'https://x' } } });
    expect(bindOverdbInConfig(none, 'c')).toBe(none);
    expect(boundOverdbTool(() => ({}), 'c')).toEqual({});
  });
});
