import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICE_COM_SCRIPT,
  convertOfficeToPreview,
  findLibreOfficeBinary,
  inlineQuickLookAttachments,
  libreOfficeCandidates,
  officeFamilyForExtension,
  parseSlideSize,
  readQuickLookAttachments,
  resolveOnPath,
} from './officePreview';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-office-preview-test-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(full: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('officeFamilyForExtension', () => {
  it('maps the six Office extensions and nothing else', () => {
    expect(officeFamilyForExtension('docx')).toBe('document');
    expect(officeFamilyForExtension('xls')).toBe('spreadsheet');
    expect(officeFamilyForExtension('pptx')).toBe('presentation');
    expect(officeFamilyForExtension('pdf')).toBeNull();
  });
});

describe('libreOfficeCandidates', () => {
  it('looks in Program Files on Windows, where the installer puts it', () => {
    const candidates = libreOfficeCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
    });
    expect(candidates).toContain('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    expect(candidates).toContain('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe');
    expect(candidates).toContain('C:\\Users\\ada\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.exe');
  });

  it('skips roots the environment does not define', () => {
    expect(libreOfficeCandidates('win32', {}).filter((c) => c.includes('LibreOffice'))).toEqual([]);
  });

  it('keeps the app bundle first on macOS', () => {
    expect(libreOfficeCandidates('darwin', {})[0]).toBe(
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    );
  });

  it('covers distro and snap paths on Linux', () => {
    const candidates = libreOfficeCandidates('linux', {});
    expect(candidates).toContain('/usr/bin/soffice');
    expect(candidates).toContain('/snap/bin/libreoffice');
  });
});

/// Windows candidates are `path.win32` strings, which a POSIX test host
/// cannot represent on disk — so the Windows cases assert against a fake set
/// of installed paths rather than real files.
function installed(...paths: string[]) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (candidate: string) => set.has(candidate.toLowerCase());
}

