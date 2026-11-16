import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOrgChatGuard, orgChatTools, setOrgChatSource } from './orgChatTools';
import { relayFailureWords, type RelayCallGuard } from './runToolRelay';

// The guard orgChatTools hands the relay, kept for the tests to call.
const installed = vi.hoisted(() => ({ guard: null as RelayCallGuard | null }));
vi.mock('./runToolRelay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runToolRelay')>()),
  setRelayCallGuard: (g: RelayCallGuard | null) => {
    installed.guard = g;
  },
}));

afterEach(() => setOrgChatSource(null));

describe('orgChatTools', () => {
  it("points a typed chat at the org's MCP endpoint as the signed-in person, saying it's an overcli chat", () => {
    setOrgChatSource(() => ({ tool: 'overgo', url: 'https://overgo.acme.example/', token: 'ocli_acme' }));
    expect(orgChatTools({ interactive: true })).toEqual({
      overgo: { type: 'http', url: 'https://overgo.acme.example/mcp', headers: { Authorization: 'Bearer ocli_acme', 'X-Overcli-Client': 'desktop-chat' } },
    });
  });

  it('gives nothing to flow steps, hidden sends, a signed-out app, or when reading the sign-in fails', () => {
    setOrgChatSource(() => ({ tool: 'overgo', url: 'https://overgo.acme.example', token: 'ocli_acme' }));
    expect(orgChatTools({ interactive: true, flowStep: true })).toEqual({});
    expect(orgChatTools({})).toEqual({});
    setOrgChatSource(() => ({ tool: 'overgo', url: 'https://overgo.acme.example', token: '' }));
    expect(orgChatTools({ interactive: true })).toEqual({});
    setOrgChatSource(() => {
      throw new Error('keychain locked');
    });
    expect(orgChatTools({ interactive: true })).toEqual({});
    setOrgChatSource(null);
    expect(orgChatTools({ interactive: true })).toEqual({});
  });
});

describe('relayFailureWords', () => {
  it("passes on the server's own sentence, as an expired sign-in's 401 gives it", () => {
    const err = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Not signed in to overgo: sign in again under Settings → Your org."},"id":null}'), { code: 401 });
    expect(relayFailureWords('overgo', err)).toBe('overgo: Not signed in to overgo: sign in again under Settings → Your org.');
  });

  it('says a server that is down could not be reached, and names a bare status', () => {
    expect(relayFailureWords('overgo', new TypeError('fetch failed'))).toBe("overgo couldn't be reached. Check the connection and try again.");
    expect(relayFailureWords('overgo', Object.assign(new Error('Error POSTing to endpoint: Unauthorized'), { code: 401 }))).toContain('refused this app');
    expect(relayFailureWords('overgo', Object.assign(new Error('Error POSTing to endpoint: Bad gateway'), { code: 502 }))).toBe('overgo answered with an error (502).');
  });
});

describe('several org servers', () => {
  it('gives a chat one tool per server with its switch on, each with its own token', () => {
    setOrgChatSource(() => [
      { tool: 'overgo-acme', url: 'https://overgo.acme.example', token: 'ocli_acme' },
      { tool: 'overgo-acme-labs', url: 'http://localhost:7420', token: 'ocli_labs' },
    ]);
    const tools = orgChatTools({ interactive: true });
    expect(Object.keys(tools)).toEqual(['overgo-acme', 'overgo-acme-labs']);
    expect(tools['overgo-acme-labs']).toMatchObject({ url: 'http://localhost:7420/mcp', headers: { Authorization: 'Bearer ocli_labs' } });
  });
});

describe('the change guard', () => {
  afterEach(() => installOrgChatGuard(null));
  const ctx = { conversationId: 'c1', tool: 'overgo-acme', name: 'retire_worker', args: { worker: 'Mario' } };
  const serve = (access?: 'read' | 'ask') => setOrgChatSource(() => [{ tool: 'overgo-acme', url: 'https://overgo.acme.example', token: 'ocli_a', org: 'Acme', ...(access ? { access } : {}) }]);

  it('asks the person before each change, by default, and says so when they decline', async () => {
    const confirm = vi.fn(async () => false);
    serve();
    orgChatTools({ interactive: true });
    installOrgChatGuard(confirm);
    expect(installed.guard!.listMode({ conversationId: 'c1', tool: 'overgo-acme' })).toBe('all');
    expect(await installed.guard!.checkCall(ctx)).toEqual({ allow: false, message: expect.stringContaining('said no to retire_worker on Acme') });
    expect(confirm).toHaveBeenCalledWith({ conversationId: 'c1', tool: 'overgo-acme', org: 'Acme', name: 'retire_worker', args: { worker: 'Mario' } });
    confirm.mockResolvedValueOnce(true);
    expect(await installed.guard!.checkCall(ctx)).toEqual({ allow: true });
  });

  it('hides and refuses every change on a read-only server, without asking', async () => {
    const confirm = vi.fn(async () => true);
    serve('read');
    orgChatTools({ interactive: true });
    installOrgChatGuard(confirm);
    expect(installed.guard!.listMode({ conversationId: 'c1', tool: 'overgo-acme' })).toBe('readOnly');
    expect(await installed.guard!.checkCall(ctx)).toEqual({ allow: false, message: expect.stringContaining('only read Acme') });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('refuses a change once the server is switched off for chats, and leaves other tools alone', async () => {
    serve();
    orgChatTools({ interactive: true });
    installOrgChatGuard(async () => true);
    setOrgChatSource(() => []);
    expect(await installed.guard!.checkCall(ctx)).toEqual({ allow: false, message: expect.stringContaining('turned off for chats') });
    expect(installed.guard!.checkCall({ ...ctx, tool: 'jira' })).toBeNull();
    expect(installed.guard!.listMode({ conversationId: 'c1', tool: 'jira' })).toBeNull();
  });
});
