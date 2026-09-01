// The outbound notification webhook.
//
// `Store` and `diagnostics` are mocked in the house style (see
// updater.test.ts / whatsNew.test.ts) so the module under test is exercised
// as a pure function of one settings string plus one `fetch`.
//
// The load-bearing assertion in most of these is NOT that the request was
// shaped right — it is that nothing threw and nothing was posted. A
// notification path that can throw takes a worker shift down with it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(
  () =>
    ({ current: {} }) as {
      current: {
        notificationWebhookUrl?: string;
        notificationWebhookAuthHeader?: string;
        notificationWebhookFilter?: 'all' | 'failures';
      };
    },
);
const logged = vi.hoisted(() => ({ entries: [] as Array<{ level: string; message: string }> }));

/// The secret store, swappable per-test. `throws` stands in for a locked or
/// corrupt keychain — the case that must degrade to an unauthenticated POST
/// rather than take the notification path down.
const secrets = vi.hoisted(() => ({ token: null as string | null, throws: false }));

vi.mock('./store', () => ({
  Store: { load: () => ({ settings: settings.current }) },
}));

vi.mock('./host', () => ({
  host: () => ({
    secrets: {
      get: () => {
        if (secrets.throws) throw new Error('keychain locked');
        return secrets.token;
      },
      set: () => true,
    },
  }),
}));

vi.mock('./diagnostics', () => ({
  log: (level: string, _scope: string, message: string) => {
    logged.entries.push({ level, message });
  },
}));

import {
  configuredWebhookAuth,
  configuredWebhookAuthHeader,
  configuredWebhookFilter,
  lastWebhookDelivery,
  resetWebhookDelivery,
  shouldPostKind,
  configuredWebhookToken,
  configuredWebhookUrl,
  postWebhookNotification,
  sendWebhookNotification,
  transportRefusal,
  validateWebhookUrl,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_TOKEN_ENV,
  withWebhookNotify,
} from './webhookNotify';

const URL_OK = 'https://hooks.example.test/services/T000/B000/xxxx';

function okResponse() {
  return { ok: true, status: 200 } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  settings.current = {};
  logged.entries = [];
  resetWebhookDelivery();
  secrets.token = null;
  secrets.throws = false;
  delete process.env[WEBHOOK_TOKEN_ENV];
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[WEBHOOK_TOKEN_ENV];
});

/// Headers of the Nth fetch call, as a plain object.
function headersOf(call = 0): Record<string, string> {
  return fetchMock.mock.calls[call][1].headers as Record<string, string>;
}

/// `postWebhookNotification` returns before its request settles, by design.
/// Give the unawaited promise chain a turn to run.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('validateWebhookUrl', () => {
  it('accepts http and https', () => {
    expect(validateWebhookUrl(URL_OK)).toEqual({ ok: true, url: URL_OK });
    expect(validateWebhookUrl('  http://localhost:9000/hook  ')).toEqual({
      ok: true,
      url: 'http://localhost:9000/hook',
    });
  });

  it('rejects an empty value, a non-URL, and a non-network scheme', () => {
    expect(validateWebhookUrl('   ').ok).toBe(false);
    expect(validateWebhookUrl('not a url').ok).toBe(false);
    // The reason this check exists: `fetch('file:///etc/passwd')` is not a
    // network call, and this field is user input.
    const bad = validateWebhookUrl('file:///etc/passwd');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain('file:');
  });
});

describe('configuredWebhookUrl', () => {
  it('is null when unset, empty, or whitespace', () => {
    expect(configuredWebhookUrl()).toBeNull();
    settings.current = { notificationWebhookUrl: '' };
    expect(configuredWebhookUrl()).toBeNull();
    settings.current = { notificationWebhookUrl: '   ' };
    expect(configuredWebhookUrl()).toBeNull();
    expect(logged.entries).toEqual([]);
  });

  it('is null and warns when the stored value is unusable', () => {
    settings.current = { notificationWebhookUrl: 'javascript:alert(1)' };
    expect(configuredWebhookUrl()).toBeNull();
    expect(logged.entries).toHaveLength(1);
    expect(logged.entries[0].level).toBe('warn');
  });

  it('returns the URL when set', () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    expect(configuredWebhookUrl()).toBe(URL_OK);
  });
});

