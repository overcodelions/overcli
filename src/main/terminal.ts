// Opens a fresh terminal window with a command pre-typed and run.
// macOS-only today: AppleScript drives Terminal.app so users see progress
// and can respond to interactive prompts (sudo, device codes, browser
// OAuth flows). Other platforms fall back to an error message the caller
// can surface so the user runs the command themselves.

import { spawn } from 'node:child_process';

export type TerminalLaunchResult = { ok: true } | { ok: false; error: string };

export function runInTerminal(command: string): TerminalLaunchResult {
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
