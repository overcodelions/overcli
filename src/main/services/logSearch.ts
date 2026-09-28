// Searching the output of every service at once.
//
// A problem in a stack rarely stays in the service that has it: checkout
// times out because pricing is slow because the database refused a
// connection. Reading that meant opening each service's output in turn and
// searching it again. This answers the question once, across all of them.
//
// Pure, apart from reading a log file's tail, so the matching is tested on
// plain arrays.

import fs from 'node:fs';

import { lineAtLevel, type OutputLevel, type OutputMatch } from '../../shared/services';
import { stripAnsi } from './logFile';

/// Per service: a query that matches every line of a chatty service is not
/// an answer, and the pane can say "and more" instead of drawing thousands.
export const MATCHES_PER_SERVICE = 100;
/// Across every service, for the same reason.
export const MATCHES_TOTAL = 1000;
/// How much of a log file is read, from the end. The file rotates at 20 MB;
/// the newest few are what someone searching is after.
export const FILE_TAIL_BYTES = 4 * 1024 * 1024;

/// The file stamps every line `2026-09-28T06:40:19.003Z <line>`.
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

/// Lines containing `query`, case-insensitively, newest last. Colour codes
/// are stripped before matching, so a search never misses a word because a
/// dev server tinted half of it. `level` filters before the limit, so an
/// old error is found under a pile of newer ordinary matches.
export function matchLines(
  lines: readonly string[],
  query: string,
  limit = MATCHES_PER_SERVICE,
  level: OutputLevel = 'all',
): { index: number; text: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: { index: number; text: string }[] = [];
  // From the end: when a service matches more than the limit, the newest
  // matches are the ones worth keeping.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const text = stripAnsi(lines[i]).replace(/\r?\n$/, '');
    if (text.toLowerCase().includes(needle) && lineAtLevel(text, level)) out.push({ index: i, text });
  }
  return out.reverse();
}

/// A log file line split into its stamp and what the service printed.
export function splitStamp(line: string): { at?: string; text: string } {
  const m = STAMP.exec(line);
  return m ? { at: m[1], text: line.slice(m[0].length) } : { text: line };
}

/// The last `maxBytes` of a file as lines, dropping the first (probably cut)
/// one when the read started mid-file. Empty when there is no file.
export async function readTail(file: string, maxBytes = FILE_TAIL_BYTES): Promise<string[]> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

/// One service's matches, from memory or from its file.
export function toMatches(
  workspaceId: string,
  serviceId: string,
  source: OutputMatch['source'],
  lines: readonly string[],
  query: string,
  limit = MATCHES_PER_SERVICE,
  level: OutputLevel = 'all',
): OutputMatch[] {
  if (source === 'recent') {
    return matchLines(lines, query, limit, level).map((m) => ({ workspaceId, serviceId, source, ...m }));
  }
  // Match on what the service printed, not on the stamp: "06:40" should find
  // a line that says 06:40, not every line written in that minute.
  const stripped = lines.map((line) => splitStamp(line));
  return matchLines(
    stripped.map((l) => l.text),
    query,
    limit,
    level,
  ).map((m) => ({ workspaceId, serviceId, source, ...m, at: stripped[m.index].at }));
}
