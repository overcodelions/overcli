// Opens a fresh terminal window with a command pre-typed and run.
// macOS-only today: AppleScript drives Terminal.app so users see progress
// and can respond to interactive prompts (sudo, device codes, browser
// OAuth flows). Other platforms fall back to an error message the caller
// can surface so the user runs the command themselves.

import { spawn } from 'node:child_process';

export type TerminalLaunchResult = { ok: true } | { ok: false; error: string };

// `do script` passes the string to the user's login shell, so any shell
// metacharacter in the command reaches sh/bash/zsh. Command substitution
// (backtick, `$(...)`) and control operators (`;`, `&&`, `|`) are the
// dangerous ones — reject them so a malformed backend path can't escape
// into shell execution.
const FORBIDDEN_COMMAND_PATTERNS = /[`$;&|<>\n\r]/;

function runAppleScriptTerminal(shellLine: string): TerminalLaunchResult {
  const script = `tell application "Terminal"
  activate
  do script "${shellLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`;
  try {
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function runInTerminal(command: string): TerminalLaunchResult {
  if (FORBIDDEN_COMMAND_PATTERNS.test(command)) {
    return { ok: false, error: 'Command contains shell metacharacters and was refused.' };
  }
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: `Opening a terminal window isn't wired up for ${process.platform} yet. Run this in your shell: ${command}`,
    };
  }
  return runAppleScriptTerminal(command);
}

// Opens Terminal.app in `cwd` and runs `command` there. We first
// `open -a Terminal <cwd>` so a new window launches with the shell
// already cwd'd into the workspace, then tell Terminal via AppleScript
// to run the command in that window. The two-step is deliberate: doing
// `do script "cd && ..."` in one shot races the shell's init and the
// typed command ends up sitting in the buffer unexecuted. Opening at a
// path is reliable, and the follow-up `do script` runs after the shell
// is idle.
export function openTerminalAt(cwd: string, command: string): TerminalLaunchResult {
  if (!cwd || /['\n\r"\\]/.test(cwd)) {
    return { ok: false, error: 'Workspace path contains characters unsafe for terminal launch.' };
  }
  if (FORBIDDEN_COMMAND_PATTERNS.test(command)) {
    return { ok: false, error: 'Command contains shell metacharacters and was refused.' };
  }
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: `Opening a terminal window isn't wired up for ${process.platform} yet. Run this in your shell: cd '${cwd}' && ${command}`,
    };
  }
  try {
    spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' }).unref();
    // Give Terminal.app time to open the window and the login shell to
    // finish printing its banner. Without this, the `do script` keystrokes
    // arrive while bash is still sourcing /etc/bashrc and the command is
    // discarded.
    const script = `delay 0.8
tell application "Terminal"
  activate
  do script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" in front window
end tell`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
