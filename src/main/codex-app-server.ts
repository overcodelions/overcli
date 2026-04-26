import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { backendNeedsShell } from './backendPaths';
import { Attachment, EffortLevel } from '../shared/types';

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

export type CodexAppServerSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexAppServerApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export interface CodexAppServerStartOptions {
  cwd: string;
  model: string;
  sandbox: CodexAppServerSandboxMode;
  approval: CodexAppServerApprovalPolicy;
}

export interface CodexAppServerTurnOptions {
  cwd: string;
  model: string;
  sandbox: CodexAppServerSandboxMode;
  approval: CodexAppServerApprovalPolicy;
  effortLevel?: EffortLevel;
  attachments?: Attachment[];
}

interface CodexAppServerNotificationEvent {
  method: string;
  params: any;
  raw: string;
}

interface CodexAppServerRequestEvent {
  id: JsonRpcId;
  method: string;
  params: any;
  raw: string;
}

export declare interface CodexAppServerClient {
  on(event: 'notification', listener: (evt: CodexAppServerNotificationEvent) => void): this;
  on(event: 'request', listener: (evt: CodexAppServerRequestEvent) => void): this;
  on(event: 'stderr', listener: (chunk: string) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
}

export class CodexAppServerClient extends EventEmitter {
  readonly proc: ChildProcessWithoutNullStreams;

  private stdoutBuffer = '';
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private initialized = false;
  private closed = false;
  private threadId?: string;
  private startPromise?: Promise<{ threadId: string }>;
  /// Persisted thread id we should attempt to resume on first start.
  /// Populated by spawnCodexAppServer from the conversation's saved
  /// sessionId so a follow-up after app restart re-attaches to the
  /// original codex thread instead of opening a fresh one.
  private resumeId?: string;
  /// turnId of any turn currently in flight. Set on turn/start, cleared on
  /// turn/completed (via observation of the matching notification). Used so
  /// follow-up sends route through turn/steer (queue input mid-turn) instead
  /// of failing.
  private inFlightTurnId: string | null = null;

