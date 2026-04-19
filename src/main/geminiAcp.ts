import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { backendNeedsShell } from './backendPaths';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: any;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

interface JsonRpcSuccess {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result: any;
}

interface JsonRpcFailure {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: any };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;
const geminiAcpFlagCache = new Map<string, '--acp' | '--experimental-acp'>();

export class GeminiAcpClient {
  readonly proc: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (error: any) => void }>();
  private closed = false;

  constructor(args: {
    binary: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    onNotification: (method: string, params: any) => void | Promise<void>;
    onRequest: (id: JsonRpcId, method: string, params: any) => any | Promise<any>;
    onStderr?: (chunk: string) => void;
    onClose?: (code: number | null) => void;
  }) {
    const acpFlag = resolveGeminiAcpFlag(args.binary, args.env);
    this.proc = spawn(args.binary, [acpFlag], {
      cwd: args.cwd,
      env: args.env,
      shell: backendNeedsShell(args.binary),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => {
      void this.handleStdout(chunk, args.onNotification, args.onRequest);
    });

    this.proc.stderr.setEncoding('utf-8');
    this.proc.stderr.on('data', (chunk: string) => args.onStderr?.(chunk));

    this.proc.on('close', (code) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`gemini ACP exited with status ${code ?? 'unknown'}`));
      }
      this.pending.clear();
      args.onClose?.(code);
    });
  }

  async request(method: string, params?: any): Promise<any> {
    if (this.closed) throw new Error('gemini ACP connection is closed');
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  async notify(method: string, params?: any): Promise<void> {
    if (this.closed) return;
    await this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
    } catch {}
    try {
      this.proc.kill('SIGTERM');
    } catch {}
  }

  private async handleStdout(
    chunk: string,
    onNotification: (method: string, params: any) => void | Promise<void>,
    onRequest: (id: JsonRpcId, method: string, params: any) => any | Promise<any>,
  ): Promise<void> {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if ('method' in msg && 'id' in msg) {
        try {
          const result = await onRequest(msg.id, msg.method, msg.params);
          await this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
        } catch (err: any) {
          await this.write({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32603,
              message: err?.message ?? String(err),
            },
          });
        }
        continue;
      }

      if ('method' in msg) {
        await onNotification(msg.method, msg.params);
        continue;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if ('error' in msg) pending.reject(new Error(msg.error?.message ?? 'ACP request failed'));
      else pending.resolve(msg.result);
    }
  }

  private async write(message: Record<string, any>): Promise<void> {
    const line = JSON.stringify(message) + '\n';
    await new Promise<void>((resolve, reject) => {
      this.proc.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }
}

function resolveGeminiAcpFlag(binary: string, env: NodeJS.ProcessEnv): '--acp' | '--experimental-acp' {
  const cached = geminiAcpFlagCache.get(binary);
  if (cached) return cached;
  const help = spawnSync(binary, ['--help'], {
    encoding: 'utf-8',
    timeout: 3000,
    env,
    shell: backendNeedsShell(binary),
  });
  const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`.toLowerCase();
  const flag: '--acp' | '--experimental-acp' = text.includes('--experimental-acp')
    ? '--experimental-acp'
    : '--acp';
  geminiAcpFlagCache.set(binary, flag);
  return flag;
}
