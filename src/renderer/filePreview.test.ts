import { describe, expect, it } from 'vitest';
import {
  defaultFileViewMode,
  detectFilePreviewKind,
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

  it('opens previewable files in preview mode unless a line highlight is requested', () => {
    expect(defaultFileViewMode('/repo/Button.tsx', false)).toBe('preview');
    expect(defaultFileViewMode('/repo/Button.tsx', true)).toBe('edit');
  });
});
