// Ask Claude which MCP servers and tools it has, without asking it anything.
//
// The seen-cache (mcpToolCache) fills from the init event of real Claude
// sessions — but the hire drafter's own turns are hidden one-shots run under
// `--strict-mcp-config`, so they load no servers and report none. A user who
// goes straight to hiring would get a drafter that has never heard of their
// Gmail connector. This closes that gap: start `claude`, read the init event
// it prints before it ever calls the model, and stop it there.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../diagnostics';
import { stripSecrets } from '../org/secrets/service';
import { workerLaunch } from '../org/workerUser';
import { recordMcpSeen, seenMcpServers } from './mcpToolCache';

/// Servers can take a while to boot (an npx install, an OAuth refresh), and
/// Claude only prints init once they have. Past this, give up quietly.
const PROBE_TIMEOUT_MS = 60_000;

let inFlight: Promise<boolean> | null = null;

type SpawnFn = (command: string, args: string[]) => ChildProcess;

/// Where the probe starts: an empty folder of its own, made for this probe
/// and removed after it. Never HOME or a repo: on a server those are
/// folders workers can write, and a `.mcp.json` planted there would be
/// loaded by the probe. Readable by the worker user, which the probe runs
/// as when there is one.
function probeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-mcp-probe-'));
  fs.chmodSync(dir, 0o755);
  return dir;
}

/// Claude, started as a worker's would be: as the worker user when there is
/// one (whatever its config makes it run, runs as the worker), with the
/// server's secrets out of its environment, in a folder of the probe's own.
export function probeLaunch(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  return { ...workerLaunch(command, args), cwd: probeDir(), env: stripSecrets(env) };
}

const defaultSpawn: SpawnFn = (command, args) => {
  const { cwd, ...launch } = probeLaunch(command, args);
  const proc = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rm(cwd, { recursive: true, force: true }, () => {});
  };
  proc.once('error', cleanup);
  proc.once('close', cleanup);
  return proc;
};

/// What Claude reports at start-up, before any model call: each MCP server
/// with its status, and every tool. Null if it never got that far.
export interface McpInit {
  servers: Array<{ name: string; status: string }>;
  tools: string[];
}

/// Start Claude, read its init event, stop it. No model call is made.
export function readClaudeInit(
  binary: string,
  opts: { timeoutMs?: number; spawnFn?: SpawnFn } = {},
): Promise<McpInit | null> {
  return new Promise<McpInit | null>((resolve) => {
    let settled = false;
    let proc: ChildProcess;
    const finish = (init: McpInit | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc?.kill();
      } catch {
        // Already gone.
      }
      resolve(init);
    };
    const timer = setTimeout(() => {
      log('info', 'mcp.probe', 'Claude did not report its MCP servers in time; skipping');
      finish(null);
    }, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    try {
      // The prompt is never answered: the process is stopped on init, which
      // Claude prints before the first model call.
      proc = (opts.spawnFn ?? defaultSpawn)(binary, [
        '-p',
        'ok',
        '--model',
        'haiku',
        '--output-format',
        'stream-json',
        '--verbose',
      ]);
    } catch (err) {
      log('warn', 'mcp.probe', 'could not start Claude to list MCP servers', err);
      finish(null);
      return;
    }
    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          const json = JSON.parse(line);
          if (json?.type === 'system' && json?.subtype === 'init') {
            finish({
              servers: Array.isArray(json.mcp_servers) ? json.mcp_servers : [],
              tools: Array.isArray(json.tools) ? json.tools : [],
            });
            return;
          }
        } catch {
          // Not JSON we care about.
        }
      }
    });
    proc.on('error', (err) => {
      log('warn', 'mcp.probe', 'Claude MCP probe failed', err);
      finish(null);
    });
    proc.on('exit', () => finish(null));
  });
}

/// Run one probe. Resolves true when an init event was read and recorded.
/// Concurrent callers share the probe already running.
export function probeClaudeMcp(
  binary: string,
  opts: { timeoutMs?: number; spawnFn?: SpawnFn } = {},
): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = readClaudeInit(binary, opts)
    .then((init) => {
      if (!init) return false;
      recordMcpSeen(init.servers, init.tools);
      return true;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/// Probe only when there is nothing to go on yet. Once any server has been
/// seen, the real sessions keep the record current by themselves.
export async function ensureMcpSeen(binary: string | null): Promise<void> {
  if (!binary || seenMcpServers().length > 0) return;
  await probeClaudeMcp(binary);
}
