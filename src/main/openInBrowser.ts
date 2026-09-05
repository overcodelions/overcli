import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/// Opening a local page in a real browser is NOT the same as opening it in
/// the default app. Every "open it the way the system would" call — macOS
/// `open`, Linux `xdg-open`, a `file://` URL through `shell.openExternal` —
/// follows the registered handler for `.html`, and on a developer's machine
/// that handler is very often an editor: VS Code claims it on install. So
/// "Open in browser" would land in the editor for exactly the people most
/// likely to have set that up, which makes the menu row a lie. We name a
/// browser explicitly and launch that.
///
/// Order is a judgement, stated plainly: Chrome, Arc, Firefox and Edge come
/// before the OS's own browser, because a machine that has one installed it
/// deliberately. Safari on macOS and Edge on Windows sit last as the
/// always-present fallback rather than a choice. The row the user sees is
/// named after whichever we found, never a generic "browser", so it can only
/// promise what it will actually do.

/// How to launch one: `exec` plus a fixed argument prefix, with the file
/// appended. macOS goes through `open -a <app>` (the app bundle isn't
/// executable directly); Windows and Linux run the browser binary itself.
export type Browser = { name: string; exec: string; args: string[] };

const MAC_APPS: ReadonlyArray<{ name: string; app: string }> = [
  { name: 'Chrome', app: '/Applications/Google Chrome.app' },
  { name: 'Arc', app: '/Applications/Arc.app' },
  { name: 'Firefox', app: '/Applications/Firefox.app' },
  { name: 'Safari', app: '/Applications/Safari.app' },
  { name: 'Safari', app: '/System/Applications/Safari.app' },
];

/// Windows installs land under one of three roots depending on whether the
/// installer was per-machine or per-user, so each browser is listed at every
/// place it actually shows up rather than at one canonical path.
function windowsCandidates(env: NodeJS.ProcessEnv): Array<{ name: string; exe: string }> {
  const roots = [
    env['ProgramFiles'] ?? 'C:\\Program Files',
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    env['LOCALAPPDATA'] ?? '',
  ].filter(Boolean);
  const rel: Array<{ name: string; sub: string }> = [
    { name: 'Chrome', sub: 'Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Firefox', sub: 'Mozilla Firefox\\firefox.exe' },
    { name: 'Edge', sub: 'Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  return roots.flatMap((root) => rel.map((r) => ({ name: r.name, exe: `${root}\\${r.sub}` })));
}

/// Linux browsers are binaries on PATH, not fixed install locations. Each
/// name is the command a distro actually ships — `google-chrome-stable` and
/// `chromium-browser` are the Debian/Ubuntu spellings.
const LINUX_BINS: ReadonlyArray<{ name: string; bins: string[] }> = [
  { name: 'Chrome', bins: ['google-chrome', 'google-chrome-stable'] },
  { name: 'Chromium', bins: ['chromium', 'chromium-browser'] },
  { name: 'Firefox', bins: ['firefox'] },
  { name: 'Edge', bins: ['microsoft-edge'] },
];

/// The first installed browser, or null when none is found. Callers treat
/// null as "don't offer the row" rather than falling back to the default
/// handler — see the note above about what that fallback would do.
export function findBrowser(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
  env: NodeJS.ProcessEnv = process.env,
): Browser | null {
  if (platform === 'darwin') {
    const hit = MAC_APPS.find((b) => exists(b.app));
    return hit ? { name: hit.name, exec: 'open', args: ['-a', hit.app] } : null;
  }
  if (platform === 'win32') {
    const hit = windowsCandidates(env).find((b) => exists(b.exe));
    return hit ? { name: hit.name, exec: hit.exe, args: [] } : null;
  }
  // Everything else is treated as Linux/BSD: resolve the command on PATH
  // ourselves rather than relying on the shell, since we spawn without one.
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of LINUX_BINS) {
    for (const bin of entry.bins) {
      for (const dir of dirs) {
        const full = path.join(dir, bin);
        if (exists(full)) return { name: entry.name, exec: full, args: [] };
      }
    }
  }
  return null;
}

export async function openInBrowser(
  file: string,
  browser: Browser,
): Promise<{ ok: true; browser: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    // execFile, not exec: the path is user data and must never reach a shell.
    execFile(browser.exec, [...browser.args, file], (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true, browser: browser.name });
    });
  });
}
