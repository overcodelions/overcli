import { describe, expect, it } from 'vitest';
import { teamBriefFiles } from './controlPlane';

describe('files sent with a task for a team', () => {
  it('takes documents whole', () => {
    const got = teamBriefFiles([{ name: 'gap.pdf', type: 'application/pdf', data: 'data:application/pdf;base64,eHl6' }]);
    expect(got).toEqual({ ok: true, attachments: [{ id: 'file-1', mimeType: 'application/pdf', dataBase64: 'eHl6', label: 'gap.pdf', size: 3 }] });
  });

  it('takes a file the browser could not type, and a task with none', () => {
    expect(teamBriefFiles([{ name: 'notes', data: 'data:;base64,eHl6' }])).toMatchObject({ ok: true, attachments: [{ mimeType: 'application/octet-stream' }] });
    expect(teamBriefFiles(undefined)).toEqual({ ok: true, attachments: [] });
  });

  it('refuses what it cannot read, and too many', () => {
    expect(teamBriefFiles('nope')).toMatchObject({ ok: false });
    expect(teamBriefFiles([{ name: 'x.pdf', data: 'not a data url' }])).toEqual({ ok: false, error: 'x.pdf could not be read.' });
    expect(teamBriefFiles(Array.from({ length: 11 }, () => ({ name: 'a', data: 'data:;base64,eA==' })))).toMatchObject({ ok: false });
  });
});
