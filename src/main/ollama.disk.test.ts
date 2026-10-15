import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listModelsOnDisk } from './ollama';

let dir: string;

function writeManifest(rel: string, body: unknown, mtime?: Date): void {
  const file = path.join(dir, 'manifests', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-models-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('listModelsOnDisk', () => {
  it('returns nothing when there is no manifest store', () => {
    expect(listModelsOnDisk(dir)).toEqual([]);
  });

  it('names library, namespaced and foreign-registry models like `ollama list`', () => {
    const manifest = { config: { size: 10 }, layers: [{ size: 100 }, { size: 5 }] };
    writeManifest('registry.ollama.ai/library/gemma4/12b', manifest);
    writeManifest('registry.ollama.ai/acme/coder/latest', manifest);
    writeManifest('hf.co/acme/tiny-gguf/Q4_K_M', manifest);
    const names = listModelsOnDisk(dir).map((m) => m.name).sort();
    expect(names).toEqual(['acme/coder:latest', 'gemma4:12b', 'hf.co/acme/tiny-gguf:Q4_K_M']);
  });

  it('sums config and layer sizes', () => {
    writeManifest('registry.ollama.ai/library/qwen/7b', {
      config: { size: 10 },
      layers: [{ size: 100 }, { size: 5 }],
    });
    expect(listModelsOnDisk(dir)[0].sizeBytes).toBe(115);
  });

  it('skips unreadable manifests and dotfiles, newest first', () => {
    writeManifest('registry.ollama.ai/library/old/1b', { layers: [] }, new Date('2025-01-01'));
    writeManifest('registry.ollama.ai/library/new/1b', { layers: [] }, new Date('2026-01-01'));
    writeManifest('registry.ollama.ai/library/broken/1b', '{not json');
    writeManifest('registry.ollama.ai/library/new/.DS_Store', '');
    expect(listModelsOnDisk(dir).map((m) => m.name)).toEqual(['new:1b', 'old:1b']);
  });
});
