// Checkpointing is what makes the "you can undo anything" promise true, so
// the parts that decide WHETHER to commit are the ones worth pinning down:
// skip when nothing changed, skip when the change is too big to live in a
// git object store forever, commit otherwise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkpointProject, MAX_CHECKPOINT_BYTES, pendingChangeBytes } from './versions';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-versions-'));
}

const commitOk = async () => ({ ok: true as const, sha: 'abc123' });

describe('pendingChangeBytes', () => {
  it('adds up the files porcelain says have changed', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.md'), 'x'.repeat(100));
    fs.writeFileSync(path.join(dir, 'b.md'), 'y'.repeat(50));

    expect(pendingChangeBytes(dir, ' M a.md\n?? b.md\n')).toBe(150);
  });

  it('reads the new name of a rename, and ignores a file that is gone', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'new.md'), 'z'.repeat(10));

    expect(pendingChangeBytes(dir, 'R  old.md -> new.md\n D deleted.md\n')).toBe(10);
  });

  it('measures a wholly-untracked FOLDER, which porcelain reports as one entry', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'exports', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'exports', 'a.pdf'), 'x'.repeat(400));
    fs.writeFileSync(path.join(dir, 'exports', 'nested', 'b.pdf'), 'y'.repeat(600));

    // `?? exports/` used to measure 0, so the guard passed and the artifacts
    // were committed — exactly the case it exists to block.
    expect(pendingChangeBytes(dir, '?? exports/\n')).toBe(1000);
  });

  it('handles a quoted path without counting the quotes as part of the name', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a b.md'), 'q'.repeat(7));

    expect(pendingChangeBytes(dir, ' M "a b.md"\n')).toBe(7);
  });
});

describe('checkpointProject', () => {
  it('skips quietly when nothing changed — the ordinary case for a timer', async () => {
    const res = await checkpointProject(
      { projectPath: '/tmp/whatever', message: 'Edited BRIEF.md' },
      { statusPorcelain: async () => '', commit: commitOk },
    );

    expect(res).toEqual({ ok: false, skipped: 'nothing-to-save' });
  });

  it('commits when there is something to record', async () => {
    const messages: string[] = [];
    const res = await checkpointProject(
      { projectPath: '/tmp/whatever', message: 'Edited BRIEF.md' },
      {
        statusPorcelain: async () => ' M BRIEF.md\n',
        sizeOf: () => 1024,
        commit: async (a) => {
          messages.push(a.message);
          return { ok: true as const, sha: 'abc123' };
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(messages).toEqual(['Edited BRIEF.md']);
  });

  it('declines a change too large to keep forever, and does not commit it', async () => {
    let committed = false;
    const res = await checkpointProject(
      { projectPath: '/tmp/whatever', message: 'Added 1 document' },
      {
        statusPorcelain: async () => '?? huge.pdf\n',
        sizeOf: () => MAX_CHECKPOINT_BYTES + 1,
        commit: async () => {
          committed = true;
          return { ok: true as const, sha: 'abc123' };
        },
      },
    );

    expect(res).toEqual({ ok: false, skipped: 'too-large' });
    expect(committed).toBe(false);
  });

  it('reports a real commit failure rather than swallowing it', async () => {
    const res = await checkpointProject(
      { projectPath: '/tmp/whatever', message: 'Edited BRIEF.md' },
      {
        statusPorcelain: async () => ' M BRIEF.md\n',
        sizeOf: () => 10,
        commit: async () => ({ ok: false as const, error: 'git exploded' }),
      },
    );

    expect(res).toEqual({ ok: false, error: 'git exploded' });
  });
});
