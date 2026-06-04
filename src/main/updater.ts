import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { log } from './diagnostics';
import { Store } from './store';

const { autoUpdater } = electronUpdater;

let wired = false;
let getWindowRef: () => BrowserWindow | null = () => null;

// Map the user's channel setting onto electron-updater's channel + prerelease
// flags. 'stable' follows the `latest` feed (tagged releases); 'nightly'
// follows the rolling `nightly` prerelease feed. The setting is the single
// source of truth regardless of which build was originally installed.
function applyChannel(): void {
  const channel = Store.load().settings.updateChannel ?? 'stable';
  if (channel === 'nightly') {
    autoUpdater.channel = 'nightly';
    autoUpdater.allowPrerelease = true;
  } else {
    autoUpdater.channel = 'latest';
    autoUpdater.allowPrerelease = false;
  }
  log('info', 'updater', `channel = ${autoUpdater.channel}`);
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err) => log('error', 'updater', 'checkForUpdates threw', err));
}

// Wire electron-updater against the GitHub Releases feed declared in
// package.json `build.publish`. Download happens in the background; the
// install is deferred until the user quits so we never interrupt a turn.
//
// macOS note: Squirrel.Mac refuses to install an *unsigned* update, so this
// is a no-op on unsigned/dev builds. That's why signing + notarization are a
// hard prerequisite, not a nicety.
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow;
  // Updates only exist for a packaged .app/.exe — skip in dev entirely.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log('info', 'updater', String(m)),
    warn: (m: unknown) => log('warn', 'updater', String(m)),
    error: (m: unknown) => log('error', 'updater', String(m)),
    debug: (m: unknown) => log('info', 'updater', String(m)),
  };

  const notify = (type: string, payload?: unknown) => {
    const win = getWindowRef();
    if (win && !win.isDestroyed()) win.webContents.send('main:event', { type, payload });
  };

  autoUpdater.on('update-available', (info) => {
    log('info', 'updater', `update available: ${info.version}`);
    notify('update:available', { version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    log('info', 'updater', 'no update available');
  });
  autoUpdater.on('download-progress', (p) => {
    notify('update:progress', { percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log('info', 'updater', `update downloaded: ${info.version} (installs on quit)`);
    notify('update:downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    log('error', 'updater', 'auto-update check failed', err);
  });

  wired = true;
  applyChannel();

  // Check shortly after launch so we don't compete with window creation, then
  // poll every 6 hours for long-running sessions.
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// Called from the store:saveSettings IPC handler so flipping the channel in
// Settings takes effect immediately — re-point the feed and check right away.
export function refreshUpdateChannel(): void {
  if (!wired) return;
  applyChannel();
  check();
}

// Quit and install a downloaded update now — invoked when the user clicks
// "Restart" in the UpdateToast instead of waiting for the next quit.
export function quitAndInstall(): void {
  if (!wired) return;
  autoUpdater.quitAndInstall();
}
