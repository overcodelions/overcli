// Disk round-trip for persisted Ollama sessions. The store must survive a
// missing file, a corrupt file, and a sessionId that picked up stray
// characters — all three would otherwise crash the main process on load.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from './testHost';

let userDataDir: string;
useTestHost(() => userDataDir);

import { deleteOllamaSession, loadOllamaSession, saveOllamaSession } from './ollamaStore';
import { OllamaChatMessage } from './ollama';

const messages: OllamaChatMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-ollama-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const sessionsDir = () => path.join(userDataDir, 'ollama-sessions');

describe('saveOllamaSession / loadOllamaSession', () => {
  it('round-trips a session', () => {
    saveOllamaSession({ sessionId: 'abc-123', lastModel: 'qwen', messages, messageTimestamps: [1, 2] });
    const loaded = loadOllamaSession('abc-123');
    expect(loaded?.sessionId).toBe('abc-123');
    expect(loaded?.lastModel).toBe('qwen');
    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.messageTimestamps).toEqual([1, 2]);
    expect(loaded?.version).toBe(1);
    expect(typeof loaded?.updatedAt).toBe('number');
  });

  it('creates the sessions directory on first save', () => {
    expect(fs.existsSync(sessionsDir())).toBe(false);
    saveOllamaSession({ sessionId: 'abc-123', messages });
    expect(fs.existsSync(sessionsDir())).toBe(true);
  });

  it('leaves no .tmp file behind after an atomic write', () => {
    saveOllamaSession({ sessionId: 'abc-123', messages });
    const leftovers = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites a previous save for the same session', () => {
    saveOllamaSession({ sessionId: 'abc-123', lastModel: 'old', messages });
    saveOllamaSession({ sessionId: 'abc-123', lastModel: 'new', messages });
    expect(loadOllamaSession('abc-123')?.lastModel).toBe('new');
    expect(fs.readdirSync(sessionsDir()).length).toBe(1);
  });

  it('strips unsafe characters so the id maps to one sanitized file', () => {
    saveOllamaSession({ sessionId: '../abc-123', messages });
    expect(fs.existsSync(path.join(sessionsDir(), 'abc-123.json'))).toBe(true);
    expect(loadOllamaSession('abc-123')?.messages).toEqual(messages);
  });

  it('ignores an empty sessionId instead of writing a stray file', () => {
    saveOllamaSession({ sessionId: '', messages });
    expect(fs.existsSync(sessionsDir())).toBe(false);
    expect(loadOllamaSession('')).toBeNull();
  });

  it('returns null for a session that was never saved', () => {
    expect(loadOllamaSession('abc-123')).toBeNull();
  });

  it('returns null for a corrupt file rather than throwing', () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), 'abc-123.json'), '{not json', 'utf-8');
    expect(loadOllamaSession('abc-123')).toBeNull();
  });

  it('returns null when messages is not an array', () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), 'abc-123.json'), '{"messages":"nope"}', 'utf-8');
    expect(loadOllamaSession('abc-123')).toBeNull();
  });
});

describe('deleteOllamaSession', () => {
  it('removes a saved session', () => {
    saveOllamaSession({ sessionId: 'abc-123', messages });
    deleteOllamaSession('abc-123');
    expect(loadOllamaSession('abc-123')).toBeNull();
  });

  it('is a no-op for a session that does not exist', () => {
    expect(() => deleteOllamaSession('abc-123')).not.toThrow();
    expect(() => deleteOllamaSession('')).not.toThrow();
  });
});
