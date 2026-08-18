// Opens a fresh terminal window with a command pre-typed and run.
// macOS-only today: AppleScript drives Terminal.app so users see progress
// and can respond to interactive prompts (sudo, device codes, browser
// OAuth flows). Other platforms fall back to an error message the caller
// can surface so the user runs the command themselves.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { log } from './diagnostics';

/// On failure `command` carries the exact shell line we wanted to run, kept
/// separate from the prose so the UI can offer it as a copyable block rather
/// than making the user pick it out of a sentence.
export type TerminalLaunchResult =
  | { ok: true }
  | { ok: false; error: string; command?: string };

// `do script` passes the string to the user's login shell, so any shell
// metacharacter in the command reaches sh/bash/zsh. Command substitution
// (backtick, `$(...)`) and control operators (`;`, `&&`, `|`) are the
// dangerous ones — reject them so a malformed backend path can't escape
// into shell execution.
const FORBIDDEN_COMMAND_PATTERNS = /[`$;&|<>\n\r]/;

// osascript exits as soon as Terminal accepts the `do script` — the command
// itself keeps running in the window, so this budget only has to cover the
// `delay 0.8` plus Terminal launching. Anything longer is a wedge (a modal
// permission sheet, a hung Terminal) that we'd rather report than wait on.
const OSASCRIPT_TIMEOUT_MS = 15_000;

function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/// Runs an AppleScript and waits for osascript to exit, capturing stderr.
/// We deliberately do NOT detach with `stdio: 'ignore'` here: that hides the
/// single most common failure, macOS refusing the Apple Event with -1743
/// because the app has no Automation access for Terminal. osascript exits 1,
/// nothing opens, and the old code still reported success.
function runAppleScript(script: string): Promise<TerminalLaunchResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err: any) {
      resolve({ ok: false, error: err?.message ?? String(err) });
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (result: TerminalLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `osascript did not return within ${OSASCRIPT_TIMEOUT_MS}ms.` });
    }, OSASCRIPT_TIMEOUT_MS);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err: any) => finish({ ok: false, error: err?.message ?? String(err) }));
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({ ok: false, error: stderr.trim() || `osascript exited with code ${code}.` });
    });
  });
}

/// True when macOS refused the Apple Event outright. Under the hardened
/// runtime this needs both the com.apple.security.automation.apple-events
/// entitlement and NSAppleEventsUsageDescription; it also fails when the
/// process that launched us (a terminal emulator, in dev) no longer has a
/// verifiable code signature, which TCC reports the same way.
function isAutomationDenial(error: string): boolean {
  return error.includes('-1743') || /not authorized to send apple events/i.test(error);
}

function runWindowsTerminal(command: string, cwd?: string): TerminalLaunchResult {
  try {
    // Launch through `start` so Windows reliably creates a visible
    // console window even when the Electron parent has no attached TTY.
    spawn(
      'cmd.exe',
      ['/d', '/c', 'start', '', 'powershell.exe', '-NoProfile', '-NoExit', '-Command', command],
      {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    ).unref();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Opens Terminal.app in `cwd` and runs `command` there. We first
// `open -a Terminal <cwd>` so a new window launches with the shell
// already cwd'd into the workspace, then tell Terminal via AppleScript
// to run the command in that window. The two-step is deliberate on both
// counts: doing `do script "cd && ..."` in one shot races the shell's
// init and the typed command ends up sitting in the buffer unexecuted,
// and `open` needs no Apple Events, so the user still gets a visible
// window to paste into when the `do script` half is refused by TCC.
async function launchTerminalWith(cwd: string, command: string): Promise<TerminalLaunchResult> {
  try {
    spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' }).unref();
  } catch (err: any) {
    const error = err?.message ?? String(err);
    log('warn', 'terminal', `open -a Terminal failed: ${error}`);
    return { ok: false, error };
  }
  // Give Terminal.app time to open the window and the login shell to
  // finish printing its banner. Without this, the `do script` keystrokes
  // arrive while bash is still sourcing /etc/bashrc and the command is
  // discarded.
  const script = `delay 0.8
tell application "Terminal"
  activate
  do script "${appleScriptString(command)}" in front window
end tell`;
  const res = await runAppleScript(script);
  if (res.ok) return res;
  log('warn', 'terminal', `couldn't run \`${command}\` in Terminal: ${res.error}`);
  if (isAutomationDenial(res.error)) {
    return {
      ok: false,
      error:
        'macOS blocked overcli from controlling Terminal — allow it under System Settings → ' +
        'Privacy & Security → Automation. Until then, run this in the window that just opened:',
      command,
    };
  }
  return { ok: false, error: `${res.error} Run this in the window that just opened:`, command };
}

export function runInTerminal(command: string): Promise<TerminalLaunchResult> {
  if (FORBIDDEN_COMMAND_PATTERNS.test(command)) {
    return Promise.resolve({
      ok: false,
      error: 'Command contains shell metacharacters and was refused.',
    });
  }
  if (process.platform === 'win32') {
    return Promise.resolve(runWindowsTerminal(command));
  }
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      ok: false,
      error: `Opening a terminal window isn't wired up for ${process.platform} yet. Run this in your shell:`,
      command,
    });
  }
  // No workspace to sit in — home is as good a place as any, and going
  // through the same two-step path means one launch mechanism to keep working.
  return launchTerminalWith(os.homedir(), command);
}

// Opens a terminal window sitting in `cwd` with nothing typed into it —
// the "open this folder in Terminal" gesture from the file tree. No command
// means no AppleScript `do script`, so there's nothing to escape, no
// shell-init race to wait out, and no Automation permission needed; the path
// is a dedicated argv entry either way. A leading dash is refused rather than
// passed on: `open` would read it as a flag (the option-injection class of
// bug f731162 fixed for refs).
export function openTerminalIn(cwd: string): TerminalLaunchResult {
  if (!cwd || /[\n\r]/.test(cwd) || cwd.startsWith('-')) {
    return { ok: false, error: 'That folder path is unsafe to hand to a terminal.' };
  }
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/c', 'start', '', 'powershell.exe', '-NoProfile', '-NoExit'], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return { ok: true };
    }
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: `Opening a terminal window isn't wired up for ${process.platform} yet. cd '${cwd}'`,
      };
    }
    spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function openTerminalAt(cwd: string, command: string): Promise<TerminalLaunchResult> {
  // `cwd` is passed to `open` as a dedicated argv entry (not shell-
  // interpolated), so quotes/backslashes are safe. Only reject blank or
  // newline-delimited values to avoid malformed AppleScript fallback text.
  if (!cwd || /[\n\r]/.test(cwd)) {
    return Promise.resolve({
      ok: false,
      error: 'Workspace path contains characters unsafe for terminal launch.',
    });
  }
  if (FORBIDDEN_COMMAND_PATTERNS.test(command)) {
    return Promise.resolve({
      ok: false,
      error: 'Command contains shell metacharacters and was refused.',
    });
  }
  if (process.platform === 'win32') {
    return Promise.resolve(runWindowsTerminal(command, cwd));
  }
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      ok: false,
      error: `Opening a terminal window isn't wired up for ${process.platform} yet. Run this in your shell:`,
      command: `cd '${cwd}' && ${command}`,
    });
  }
  return launchTerminalWith(cwd, command);
}