describe('postWebhookNotification', () => {
  it('does nothing at all when no URL is configured', async () => {
    postWebhookNotification({ title: 'Shift done', body: '3 items' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs JSON with a Slack-compatible text key when a URL is set', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    postWebhookNotification({ title: 'nightly failed', body: 'no such flow' });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'nightly failed: no such flow',
      title: 'nightly failed',
      body: 'no such flow',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('swallows a transport failure and logs it at warn', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(() => postWebhookNotification({ title: 'a', body: 'b' })).not.toThrow();
    await flush();
    expect(logged.entries).toHaveLength(1);
    expect(logged.entries[0].level).toBe('warn');
    expect(logged.entries[0].message).toContain('ECONNREFUSED');
  });

  it('swallows a non-2xx response and logs the status', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    expect(() => postWebhookNotification({ title: 'a', body: 'b' })).not.toThrow();
    await flush();
    expect(logged.entries).toHaveLength(1);
    expect(logged.entries[0].message).toContain('404');
  });

  it('swallows a throwing settings read rather than taking the caller down', async () => {
    // The scheduler and the worker engine call this. If a corrupt store can
    // make notify() throw, a shift dies on the notification, not on the work.
    const { Store } = await import('./store');
    vi.spyOn(Store, 'load').mockImplementation(() => {
      throw new Error('overcli.json unreadable');
    });
    expect(() => postWebhookNotification({ title: 'a', body: 'b' })).not.toThrow();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.entries[0].level).toBe('warn');
    vi.restoreAllMocks();
  });
});

describe('sendWebhookNotification', () => {
  it('reports success and failure instead of swallowing (the Send-test path)', async () => {
    await expect(sendWebhookNotification(URL_OK, { title: 'a', body: 'b' })).resolves.toEqual({
      ok: true,
    });

    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const bad = await sendWebhookNotification(URL_OK, { title: 'a', body: 'b' });
    expect(bad).toEqual({ ok: false, error: 'Webhook returned 500.' });

    fetchMock.mockRejectedValue(new Error('boom'));
    const worse = await sendWebhookNotification(URL_OK, { title: 'a', body: 'b' });
    expect(worse.ok).toBe(false);
  });

  it('aborts the request when the receiver never answers', async () => {
    vi.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      fetchMock.mockImplementation(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            captured = init.signal ?? undefined;
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const pending = sendWebhookNotification(URL_OK, { title: 'a', body: 'b' });
      expect(captured?.aborted).toBe(false);
      vi.advanceTimersByTime(WEBHOOK_TIMEOUT_MS);
      expect(captured?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withWebhookNotify', () => {
  it('always delegates, whether the webhook is on or off', async () => {
    const seen: string[] = [];
    const wrapped = withWebhookNotify((a) => seen.push(a.title));

    wrapped({ title: 'off', body: 'x' });
    await flush();
    expect(seen).toEqual(['off']);
    expect(fetchMock).not.toHaveBeenCalled();

    settings.current = { notificationWebhookUrl: URL_OK };
    wrapped({ title: 'on', body: 'x' });
    await flush();
    expect(seen).toEqual(['off', 'on']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still delegates when the webhook throws on the way past', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    fetchMock.mockRejectedValue(new Error('nope'));
    const seen: string[] = [];
    const wrapped = withWebhookNotify((a) => seen.push(a.title));
    expect(() => wrapped({ title: 'local still fires', body: 'x' })).not.toThrow();
    await flush();
    expect(seen).toEqual(['local still fires']);
  });
});

// ---------- auth ----------
//
// The load-bearing assertions here are about what does NOT happen: no header
// when nothing is configured, no `Bearer ` the user did not type, no fetch at
// all when the transport is refused, and no throw when the keychain is broken.

describe('configuredWebhookToken', () => {
  it('is null when neither the env var nor the store has one', () => {
    expect(configuredWebhookToken()).toBeNull();
  });

  it('reads the keychain when there is no env var', () => {
    secrets.token = 'from-keychain';
    expect(configuredWebhookToken()).toBe('from-keychain');
  });

  it('lets the env var win over the keychain', () => {
    secrets.token = 'from-keychain';
    process.env[WEBHOOK_TOKEN_ENV] = '  from-env  ';
    expect(configuredWebhookToken()).toBe('from-env');
  });

  it('warns and returns null when the secret store throws, rather than propagating', () => {
    secrets.throws = true;
    expect(() => configuredWebhookToken()).not.toThrow();
    expect(configuredWebhookToken()).toBeNull();
    expect(logged.entries.some((e) => e.level === 'warn' && /auth token/.test(e.message))).toBe(
      true,
    );
  });
});

describe('configuredWebhookAuthHeader', () => {
  it('defaults to Authorization when unset or blank', () => {
    expect(configuredWebhookAuthHeader()).toBe('Authorization');
    settings.current = { notificationWebhookAuthHeader: '   ' };
    expect(configuredWebhookAuthHeader()).toBe('Authorization');
  });

  it('trims and uses a custom header name', () => {
    settings.current = { notificationWebhookAuthHeader: '  X-API-Key ' };
    expect(configuredWebhookAuthHeader()).toBe('X-API-Key');
  });
});

describe('configuredWebhookAuth', () => {
  it('is null without a token, even when a header name is set', () => {
    settings.current = { notificationWebhookAuthHeader: 'X-API-Key' };
    expect(configuredWebhookAuth()).toBeNull();
  });

  it('pairs the token with the configured header', () => {
    secrets.token = 'tok';
    settings.current = { notificationWebhookAuthHeader: 'X-API-Key' };
    expect(configuredWebhookAuth()).toEqual({ header: 'X-API-Key', token: 'tok' });
  });
});

describe('transportRefusal', () => {
  it('allows plain http when there is no token at all (the shipped behaviour)', () => {
    expect(transportRefusal('http://intranet.example.test/hook', false)).toBeNull();
  });

  it('refuses http + token to a remote host', () => {
    const refusal = transportRefusal('http://intranet.example.test/hook', true);
    expect(refusal).toMatch(/Refusing to send an auth token over plain http/);
    expect(refusal).toMatch(/intranet\.example\.test/);
  });

  it('allows https + token', () => {
    expect(transportRefusal('https://intranet.example.test/hook', true)).toBeNull();
  });

  it('allows http + token to loopback in all three spellings', () => {
    expect(transportRefusal('http://localhost:8080/hook', true)).toBeNull();
    expect(transportRefusal('http://127.0.0.1:8080/hook', true)).toBeNull();
    expect(transportRefusal('http://[::1]:8080/hook', true)).toBeNull();
  });
});

describe('sendWebhookNotification auth', () => {
  it('sends no auth header when none is passed', async () => {
    await sendWebhookNotification(URL_OK, { title: 't', body: 'b' });
    expect(headersOf()).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends the token under the given header name', async () => {
    await sendWebhookNotification(URL_OK, { title: 't', body: 'b' }, {
      header: 'X-API-Key',
      token: 'abc123',
    });
    expect(headersOf()['X-API-Key']).toBe('abc123');
    expect(headersOf()['Content-Type']).toBe('application/json');
  });

  it('sends the token VERBATIM — no Bearer is invented, and one already there is kept', async () => {
    await sendWebhookNotification(URL_OK, { title: 't', body: 'b' }, {
      header: 'Authorization',
      token: 'tk_raw_opaque',
    });
    expect(headersOf()['Authorization']).toBe('tk_raw_opaque');
    fetchMock.mockClear();
    await sendWebhookNotification(URL_OK, { title: 't', body: 'b' }, {
      header: 'Authorization',
      token: 'Bearer tk_already_prefixed',
    });
    expect(headersOf()['Authorization']).toBe('Bearer tk_already_prefixed');
  });

  it('makes ZERO fetch calls when the transport is refused', async () => {
    const res = await sendWebhookNotification(
      'http://intranet.example.test/hook',
      { title: 't', body: 'b' },
      { header: 'Authorization', token: 'tok' },
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/Refusing to send an auth token over plain http/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('postWebhookNotification auth', () => {
  it('attaches the keychain token as Authorization by default', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    secrets.token = 'from-keychain';
    postWebhookNotification({ title: 't', body: 'b' });
    await flush();
    expect(headersOf()['Authorization']).toBe('from-keychain');
  });

  it('uses the custom header name from settings', async () => {
    settings.current = { notificationWebhookUrl: URL_OK, notificationWebhookAuthHeader: 'X-API-Key' };
    secrets.token = 'from-keychain';
    postWebhookNotification({ title: 't', body: 'b' });
    await flush();
    expect(headersOf()['X-API-Key']).toBe('from-keychain');
    expect(headersOf()['Authorization']).toBeUndefined();
  });

  it('still posts, unauthenticated, when the secret store is broken', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    secrets.throws = true;
    expect(() => postWebhookNotification({ title: 't', body: 'b' })).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOf()).toEqual({ 'Content-Type': 'application/json' });
  });

  it('warns and drops — does not throw, does not post — when the transport is refused', async () => {
    settings.current = { notificationWebhookUrl: 'http://intranet.example.test/hook' };
    secrets.token = 'tok';
    expect(() => postWebhookNotification({ title: 't', body: 'b' })).not.toThrow();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      logged.entries.some(
        (e) => e.level === 'warn' && /Refusing to send an auth token over plain http/.test(e.message),
      ),
    ).toBe(true);
  });
});

// ---------- filtering ----------
//
// The failure mode being defended against is not noise, it is silence: a
// channel that also carries "worker X finished a shift" gets muted, and a
// muted channel delivers the one message that mattered no better than no
// webhook at all.

describe('configuredWebhookFilter', () => {
  it('defaults to forwarding everything, and treats junk as the default', () => {
    expect(configuredWebhookFilter()).toBe('all');
    settings.current = { notificationWebhookFilter: 'failures' };
    expect(configuredWebhookFilter()).toBe('failures');
    settings.current = { notificationWebhookFilter: 'nonsense' as 'all' };
    expect(configuredWebhookFilter()).toBe('all');
  });
});

describe('shouldPostKind', () => {
  it('lets every kind through on "all"', () => {
    for (const kind of ['failure', 'progress', 'watch', undefined] as const) {
      expect(shouldPostKind(kind, 'all')).toBe(true);
    }
  });

  it('lets only failures through on "failures"', () => {
    expect(shouldPostKind('failure', 'failures')).toBe(true);
    expect(shouldPostKind('progress', 'failures')).toBe(false);
    expect(shouldPostKind('watch', 'failures')).toBe(false);
    // An unmarked call site reads as progress, so a site that forgets to
    // classify itself under-delivers rather than crying wolf.
    expect(shouldPostKind(undefined, 'failures')).toBe(false);
  });
});

describe('postWebhookNotification, filtered', () => {
  it('drops a filtered kind and posts an unfiltered one', async () => {
    settings.current = { notificationWebhookUrl: URL_OK, notificationWebhookFilter: 'failures' };
    postWebhookNotification({ title: 'T', body: 'B', kind: 'progress' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    postWebhookNotification({ title: 'T', body: 'B', kind: 'failure' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still shows the LOCAL notification for a filtered kind', async () => {
    // Filtering is about what leaves the machine. The desktop toast is not
    // negotiable — the user is at the desk in that case.
    settings.current = { notificationWebhookUrl: URL_OK, notificationWebhookFilter: 'failures' };
    const seen: string[] = [];
    const wrapped = withWebhookNotify((a) => seen.push(a.title));
    wrapped({ title: 'local only', body: 'x', kind: 'progress' });
    await flush();
    expect(seen).toEqual(['local only']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------- delivery status ----------
//
// The gap this closes: a webhook that has silently stopped delivering is
// indistinguishable from a quiet week, and the user is by definition not at
// the machine to notice.

describe('lastWebhookDelivery', () => {
  it('is null until something is actually sent', () => {
    expect(lastWebhookDelivery()).toBeNull();
  });

  it('counts consecutive failures and clears the streak on success', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    fetchMock.mockRejectedValue(new Error('down'));
    postWebhookNotification({ title: 'T', body: 'B' });
    await flush();
    postWebhookNotification({ title: 'T', body: 'B' });
    await flush();
    expect(lastWebhookDelivery()).toMatchObject({ ok: false, consecutiveFailures: 2 });

    fetchMock.mockResolvedValue(okResponse());
    postWebhookNotification({ title: 'T', body: 'B' });
    await flush();
    expect(lastWebhookDelivery()).toMatchObject({ ok: true, consecutiveFailures: 0 });
  });

  it('carries the reason the delivery failed', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    postWebhookNotification({ title: 'T', body: 'B' });
    await flush();
    expect(lastWebhookDelivery()?.error).toContain('404');
  });

  it('does not record a filtered notification as a delivery', async () => {
    // The trap: recording a deliberate skip as a success would mask a
    // webhook that has genuinely stopped working.
    settings.current = { notificationWebhookUrl: URL_OK, notificationWebhookFilter: 'failures' };
    postWebhookNotification({ title: 'T', body: 'B', kind: 'progress' });
    await flush();
    expect(lastWebhookDelivery()).toBeNull();
  });
});
