// Getting a notification off the machine.
//
// `host().notify()` has always ended locally: an Electron toast on the
// desktop (`hostElectron.ts`), a stderr line headless (`hostNode.ts`). Both
// comments on that seam say the same thing — the callers are the scheduler
// and the worker engine, and *nobody is there*. That is exactly the case a
// local-only notification cannot serve. This module is the second delivery
// channel: one URL in Settings, and every notification overcli would have
// shown is also POSTed there.
//
// The payload is `{ text, title, body }`. `text` alone is what a Slack
// incoming webhook renders, with no extra configuration; `title`/`body` keep
// it useful for a generic receiver (n8n, webhook.site, a shell script behind
// a tunnel). Slack ignores the two keys it does not know.
//
// WHERE THIS IS WIRED, and why not in `index.ts`. The obvious seam is
// `showDesktopNotification` (index.ts), which every `deps.notify(...)` call
// site funnels through. It is the wrong one: that function lives in the
// Electron-only main file, so it cannot see the watch loop
// (`flows/watch/notify.ts` calls `host().notify()` directly) and cannot exist
// at all under `overcli serve`, whose engines are built in `cli/engines.ts`
// and never load `index.ts`. Those are precisely the runs where the user is
// most away from the desktop. So the fan-out sits one layer down, on the two
// host implementations plus the one headless path that bypasses the host
// (`cli/engines.ts` hands `onNotify` straight to `WorkerEngine`).
//
// The rule that keeps that correct: EXACTLY ONE `withWebhookNotify` wrap per
// delivery path. Wrapping both `showDesktopNotification` and the host would
// double-post every desktop notification.
//
// Best-effort by construction, like the desktop notification it accompanies.
// A dead receiver, a typo'd URL, or a five-second stall must not take down a
// worker shift, so on the notification path every failure is logged at `warn`
// and swallowed. `sendWebhookNotification` is the one entry point that
// REPORTS failure instead, because the Settings "Send test" button is the one
// caller that has a human waiting for the answer.

import { log } from './diagnostics';
import { host } from './host';
import { Store } from './store';

export interface WebhookNotifyArgs {
  title: string;
  body: string;
}

export type WebhookSendResult = { ok: true } | { ok: false; error: string };

/// Long enough for a slow webhook receiver, short enough that a black-holed
/// URL cannot pin a request open for the life of the process.
export const WEBHOOK_TIMEOUT_MS = 5000;

/// Where the auth token lives in `host().secrets` — the same safeStorage-backed
/// store that holds registry bearer tokens (`flows/registryAuth.ts`). The token
/// is a real credential, so unlike the URL it never goes near `overcli.json`.
export const WEBHOOK_TOKEN_KEY = 'notify-webhook-token';

/// Headless override. `overcli serve` has no keychain: `hostNode`'s secrets are
/// read-only and backed by the environment. It is also the only way to supply a
/// token there, because `envSecrets.get` does not read the key it is handed — it
/// routes through `registryTokenEnvName`, which would turn this key into
/// `OVERCLI_REGISTRY_TOKEN_NOTIFY_WEBHOOK_TOKEN`, a registry-shaped name for
/// something that is not a registry. A dedicated variable avoids that entirely.
///
/// The env var WINS over the stored value: on a box where both exist, the one
/// the operator set for this process is the more specific intent.
export const WEBHOOK_TOKEN_ENV = 'OVERCLI_NOTIFY_WEBHOOK_TOKEN';

/// What almost every receiver wants. Configurable because a meaningful minority
/// does not: ntfy and PagerDuty take `Authorization`, but plenty of bespoke
/// endpoints behind a gateway want `X-API-Key` or a vendor-specific name.
export const DEFAULT_WEBHOOK_AUTH_HEADER = 'Authorization';

export interface WebhookAuth {
  header: string;
  token: string;
}

