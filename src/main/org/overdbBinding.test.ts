import { afterEach, describe, expect, it } from 'vitest';
import { bindOverdbInConfig, boundOverdbTool, useOverdbWorkerLookup } from './overdbBinding';
import { closeRunToolRelay } from './runToolRelay';

afterEach(() => { closeRunToolRelay(); useOverdbWorkerLookup(() => undefined); });

const overdb = { command: 'node', args: ['/opt/overdb/dist/mcp/headless.js'], env: { OVERDB_SHOP_PASSWORD: 'pw' } };

describe('the overdb tool, told whose run it serves', () => {
  it('returns credential-free relay descriptors', () => {
    useOverdbWorkerLookup((id) => (id === 'conv-1' ? 'Triage' : undefined));
    const bound = boundOverdbTool(() => ({ overdb, other: { command: 'x' } }), 'conv-1').overdb;
    expect(JSON.stringify(bound)).not.toContain('pw');
    expect((bound.args as string[] | undefined)?.slice(-2)).toEqual(['conv-1', 'overdb']);
  });

  it('binds an allowlisted config in place and leaves every other one alone', () => {
    useOverdbWorkerLookup(() => 'Triage');
    const bound = JSON.parse(bindOverdbInConfig(JSON.stringify({ mcpServers: { overdb, gmail: { url: 'https://x' } } }), 'c'));
    expect(JSON.stringify(bound.mcpServers.overdb)).not.toContain('pw');
    expect(bound.mcpServers.gmail).toEqual({ url: 'https://x' });
    const none = JSON.stringify({ mcpServers: { gmail: { url: 'https://x' } } });
    expect(bindOverdbInConfig(none, 'c')).toBe(none);
    expect(boundOverdbTool(() => ({}), 'c')).toEqual({});
  });
});
