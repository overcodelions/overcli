// Ollama integration. Overcli talks to a locally-installed Ollama server
// (http://127.0.0.1:11434) — we don't bundle or redistribute weights.
// Users pull models themselves via `ollama pull`, which means they accept
// each model's license (Apache 2.0, Qwen Research, Meta CodeLlama, etc.)
// directly. Our job is to detect, surface, and make that setup easy.

import { spawn, spawnSync, ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runInTerminal } from './terminal';

export type OllamaTier = 'tiny' | 'small' | 'medium' | 'large';

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface OllamaDetection {
  installed: boolean;
  /// True if the Ollama HTTP server is answering on 127.0.0.1:11434.
  running: boolean;
  version?: string;
  binaryPath?: string;
  models: OllamaModel[];
  /// Populated when `installed` is false — URL the user can follow to
  /// install, or the package-manager command we'd run on their behalf.
  installHint?: { brewAvailable: boolean; downloadUrl: string };
}

export interface HardwareReport {
  platform: NodeJS.Platform;
  arch: string;
  totalRamGB: number;
  cpuModel: string;
  gpu?: string;
  appleSilicon: boolean;
  recommendedTier: OllamaTier;
  recommendedModels: RecommendedModel[];
}

export interface RecommendedModel {
  tag: string;
  displayName: string;
  sizeGB: number;
  license: string;
  note?: string;
}

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

function ollamaBinaryCandidates(): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (process.platform === 'win32') {
    const localAppdata = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    list.push(
      path.join(localAppdata, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(programFiles, 'Ollama', 'ollama.exe'),
    );
  } else {
    list.push(
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      path.join(home, '.ollama', 'bin', 'ollama'),
      '/Applications/Ollama.app/Contents/Resources/ollama',
    );
  }
  // Walk PATH too, since anyone can have put the binary anywhere.
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  for (const dir of pathDirs) list.push(path.join(dir, exe));
  return Array.from(new Set(list));
}

function firstExistingBinary(): string | undefined {
  for (const p of ollamaBinaryCandidates()) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function httpGetJson<T>(pathname: string, timeoutMs = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: pathname, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function detectRunningServer(): Promise<{ running: boolean; models: OllamaModel[]; version?: string }> {
  const tags = await httpGetJson<{ models?: Array<{ name: string; size: number; modified_at?: string }> }>(
    '/api/tags',
  );
  if (!tags) return { running: false, models: [] };
  const versionResp = await httpGetJson<{ version?: string }>('/api/version');
  const models: OllamaModel[] = (tags.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size,
    modifiedAt: m.modified_at,
  }));
  return { running: true, models, version: versionResp?.version };
}

function brewAvailable(): boolean {
  // Electron on macOS inherits a minimal PATH from Finder that often
  // excludes /opt/homebrew/bin and /usr/local/bin, so a bare `brew`
  // lookup misses real installs. Check common locations explicitly.
  const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return true;
    } catch {}
  }
  const res = spawnSync('brew', ['--version'], { encoding: 'utf-8', timeout: 2000 });
  return !res.error && res.status === 0;
}

export async function detectOllama(): Promise<OllamaDetection> {
  const bin = firstExistingBinary();
  const server = await detectRunningServer();
  const installed = !!bin || server.running;
  if (!installed) {
    return {
      installed: false,
      running: false,
      models: [],
      installHint: {
        brewAvailable: process.platform === 'darwin' && brewAvailable(),
        downloadUrl: OLLAMA_DOWNLOAD_URL,
      },
    };
  }
  return {
    installed: true,
    running: server.running,
    version: server.version,
    binaryPath: bin,
    models: server.models,
  };
}

/// Inspects CPU / RAM / GPU to suggest a quant/size tier. The tier is a
/// conservative guess — users with real constraints (shared machine,
/// always-on workloads) will want something smaller.
export function detectHardware(): HardwareReport {
  const totalRamGB = Math.round(os.totalmem() / (1024 ** 3));
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const arch = process.arch;
  const appleSilicon = process.platform === 'darwin' && arch === 'arm64';
  const gpu = detectGpu();

  let tier: OllamaTier = 'tiny';
  if (totalRamGB >= 64 && appleSilicon) tier = 'large';
  else if (totalRamGB >= 32) tier = 'medium';
  else if (totalRamGB >= 16) tier = 'small';

  const recommendedModels = recommendationsForTier(tier);
  return {
    platform: process.platform,
    arch,
    totalRamGB,
    cpuModel,
    gpu,
    appleSilicon,
    recommendedTier: tier,
    recommendedModels,
  };
}

function detectGpu(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const res = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], {
    encoding: 'utf-8',
    timeout: 4000,
  });
  if (res.error || res.status !== 0) return undefined;
  try {
    const data = JSON.parse(res.stdout);
    const displays = data?.SPDisplaysDataType;
    if (Array.isArray(displays) && displays[0]?._name) return displays[0]._name as string;
  } catch {
    // ignore
  }
  return undefined;
}

