// Contract test for the renderer ↔ main IPC seam.
//
// `IPCInvokeMap` (in src/shared/types.ts) is the typed contract: every
// channel the renderer can call lives there with its argument and return
// shape. The actual handlers register via `ipcMain.handle('channel', ...)`
// in src/main/index.ts. TypeScript will catch shape mismatches but
// CANNOT catch a missing or mistyped channel name — the renderer's
// `window.overcli.invoke(...)` accepts any key from the map, but at
// runtime Electron just returns undefined / errors when no handler is
// listening.
//
// This test parses both files at test time and asserts the sets of keys
// match exactly. It will fail loudly the next time someone:
//   - adds a key to IPCInvokeMap but forgets the handler,
//   - renames a key on one side and not the other,
//   - registers a handler that no IPCInvokeMap entry references.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function ipcInvokeMapKeys(): Set<string> {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'types.ts'), 'utf-8');
  const start = src.indexOf('export interface IPCInvokeMap');
  if (start < 0) throw new Error('IPCInvokeMap interface not found in types.ts');
  const braceOpen = src.indexOf('{', start);
  // Find the matching closing brace by counting depth.
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('IPCInvokeMap interface body has unbalanced braces');
  const body = src.slice(braceOpen + 1, end);
  // Match keys at the start of any line: optional whitespace, a quoted
  // string, then a colon. This skips block comments and field-typedef
  // continuation lines (which start with non-quote chars).
  const re = /^\s*['"]([^'"]+)['"]\s*:/gm;
  const keys = new Set<string>();
  for (const m of body.matchAll(re)) {
    keys.add(m[1]);
  }
  return keys;
}

function ipcHandleChannels(): Set<string> {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf-8');
  const channels = new Set<string>();
  // Catch both `ipcMain.handle('foo', ...)` and `ipcMain.handle("foo", ...)`.
  const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    channels.add(m[1]);
  }
  return channels;
}

describe('IPC contract', () => {
  it('every IPCInvokeMap key has a matching ipcMain.handle registration', () => {
    const keys = ipcInvokeMapKeys();
    const channels = ipcHandleChannels();
    const missing = [...keys].filter((k) => !channels.has(k)).sort();
    expect(
      missing,
      `IPCInvokeMap declares these channels but no ipcMain.handle is registered for them:\n  - ${missing.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('every ipcMain.handle registration has a matching IPCInvokeMap entry', () => {
    const keys = ipcInvokeMapKeys();
    const channels = ipcHandleChannels();
    const orphan = [...channels].filter((c) => !keys.has(c)).sort();
    expect(
      orphan,
      `ipcMain.handle registers these channels but they're not declared in IPCInvokeMap (renderer cannot invoke them through the typed wrapper):\n  - ${orphan.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('finds a non-trivial number of channels (sanity check on the parser)', () => {
    const keys = ipcInvokeMapKeys();
    const channels = ipcHandleChannels();
    // Anything in single digits would mean the parser silently failed
    // and matched almost nothing — fail before declaring "they match!".
    expect(keys.size).toBeGreaterThan(20);
    expect(channels.size).toBeGreaterThan(20);
  });
});
