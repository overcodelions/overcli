// Tiny structured logger for failures we used to swallow with `catch {}`.
// Two outputs: an in-memory ring buffer the renderer reads via IPC for
// live diagnostics, and an append-only file at `~/.overcli/session.log`
// so a user can attach the log to a bug report after restarting the app.
//
// Resilience-on-purpose: failures here are themselves swallowed — losing a
// log line is strictly less bad than crashing the parent operation.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SilentLogEntry {
  timestamp: number;
  scope: string;
  message: string;
  /// Best-effort stack — present when the original throw carried one.
  stack?: string;
}

const MAX_BUFFER = 500;
const buffer: SilentLogEntry[] = [];

let logFilePath: string | null = null;
function getLogFilePath(): string {
  if (logFilePath) return logFilePath;
  const dir = path.join(os.homedir(), '.overcli');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // We'll try again on the next call. The in-memory buffer still works.
  }
  logFilePath = path.join(dir, 'session.log');
  return logFilePath;
}

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || String(err), stack: err.stack };
  if (typeof err === 'string') return { message: err };
  if (err && typeof err === 'object') {
    try {
      return { message: JSON.stringify(err) };
    } catch {
      return { message: '[unserializable error]' };
    }
  }
  return { message: String(err) };
}

export function logSilent(scope: string, err: unknown): void {
  const { message, stack } = describe(err);
  const entry: SilentLogEntry = { timestamp: Date.now(), scope, message, stack };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  try {
    const line = `[${new Date(entry.timestamp).toISOString()}] ${scope}: ${message}\n`;
    fs.appendFileSync(getLogFilePath(), line, 'utf-8');
  } catch {
    // File-write failed (read-only home? quota?). Keep the in-memory copy.
  }
}

export function listSilentLog(): SilentLogEntry[] {
  return buffer.slice();
}

export function clearSilentLog(): void {
  buffer.length = 0;
  try {
    fs.writeFileSync(getLogFilePath(), '', 'utf-8');
  } catch {
    // No-op: same rationale as the write path above.
  }
}
