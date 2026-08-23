// `createDocumentFromPrompt` takes a filename straight from a model and
// writes it to the user's disk, so the parsing and sanitising in between are
// the load-bearing parts. The LLM call itself is covered by the drafter's own
// tests — these cover everything downstream of it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../shared/types';
import { resolveNumstatPath } from './git';

const { mockOneShotDraftText } = vi.hoisted(() => ({
  mockOneShotDraftText: vi.fn(),
}));

// reviseDocument resolves which backend is healthy before drafting, then
// hands the turn to oneShotDraftText — stub both so the test exercises only
// the fence-stripping logic downstream of the model's reply.
vi.mock('./health', () => ({
  healthyBackends: vi.fn(async () => new Set(['claude'])),
}));
vi.mock('./flows/drafter', () => ({
  oneShotDraftText: mockOneShotDraftText,
}));

import {
  createBlankDocument,
  gatherProjectContext,
  listDocuments,
  parseDraftedDocument,
  reviseDocument,
  safeDocumentName,
  uniqueDocumentPath,
} from './documents';

function draftDeps(): Parameters<typeof reviseDocument>[0] {
  return {
    settings: {
      preferredBackend: 'claude',
      disabledBackends: {},
      backendPaths: {},
    } as unknown as AppSettings,
    runner: {} as never,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-documents-'));
}

describe('parseDraftedDocument', () => {
  it('splits the FILENAME header from the body', () => {
    const { name, body } = parseDraftedDocument(
      'FILENAME: Q3 summary.md\n---\n# Q3 summary\n\nRevenue was up.\n',
      'New document',
    );
    expect(name).toBe('Q3 summary.md');
    expect(body).toBe('# Q3 summary\n\nRevenue was up.\n');
  });

  it('keeps the whole reply as the document when the model skips the header', () => {
    const { name, body } = parseDraftedDocument('# Just a document\n\nBody.', 'New document');
    expect(name).toBe('New document.md');
    expect(body).toBe('# Just a document\n\nBody.\n');
  });
});

describe('safeDocumentName', () => {
  it('keeps a readable name with an allowed extension', () => {
    expect(safeDocumentName('Q3 marketing plan.md', 'x')).toBe('Q3 marketing plan.md');
    expect(safeDocumentName('budget.csv', 'x')).toBe('budget.csv');
  });

  it('forces .md onto an extension we would not open', () => {
    expect(safeDocumentName('payload.sh', 'x')).toBe('payload.md');
    expect(safeDocumentName('notes', 'x')).toBe('notes.md');
  });

  it('cannot be walked out of the folder', () => {
    expect(safeDocumentName('../../../etc/passwd.md', 'x')).toBe('passwd.md');
    expect(safeDocumentName('/tmp/evil.md', 'x')).toBe('evil.md');
    expect(safeDocumentName('...', 'fallback')).toBe('fallback.md');
    expect(safeDocumentName('', 'fallback')).toBe('fallback.md');
  });
});

describe('uniqueDocumentPath', () => {
  it('numbers rather than overwriting an existing document', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'plan.md'), 'first');
    expect(uniqueDocumentPath(dir, 'plan.md')).toBe(path.join(dir, 'plan 2.md'));
  });

  it('leaves a free name alone', () => {
    const dir = tempDir();
    expect(uniqueDocumentPath(dir, 'plan.md')).toBe(path.join(dir, 'plan.md'));
  });
});

describe('listDocuments', () => {
  it('lists one level, folders first then newest', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'Archive'));
    fs.writeFileSync(path.join(dir, 'old.md'), 'old');
    fs.writeFileSync(path.join(dir, 'new.md'), 'new');
    // Force a deterministic ordering rather than relying on write timing.
    fs.utimesSync(path.join(dir, 'old.md'), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(dir, 'new.md'), new Date(9000), new Date(9000));

    const res = listDocuments({ dirPath: dir });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.name)).toEqual(['Archive', 'new.md', 'old.md']);
    expect(res.entries[0].isDir).toBe(true);
    expect(res.entries[1].sizeBytes).toBe(3);
  });

  it('hides the undo history and other dotfiles', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'x');
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'x');

    const res = listDocuments({ dirPath: dir });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.name)).toEqual(['BRIEF.md']);
  });

  it('reports an unreadable folder instead of throwing', () => {
    expect(listDocuments({ dirPath: '/definitely/not/here' }).ok).toBe(false);
  });
});