function recommendationsForTier(tier: OllamaTier): RecommendedModel[] {
  // Tags are pull-on-demand from ollama.com. Licenses reflect the model
  // card as of 2026-04 — verify before shipping copy changes.
  const qwenCoder7 = {
    tag: 'qwen2.5-coder:7b',
    displayName: 'Qwen2.5-Coder 7B',
    sizeGB: 4.7,
    license: 'Apache 2.0',
  };
  const qwenCoder14 = {
    tag: 'qwen2.5-coder:14b',
    displayName: 'Qwen2.5-Coder 14B',
    sizeGB: 9.0,
    license: 'Apache 2.0',
  };
  const qwenCoder32 = {
    tag: 'qwen2.5-coder:32b',
    displayName: 'Qwen2.5-Coder 32B',
    sizeGB: 20.0,
    license: 'Apache 2.0',
  };
  const qwenCoder3 = {
    tag: 'qwen2.5-coder:3b',
    displayName: 'Qwen2.5-Coder 3B',
    sizeGB: 1.9,
    license: 'Qwen Research',
    note: 'Non-commercial license — check terms before commercial use.',
  };
  const deepseekCoder = {
    tag: 'deepseek-coder-v2:16b',
    displayName: 'DeepSeek-Coder-V2 16B',
    sizeGB: 8.9,
    license: 'DeepSeek License',
    note: 'Permits commercial use; review license terms.',
  };
  switch (tier) {
    case 'tiny':
      return [qwenCoder3];
    case 'small':
      return [qwenCoder7, qwenCoder3];
    case 'medium':
      return [qwenCoder14, qwenCoder7, deepseekCoder];
    case 'large':
      return [qwenCoder32, qwenCoder14, deepseekCoder];
  }
}

/// Kicks off an Ollama install. On macOS with Homebrew we open Terminal.app
/// running `brew install ollama` so the user sees progress and can spot
/// failures — silent background installs leave people wondering if
/// anything is happening. Everywhere else we open the download page.
export async function installOllama(opener: (url: string) => void): Promise<{ started: 'brew' | 'browser'; detail?: string }> {
  if (process.platform === 'darwin' && brewAvailable()) {
    runInTerminal('brew install ollama');
    return { started: 'brew', detail: 'Opened Terminal running `brew install ollama`' };
  }
  opener(OLLAMA_DOWNLOAD_URL);
  return { started: 'browser', detail: OLLAMA_DOWNLOAD_URL };
}

export interface ServerLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

/// Manages an `ollama serve` child process with its stdout/stderr piped
/// back to the main process so the UI can show live logs. One instance,
/// created at app start. The server lives as long as Overcli does —
/// killed on app quit. If the user already has Ollama running (e.g. via
/// Ollama.app or brew services), start() is a no-op once detection sees
/// port 11434 bound, and we show a system log line explaining that.
type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

export class OllamaServerManager {
  private child: ServerChild | null = null;
  private status: ServerStatus = 'stopped';
  private log: ServerLogLine[] = [];
  private readonly maxLog = 500;
  private listeners = new Set<(line: ServerLogLine) => void>();
  private statusListeners = new Set<(status: ServerStatus) => void>();

  getStatus(): ServerStatus {
    return this.status;
  }

  getLog(): ServerLogLine[] {
    return this.log.slice();
  }

