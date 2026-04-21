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

export function runInTerminal(command: string): TerminalLaunchResult {
  if (FORBIDDEN_COMMAND_PATTERNS.test(command)) {
    return { ok: false, error: 'Command contains shell metacharacters and was refused.' };
  }
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"
  activate
  do script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`;
    try {
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }
  return {
    ok: false,
    error: `Opening a terminal window isn't wired up for ${process.platform} yet. Run this in your shell: ${command}`,
  };
}
