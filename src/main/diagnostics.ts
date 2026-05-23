// Product-wide structured logger. Two outputs: an in-memory ring buffer the
// renderer reads via IPC for live diagnostics, and an append-only file at
// `~/.overcli/session.log`. Failures here are swallowed on purpose — losing a
// log line is strictly less bad than crashing the parent operation.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SilentLogEntry {
  timestamp: number;
  level: LogLevel;
  scope: string;
  message: string;
  stack?: string;
}

const MAX_BUFFER = 500;
const MAX_SESSION_LOG_BYTES = 1 * 1024 * 1024;
const ROTATED_SESSION_LOG_SUFFIX = '.1';
// Re-check the on-disk size every N writes rather than once per process, so a
// long-lived session still gets capped. `statSync` is cheap but not free, so we
// keep it off every single log line.
export const ROTATION_CHECK_INTERVAL = 50;
const buffer: SilentLogEntry[] = [];
let writesUntilRotationCheck = 0;

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
function normalizeLevel(level: unknown): LogLevel {
  return typeof level === 'string' && (VALID_LOG_LEVELS as readonly string[]).includes(level)
    ? (level as LogLevel)
    : 'info';
}

let logFilePath: string | null = null;
function getLogFilePath(): string {
  if (logFilePath) return logFilePath;
  const dir = path.join(os.homedir(), '.overcli');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Retry next call; the in-memory buffer still works.
  }
  logFilePath = path.join(dir, 'session.log');
  return logFilePath;
}

function rotateSessionLogIfNeeded(filePath: string, nextLineBytes: number): void {
  if (writesUntilRotationCheck > 0) {
    writesUntilRotationCheck--;
    return;
  }
  writesUntilRotationCheck = ROTATION_CHECK_INTERVAL;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size + nextLineBytes <= MAX_SESSION_LOG_BYTES) return;

    const rotatedPath = `${filePath}${ROTATED_SESSION_LOG_SUFFIX}`;
    try {
      fs.unlinkSync(rotatedPath);
    } catch {
      // Best effort: if the rotated file is already gone, keep going.
    }
    fs.renameSync(filePath, rotatedPath);
    fs.writeFileSync(filePath, '', 'utf-8');
  } catch {
    // Missing file, permission issue, or cleanup failure: keep logging.
  }
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

/// Core entry point. When `err` is provided its message is appended and its
/// stack captured.
export function log(level: LogLevel, scope: string, message: string, err?: unknown): void {
  // Callers are type-checked, but the diagnostics:log IPC path forwards
  // untrusted renderer payloads. Normalize so a bad level can't push a broken
  // entry into the buffer or throw on `.toUpperCase()` below (silently dropping
  // the file line).
  const safeLevel = normalizeLevel(level);
  let fullMessage = message;
  let stack: string | undefined;
  if (err !== undefined) {
    const d = describe(err);
    fullMessage = message ? `${message}: ${d.message}` : d.message;
    stack = d.stack;
  }
  const entry: SilentLogEntry = { timestamp: Date.now(), level: safeLevel, scope, message: fullMessage, stack };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  try {
    const line = `[${new Date(entry.timestamp).toISOString()}] ${safeLevel.toUpperCase()} ${scope}: ${fullMessage}\n`;
    const filePath = getLogFilePath();
    rotateSessionLogIfNeeded(filePath, Buffer.byteLength(line, 'utf-8'));
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch {
    // File-write failed (read-only home? quota?). Keep the in-memory copy.
  }
}

/// Back-compat shim: records an error at 'error' level with its stack.
export function logSilent(scope: string, err: unknown): void {
  log('error', scope, '', err);
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
