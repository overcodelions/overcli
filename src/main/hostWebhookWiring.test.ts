// Proof that the webhook is actually WIRED, not merely implemented.
//
// webhookNotify.test.ts proves the module. It cannot prove that any host
// calls it — and the wiring is the whole feature, because the reason the
// fan-out lives on the host rather than on `showDesktopNotification`
// (index.ts) is that index.ts is Electron-only and cannot see the watch loop
// or `overcli serve`. Delete a `withWebhookNotify(...)` from either host and
// the module's own suite stays green; these cases go red.
//
// Both hosts are asserted in one file so the two cannot drift: the whole
// point of the design is that the desktop and the headless build behave the
// same way here.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ current: {} as { notificationWebhookUrl?: string } }));

vi.mock('./store', () => ({
  Store: { load: () => ({ settings: settings.current }) },
}));

vi.mock('./diagnostics', () => ({ log: () => {} }));

// hostElectron imports electron at module load; the notification itself is
// not under test here, only that the webhook rides alongside it.
const shown = vi.hoisted(() => ({ titles: [] as string[] }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/overcli-webhook-wiring' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: Object.assign(
    class {
      constructor(opts: { title: string; body: string }) {
        shown.titles.push(opts.title);
      }
      on() {}
      show() {}
    },
    { isSupported: () => true },
  ),
}));

import { electronHost } from './hostElectron';
import { nodeHost } from './hostNode';

const URL_OK = 'https://hooks.example.test/hook';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  settings.current = {};
  shown.titles = [];
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function postedTitles(): string[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string).title as string,
  );
}

describe('the Electron host posts the webhook alongside the OS notification', () => {
  it('does not post when no URL is configured', async () => {
    electronHost().notify({ title: 'quiet', body: 'x' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown.titles).toEqual(['quiet']);
  });

  it('posts once, and still shows the OS notification', async () => {
    settings.current = { notificationWebhookUrl: URL_OK };
    electronHost().notify({ title: 'worker paused', body: 'needs approval' });
    await flush();
    // Exactly once. Wrapping BOTH this host and `showDesktopNotification`
    // would make every desktop notification post twice.
    expect(postedTitles()).toEqual(['worker paused']);
    expect(shown.titles).toEqual(['worker paused']);
  });
});

describe('the headless host posts the webhook alongside its own notify', () => {
  it('wraps the caller-supplied onNotify, not just the stderr default', async () => {
    // `overcli run` supplies onNotify (cli/run.ts routes it into the
    // reporter), so wrapping only the default would leave every real
    // headless run with no webhook at all.
    settings.current = { notificationWebhookUrl: URL_OK };
    const seen: string[] = [];
    nodeHost({ dataDir: '/tmp/overcli-webhook-wiring', onNotify: (a) => seen.push(a.title) }).notify({
      title: 'scheduled run failed',
      body: 'no such flow',
    });
    await flush();
    expect(postedTitles()).toEqual(['scheduled run failed']);
    expect(seen).toEqual(['scheduled run failed']);
  });

  it('is silent when no URL is configured', async () => {
    const seen: string[] = [];
    nodeHost({ dataDir: '/tmp/overcli-webhook-wiring', onNotify: (a) => seen.push(a.title) }).notify({
      title: 'quiet',
      body: 'x',
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seen).toEqual(['quiet']);
  });
});
