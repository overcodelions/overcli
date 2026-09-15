// A service's output, kept on disk.
//
// The in-memory buffer is what the pane scrolls; it is capped, and it dies
// with the app. The file is what you hand to an agent when something went
// wrong an hour ago: every line, timestamped, colour codes stripped, secrets
// already masked by the supervisor before they get here.
//
// Rotated rather than unbounded — a chatty dev server left running over a
// weekend should not fill a disk. One previous file is kept beside it.

import fs from 'node:fs';
import path from 'node:path';

/// Past this, the file is moved to `<name>.1.log` and a fresh one begun.
export const LOG_FILE_LIMIT = 20 * 1024 * 1024;

export interface LogSink {
  write(serviceId: string, line: string): void;
  close(serviceId: string): void;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '');
}

export function createLogSink(fileFor: (serviceId: string) => string, limit = LOG_FILE_LIMIT): LogSink {
  const open = new Map<string, { fd: number; size: number; file: string }>();

  const handle = (serviceId: string) => {
    const existing = open.get(serviceId);
    if (existing) return existing;
    const file = fileFor(serviceId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    const entry = { fd, size: fs.fstatSync(fd).size, file };
    open.set(serviceId, entry);
    return entry;
  };

  const close = (serviceId: string) => {
    const entry = open.get(serviceId);
    if (!entry) return;
    open.delete(serviceId);
    try {
      fs.closeSync(entry.fd);
    } catch {
      // Already gone.
    }
  };

  return {
    write(serviceId, line) {
      try {
        let entry = handle(serviceId);
        if (entry.size >= limit) {
          close(serviceId);
          fs.renameSync(entry.file, entry.file.replace(/\.log$/, '.1.log'));
          entry = handle(serviceId);
        }
        const text = `${new Date().toISOString()} ${stripAnsi(line)}\n`;
        fs.writeSync(entry.fd, text);
        entry.size += Buffer.byteLength(text);
      } catch {
        // A full disk or a deleted folder must not take the service down with
        // it; the pane still has the lines.
        close(serviceId);
      }
    },
    close,
  };
}
