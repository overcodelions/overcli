import { describe, expect, it } from 'vitest';
import { SocketModeClient, type SocketCtor, type SocketLike } from './socketMode';
import { validateSlackToken } from './slackSettings';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function client() {
  FakeSocket.all = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let n = 0;
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, url: `wss://acme.example/${++n}` }));
  const envelopes: unknown[] = [];
  const c = new SocketModeClient({
    appToken: 'xapp-test',
    onEnvelope: (env) => {
      envelopes.push(env);
    },
    WebSocketCtor: FakeSocket as unknown as SocketCtor,
    fetchImpl: fetchImpl as never,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    random: () => 1,
  });
  return { c, timers, envelopes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SocketModeClient', () => {
  it('moves to a fresh connection on disconnect and closes the old one after', async () => {
    const { c } = client();
    c.start();
    await tick();
    const first = FakeSocket.all[0];
    first.onmessage!({ data: JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }) });
    await tick();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].url).toBe('wss://acme.example/2');
    expect(first.closed).toBe(true);
    // The old socket closing must not trigger yet another reconnect.
    first.onclose!({});
    await tick();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('backs off after an unexpected close', async () => {
    const { c, timers } = client();
    c.start();
    await tick();
    FakeSocket.all[0].onclose!({});
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000);
    timers[0].fn();
    await tick();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('delivers envelopes after acking them', async () => {
    const { c, envelopes } = client();
    c.start();
    await tick();
    FakeSocket.all[0].onmessage!({ data: JSON.stringify({ type: 'events_api', envelope_id: 'e9', payload: {} }) });
    await tick();
    expect(FakeSocket.all[0].sent).toEqual([JSON.stringify({ envelope_id: 'e9' })]);
    expect(envelopes).toHaveLength(1);
  });

  it('stays down once stopped', async () => {
    const { c, timers } = client();
    c.start();
    await tick();
    c.stop();
    FakeSocket.all[0].onclose!({});
    expect(timers).toHaveLength(0);
  });
});

describe('validateSlackToken', () => {
  it('spots tokens pasted into the wrong box', () => {
    expect(validateSlackToken('bot', 'xapp-1-abc')).toMatch(/app-level/);
    expect(validateSlackToken('app', 'xoxb-123')).toMatch(/bot token/);
  });
  it('accepts the right prefix and blank', () => {
    expect(validateSlackToken('bot', 'xoxb-123-abc')).toBeNull();
    expect(validateSlackToken('app', '')).toBeNull();
  });
});
