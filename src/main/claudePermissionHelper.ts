// Runs as a standalone Node process (via Electron's ELECTRON_RUN_AS_NODE).
// Speaks MCP over stdio to Claude, relays approval decisions back to
// overcli main over a local TCP socket. One short-lived helper per Claude
// launch; exits when Claude closes stdin.

import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.OVERCLI_PERM_PORT || '0');
const TOKEN = process.env.OVERCLI_PERM_TOKEN || '';
const CONV_ID = process.env.OVERCLI_PERM_CONV || '';

if (!PORT || !TOKEN || !CONV_ID) {
  // No way to recover — exit so Claude fails loudly instead of hanging.
  process.stderr.write('[overcli-perm-helper] missing env OVERCLI_PERM_PORT/TOKEN/CONV\n');
  process.exit(1);
}

type Pending = { resolve: (decision: Decision) => void; reject: (err: Error) => void };
type Decision = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

const pending = new Map<string, Pending>();
let socket: net.Socket | null = null;
let socketReady: Promise<net.Socket> | null = null;

function connect(): Promise<net.Socket> {
  if (socketReady) return socketReady;
  socketReady = new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
      s.write(JSON.stringify({ type: 'hello', token: TOKEN, conversationId: CONV_ID }) + '\n');
      socket = s;
      resolve(s);
    });
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'decision' && typeof msg.requestId === 'string') {
            const p = pending.get(msg.requestId);
            if (p) {
              pending.delete(msg.requestId);
              if (msg.behavior === 'allow') {
                p.resolve({ behavior: 'allow', updatedInput: msg.updatedInput ?? {} });
              } else {
                p.resolve({ behavior: 'deny', message: String(msg.message ?? 'denied') });
              }
            }
          }
        } catch {}
      }
    });
    s.on('error', (err) => {
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      reject(err);
    });
    s.on('close', () => {
      for (const [, p] of pending) p.reject(new Error('overcli broker closed'));
      pending.clear();
    });
  });
  return socketReady;
}

async function askOvercli(toolName: string, input: unknown, toolUseId: string): Promise<Decision> {
  const s = await connect();
  const requestId = randomUUID();
  return new Promise<Decision>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    s.write(
      JSON.stringify({
        type: 'approval',
        requestId,
        conversationId: CONV_ID,
        toolName,
        toolInput: input,
        toolUseId,
      }) + '\n',
    );
  });
}

// --- MCP stdio server (JSON-RPC 2.0, newline-delimited) ---

const APPROVE_TOOL = {
  name: 'approve',
  description: 'Request user approval for a tool call',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleRpc(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'overcli-permissions', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [APPROVE_TOOL] } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== 'approve') {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      const decision = await askOvercli(
        String(args.tool_name ?? 'tool'),
        args.input ?? {},
        String(args.tool_use_id ?? ''),
      );
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(decision) }],
        },
      });
      return;
    }
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (!isNotification) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuf += chunk;
  let idx: number;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx);
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      void handleRpc(msg);
    } catch {}
  }
});
process.stdin.on('end', () => {
  try {
    socket?.end();
  } catch {}
  process.exit(0);
});
