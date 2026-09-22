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
  close(serviceId: string): Promise<void>;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '');
}

export function createLogSink(fileFor: (serviceId: string) => string, limit = LOG_FILE_LIMIT): LogSink {
  const queues = new Map<string, string[]>();
  const pending = new Map<string, Promise<void>>();
  const flush = (serviceId: string) => {
    const previous = pending.get(serviceId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const lines = queues.get(serviceId) ?? [];
      queues.delete(serviceId);
      if (!lines.length) return;
      const file = fileFor(serviceId);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = (await fs.promises.stat(file)).size; } catch { /* new file */ }
      if (size >= limit) {
        try { await fs.promises.rename(file, file.replace(/\.log$/, '.1.log')); } catch { /* best effort */ }
      }
      await fs.promises.appendFile(file, lines.join(''), 'utf8');
    }).catch(() => undefined).finally(() => { if (!queues.has(serviceId)) pending.delete(serviceId); });
    pending.set(serviceId, next);
    return next;
  };

  return {
    write(serviceId, line) {
      const queue = queues.get(serviceId) ?? [];
      queue.push(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
      queues.set(serviceId, queue);
      void flush(serviceId);
    },
    async close(serviceId) { await flush(serviceId); await pending.get(serviceId); },
  };
}
