import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

vi.mock('../diagnostics', () => ({
  log: vi.fn(),
}));

// Re-imported fresh each test (resetModules below) so the module-level cache
// doesn't bleed state between cases.
type Store = typeof import('./recentPromptsStore');

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import('./recentPromptsStore');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-recent-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('recentPromptsStore', () => {
  it('records a prompt and lists it back', async () => {
    const store = await freshStore();
    store.recordRecentPrompt('find small docs fixes');
    expect(store.listRecentPrompts().map((p) => p.text)).toEqual(['find small docs fixes']);
  });

  it('trims whitespace and ignores blank prompts', async () => {
    const store = await freshStore();
    store.recordRecentPrompt('  padded ask  ');
    store.recordRecentPrompt('   ');
    expect(store.listRecentPrompts().map((p) => p.text)).toEqual(['padded ask']);
  });

  it('dedupes by exact text, bumping the duplicate to the front', async () => {
    const store = await freshStore();
    store.recordRecentPrompt('alpha');
    store.recordRecentPrompt('beta');
    store.recordRecentPrompt('alpha'); // bump
    expect(store.listRecentPrompts().map((p) => p.text)).toEqual(['alpha', 'beta']);
  });

  it('caps the list at 30, dropping the oldest', async () => {
    const store = await freshStore();
    for (let i = 0; i < 35; i++) store.recordRecentPrompt(`ask ${i}`);
    const texts = store.listRecentPrompts().map((p) => p.text);
    expect(texts).toHaveLength(30);
    expect(texts[0]).toBe('ask 34'); // newest first
    expect(texts).not.toContain('ask 4'); // oldest five dropped
    expect(texts).toContain('ask 5');
  });

  it('deletes a prompt by exact text', async () => {
    const store = await freshStore();
    store.recordRecentPrompt('keep me');
    store.recordRecentPrompt('drop me');
    const after = store.deleteRecentPrompt('drop me');
    expect(after.map((p) => p.text)).toEqual(['keep me']);
  });

  it('persists across a fresh module load (atomic write)', async () => {
    const first = await freshStore();
    first.recordRecentPrompt('survives restart');
    const second = await freshStore(); // re-import → cache cleared, reads file
    expect(second.listRecentPrompts().map((p) => p.text)).toEqual(['survives restart']);
  });
});
