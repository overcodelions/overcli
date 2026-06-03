// Trigger a remote MCP server's OAuth login from within overcli.
//
// Only Codex exposes a spawnable login command (`codex mcp login <name>`)
// that runs the browser OAuth flow and stores the token in Codex's own
// auth store. Claude authenticates remote servers in-session via `/mcp`
// (no standalone command), and Gemini has no equivalent — so this module
// is Codex-only by design; the IPC handler returns a helpful message for
// the others.
//
// The login process opens the system browser and waits on a localhost
// callback, then exits 0. We pipe its output, surface the first URL it
// prints (in case it didn't auto-open a browser), and resolve when the
// process exits or a generous timeout elapses.

import { spawn } from 'node:child_process';

export type McpLoginResult =
  | { ok: true; output: string }
  | { ok: false; error: string; output?: string };

export function loginCodexMcp(opts: {
  binary: string;
  name: string;
  env: NodeJS.ProcessEnv;
  useShell?: boolean;
  /// Invoked once with the first URL seen in output, so the caller can
  /// open it in the browser if Codex didn't do so itself.
  onUrl?: (url: string) => void;
  timeoutMs?: number;
}): Promise<McpLoginResult> {
  const { binary, name, env, useShell = false, onUrl, timeoutMs = 180_000 } = opts;
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let urlOpened = false;

    const child = spawn(binary, ['mcp', 'login', name], {
      env,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      if (!urlOpened && onUrl) {
        const m = text.match(/https?:\/\/[^\s'"]+/);
        if (m) {
          urlOpened = true;
          onUrl(m[0]);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const finish = (result: McpLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({
        ok: false,
        error: `Login timed out after ${Math.round(timeoutMs / 1000)}s. Finish the browser sign-in, or run \`codex mcp login ${name}\` in a terminal.`,
        output,
      });
    }, timeoutMs);

    child.on('error', (err) => finish({ ok: false, error: err.message, output }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, output });
      else finish({ ok: false, error: `codex mcp login exited with code ${code}.`, output });
    });
  });
}
