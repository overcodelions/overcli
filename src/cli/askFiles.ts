// Files sent with a question from the console, shaped the way the Slack front
// door shapes the files in a thread: pictures go to the worker as
// attachments, text files are read into the message under their names. Same
// kinds and limits as Slack, so a worker can't tell which door a file came in.

import type { Attachment } from '../shared/types';

export const ASK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const ASK_MAX_IMAGES = 4;
export const ASK_MAX_IMAGE_BYTES = 5_000_000;
export const ASK_MAX_TEXTS = 3;
export const ASK_MAX_TEXT_CHARS = 60_000;
/// A question carrying its pictures as base64: four at the 5 MB cap is about
/// 27 MB, more than anyone needs to ask something. The console holds the
/// pictures to 10 MB together; this leaves room for the base64 and the rest.
export const MAX_ASK_BODY_BYTES = 14_000_000;

export type AskFilesResult = { ok: true; attachments: Attachment[]; text: string; names: string[] } | { ok: false; error: string };

/// `raw`: `[{ name, type, data }]` for a picture (base64, a data URL's
/// prefix allowed) or `[{ name, text }]` for a text file. Absent or empty:
/// nothing attached.
export function askFiles(raw: unknown): AskFilesResult {
  if (raw === undefined || raw === null) return { ok: true, attachments: [], text: '', names: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Send files as a list.' };
  const attachments: Attachment[] = [];
  const texts: Array<{ name: string; body: string }> = [];
  for (const [i, f] of raw.entries()) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'A file is missing its contents.' };
    const o = f as Record<string, unknown>;
    const name = (typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `file ${i + 1}`).slice(0, 200);
    if (typeof o.text === 'string') {
      if (texts.length >= ASK_MAX_TEXTS) return { ok: false, error: `Attach at most ${ASK_MAX_TEXTS} text files.` };
      if (o.text.length > ASK_MAX_TEXT_CHARS) return { ok: false, error: `${name} is too long to read in: keep text files under 60 KB.` };
      texts.push({ name, body: o.text });
      continue;
    }
    const type = typeof o.type === 'string' ? o.type : '';
    if (!ASK_IMAGE_TYPES.includes(type)) return { ok: false, error: `${name}: attach a PNG, JPEG, GIF or WebP picture, or a text file.` };
    if (typeof o.data !== 'string' || !o.data) return { ok: false, error: `${name} is empty.` };
    if (attachments.length >= ASK_MAX_IMAGES) return { ok: false, error: `Attach at most ${ASK_MAX_IMAGES} pictures.` };
    const data = o.data.replace(/^data:[^,]*;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, error: `${name} couldn’t be read.` };
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (size > ASK_MAX_IMAGE_BYTES) return { ok: false, error: `${name} is over 5 MB.` };
    attachments.push({ id: `ask-file-${i + 1}`, mimeType: type, dataBase64: data, label: name, size });
  }
  const text = texts.length
    ? `\n\nFiles attached to this message:\n${texts.map((t) => `--- ${t.name} ---\n${t.body}\n--- end of ${t.name} ---`).join('\n')}`
    : '';
  return { ok: true, attachments, text, names: [...attachments.map((a) => a.label ?? ''), ...texts.map((t) => t.name)] };
}
