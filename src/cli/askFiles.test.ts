import { describe, expect, it } from 'vitest';
import { ASK_MAX_IMAGES, askFiles } from './askFiles';

const PNG = Buffer.from('not really a png').toString('base64');

describe('askFiles', () => {
  it('attaches nothing when no files are sent', () => {
    expect(askFiles(undefined)).toEqual({ ok: true, attachments: [], text: '', names: [] });
  });

  it('sends a picture as an attachment, a data URL prefix and all', () => {
    const res = askFiles([{ name: 'screen.png', type: 'image/png', data: `data:image/png;base64,${PNG}` }]);
    expect(res).toMatchObject({ ok: true, text: '', names: ['screen.png'] });
    if (!res.ok) return;
    expect(res.attachments[0]).toMatchObject({ mimeType: 'image/png', dataBase64: PNG, label: 'screen.png', size: 16 });
  });

  it('reads a text file into the message under its name', () => {
    const res = askFiles([{ name: 'notes.md', text: 'line one' }]);
    expect(res.ok && res.text).toContain('--- notes.md ---\nline one\n--- end of notes.md ---');
    expect(res.ok && res.attachments).toEqual([]);
  });

  it('refuses kinds and sizes the Slack door would not take either', () => {
    expect(askFiles([{ name: 'a.pdf', type: 'application/pdf', data: PNG }])).toMatchObject({ ok: false });
    expect(askFiles([{ name: 'big.txt', text: 'x'.repeat(60_001) }])).toMatchObject({ ok: false });
    expect(askFiles(Array.from({ length: ASK_MAX_IMAGES + 1 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', data: PNG })))).toMatchObject({ ok: false });
    expect(askFiles([{ name: 'bad.png', type: 'image/png', data: 'not base64!' }])).toMatchObject({ ok: false });
    expect(askFiles('nope')).toMatchObject({ ok: false });
  });
});
