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

const settings = vi.hoisted(() => ({ current: {} as { notificationWebhookUrl?: string } }));
const logged = vi.hoisted(() => ({ entries: [] as Array<{ level: string; message: string }> }));

vi.mock('./store', () => ({
  Store: { load: () => ({ settings: settings.current }) },
}));

vi.mock('./diagnostics', () => ({
  log: (level: string, _scope: string, message: string) => {
    logged.entries.push({ level, message });
  },
}));

import {
  configuredWebhookUrl,
  postWebhookNotification,
  sendWebhookNotification,
  validateWebhookUrl,
  WEBHOOK_TIMEOUT_MS,
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
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
