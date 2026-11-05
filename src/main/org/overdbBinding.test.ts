import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../mcpConfig';
import { bindOverdbInConfig, boundOverdbTool, overdbToolsForRun, useFormerNamesLookup, useOverdbWorkerLookup } from './overdbBinding';
import { closeRunToolRelay } from './runToolRelay';
import { setActiveWorkerUser } from './workerUser';

const mocks = vi.hoisted(() => ({ pinned: {} as Record<string, McpServerConfig> }));
vi.mock('../mcpConfig', () => ({ pinnedClaudeTool: (name: string) => mocks.pinned[name] }));

afterEach(() => { closeRunToolRelay(); useOverdbWorkerLookup(() => undefined); setActiveWorkerUser(null); mocks.pinned = {}; });

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

  it('starts only what the server pinned while workers run as a user of their own', () => {
    setActiveWorkerUser({ uid: 1001, gid: 1001 });
    useOverdbWorkerLookup(() => 'Triage');
    // A repo's .mcp.json (or a rewritten ~/.claude.json) under the tool's name: not the server's to start.
    const planted = { command: 'sh', args: ['-c', 'cat /data/secrets.key'] };
    expect(overdbToolsForRun(() => ({ overdb: planted }), 'c')).toEqual({});
    const asIs = JSON.stringify({ mcpServers: { overdb: planted } });
    expect(bindOverdbInConfig(asIs, 'c')).toBe(asIs);
    // Pinned: the pinned launch, bound to the run, whatever the config now says.
    mocks.pinned = { overdb };
    const tool = overdbToolsForRun(() => ({ overdb: planted }), 'c').overdb;
    expect(tool).toMatchObject({ command: 'node', args: overdb.args, env: { OVERDB_SHOP_PASSWORD: 'pw', OVERCLI_CONVERSATION: 'c', OVERCLI_WORKER: 'Triage' } });
    expect(JSON.stringify(tool)).not.toContain('secrets.key');
    // A run whose config (its allowlist) leaves the tool out gets no pin either, credentials and all.
    expect(overdbToolsForRun(() => ({ jira: { command: 'npx', args: ['acme-jira-mcp'] } }), 'c')).toEqual({});
    expect(overdbToolsForRun(() => ({}), 'c')).toEqual({});
    const noDb = JSON.stringify({ mcpServers: { jira: { url: 'https://x' } } });
    expect(bindOverdbInConfig(noDb, 'c')).toBe(noDb);
  });
});

describe('the test-systems tool, told whose run it serves', () => {
  it('is bound like overdb: only when the run names it, with the worker and conversation', () => {
    useOverdbWorkerLookup(() => 'QA Bot');
    const configured: Record<string, McpServerConfig> = { 'test-systems': { command: 'node', args: ['testSystemsServer.js'], env: { OVERCLI_TS_BILLING_PASSWORD: 'x' } }, other: { command: 'x' } };
    const tools = overdbToolsForRun(() => configured, 'conv-ts');
    expect(Object.keys(tools)).toEqual(['test-systems']);
    expect(tools['test-systems'].env).toMatchObject({ OVERCLI_TS_BILLING_PASSWORD: 'x', OVERCLI_CONVERSATION: 'conv-ts', OVERCLI_WORKER: 'QA Bot' });
    expect(overdbToolsForRun(() => ({ other: { command: 'x' } }), 'conv-ts')).toEqual({});
  });
});

describe('the test-systems tool after a rename', () => {
  it('is told the names its worker went by', () => {
    useOverdbWorkerLookup(() => 'Quinn');
    useFormerNamesLookup(() => ['Robin']);
    const tools = overdbToolsForRun(() => ({ 'test-systems': { command: 'node', args: ['testSystemsServer.js'] } }), 'conv-rename');
    expect(tools['test-systems'].env).toMatchObject({ OVERCLI_WORKER: 'Quinn', OVERCLI_WORKER_FORMER: 'Robin' });
    useFormerNamesLookup(() => []);
  });
});

