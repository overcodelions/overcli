// Claude Agent SDK client. Wraps @anthropic-ai/claude-agent-sdk's `query()`
// in an EventEmitter so the runner can drive Claude turns without spawning
// `claude -p`. The SDK still requires Claude Code installed locally; this
// path swaps the stdin/stdout JSON envelope for an in-process typed API.
//
// Design choice: the SDK's SDKMessage shapes are byte-for-byte the same as
// the lines `claude -p --output-format stream-json --verbose
// --include-partial-messages` writes to stdout. So we serialize each
// SDKMessage to a JSON line and emit it on `line`; the runner pipes those
// lines straight through the existing `claudeBackend.parseChunk` parser.
// Zero duplication of the event-translation logic.

import { EventEmitter } from 'node:events';
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import type { Attachment, EffortLevel, PermissionMode } from '../shared/types';

export interface ClaudeSdkStartOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  /// Extra absolute paths Claude is allowed to read beyond `cwd`. Passed
  /// through as the SDK's `additionalDirectories` (analogous to `--add-dir`).
  allowedDirs?: string[];
  /// Session id to resume. Set only on the first query() call of a
  /// conversation; subsequent turns share the same long-lived query.
  resumeSessionId?: string;
  effortLevel?: EffortLevel;
  /// Direct permission callback. Replaces the MCP permission-prompt-tool
  /// round-trip used by the CLI transport — the runner registers a
  /// pending-permission resolver and emits the same permissionRequest
  /// stream event the CLI broker produces.
  canUseTool: CanUseTool;
}

export interface ClaudeSdkTurnInput {
  prompt: string;
  attachments?: Attachment[];
}

export declare interface ClaudeSdkClient {
  on(event: 'message', listener: (msg: SDKMessage) => void): this;
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}

export class ClaudeSdkClient extends EventEmitter {
  private q: Query | null = null;
  private startOpts: ClaudeSdkStartOptions;
  /// Streaming-input queue. query() consumes an AsyncIterable of user
  /// messages; we push onto it as each turn arrives so a single query()
  /// invocation spans the whole conversation (lets us use interrupt()).
  private inputQueue: SDKUserMessage[] = [];
  private inputWaiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private inputClosed = false;
  private consumerDone = false;

  constructor(opts: ClaudeSdkStartOptions) {
    super();
    this.startOpts = opts;
  }

  private async *iterableInput(): AsyncGenerator<SDKUserMessage, void> {
    while (true) {
      if (this.inputQueue.length > 0) {
        yield this.inputQueue.shift()!;
        continue;
      }
      if (this.inputClosed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.inputWaiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  private start(): void {
    if (this.q) return;
    const o = this.startOpts;
    const options: Options = {
      cwd: o.cwd,
      ...(o.model ? { model: o.model } : {}),
      permissionMode: o.permissionMode,
      ...(o.allowedDirs?.length ? { additionalDirectories: o.allowedDirs } : {}),
      ...(o.resumeSessionId ? { resume: o.resumeSessionId } : {}),
      canUseTool: o.canUseTool,
      includePartialMessages: true,
      ...(o.effortLevel ? { effort: o.effortLevel as Options['effort'] } : {}),
      ...(o.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    };
    this.q = query({ prompt: this.iterableInput(), options });
    void this.consume();
  }

  private async consume(): Promise<void> {
    const q = this.q;
    if (!q) return;
    try {
      for await (const msg of q) {
        try {
          this.emit('line', JSON.stringify(msg));
          this.emit('message', msg);
        } catch (err) {
          this.emit('error', err as Error);
        }
      }
    } catch (err) {
      if (!this.consumerDone) this.emit('error', err as Error);
    } finally {
      this.consumerDone = true;
      this.emit('close');
    }
  }

  /// Queue a turn. Starts the underlying query() on the first call.
  sendTurn(turn: ClaudeSdkTurnInput): void {
    if (this.inputClosed) return;
    this.start();
    const content = buildUserContent(turn);
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content } as SDKUserMessage['message'],
      parent_tool_use_id: null,
    };
    if (this.inputWaiter) {
      const w = this.inputWaiter;
      this.inputWaiter = null;
      w({ done: false, value: msg });
    } else {
      this.inputQueue.push(msg);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.q || this.consumerDone) return;
    try {
      await this.q.interrupt();
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  /// Tear down: ends the input iterable, which lets query() drain and
  /// close. The 'close' event fires once the consumer loop exits.
  close(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    if (this.inputWaiter) {
      const w = this.inputWaiter;
      this.inputWaiter = null;
      w({ done: true, value: undefined as unknown as SDKUserMessage });
    }
    if (this.q && !this.consumerDone) {
      try {
        void this.q.return(undefined);
      } catch {}
    }
  }
}

function buildUserContent(turn: ClaudeSdkTurnInput): SDKUserMessage['message']['content'] {
  const attachments = turn.attachments ?? [];
  if (attachments.length === 0) return turn.prompt;
  const blocks: Array<Record<string, unknown>> = attachments.map((a) => ({
    type: 'image',
    source: { type: 'base64', media_type: a.mimeType, data: a.dataBase64 },
  }));
  blocks.push({ type: 'text', text: turn.prompt || '(no text)' });
  return blocks as unknown as SDKUserMessage['message']['content'];
}
