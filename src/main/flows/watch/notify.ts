// Native desktop notification for watch events. A native OS notification is
// the right surface here: the whole point of watching is that the user is
// AFK, so an in-app toast they're not looking at is useless — but a system
// notification reaches them on the desktop. Best-effort: if the platform
// can't show one, we log and move on rather than failing the tick.

import { Notification } from 'electron';
import { log } from '../../diagnostics';

export function notifyWatch(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) {
      log('info', 'flows.watch.notify', `(unsupported) ${title}: ${body}`);
      return;
    }
    new Notification({ title, body, silent: false }).show();
  } catch (err) {
    log('warn', 'flows.watch.notify', 'failed to show watch notification', err);
  }
}
