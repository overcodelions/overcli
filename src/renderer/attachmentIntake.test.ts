// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

// `intakeAttachments` reads file contents through `FileReader`, which node's
// bare environment doesn't provide — jsdom does.

import {
  ATTACHMENT_ACCEPT,
  MAX_LLM_ATTACHMENT_BYTES,
  MAX_PROJECT_FILE_BYTES,
  guessMimeFromName,
  intakeAttachments,
  needsImageConversion,
  intakeProjectFiles,
  isAcceptedAttachment,
} from './attachmentIntake';

describe('guessMimeFromName', () => {
  it('maps common text-like extensions to their mime type', () => {
    expect(guessMimeFromName('report.csv')).toBe('text/csv');
    expect(guessMimeFromName('data.json')).toBe('application/json');
    expect(guessMimeFromName('notes.md')).toBe('text/markdown');
    expect(guessMimeFromName('config.yaml')).toBe('application/x-yaml');
    expect(guessMimeFromName('config.yml')).toBe('application/x-yaml');
  });

  it('maps document extensions to their mime type', () => {
    expect(guessMimeFromName('spec.pdf')).toBe('application/pdf');
    expect(guessMimeFromName('brief.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('falls back to text/plain for an unrecognized extension', () => {
    expect(guessMimeFromName('script.sh')).toBe('text/plain');
    expect(guessMimeFromName('server.log')).toBe('text/plain');
  });

  it('returns null when the name has no extension', () => {
    expect(guessMimeFromName('README')).toBeNull();
  });
});

describe('isAcceptedAttachment', () => {
  it('accepts anything typed image/* or text/*', () => {
    expect(isAcceptedAttachment(new File([''], 'photo.heic', { type: 'image/heic' }))).toBe(true);
    expect(isAcceptedAttachment(new File([''], 'notes.txt', { type: 'text/plain' }))).toBe(true);
  });

  it('accepts a known extension even when the browser reports no mime type', () => {
    expect(isAcceptedAttachment(new File([''], 'data.csv', { type: '' }))).toBe(true);
    expect(isAcceptedAttachment(new File([''], 'report.pdf', { type: '' }))).toBe(true);
  });

  it('rejects an unsupported type and extension', () => {
    expect(isAcceptedAttachment(new File([''], 'archive.zip', { type: 'application/zip' }))).toBe(
      false,
    );
    expect(isAcceptedAttachment(new File([''], 'video.mp4', { type: 'video/mp4' }))).toBe(false);
  });

  it('every extension listed in ATTACHMENT_ACCEPT is accepted', () => {
    const exts = ATTACHMENT_ACCEPT.split(',').filter((tok) => tok.startsWith('.'));
    expect(exts.length).toBeGreaterThan(0);
    for (const ext of exts) {
      const f = new File([''], `sample${ext}`, { type: '' });
      expect(isAcceptedAttachment(f)).toBe(true);
    }
  });
});

describe('intakeAttachments — size rejection', () => {
  it('rejects a file over the LLM attachment cap with a sized reason', async () => {
    const big = new File(['x'], 'huge.txt', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: MAX_LLM_ATTACHMENT_BYTES + 1 });

    const { attachments, rejections } = await intakeAttachments([big]);

    expect(attachments).toHaveLength(0);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('huge.txt');
    expect(rejections[0]).toContain('max is 25 MB');
  });

  it('rounds a 25.4 MB rejected file up without rounding the 25 MB cap up', async () => {
    const big = new File(['x'], 'fractional.txt', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 25.4 * 1024 * 1024 });

    const { rejections } = await intakeAttachments([big]);

    expect(rejections[0]).toContain('is 26 MB; max is 25 MB');
  });

  it('still attaches a file at or under the limit', async () => {
    const ok = new File(['x'], 'ok.txt', { type: 'text/plain' });
    Object.defineProperty(ok, 'size', { value: MAX_LLM_ATTACHMENT_BYTES });

    const { attachments, rejections } = await intakeAttachments([ok]);

    expect(rejections).toHaveLength(0);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].label).toBe('ok.txt');
  });
});

describe('intakeProjectFiles — a copy, not an attachment', () => {
  function sized(name: string, size: number): File {
    const f = new File(['x'], name, { type: '' });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  }

  it('accepts a file the LLM cap would have refused', async () => {
    const { files, rejections } = await intakeProjectFiles([
      sized('deck.pptx', MAX_LLM_ATTACHMENT_BYTES + 1),
    ]);

    expect(rejections).toHaveLength(0);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('deck.pptx');
  });

  it('rejects past its own, larger cap and says the right number', async () => {
    const { files, rejections } = await intakeProjectFiles([
      sized('enormous.mov', MAX_PROJECT_FILE_BYTES + 1),
    ]);

    expect(files).toHaveLength(0);
    expect(rejections[0]).toContain('enormous.mov');
    expect(rejections[0]).toContain('max is 50 MB');
  });

  it('prefers the real path over reading the bytes, when the bridge has one', async () => {
    (window as unknown as { overcli: unknown }).overcli = {
      filePath: () => '/Users/someone/Desktop/deck.pptx',
    };
    try {
      const { files } = await intakeProjectFiles([sized('deck.pptx', 40 * 1024 * 1024)]);

      expect(files[0].sourcePath).toBe('/Users/someone/Desktop/deck.pptx');
      expect(files[0].dataBase64).toBeUndefined();
    } finally {
      delete (window as unknown as { overcli?: unknown }).overcli;
    }
  });

  it('falls back to bytes when there is no path behind the file', async () => {
    const { files } = await intakeProjectFiles([new File(['hello'], 'pasted.png')]);

    expect(files[0].sourcePath).toBeUndefined();
    expect(files[0].dataBase64).toBe(Buffer.from('hello').toString('base64'));
  });
});

describe('intakeAttachments — images the models cannot read', () => {
  it('only flags formats outside png/jpeg/gif/webp', () => {
    expect(needsImageConversion('image/heic')).toBe(true);
    expect(needsImageConversion('image/tiff')).toBe(true);
    expect(needsImageConversion('image/jpeg')).toBe(false);
    expect(needsImageConversion('image/svg+xml')).toBe(false);
    expect(needsImageConversion('text/plain')).toBe(false);
  });

  it('accepts a .heic the OS gave no type for', () => {
    expect(isAcceptedAttachment(new File([''], 'IMG_3942.HEIC'))).toBe(true);
  });

  it('swaps a HEIC for the JPEG the main process converted it to', async () => {
    const jpeg = Buffer.from('jpeg-bytes').toString('base64');
    (window as unknown as { overcli: unknown }).overcli = {
      invoke: async () => ({ ok: true, dataBase64: jpeg, mimeType: 'image/jpeg', label: 'IMG_3942.jpg' }),
    };
    try {
      const { attachments, rejections } = await intakeAttachments([
        new File(['heic-bytes'], 'IMG_3942.HEIC', { type: 'image/heic' }),
      ]);

      expect(rejections).toEqual([]);
      expect(attachments[0]).toMatchObject({ mimeType: 'image/jpeg', label: 'IMG_3942.jpg', dataBase64: jpeg });
    } finally {
      delete (window as unknown as { overcli?: unknown }).overcli;
    }
  });

  it('rejects with a reason when there is nothing to convert it', async () => {
    const { attachments, rejections } = await intakeAttachments([
      new File(['heic-bytes'], 'IMG_3942.HEIC', { type: 'image/heic' }),
    ]);

    expect(attachments).toHaveLength(0);
    expect(rejections[0]).toContain('IMG_3942.HEIC');
  });
});
