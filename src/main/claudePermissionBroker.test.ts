import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePermissionBroker } from './claudePermissionBroker';
import type { UUID } from '../shared/types';
import { bindRunTools, closeRunToolRelay } from './org/runToolRelay';
const sockets: net.Socket[] = [];
const handler = vi.fn();
const broker = new ClaudePermissionBroker(handler);
afterEach(() => {
  broker.shutdown();
  closeRunToolRelay();
  for (const socket of sockets.splice(0)) socket.destroy();
  handler.mockClear();
});
async function socketFor(env: Record<string, string>, conversationId = env.OVERCLI_PERM_CONV, token = env.OVERCLI_PERM_TOKEN) {
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(env.OVERCLI_PERM_PORT) });
  sockets.push(socket);
  await once(socket, 'connect');
  socket.write(JSON.stringify({ type: 'hello', token, conversationId }) + '\n');
  return socket;
}
describe('permission broker inherited credentials', () => {
  it('keeps tokens off disk while allowing authenticated approvals and revoking old sessions', async () => {
    const tools = bindRunTools({
      overdb: { command: 'node', env: { PASSWORD: 'private-db-password' } },
      gateway: { url: 'http://127.0.0.1:123/t/test', headers: { Authorization: 'Bearer private-gateway-key' } },
    }, 'first');
    const first = await broker.registerSession('first' as UUID, 'helper.js', process.execPath, {}, tools);
    const second = await broker.registerSession('second' as UUID, 'helper.js', process.execPath, {});
    for (const session of [first, second]) {
      const text = fs.readFileSync(session.configPath, 'utf8');
      expect(text).not.toContain(first.token);
      expect(text).not.toContain(second.token);
      expect(text).not.toContain('OVERCLI_PERM_TOKEN');
      expect(text).not.toContain('private-db-password');
      expect(text).not.toContain('private-gateway-key');
    }
    const socket = await socketFor(first.launchEnv);
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    socket.write(JSON.stringify({ type: 'approval', requestId: 'request', toolName: 'Write', toolInput: { file_path: 'a' }, toolUseId: 'tool' }) + '\n');
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'first', requestId: 'request' })));
    expect(broker.resolve('first' as UUID, 'request', { behavior: 'allow' })).toBe(true);
    expect(JSON.parse((await lines.next()).value!)).toMatchObject({ type: 'decision', behavior: 'allow' });
    broker.unregisterSession('first' as UUID);
    expect(fs.existsSync(first.configPath)).toBe(false);
    const refused = await socketFor(first.launchEnv);
    await once(refused, 'close');
    expect(broker.resolve('first' as UUID, 'request', { behavior: 'allow' })).toBe(false);
  });
  it('refuses another conversation using a valid session token', async () => {
    const session = await broker.registerSession('first' as UUID, 'helper.js', process.execPath, {});
    const socket = await socketFor(session.launchEnv, 'second');
    await once(socket, 'close');
    expect(handler).not.toHaveBeenCalled();
  });
});
