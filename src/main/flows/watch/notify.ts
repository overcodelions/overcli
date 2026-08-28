// Telling the user a watch tick found something. The whole point of watching
// is that they are AFK, so this has to leave the app — a desktop notification
// under Electron, a stderr line under `overcli serve`. Which one is the host's
// business, not this file's; see src/main/host.ts.
//
// Best-effort by construction: the host's `notify` swallows its own failures,
// because a Linux box with no notification daemon must not take the watch
// loop down with it.

import { host } from '../../host';

export function notifyWatch(title: string, body: string): void {
  host().notify({ title, body });
}