describe('resolveOnPath', () => {
  it('applies PATHEXT on Windows so a bare name finds the .exe', () => {
    const found = resolveOnPath(
      'soffice',
      'win32',
      { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE' },
      installed('C:\\tools\\soffice.exe'),
    );
    // PATHEXT is conventionally uppercase and Windows filenames are
    // case-insensitive, so the resolved path carries PATHEXT's casing.
    expect(found?.toLowerCase()).toBe('c:\\tools\\soffice.exe');
  });

  it('misses on Windows when the extensionless name is all that is checked', () => {
    const found = resolveOnPath(
      'soffice',
      'win32',
      { PATH: 'C:\\tools', PATHEXT: '.BAT' },
      installed('C:\\tools\\soffice.exe'),
    );
    expect(found).toBeNull();
  });

  it('reads the Path spelling Windows also uses', () => {
    const found = resolveOnPath(
      'soffice',
      'win32',
      { Path: 'C:\\tools' },
      installed('C:\\tools\\soffice.exe'),
    );
    expect(found).not.toBeNull();
  });

  it('splits on colons and takes the bare name on POSIX', () => {
    const dir = path.join(root, 'bin');
    write(path.join(dir, 'soffice'), 'x');
    expect(resolveOnPath('soffice', 'darwin', { PATH: `/nope:${dir}` })).toBe(
      path.posix.join(dir, 'soffice'),
    );
  });
});

describe('findLibreOfficeBinary', () => {
  it('finds a Program Files install that is not on PATH', () => {
    const soffice = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
    expect(
      findLibreOfficeBinary({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
        exists: installed(soffice),
      }),
    ).toBe(soffice);
  });

  it('returns null when nothing is installed', () => {
    expect(
      findLibreOfficeBinary({ platform: 'linux', env: { PATH: '/nowhere' }, exists: () => false }),
    ).toBeNull();
  });
});

describe('inlineQuickLookAttachments', () => {
  it('inlines a stylesheet as <style> rather than a data: URL', () => {
    const html = '<link href="Attachment1.css" rel="stylesheet" type="text/css" charset="utf-8"><body>';
    const out = inlineQuickLookAttachments(html, [
      { name: 'Attachment1.css', mimeType: 'text/css', data: Buffer.from('td{color:red}') },
    ]);
    expect(out).toBe('<style type="text/css">td{color:red}</style><body>');
    expect(out).not.toContain('data:text/css');
  });

  it('inlines an image as a data: URL', () => {
    const html = '<img src="Attachment1.png" style="top:144;">';
    const out = inlineQuickLookAttachments(html, [
      { name: 'Attachment1.png', mimeType: 'image/png', data: Buffer.from([1, 2, 3]) },
    ]);
    expect(out).toBe(`<img src="data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}" style="top:144;">`);
  });

  it('leaves a document with no attachments untouched', () => {
    expect(inlineQuickLookAttachments('<body>slides</body>', [])).toBe('<body>slides</body>');
  });
});

describe('readQuickLookAttachments', () => {
  it('skips the document and its properties list', () => {
    write(path.join(root, 'Preview.html'), '<body>');
    write(path.join(root, 'PreviewProperties.plist'), 'plist');
    write(path.join(root, 'Attachment1.png'), 'png-bytes');
    expect(readQuickLookAttachments(root, 1024).map((a) => a.name)).toEqual(['Attachment1.png']);
  });

  it('stops at the byte cap instead of inlining an unbounded deck', () => {
    write(path.join(root, 'Attachment1.png'), 'a'.repeat(80));
    write(path.join(root, 'Attachment2.png'), 'b'.repeat(80));
    expect(readQuickLookAttachments(root, 100).map((a) => a.name)).toEqual(['Attachment1.png']);
  });

  it('types attachments by extension', () => {
    write(path.join(root, 'Attachment1.css'), 'x');
    write(path.join(root, 'Attachment2.bin'), 'x');
    expect(readQuickLookAttachments(root, 1024).map((a) => a.mimeType)).toEqual([
      'text/css',
      'application/octet-stream',
    ]);
  });
});

describe('convertOfficeToPreview', () => {
  const hasSoffice = { exists: (c: string) => c === '/usr/bin/soffice' };
  const hasNothing = { exists: () => false };

  it('returns LibreOffice PDF output when the conversion succeeds', async () => {
    const result = await convertOfficeToPreview(path.join(root, 'deck.pptx'), 'presentation', 1024 * 1024, {
      platform: 'linux',
      env: {},
      ...hasSoffice,
      run: async (_file, args) => {
        const outDir = args[args.indexOf('--outdir') + 1];
        write(path.join(outDir, 'deck.pdf'), '%PDF-1.4');
      },
    });
    expect(result.converterKind).toBe('libreoffice');
    expect(result.convertedPdfDataUrl).toBe(`data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`);
    expect(result.convertedPdfSizeBytes).toBe(8);
  });

  it('prefers LibreOffice over Quick Look when both succeed', async () => {
    const result = await convertOfficeToPreview(path.join(root, 'deck.pptx'), 'presentation', 1024 * 1024, {
      platform: 'darwin',
      env: {},
      exists: (c) => c === '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      run: async (file, args) => {
        if (file === 'qlmanage') {
          const bundle = path.join(args[args.indexOf('-o') + 1], 'deck.pptx.qlpreview');
          write(path.join(bundle, 'Preview.html'), '<p>ql</p>');
          return;
        }
        // Slower than Quick Look, and still the one that must win.
        await new Promise((r) => setTimeout(r, 20));
        write(path.join(args[args.indexOf('--outdir') + 1], 'deck.pdf'), '%PDF-1.4');
      },
    });
    expect(result.converterKind).toBe('libreoffice');
  });

  it('falls through to Quick Look on macOS when LibreOffice is absent', async () => {
    const result = await convertOfficeToPreview(path.join(root, 'deck.pptx'), 'presentation', 1024 * 1024, {
      platform: 'darwin',
      env: {},
      ...hasNothing,
      run: async (file, args) => {
        expect(file).toBe('qlmanage');
        const outDir = args[args.indexOf('-o') + 1];
        const bundle = path.join(outDir, 'deck.pptx.qlpreview');
        write(path.join(bundle, 'Preview.html'), '<img src="Attachment1.png">');
        write(path.join(bundle, 'Attachment1.png'), 'png');
      },
    });
    expect(result.converterKind).toBe('quicklook');
    expect(result.convertedHtml).toBe(
      `<img src="data:image/png;base64,${Buffer.from('png').toString('base64')}">`,
    );
  });

  it('treats a silent qlmanage as a failure, since it exits 0 either way', async () => {
    const result = await convertOfficeToPreview(path.join(root, 'deck.pptx'), 'presentation', 1024 * 1024, {
      platform: 'darwin',
      env: {},
      ...hasNothing,
      run: async () => {},
    });
    expect(result.convertedHtml).toBeUndefined();
    expect(result.conversionError).toContain('Quick Look: produced no preview.');
  });

  it('falls through to Office COM on Windows and reads the PDF it writes', async () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const result = await convertOfficeToPreview('C:\\deck.pptx', 'presentation', 1024 * 1024, {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PATH: '' },
      exists: (c) => c === powershell,
      run: async (file, args) => {
        expect(file).toBe(powershell);
        expect(args).toContain('-NonInteractive');
        expect(args[args.indexOf('-Family') + 1]).toBe('presentation');
        write(args[args.indexOf('-Out') + 1], '%PDF-1.4');
      },
    });
    expect(result.converterKind).toBe('office-com');
    expect(result.convertedPdfDataUrl).toContain('data:application/pdf;base64,');
  });

  it('says Office is not installed rather than surfacing the COM error', async () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const result = await convertOfficeToPreview('C:\\deck.pptx', 'presentation', 1024 * 1024, {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PATH: '' },
      exists: (c) => c === powershell,
      run: async () => {
        throw new Error('Retrieving the COM class factory for component with CLSID … failed');
      },
    });
    expect(result.conversionError).toBe('LibreOffice: not found. Office: is not installed.');
  });

  it('reports every converter it tried when they all fail', async () => {
    const result = await convertOfficeToPreview(path.join(root, 'deck.pptx'), 'presentation', 1024 * 1024, {
      platform: 'linux',
      env: {},
      ...hasNothing,
      run: async () => {},
    });
    expect(result.conversionError).toBe('LibreOffice: not found.');
  });

  it('refuses a converted PDF over the size cap', async () => {
    const result = await convertOfficeToPreview(path.join(root, 'deck.pptx'), 'presentation', 4, {
      platform: 'linux',
      env: {},
      ...hasSoffice,
      run: async (_file, args) => {
        const outDir = args[args.indexOf('--outdir') + 1];
        write(path.join(outDir, 'deck.pdf'), '%PDF-1.4');
      },
    });
    expect(result.convertedPdfDataUrl).toBeUndefined();
    expect(result.conversionError).toContain('over the size cap');
  });
});

