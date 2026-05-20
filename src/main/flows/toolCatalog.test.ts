import { describe, expect, it } from 'vitest';

import type { Backend } from '../../shared/types';
import { listToolCatalog } from './toolCatalog';

describe('listToolCatalog', () => {
  it.each(['claude', 'codex', 'gemini', 'copilot'] as Backend[])(
    'returns available Claude-family built-ins for %s',
    backend => {
      const catalog = listToolCatalog({ backend });
      expect(catalog.map(t => t.id)).toEqual([
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'WebFetch',
        'Task',
      ]);
      expect(catalog.every(t => t.available)).toBe(true);
      expect(catalog.every(t => t.category === 'builtin')).toBe(true);
      expect(catalog.every(t => t.supportedBackends.includes(backend))).toBe(true);
    },
  );

  it('returns native Ollama tools as available', () => {
    const catalog = listToolCatalog({ backend: 'ollama' });
    const native = catalog.filter(t => ['read_file', 'list_dir', 'grep'].includes(t.id));
    expect(native.map(t => t.id)).toEqual(['read_file', 'list_dir', 'grep']);
    expect(native.every(t => t.available)).toBe(true);
    expect(native.every(t => t.supportedBackends.includes('ollama'))).toBe(true);
  });

  it('returns Ollama write_file, edit_file, and bash as available', () => {
    // Originally surfaced as greyed roadmap entries — now implemented in
    // ollamaTools.ts so flow implementers can actually create + edit
    // files and run shell commands. Test guards the contract so the
    // editor stops greying them.
    const catalog = listToolCatalog({ backend: 'ollama' });
    const writeBash = catalog.filter(t => ['write_file', 'edit_file', 'bash'].includes(t.id));
    expect(writeBash.map(t => t.id)).toEqual(['write_file', 'edit_file', 'bash']);
    expect(writeBash.every(t => t.available)).toBe(true);
    expect(writeBash.every(t => t.supportedBackends.includes('ollama'))).toBe(true);
  });
});
