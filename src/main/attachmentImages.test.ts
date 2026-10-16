import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertImageToJpeg, jpegLabel } from './attachmentImages';

describe('convertImageToJpeg', () => {
  it('runs sips and returns the JPEG it wrote', async () => {
    const result = await convertImageToJpeg(
      { dataBase64: Buffer.from('heic').toString('base64'), label: 'IMG_3942.HEIC' },
      {
        platform: 'darwin',
        run: async (cmd, args) => {
          expect(cmd).toBe('sips');
          fs.writeFileSync(args[args.length - 1], 'jpeg');
        },
      },
    );

    expect(result).toEqual({
      ok: true,
      dataBase64: Buffer.from('jpeg').toString('base64'),
      mimeType: 'image/jpeg',
      label: 'IMG_3942.jpg',
    });
  });

  it('reports failure instead of throwing when sips does', async () => {
    const result = await convertImageToJpeg(
      { dataBase64: 'AAAA', label: 'x.heic' },
      { platform: 'darwin', run: async () => { throw new Error('sips: unsupported'); } },
    );

    expect(result).toEqual({ ok: false, error: 'sips: unsupported' });
  });

  it('declines off macOS', async () => {
    const result = await convertImageToJpeg({ dataBase64: 'AAAA' }, { platform: 'linux', run: async () => {} });

    expect(result.ok).toBe(false);
  });

  it('renames to .jpg', () => {
    expect(jpegLabel('scan.final.tiff')).toBe('scan.final.jpg');
    expect(jpegLabel(undefined)).toBe('image.jpg');
  });
});
