import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../shared/types';
import {
  isAgentWrittenPath,
  isWritingTool,
  recordWritesFromEvents,
  recordWrittenPath,
  resetWrittenPathsForTest,
} from './writtenPaths';

function assistantEvent(
  toolUses: Array<{ name: string; filePath?: string }>,
): StreamEvent {
  return {
    id: 'e1',
    timestamp: 1,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: {
        model: 'claude-sonnet-5',
        text: '',
        thinking: [],
        toolUses: toolUses.map((t, i) => ({
          id: `t${i}`,
          name: t.name,
          inputJSON: '{}',
          filePath: t.filePath,
        })),
      },
    },
  } as StreamEvent;
}

function toolResultEvent(results: Array<{ id: string; isError?: boolean }>): StreamEvent {
  return {
    id: 'r1',
    timestamp: 2,
    raw: '',
    revision: 0,
    kind: {
      type: 'toolResult',
      results: results.map((r) => ({ id: r.id, content: '', isError: r.isError ?? false })),
    },
  } as StreamEvent;
}

afterEach(() => resetWrittenPathsForTest());

describe('isWritingTool', () => {
  it('accepts the tools that create files', () => {
    for (const name of ['Write', 'Edit', 'NotebookEdit', 'write_file', 'edit_file']) {
      expect(isWritingTool(name)).toBe(true);
    }
  });

  it('refuses read-only tools', () => {
    // Naming a file is not creating one. Honouring Read would let a model
    // launder any path into the allowlist by trying to read it first.
    for (const name of ['Read', 'Grep', 'Glob', 'Bash', undefined]) {
      expect(isWritingTool(name)).toBe(false);
    }
  });
});

describe('recordWrittenPath / isAgentWrittenPath', () => {
  it('allows a path only after a write to it was recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const file = join(dir, 'chunk_19.json');
      writeFileSync(file, '{}');
      expect(isAgentWrittenPath(file)).toBe(false);
      recordWrittenPath(file);
      expect(isAgentWrittenPath(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not allow a sibling in the same directory', () => {
    // The unit is the FILE, not its folder: recording one chunk must not
    // open the whole scratch directory.
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      recordWrittenPath(join(dir, 'a.json'));
      expect(isAgentWrittenPath(join(dir, 'b.json'))).toBe(false);
      expect(isAgentWrittenPath(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches the same file spelled through a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const real = join(dir, 'real.json');
      writeFileSync(real, '{}');
      const link = join(dir, 'link.json');
      symlinkSync(real, link);
      recordWrittenPath(link);
      expect(isAgentWrittenPath(real)).toBe(true);
      expect(isAgentWrittenPath(realpathSync(real))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores relative and empty hints', () => {
    // A relative path would resolve against the main process cwd, which in a
    // dev build is the overcli checkout.
    recordWrittenPath('notes.md');
    recordWrittenPath('');
    recordWrittenPath(undefined);
    expect(isAgentWrittenPath('notes.md')).toBe(false);
    expect(isAgentWrittenPath('')).toBe(false);
  });

  it('evicts the oldest once the cap is passed, keeping recent writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const first = join(dir, 'first.json');
      recordWrittenPath(first);
      for (let i = 0; i < 5_000; i++) recordWrittenPath(join(dir, `f${i}.json`));
      expect(isAgentWrittenPath(first)).toBe(false);
      expect(isAgentWrittenPath(join(dir, 'f4999.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-writing a file refreshes its place in the queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const kept = join(dir, 'kept.json');
      recordWrittenPath(kept);
      for (let i = 0; i < 4_000; i++) recordWrittenPath(join(dir, `f${i}.json`));
      recordWrittenPath(kept); // touched again, so it must survive
      for (let i = 4_000; i < 6_000; i++) recordWrittenPath(join(dir, `f${i}.json`));
      expect(isAgentWrittenPath(kept)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordWritesFromEvents', () => {
  it('records the file a Write tool touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const file = join(dir, 'chunk_19.json');
      recordWritesFromEvents([
        assistantEvent([{ name: 'Write', filePath: file }]),
        toolResultEvent([{ id: 't0' }]),
      ]);
      expect(isAgentWrittenPath(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores the paths a read-only tool names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const file = join(dir, 'secret.env');
      recordWritesFromEvents([assistantEvent([{ name: 'Read', filePath: file }])]);
      expect(isAgentWrittenPath(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes every write in a batch and skips tool uses with no path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const a = join(dir, 'a.json');
      const b = join(dir, 'b.json');
      recordWritesFromEvents([
        assistantEvent([
          { name: 'Write', filePath: a },
          { name: 'Bash' },
          { name: 'Edit', filePath: b },
        ]),
        toolResultEvent([{ id: 't0' }, { id: 't1' }, { id: 't2' }]),
      ]);
      expect(isAgentWrittenPath(a)).toBe(true);
      expect(isAgentWrittenPath(b)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-assistant events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const file = join(dir, 'x.json');
      recordWritesFromEvents([
        { id: 'u1', timestamp: 1, raw: '', revision: 0, kind: { type: 'user', text: file } } as unknown as StreamEvent,
      ]);
      expect(isAgentWrittenPath(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not record a write the user denied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-written-'));
    try {
      const target = join(dir, 'denied.txt');
      recordWritesFromEvents([
        assistantEvent([{ name: 'Write', filePath: target }]),
        toolResultEvent([{ id: 't0', isError: true }]),
      ]);
      expect(isAgentWrittenPath(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