  constructor(args: { binary: string; cwd: string; env: NodeJS.ProcessEnv; resumeId?: string }) {
    super();
    this.resumeId = args.resumeId;
    this.proc = spawn(args.binary, ['app-server'], {
      cwd: args.cwd,
      env: args.env,
      shell: backendNeedsShell(args.binary),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => {
      void this.handleStdout(chunk);
    });

    this.proc.stderr.setEncoding('utf-8');
    this.proc.stderr.on('data', (chunk: string) => this.emit('stderr', chunk));

    this.proc.on('close', (code) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`codex app-server exited with status ${code ?? 'unknown'}`));
      }
      this.pending.clear();
      this.emit('close', code);
    });
  }

  async start(opts: CodexAppServerStartOptions): Promise<{ threadId: string }> {
    if (this.threadId) return { threadId: this.threadId };
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(opts).finally(() => {
      if (!this.threadId) this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async sendUserInput(text: string, opts: CodexAppServerTurnOptions): Promise<{ threadId: string }> {
    const { threadId } = await this.start(opts);
    const input = buildUserInput(text, opts.attachments ?? []);
    if (this.inFlightTurnId) {
      // Turn is still running — queue the new input via turn/steer rather
      // than failing or starting a parallel turn.
      try {
        await this.request('turn/steer', {
          threadId,
          input,
          expectedTurnId: this.inFlightTurnId,
        });
        return { threadId };
      } catch {
        // Steer can race with turn completion; if the precondition fails
        // fall through to starting a new turn below.
        this.inFlightTurnId = null;
      }
    }
    const result = await this.request('turn/start', {
      threadId,
      input,
      cwd: opts.cwd,
      approvalPolicy: opts.approval,
      sandboxPolicy: sandboxPolicyForMode(opts.sandbox, opts.cwd),
      model: opts.model || null,
      effort: codexAppServerEffort(opts.effortLevel),
    });
    const turnId: string | undefined = result?.turn?.id;
    if (turnId) this.inFlightTurnId = turnId;
    return { threadId };
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || this.closed) return;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId });
    } catch {
      // Best-effort interrupt: the process may already be closing.
    }
  }

  async respondToServerRequest(id: JsonRpcId, payload: any): Promise<void> {
    if (this.closed) return;
    await this.write({ jsonrpc: '2.0', id, result: payload ?? null });
  }

  async rejectServerRequest(id: JsonRpcId, message: string): Promise<void> {
    if (this.closed) return;
    await this.write({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message },
    });
  }

  kill(): void {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
    } catch {}
    try {
      this.proc.kill('SIGTERM');
    } catch {}
  }

  private async startInternal(opts: CodexAppServerStartOptions): Promise<{ threadId: string }> {
    if (!this.initialized) {
      await this.request('initialize', {
        clientInfo: { name: 'overcli', title: 'overcli', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      await this.notify('initialized');
      this.initialized = true;
    }

    // Try to resume the persisted thread first when we have one. Falls
    // back to thread/start on any failure (deleted thread, codex too
    // old to know thread/resume, etc.) so the user can keep talking
    // even when context can't be restored.
    if (this.resumeId) {
      const { method, params } = buildResumeRequest(opts, this.resumeId);
      try {
        const resumed = await this.request(method, params);
        const id = String(resumed?.thread?.id ?? '');
        if (id) {
          this.threadId = id;
          return { threadId: id };
        }
      } catch {
        // Fall through to thread/start below — the thread may have
        // been deleted, the codex binary may not implement
        // thread/resume, or the sandbox config may be incompatible.
      }
      // Don't try resume again on subsequent starts within this client.
      this.resumeId = undefined;
    }

    const { method, params } = buildStartRequest(opts);
    const started = await this.request(method, params);
    const threadId = String(started?.thread?.id ?? '');
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    this.threadId = threadId;
    return { threadId };
  }

  private async handleStdout(chunk: string): Promise<void> {
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
        this.emit('notification', {
          method: 'error',
          params: { message: `Malformed app-server JSON: ${trimmed.slice(0, 200)}` },
          raw: trimmed,
        });
        continue;
      }

      if ('method' in msg && 'id' in msg) {
        this.emit('request', { id: msg.id, method: msg.method, params: msg.params, raw: trimmed });
        continue;
      }

      if ('method' in msg) {
        if (msg.method === 'turn/completed') this.inFlightTurnId = null;
        this.emit('notification', { method: msg.method, params: msg.params, raw: trimmed });
        continue;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if ('error' in msg) pending.reject(new Error(msg.error?.message ?? 'codex app-server request failed'));
      else pending.resolve(msg.result);
    }
  }

  private async request(method: string, params?: any): Promise<any> {
    if (this.closed) throw new Error('codex app-server connection is closed');
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private async notify(method: string, params?: any): Promise<void> {
    if (this.closed) return;
    await this.write({ jsonrpc: '2.0', method, params });
  }

  private async write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure): Promise<void> {
    const line = JSON.stringify(message) + '\n';
    await new Promise<void>((resolve, reject) => {
      this.proc.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }
}

/// JSON-RPC request to attach to an existing codex thread. Pure for
/// testability — the network call lives in startInternal, this just
/// shapes the payload. Exported so the sibling test can lock in the
/// shape without standing up a real subprocess.
export function buildResumeRequest(
  opts: CodexAppServerStartOptions,
  threadId: string,
): { method: string; params: Record<string, unknown> } {
  return {
    method: 'thread/resume',
    params: {
      threadId,
      model: opts.model || null,
      approvalPolicy: opts.approval,
      sandbox: opts.sandbox,
    },
  };
}

/// JSON-RPC request to create a new codex thread.
export function buildStartRequest(
  opts: CodexAppServerStartOptions,
): { method: string; params: Record<string, unknown> } {
  return {
    method: 'thread/start',
    params: {
      model: opts.model || null,
      cwd: opts.cwd,
      approvalPolicy: opts.approval,
      approvalsReviewer: 'user',
      sandbox: opts.sandbox,
    },
  };
}

function buildUserInput(text: string, attachments: Attachment[]): any[] {
  const input: any[] = [];
  for (const a of attachments) {
    input.push({ type: 'localImage', path: writeAttachmentToTemp(a) });
  }
  if (text || input.length === 0) {
    input.push({ type: 'text', text: text || '(no text)', text_elements: [] });
  }
  return input;
}

function sandboxPolicyForMode(mode: CodexAppServerSandboxMode, cwd: string): any {
  switch (mode) {
    case 'read-only':
      return {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function codexAppServerEffort(level: EffortLevel | undefined): string | null {
  switch (level) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      return 'xhigh';
    case '':
    case undefined:
      return null;
    default:
      return null;
  }
}

function writeAttachmentToTemp(a: Attachment): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');

  const dir = path.join(os.homedir(), '.overcli', 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${a.id || randomUUID()}${mimeToExt(a.mimeType)}`);
  fs.writeFileSync(file, Buffer.from(a.dataBase64, 'base64'), { mode: 0o600 });
  return file;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}
