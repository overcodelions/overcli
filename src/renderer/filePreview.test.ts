import { describe, expect, it } from 'vitest';
import {
  defaultFileViewMode,
  detectFilePreviewKind,
  fileExtensionKey,
  isBinaryPreviewKind,
  isUnsupportedBinaryFile,
} from './filePreview';

describe('file preview detection', () => {
  it('detects text previews', () => {
    expect(detectFilePreviewKind('/repo/README.md')).toBe('markdown');
    expect(detectFilePreviewKind('/repo/index.html')).toBe('html');
    expect(detectFilePreviewKind('/repo/data.csv')).toBe('csv');
    expect(detectFilePreviewKind('/repo/package.json')).toBe('json');
    expect(detectFilePreviewKind('/repo/Button.tsx')).toBe('react');
  });

  it('detects binary artifact previews', () => {
    expect(detectFilePreviewKind('/repo/screen.png')).toBe('image');
    expect(detectFilePreviewKind('/repo/spec.pdf')).toBe('pdf');
    expect(detectFilePreviewKind('/repo/model.xlsx')).toBe('office');
    expect(detectFilePreviewKind('/repo/deck.pptx')).toBe('office');
  });

  it('keeps binary artifact handling out of the text editor path', () => {
    expect(isBinaryPreviewKind(detectFilePreviewKind('/repo/screen.png'))).toBe(true);
    expect(isBinaryPreviewKind(detectFilePreviewKind('/repo/Button.tsx'))).toBe(false);
  });

  it('rejects unsupported binary containers before reading', () => {
    expect(isUnsupportedBinaryFile('/repo/installer.dmg')).toBe(true);
    expect(isUnsupportedBinaryFile('/repo/archive.zip')).toBe(true);
    expect(isUnsupportedBinaryFile('/repo/README.md')).toBe(false);
  });

  it('opens every file in the editor, previewable or not', () => {
    expect(defaultFileViewMode('/repo/main.ts', false)).toBe('edit');
    expect(defaultFileViewMode('/repo/index.html', false)).toBe('edit');
    expect(defaultFileViewMode('/repo/data.csv', false)).toBe('edit');
    // …but markdown and components render, and a line jump still wins.
    expect(defaultFileViewMode('/repo/Button.tsx', false)).toBe('preview');
    expect(defaultFileViewMode('/repo/README.md', false)).toBe('preview');
    expect(defaultFileViewMode('/repo/notes.markdown', false)).toBe('preview');
    expect(defaultFileViewMode('/repo/Card.jsx', false)).toBe('preview');
    expect(defaultFileViewMode('/repo/Button.tsx', true)).toBe('edit');
  });

  it('still honours an explicitly requested mode', () => {
    expect(defaultFileViewMode('/repo/README.md', false, 'preview')).toBe('preview');
    expect(defaultFileViewMode('/repo/main.ts', false, 'diff')).toBe('diff');
    // …but not a preview of something that has no preview.
    expect(defaultFileViewMode('/repo/main.ts', false, 'preview')).toBe('edit');
  });

  it('opens in preview once that extension has been previewed before', () => {
    expect(defaultFileViewMode('/repo/index.html', false, undefined, 'preview')).toBe('preview');
    expect(defaultFileViewMode('/repo/data.csv', false, undefined, 'preview')).toBe('preview');
  });

  it('does not apply a remembered preview to a type that has none', () => {
    expect(defaultFileViewMode('/repo/main.ts', false, undefined, 'preview')).toBe('edit');
  });

  it('lets a remembered edit override the render-first default', () => {
    expect(defaultFileViewMode('/repo/README.md', false, undefined, 'edit')).toBe('edit');
    expect(defaultFileViewMode('/repo/Button.tsx', false, undefined, 'edit')).toBe('edit');
  });

  it('lets a line jump outrank the remembered mode', () => {
    // Preview cannot show you line 42.
    expect(defaultFileViewMode('/repo/README.md', true, undefined, 'preview')).toBe('edit');
  });

  it('still lets an explicit request outrank the remembered mode', () => {
    expect(defaultFileViewMode('/repo/README.md', false, 'edit', 'preview')).toBe('edit');
    expect(defaultFileViewMode('/repo/README.md', false, 'diff', 'preview')).toBe('diff');
  });
});

describe('fileExtensionKey', () => {
  it('keys on the lowercased extension', () => {
    expect(fileExtensionKey('/repo/docs/README.MD')).toBe('md');
    expect(fileExtensionKey('/repo/src/Button.tsx')).toBe('tsx');
    expect(fileExtensionKey('C:\\repo\\notes.md')).toBe('md');
  });

  it('is empty for a file with no extension', () => {
    expect(fileExtensionKey('/repo/Makefile')).toBe('');
    expect(fileExtensionKey(null)).toBe('');
  });
});
