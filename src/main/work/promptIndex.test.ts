import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ data: '', home: '' }));
vi.mock('../host', () => ({ host: () => ({ dataDir: () => dirs.data }) }));
vi.mock('../diagnostics', () => ({ log: vi.fn() }));

import { resetPromptIndexForTests, searchPrompts } from './promptIndex';

function writeTranscript(file: string, prompts: string[]): void {
  const lines = prompts.map((text, i) =>
    JSON.stringify({ type: 'user', cwd: '/work/acme-orders', timestamp: new Date(1_700_000_000_000 + i).toISOString(), message: { content: text } }),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

describe('searchPrompts', () => {
  let projectDir: string;
  beforeEach(() => {
    dirs.data = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-index-data-'));
    dirs.home = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-index-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dirs.home);
    projectDir = path.join(dirs.home, '.claude', 'projects', '-work-acme-orders');
    fs.mkdirSync(projectDir, { recursive: true });
    resetPromptIndexForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dirs.data, { recursive: true, force: true });
    fs.rmSync(dirs.home, { recursive: true, force: true });
  });

  it('matches every word case-insensitively and keeps the original casing in the snippet', async () => {
    writeTranscript(path.join(projectDir, 'sess-1.jsonl'), ['Fix the Checkout Retry on ACME orders']);
    writeTranscript(path.join(projectDir, 'sess-2.jsonl'), ['something unrelated']);
    const hits = await searchPrompts('checkout acme');
    expect(hits.map((h) => h.sessionId)).toEqual(['sess-1']);
    expect(hits[0].snippet).toContain('Checkout Retry');
  });

  it('searches the new text once a transcript changes, not a stale lowered copy', async () => {
    const file = path.join(projectDir, 'sess-3.jsonl');
    writeTranscript(file, ['Draft the invoice export']);
    expect(await searchPrompts('invoice')).toHaveLength(1);

    writeTranscript(file, ['Draft the shipping label run, now with more words']);
    resetPromptIndexForTests();
    expect(await searchPrompts('invoice')).toHaveLength(0);
    expect(await searchPrompts('SHIPPING')).toHaveLength(1);
  });
});
