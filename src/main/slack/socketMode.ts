// A Socket Mode client: Slack pushes events down a websocket this process
// opened, so a manager's reply reaches a laptop or a box behind a firewall
// without a public URL.
//
// The protocol is small. `apps.connections.open` hands out a single-use wss
// URL; Slack sends `hello`, then envelopes that must be acknowledged by id
// within three seconds, and a `disconnect` when it wants the client to move to
// a fresh connection. Everything else is reconnecting well.

import { openConnection, type FetchLike } from './slackApi';

export interface SocketEnvelope {
  type: string;
  envelope_id?: string;
  payload?: unknown;
  reason?: string;
}

/// The slice of the WebSocket API this needs, so a test can hand in a fake.
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketCtor = new (url: string) => SocketLike;

export interface SocketModeDeps {
  appToken: string;
  onEnvelope(env: SocketEnvelope): void | Promise<void>;
  onState?(state: { connected: boolean; error?: string }): void;
  log?(level: 'info' | 'warn', message: string): void;
  WebSocketCtor?: SocketCtor;
  fetchImpl?: FetchLike;
  /// Injected so tests do not wait out real backoff.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export class SocketModeClient {
  private socket: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: unknown = null;

  constructor(private readonly deps: SocketModeDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) (this.deps.clearTimer ?? clearTimeout)(this.retry as ReturnType<typeof setTimeout>);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // already closed
    }
    this.deps.onState?.({ connected: false });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const url = await openConnection(this.deps.appToken, this.deps.fetchImpl);
    if (this.stopped) return;
    if (!url.ok) {
      this.deps.onState?.({ connected: false, error: url.error });
      this.scheduleReconnect();
      return;
    }
    const Ctor = this.deps.WebSocketCtor ?? (globalThis.WebSocket as unknown as SocketCtor | undefined);
    if (!Ctor) {
      this.deps.onState?.({ connected: false, error: 'This runtime has no WebSocket.' });
      return;
    }
    let socket: SocketLike;
    try {
      socket = new Ctor(url.data);
    } catch (err) {
      this.deps.onState?.({ connected: false, error: String(err) });
      this.scheduleReconnect();
      return;
    }
    const previous = this.socket;
    this.socket = socket;
    socket.onmessage = (ev) => this.handle(socket, ev.data);
    socket.onclose = () => {
      // Only the current socket's close matters: a `disconnect` swaps in a
      // new one first, and the old one closing afterwards is expected.
      if (this.socket !== socket) return;
      this.socket = null;
      this.deps.onState?.({ connected: false });
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      this.deps.log?.('warn', 'Slack socket error; reconnecting.');
    };
    // A refreshed connection replaces the old one only once it exists, so no
    // envelope arrives into a gap.
    if (previous) {
      try {
        previous.close();
      } catch {
        // already closed
      }
    }
  }

  private handle(socket: SocketLike, raw: unknown): void {
    let env: SocketEnvelope;
    try {
      env = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as SocketEnvelope;
    } catch {
      return;
    }
    // Acknowledge first: Slack retries anything not acked within three
    // seconds, and handling may take longer than that.
    if (env.envelope_id) {
      try {
        socket.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch {
        // the close handler reconnects
      }
    }
    if (env.type === 'hello') {
      this.attempt = 0;
      this.deps.onState?.({ connected: true });
      return;
    }
    if (env.type === 'disconnect') {
      this.deps.log?.('info', `Slack asked to reconnect (${env.reason ?? 'no reason'}).`);
      void this.connect();
      return;
    }
    if (!env.envelope_id) return;
    void Promise.resolve()
      .then(() => this.deps.onEnvelope(env))
      .catch((err) => this.deps.log?.('warn', `Slack event handler failed: ${String(err)}`));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry !== null) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    // Jitter, so a fleet that lost Slack together does not return together.
    const delay = Math.round(base * (0.5 + (this.deps.random ?? Math.random)() / 2));
    this.retry = (this.deps.setTimer ?? setTimeout)(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }
}
