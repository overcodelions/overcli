// Disk-backed Ollama conversation transcripts. Ollama has no server-side
// session state of its own — the runner holds the `{role, content}[]`
// message array in memory and replays it on every /api/chat call. Before
// this module, closing the app dropped the entire transcript. Now each
// session gets a JSON sidecar under `<userData>/ollama-sessions/` that's
// rewritten after every assistant turn and rehydrated when the runner
// sees a conversation whose in-memory session map entry is empty.
//
// File layout is intentionally dumb: one JSON per sessionId, atomic
// rename on write, best-effort parse on read. Matches how the Swift
// build's plists worked — small, easy to inspect, trivial to delete if
// a user wants to reset a convo.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { OllamaChatMessage } from './ollama';

const FILE_VERSION = 1;

export interface PersistedOllamaSession {
  version: number;
  sessionId: string;
  lastModel?: string;
  messages: OllamaChatMessage[];
  /// Per-message timestamps, parallel to `messages`. Older saves may
  /// omit this; callers treat missing entries as an even spread across
  /// the `updatedAt` window so replay order stays stable.
  messageTimestamps?: number[];
  updatedAt: number;
}

function sessionsDir(): string {
  return path.join(app.getPath('userData'), 'ollama-sessions');
}

function sessionFile(sessionId: string): string {
  // sessionId is a UUID we generated ourselves — no path traversal risk,
  // but defensively strip anything non-hex/dash just in case a caller
  // ever passes user input here.
  const safe = sessionId.replace(/[^0-9a-fA-F-]/g, '');
  return path.join(sessionsDir(), `${safe}.json`);
}

export function loadOllamaSession(sessionId: string): PersistedOllamaSession | null {
  if (!sessionId) return null;
  const file = sessionFile(sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedOllamaSession;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveOllamaSession(args: {
  sessionId: string;
  lastModel?: string;
  messages: OllamaChatMessage[];
  messageTimestamps?: number[];
}): void {
  if (!args.sessionId) return;
  const dir = sessionsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const file = sessionFile(args.sessionId);
  const payload: PersistedOllamaSession = {
    version: FILE_VERSION,
    sessionId: args.sessionId,
    lastModel: args.lastModel,
    messages: args.messages,
    messageTimestamps: args.messageTimestamps,
    updatedAt: Date.now(),
  };
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`Failed to persist Ollama session ${args.sessionId}:`, err);
  }
}

export function deleteOllamaSession(sessionId: string): void {
  if (!sessionId) return;
  try {
    fs.unlinkSync(sessionFile(sessionId));
  } catch {
    // Already gone or never written — fine.
  }
}
