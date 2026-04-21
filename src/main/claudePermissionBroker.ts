// TCP loopback broker: receives approval requests from the per-Claude
// MCP helper subprocess, hands them to a caller-provided handler, and
// ships the decision back down the socket. One broker per RunnerManager.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UUID } from '../shared/types';

export interface ApprovalRequest {
  conversationId: UUID;
  requestId: string;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
}

export type Decision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string };

type Handler = (req: ApprovalRequest) => void;

interface Session {
  conversationId: UUID;
  token: string;
  configPath: string;
  socket?: net.Socket;
}

export class ClaudePermissionBroker {
  private server: net.Server | null = null;
  private port = 0;
  private ready: Promise<void> | null = null;
  private sessionsByToken = new Map<string, Session>();
  private sessionsByConvId = new Map<UUID, Session>();
  private handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  /// Start (if needed) and return this instance's loopback port.
  private async start(): Promise<number> {
    if (this.ready) {
      await this.ready;
      return this.port;
    }
    this.ready = new Promise<void>((resolve, reject) => {
      const server = net.createServer((sock) => this.handleConnection(sock));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.server = server;
        resolve();
      });
    });
    await this.ready;
    return this.port;
  }

  /// Register a Claude launch. Returns the mcp-config path + auth token
  /// the caller should pass to the subprocess via `--mcp-config` and env.
  async registerSession(
    conversationId: UUID,
    helperScript: string,
    helperCommand: string,
    helperExtraEnv: Record<string, string>,
  ): Promise<{ configPath: string; token: string }> {
    const port = await this.start();
    this.unregisterSession(conversationId);
    const token = randomBytes(24).toString('hex');
    const configPath = path.join(
      os.tmpdir(),
      `overcli-perm-${conversationId}-${randomBytes(4).toString('hex')}.json`,
    );
    const config = {
      mcpServers: {
        overcli: {
          command: helperCommand,
          args: [helperScript],
          env: {
            ...helperExtraEnv,
            OVERCLI_PERM_PORT: String(port),
            OVERCLI_PERM_TOKEN: token,
            OVERCLI_PERM_CONV: conversationId,
          },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    const session: Session = { conversationId, token, configPath };
    this.sessionsByToken.set(token, session);
    this.sessionsByConvId.set(conversationId, session);
    return { configPath, token };
  }

  unregisterSession(conversationId: UUID): void {
    const s = this.sessionsByConvId.get(conversationId);
    if (!s) return;
    this.sessionsByConvId.delete(conversationId);
    this.sessionsByToken.delete(s.token);
    try {
      s.socket?.end();
    } catch {}
    try {
      fs.unlinkSync(s.configPath);
    } catch {}
  }

  /// Send a decision back to a helper that's awaiting it.
  resolve(conversationId: UUID, requestId: string, decision: Decision): boolean {
    const s = this.sessionsByConvId.get(conversationId);
    if (!s?.socket || s.socket.destroyed) return false;
    try {
      s.socket.write(JSON.stringify({ type: 'decision', requestId, ...decision }) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private handleConnection(sock: net.Socket): void {
    sock.setEncoding('utf8');
    let buf = '';
    let authed: Session | null = null;
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!authed) {
          if (msg.type === 'hello' && typeof msg.token === 'string') {
            const s = this.sessionsByToken.get(msg.token);
            if (s && s.conversationId === msg.conversationId) {
              authed = s;
              s.socket = sock;
            } else {
              sock.destroy();
              return;
            }
          } else {
            sock.destroy();
            return;
          }
          continue;
        }
        if (msg.type === 'approval') {
          this.handler({
            conversationId: authed.conversationId,
            requestId: String(msg.requestId ?? ''),
            toolName: String(msg.toolName ?? 'tool'),
            toolInput: msg.toolInput ?? {},
            toolUseId: String(msg.toolUseId ?? ''),
          });
        }
      }
    });
    sock.on('close', () => {
      if (authed && authed.socket === sock) authed.socket = undefined;
    });
    sock.on('error', () => {});
  }

  shutdown(): void {
    for (const convId of Array.from(this.sessionsByConvId.keys())) this.unregisterSession(convId);
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    this.ready = null;
  }
}