  onLog(fn: (line: ServerLogLine) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatusChange(fn: (status: ServerStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    // Already running in-proc.
    if (this.child && !this.child.killed) {
      return { ok: true, message: 'Server already running under Overcli.' };
    }
    // Someone else (Ollama.app, brew services) is bound to :11434. Don't
    // try to spawn a second one — port conflict, and the existing server
    // works fine for our HTTP calls.
    const external = await detectRunningServer();
    if (external.running) {
      this.setStatus('running');
      this.append({
        stream: 'system',
        text: 'Ollama server already running (external process on 127.0.0.1:11434). Skipping spawn.',
        timestamp: Date.now(),
      });
      return { ok: true, message: 'External Ollama server detected.' };
    }

    const bin = firstExistingBinary();
    if (!bin) {
      this.setStatus('error');
      this.append({
        stream: 'system',
        text: 'Ollama binary not found. Install it via the Local tab first.',
        timestamp: Date.now(),
      });
      return { ok: false, message: 'Ollama binary not found.' };
    }

    this.setStatus('starting');
    this.append({ stream: 'system', text: `Spawning ${bin} serve`, timestamp: Date.now() });

    let child: ServerChild;
    try {
      child = spawn(bin, ['serve'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ServerChild;
    } catch (err: any) {
      this.setStatus('error');
      this.append({
        stream: 'system',
        text: `Failed to spawn: ${err?.message ?? String(err)}`,
        timestamp: Date.now(),
      });
      return { ok: false, message: err?.message ?? String(err) };
    }

    this.child = child;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.ingest('stdout', chunk));
    child.stderr.on('data', (chunk: string) => this.ingest('stderr', chunk));
    child.on('error', (err) => {
      this.append({ stream: 'system', text: `Error: ${err.message}`, timestamp: Date.now() });
      this.setStatus('error');
    });
    child.on('close', (code) => {
      this.append({
        stream: 'system',
        text: `Server exited with code ${code}`,
        timestamp: Date.now(),
      });
      this.child = null;
      this.setStatus('stopped');
    });

    // Poll the HTTP port briefly — ollama takes ~1-2s to bind. When the
    // probe succeeds we flip to `running`; if it never binds we stay in
    // `starting` (the child's stderr will usually explain why).
    void this.waitForPort(10_000);

    return { ok: true, message: 'Server starting.' };
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill('SIGTERM');
    } catch {}
  }

  private async waitForPort(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child == null) return; // died mid-wait
      const probe = await detectRunningServer();
      if (probe.running) {
        this.setStatus('running');
        this.append({
          stream: 'system',
          text: `Server is up on 127.0.0.1:${OLLAMA_PORT}.`,
          timestamp: Date.now(),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private ingest(stream: 'stdout' | 'stderr', chunk: string): void {
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      this.append({ stream, text: trimmed, timestamp: Date.now() });
    }
  }

  private append(line: ServerLogLine): void {
    this.log.push(line);
    if (this.log.length > this.maxLog) {
      this.log.splice(0, this.log.length - this.maxLog);
    }
    for (const l of this.listeners) l(line);
  }

  private setStatus(next: ServerStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const l of this.statusListeners) l(next);
  }
}

/// Singleton — main/index.ts owns the lifecycle.
export const ollamaServer = new OllamaServerManager();

export type PullProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; percent: number; completed: number; total: number; message?: string }
  | { type: 'done'; success: boolean; message?: string };

/// POST /api/pull with stream=true. Emits progress events via the supplied
/// callback. Returns when the server signals completion (or errors).
export function pullModel(
  tag: string,
  onEvent: (ev: PullProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: tag, stream: true });
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/pull',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8').slice(0, 400);
            onEvent({ type: 'done', success: false, message: text });
            resolve({ ok: false, error: text || `status ${res.statusCode}` });
          });
          return;
        }
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed);
              if (typeof evt.total === 'number' && typeof evt.completed === 'number' && evt.total > 0) {
                onEvent({
                  type: 'progress',
                  percent: Math.min(100, Math.round((evt.completed / evt.total) * 100)),
                  completed: evt.completed,
                  total: evt.total,
                  message: evt.status,
                });
              } else if (evt.status) {
                onEvent({ type: 'status', message: String(evt.status) });
              }
            } catch {
              // ignore malformed lines
            }
          }
        });
        res.on('end', () => {
          onEvent({ type: 'done', success: true });
          resolve({ ok: true });
        });
        res.on('error', (err) => {
          onEvent({ type: 'done', success: false, message: err.message });
          resolve({ ok: false, error: err.message });
        });
      },
    );
    req.on('error', (err) => {
      onEvent({ type: 'done', success: false, message: err.message });
      resolve({ ok: false, error: err.message });
    });
    signal?.addEventListener('abort', () => {
      try {
        req.destroy(new Error('aborted'));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; totalDurationMs?: number; evalCount?: number; promptEvalCount?: number }
  | { type: 'error'; message: string };

/// POST /api/chat with stream=true. Emits tokens as they arrive, then a
/// terminal `done` event. Abort via the signal to stop mid-response.
export function streamChat(
  args: {
    model: string;
    messages: OllamaChatMessage[];
    signal?: AbortSignal;
  },
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: true,
    });
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8').slice(0, 400);
            onEvent({ type: 'error', message: text || `status ${res.statusCode}` });
            resolve();
          });
          return;
        }
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed);
              if (evt.message?.content) {
                onEvent({ type: 'token', text: String(evt.message.content) });
              }
              if (evt.done) {
                onEvent({
                  type: 'done',
                  totalDurationMs:
                    typeof evt.total_duration === 'number'
                      ? Math.round(evt.total_duration / 1e6)
                      : undefined,
                  evalCount: evt.eval_count,
                  promptEvalCount: evt.prompt_eval_count,
                });
              }
            } catch {
              // ignore malformed lines
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', (err) => {
          onEvent({ type: 'error', message: err.message });
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      onEvent({ type: 'error', message: err.message });
      resolve();
    });
    args.signal?.addEventListener('abort', () => {
      try {
        req.destroy(new Error('aborted'));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}
