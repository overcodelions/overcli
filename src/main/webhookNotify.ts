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
import { Store } from './store';

export interface WebhookNotifyArgs {
  title: string;
  body: string;
}

export type WebhookSendResult = { ok: true } | { ok: false; error: string };

/// Long enough for a slow webhook receiver, short enough that a black-holed
/// URL cannot pin a request open for the life of the process.
export const WEBHOOK_TIMEOUT_MS = 5000;

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
export async function sendWebhookNotification(
  url: string,
  args: WebhookNotifyArgs,
): Promise<WebhookSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  // A pending timer keeps a headless `overcli run` alive past its own exit.
  // `unref` is a Node timer method the DOM timer typings don't carry, hence
  // the optional call rather than a cast.
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  void sendWebhookNotification(url, args).then((res) => {
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