describe('createBlankDocument', () => {
  it('seeds a markdown document with its own title', () => {
    const dir = tempDir();
    const res = createBlankDocument({ dirPath: dir, name: 'Q3 plan', ext: 'md' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(path.basename(res.path)).toBe('Q3 plan.md');
    expect(fs.readFileSync(res.path, 'utf-8')).toBe('# Q3 plan\n\n');
  });

  it('leaves non-markdown types genuinely empty', () => {
    const dir = tempDir();
    const res = createBlankDocument({ dirPath: dir, name: 'budget', ext: 'csv' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(path.basename(res.path)).toBe('budget.csv');
    expect(fs.readFileSync(res.path, 'utf-8')).toBe('');
  });

  it('defaults to a document when the type is unknown, and to Untitled when unnamed', () => {
    const dir = tempDir();
    const res = createBlankDocument({ dirPath: dir, name: '  ', ext: 'exe' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(path.basename(res.path)).toBe('Untitled.md');
  });

  it('numbers rather than overwriting an existing document', () => {
    const dir = tempDir();
    createBlankDocument({ dirPath: dir, name: 'Notes', ext: 'md' });
    const second = createBlankDocument({ dirPath: dir, name: 'Notes', ext: 'md' });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(path.basename(second.path)).toBe('Notes 2.md');
  });
});

describe('gatherProjectContext', () => {
  it('reads the project\'s other documents, nearest first, and never the one being edited', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'the brief');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'sibling notes');
    fs.mkdirSync(path.join(dir, 'course'));
    fs.writeFileSync(path.join(dir, 'course', 'SYLLABUS.md'), 'syllabus body');

    const { blocks } = gatherProjectContext({
      rootPath: dir,
      excludePath: path.join(dir, 'BRIEF.md'),
    });

    expect(blocks.map((b) => b.rel)).toEqual(['notes.md', path.join('course', 'SYLLABUS.md')]);
    expect(blocks.find((b) => b.rel === 'notes.md')?.text).toBe('sibling notes');
  });

  it('skips binaries and anything the model cannot read as prose', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'x');
    fs.writeFileSync(path.join(dir, 'logo.png'), 'binary');
    fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b');

    const { blocks } = gatherProjectContext({
      rootPath: dir,
      excludePath: path.join(dir, 'BRIEF.md'),
    });

    expect(blocks.map((b) => b.rel)).toEqual(['data.csv']);
  });

  it('reports what it had to leave out instead of silently truncating', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), 'x');
    fs.writeFileSync(path.join(dir, 'huge.md'), 'y'.repeat(50_000));
    fs.writeFileSync(path.join(dir, 'small.md'), 'small');

    const { blocks, omitted } = gatherProjectContext({
      rootPath: dir,
      excludePath: path.join(dir, 'BRIEF.md'),
    });

    expect(blocks.map((b) => b.rel)).toEqual(['small.md']);
    expect(omitted).toEqual(['huge.md']);
  });
});

describe('reviseDocument', () => {
  it('unwraps a reply that is entirely one fence', async () => {
    mockOneShotDraftText.mockResolvedValueOnce({
      ok: true,
      text: '```markdown\nHello world\n```',
      label: 'Claude',
      backend: 'claude',
    });

    const res = await reviseDocument(draftDeps(), {
      path: '/tmp/doc.md',
      content: 'Hello',
      instruction: 'greet the world',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content).toBe('Hello world');
  });

  it('leaves a reply byte-identical when fences appear in the middle, not just at the edges', async () => {
    const text = '```bash\necho hi\n```\n\nSome text\n\n```python\nprint(1)\n```';
    mockOneShotDraftText.mockResolvedValueOnce({
      ok: true,
      text,
      label: 'Claude',
      backend: 'claude',
    });

    const res = await reviseDocument(draftDeps(), {
      path: '/tmp/README.md',
      content: 'Some text',
      instruction: 'add a bash and a python example',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content).toBe(text);
  });
});

describe('resolveNumstatPath', () => {
  it('takes the new name from an arrow rename', () => {
    expect(resolveNumstatPath('old.md => new.md')).toBe('new.md');
  });

  it('rebuilds a braced rename, where only part of the path moved', () => {
    expect(resolveNumstatPath('docs/{old => new}/brief.md')).toBe('docs/new/brief.md');
    expect(resolveNumstatPath('{ => docs}/brief.md')).toBe('docs/brief.md');
  });

  it('leaves an ordinary path alone', () => {
    expect(resolveNumstatPath('marketing-101/BRIEF.md')).toBe('marketing-101/BRIEF.md');
  });
});

describe('safeDocumentName — long names', () => {
  it('truncates the stem, never the extension it just validated', () => {
    const out = safeDocumentName(`${'a'.repeat(200)}.csv`, 'x');
    expect(out.endsWith('.csv')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });
});