/// Hosts whose traffic never leaves the machine, so plain `http:` to them is not
/// an exposure. Deliberately the three exact spellings rather than the whole
/// 127.0.0.0/8 range: this is a refusal path, and a user pointing a webhook at
/// 127.0.0.2 is rare enough that being asked to use 127.0.0.1 is a better
/// outcome than a looser check nobody reviewed.
function isLoopbackHost(hostname: string): boolean {
  // `new URL('http://[::1]/x').hostname` keeps the brackets.
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

/// Refuse to put a credential on the wire in the clear. Returns an error string
/// when sending should NOT happen, or null when it is fine.
///
/// The rule is narrow on purpose. Without a token there is no restriction at
/// all — plain `http:` to anywhere stays legal, which is the behaviour that
/// shipped with the webhook and which some intranet receivers rely on. It is
/// only the presence of a credential that raises the bar, and only for hosts
/// the request actually leaves the machine to reach.
///
/// This REFUSES rather than warning-and-sending. A warning in a diagnostics log
/// nobody is reading is not consent, and the notification path is unattended by
/// definition — the whole point of the webhook is that nobody is at the desktop.
export function transportRefusal(url: string, hasToken: boolean): string | null {
  if (!hasToken) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Shape errors belong to `validateWebhookUrl`; say nothing here.
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (isLoopbackHost(parsed.hostname)) return null;
  return `Refusing to send an auth token over plain http: to ${parsed.hostname}. Use https:, or drop the token.`;
}

/// The configured token, or null when there is none. Never throws: this sits on
/// the notification path, so a locked or corrupt keychain must degrade to an
/// unauthenticated POST rather than take a worker shift down.
export function configuredWebhookToken(): string | null {
  try {
    const fromEnv = process.env[WEBHOOK_TOKEN_ENV]?.trim();
    if (fromEnv) return fromEnv;
    const stored = host().secrets.get(WEBHOOK_TOKEN_KEY)?.trim();
    return stored ? stored : null;
  } catch (err) {
    log('warn', 'webhook.notify', `Could not read the webhook auth token: ${String(err)}`);
    return null;
  }
}

/// The header name to send the token under. Same defensive wrap as
/// `configuredWebhookUrl` — a broken store falls back to the default rather
/// than throwing past the caller.
export function configuredWebhookAuthHeader(): string {
  let raw: string | undefined;
  try {
    raw = Store.load().settings.notificationWebhookAuthHeader;
  } catch (err) {
    log('warn', 'webhook.notify', `Could not read the webhook auth header: ${String(err)}`);
    return DEFAULT_WEBHOOK_AUTH_HEADER;
  }
  const trimmed = raw?.trim();
  return trimmed ? trimmed : DEFAULT_WEBHOOK_AUTH_HEADER;
}

/// Token plus header name, or null when the webhook is unauthenticated.
export function configuredWebhookAuth(): WebhookAuth | null {
  const token = configuredWebhookToken();
  if (!token) return null;
  return { header: configuredWebhookAuthHeader(), token };
}

/// Accept only what `fetch` can actually POST over a network. A settings
/// field is user input, and `file:`/`javascript:` are not network calls.
/// Returns the trimmed URL, or an error string naming what was wrong.
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'No webhook URL is set.' };
  let protocol: string;
  try {
    ({ protocol } = new URL(trimmed));
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: `Unsupported scheme "${protocol}" — use http: or https:.` };
  }
  return { ok: true, url: trimmed };
}

/// The configured destination, or null when the webhook is off. Anything
/// unparseable is treated as "off" plus a diagnostics warning: a bad settings
/// value must not make the notification path throw.
export function configuredWebhookUrl(): string | null {
  let raw: string | undefined;
  try {
    raw = Store.load().settings.notificationWebhookUrl;
  } catch (err) {
    log('warn', 'webhook.notify', `Could not read the webhook setting: ${String(err)}`);
    return null;
  }
  if (!raw || !raw.trim()) return null;
  const checked = validateWebhookUrl(raw);
  if (!checked.ok) {
    log('warn', 'webhook.notify', `Ignoring notification webhook: ${checked.error}`);
    return null;
  }
  return checked.url;
}

/// POST one notification and say whether it landed. Never throws — a
/// transport failure, a non-2xx status and the 5s timeout all come back as
/// `{ ok: false }` so a caller can either report or swallow, its choice.
///
/// `auth` is optional and, when present, is sent VERBATIM under its own header
/// name. No `Bearer ` is prepended: ntfy's own docs show tokens written as
/// `Bearer tk_...` while a raw opaque token is equally legal elsewhere, so
/// guessing silently breaks one of the two with an error the user cannot
/// diagnose from the receiver's end. What you paste is what goes out.
export async function sendWebhookNotification(
  url: string,
  args: WebhookNotifyArgs,
  auth?: WebhookAuth | null,
): Promise<WebhookSendResult> {
  // Before the controller and the timer, so a refusal costs no fetch and
  // leaves no stray timer behind.
  const refusal = transportRefusal(url, Boolean(auth?.token));
  if (refusal) return { ok: false, error: refusal };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  // A pending timer keeps a headless `overcli run` alive past its own exit.
  // `unref` is a Node timer method the DOM timer typings don't carry, hence
  // the optional call rather than a cast.
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { [auth.header]: auth.token } : {}),
      },
      body: JSON.stringify({
        text: `${args.title}: ${args.body}`,
        title: args.title,
        body: args.body,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `Webhook returned ${res.status}.` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/// Fire-and-forget POST of one notification to the configured webhook.
/// Returns immediately; the request runs unawaited and reports only to the
/// diagnostics log. This is what the hosts call.
export function postWebhookNotification(args: WebhookNotifyArgs): void {
  const url = configuredWebhookUrl();
  if (!url) return;
  void sendWebhookNotification(url, args, configuredWebhookAuth()).then((res) => {
    if (!res.ok) log('warn', 'webhook.notify', `Notification webhook failed: ${res.error}`);
  });
}

/// Decorate a `notify` with the webhook. The webhook fires FIRST so that a
/// host whose local notification is unavailable — `Notification.isSupported()`
/// is false on a Linux box with no notification daemon, and `electronHost`
/// returns early there — still reaches the user.
export function withWebhookNotify(
  notify: (args: WebhookNotifyArgs) => void,
): (args: WebhookNotifyArgs) => void {
  return (args) => {
    postWebhookNotification(args);
    notify(args);
  };
}
