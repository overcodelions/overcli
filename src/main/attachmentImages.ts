// Turning images the models can't read into ones they can.
//
// An iPhone photo arrives as HEIC. Chromium can't decode it, so the chat
// bubble shows a broken-image icon, and none of the model APIs accept it
// either — Claude, Codex and Gemini all stop at png/jpeg/gif/webp. Rather
// than teach every backend about HEIC, we convert once at intake and
// everything downstream sees an ordinary JPEG.
//
// `sips` ships with macOS and decodes everything ImageIO does (HEIC, HEIF,
// TIFF, BMP, …). Elsewhere there is no converter we can count on, so the
// caller gets an error and turns it into a "convert it first" rejection.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/// What the model APIs accept as an image block.
export const MODEL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/// Long edge after conversion. Phone photos are ~4000px; the APIs downscale
/// past roughly this anyway, and a smaller JPEG keeps us well under the
/// per-image request cap.
const MAX_EDGE_PX = 2048;
const SIPS_TIMEOUT_MS = 20_000;

export type ConvertImageResult =
  | { ok: true; dataBase64: string; mimeType: 'image/jpeg'; label: string }
  | { ok: false; error: string };

export interface ConvertImageDeps {
  platform: NodeJS.Platform;
  run: (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>;
}

const defaultDeps: ConvertImageDeps = {
  platform: process.platform,
  run: (cmd, args, opts) => execFileAsync(cmd, args, opts),
};

export function jpegLabel(label: string | undefined): string {
  const name = label || 'image';
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

export async function convertImageToJpeg(
  args: { dataBase64: string; label?: string },
  deps: ConvertImageDeps = defaultDeps,
): Promise<ConvertImageResult> {
  if (deps.platform !== 'darwin') {
    return { ok: false, error: 'only macOS can convert this image format' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-img-'));
  try {
    // The input name only needs an extension sips can sniff past; ImageIO
    // reads the real format from the bytes.
    const input = path.join(dir, 'in');
    const output = path.join(dir, 'out.jpg');
    fs.writeFileSync(input, Buffer.from(args.dataBase64, 'base64'));
    await deps.run(
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', String(MAX_EDGE_PX), input, '--out', output],
      { timeout: SIPS_TIMEOUT_MS },
    );
    const bytes = fs.readFileSync(output);
    if (bytes.length === 0) return { ok: false, error: 'conversion produced an empty file' };
    return { ok: true, dataBase64: bytes.toString('base64'), mimeType: 'image/jpeg', label: jpegLabel(args.label) };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'conversion failed' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