describe('OFFICE_COM_SCRIPT', () => {
  it('takes the paths as bound parameters, never interpolated', () => {
    expect(OFFICE_COM_SCRIPT).toContain('[Parameter(Mandatory=$true)][string]$In');
    expect(OFFICE_COM_SCRIPT).toContain("[ValidateSet('document','spreadsheet','presentation')]");
  });

  it('quits every app in a finally so a throw cannot orphan it', () => {
    const quits = OFFICE_COM_SCRIPT.match(/\$app\.Quit\(/g) ?? [];
    const finallys = OFFICE_COM_SCRIPT.match(/\} finally \{/g) ?? [];
    expect(quits).toHaveLength(3);
    expect(finallys).toHaveLength(3);
  });
});

describe('parseSlideSize', () => {
  it('reads the deck size the generator states in its own stylesheet', () => {
    const html =
      '<style>div.slide{position:relative;}div.slide, div.loading-slide { width: 959; height: 540;}</style>';
    expect(parseSlideSize(html)).toEqual({ slideWidth: 959, slideHeight: 540 });
  });

  it('is not fooled by the earlier rule that carries no dimensions', () => {
    const html = '<style>div.slide{position:relative;}div.slide{ width: 720; height: 540;}</style>';
    expect(parseSlideSize(html)).toEqual({ slideWidth: 720, slideHeight: 540 });
  });

  it('returns nothing when the rule is absent', () => {
    expect(parseSlideSize('<body>no styles</body>')).toEqual({});
  });
});

describe('rasterized PDF attachments', () => {
  it('serves the PNG under the name the document still references', () => {
    // Quick Look writes vector art as PDF and points an <img> at it; Chromium
    // cannot decode that, so main rasterizes alongside it.
    write(path.join(root, 'Attachment1.pdf'), 'pdf-bytes');
    write(path.join(root, 'Attachment1.png'), 'png-bytes');
    const attachments = readQuickLookAttachments(root, 1024);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('Attachment1.pdf');
    expect(attachments[0].mimeType).toBe('image/png');
    expect(attachments[0].data.toString()).toBe('png-bytes');
  });

  it('keeps the PDF when rasterization produced nothing', () => {
    write(path.join(root, 'Attachment1.pdf'), 'pdf-bytes');
    expect(readQuickLookAttachments(root, 1024)[0]).toMatchObject({
      name: 'Attachment1.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('substitutes the PNG bytes into the document under the PDF name', () => {
    const html = '<img src="Attachment1.pdf" style="width:151;">';
    const out = inlineQuickLookAttachments(html, [
      { name: 'Attachment1.pdf', mimeType: 'image/png', data: Buffer.from('png') },
    ]);
    expect(out).toContain('data:image/png;base64,');
    expect(out).not.toContain('Attachment1.pdf');
  });
});
