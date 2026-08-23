// Inline previews for Office documents, without Office.
//
// A .pptx in the preview pane should look like slides, not like an "open it
// elsewhere" card. Nothing in this app can rasterize OOXML itself, so the job
// is to find something on the machine that already can and take its output.
// Three converters, tried in order, first one that produces something wins:
//
//   1. LibreOffice — `soffice --headless --convert-to pdf`. Everywhere,
//      faithful, and the only one that renders every family well. Not
//      installed by default anywhere, which is why the others exist.
//   2. Quick Look (macOS) — the same generator Finder's spacebar preview
//      uses, `/System/Library/QuickLook/Office.qlgenerator`, driven through
//      `qlmanage`. Ships with the OS, so it needs no install at all. It emits
//      *HTML*, not PDF: one absolutely-positioned div per slide, plus its
//      images and stylesheets as sibling "attachment" files we inline.
//   3. Office COM (Windows) — PowerShell against a locally installed Office,
//      `SaveAs`/`ExportAsFixedFormat` to PDF. Perfect fidelity, but it does
//      start the real app (windowless), so it only half-answers "without
//      PowerPoint" and it goes last.
//
// Windows has no Quick Look equivalent we can reach: `IPreviewHandler` renders
// into an HWND you supply and has no give-me-a-document mode, so it needs a
// native addon and a host window. Hence COM as the Windows fallback.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type OfficeFamily = 'document' | 'spreadsheet' | 'presentation';
export type OfficeConverterKind = 'libreoffice' | 'quicklook' | 'office-com';

export interface OfficeConversion {
  convertedPdfDataUrl?: string;
  convertedPdfSizeBytes?: number;
  /// Quick Look's output. Self-contained after attachment inlining, meant for
  /// a sandboxed srcdoc frame.
  convertedHtml?: string;
  /// The deck's own slide size, so the renderer can scale the frame to the
  /// pane instead of showing a third of a slide behind a scrollbar.
  slideWidth?: number;
  slideHeight?: number;
  converterPath?: string;
  converterKind?: OfficeConverterKind;
  conversionError?: string;
}

/// LibreOffice is fast on a small deck and slow on a big one; Office COM has
/// to cold-start an app the first time. Both are generous rather than tuned —
/// the point is to bound a hang, not to police a slow machine.
const LIBREOFFICE_TIMEOUT_MS = 30_000;
const QUICKLOOK_TIMEOUT_MS = 20_000;
const OFFICE_COM_TIMEOUT_MS = 120_000;
/// One `sips` pass over the whole attachment set; 13 of them take ~0.2s.
const RASTERIZE_TIMEOUT_MS = 20_000;

export interface OfficePreviewDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: (file: string, args: string[], options: { timeout: number }) => Promise<unknown>;
  /// Converter discovery only. Injected so the Windows search can be tested
  /// off Windows: the candidate paths are `path.win32` strings, which no
  /// POSIX filesystem can hold.
  exists: (candidate: string) => boolean;
}

const defaultDeps: OfficePreviewDeps = {
  platform: process.platform,
  env: process.env,
  run: (file, args, options) => execFileAsync(file, args, { ...options, maxBuffer: 1024 * 1024 }),
  exists: (candidate) => fs.existsSync(candidate),
};

export function officeFamilyForExtension(ext: string): OfficeFamily | null {
  if (ext === 'doc' || ext === 'docx') return 'document';
  if (ext === 'xls' || ext === 'xlsx') return 'spreadsheet';
  if (ext === 'ppt' || ext === 'pptx') return 'presentation';
  return null;
}

export async function convertOfficeToPreview(
  filePath: string,
  family: OfficeFamily,
  maxBytes: number,
  deps: Partial<OfficePreviewDeps> = {},
): Promise<OfficeConversion> {
  const resolved: OfficePreviewDeps = { ...defaultDeps, ...deps };
  const attempts: Array<{ label: string; run: () => Promise<OfficeConversion> }> = [
    { label: 'LibreOffice', run: () => convertWithLibreOffice(filePath, maxBytes, resolved) },
  ];
  if (resolved.platform === 'darwin') {
    attempts.push({ label: 'Quick Look', run: () => convertWithQuickLook(filePath, maxBytes, resolved) });
  }
  if (resolved.platform === 'win32') {
    attempts.push({ label: 'Office', run: () => convertWithOfficeCom(filePath, family, maxBytes, resolved) });
  }

  // Raced, not serial: a hung LibreOffice used to burn its full 30s timeout
  // before Quick Look — which ships with macOS — was ever tried.
  const failures: string[] = [];
  let settled = 0;
  const winner = await new Promise<OfficeConversion | null>((resolve) => {
    for (const attempt of attempts) {
      void attempt.run().then(
        (result) => {
          if (result.convertedPdfDataUrl || result.convertedHtml) return resolve(result);
          failures.push(`${attempt.label}: ${result.conversionError ?? 'no preview produced.'}`);
          if (++settled === attempts.length) resolve(null);
        },
        (e: unknown) => {
          failures.push(`${attempt.label}: ${(e as Error).message}`);
          if (++settled === attempts.length) resolve(null);
        },
      );
    }
  });
  if (winner) return winner;
  return { conversionError: failures.join(' ') };
}

async function convertWithLibreOffice(
  filePath: string,
  maxBytes: number,
  deps: OfficePreviewDeps,
): Promise<OfficeConversion> {
  const converterPath = findLibreOfficeBinary(deps);
  if (!converterPath) return { conversionError: 'not found.' };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-office-preview-'));
  try {
    await deps.run(converterPath, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, filePath], {
      timeout: LIBREOFFICE_TIMEOUT_MS,
    });
    const expected = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}.pdf`);
    const produced = fs.existsSync(expected)
      ? expected
      : findFirst(outDir, (name) => name.toLowerCase().endsWith('.pdf'));
    if (!produced) return { converterPath, conversionError: 'produced no PDF.' };
    return { converterPath, converterKind: 'libreoffice', ...readPdf(produced, maxBytes) };
  } catch (err: any) {
    return { converterPath, conversionError: err?.message ?? 'conversion failed.' };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function convertWithQuickLook(
  filePath: string,
  maxBytes: number,
  deps: OfficePreviewDeps,
): Promise<OfficeConversion> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-quicklook-preview-'));
  try {
    await deps.run('qlmanage', ['-p', '-o', outDir, filePath], { timeout: QUICKLOOK_TIMEOUT_MS });
    // qlmanage exits 0 whether or not a generator claimed the file, so the
    // bundle on disk is the only honest success signal.
    const bundle = findFirst(outDir, (name) => name.endsWith('.qlpreview'));
    const htmlPath = bundle ? path.join(bundle, 'Preview.html') : '';
    if (!htmlPath || !fs.existsSync(htmlPath)) return { conversionError: 'produced no preview.' };
    const size = fs.statSync(htmlPath).size;
    if (size > maxBytes) return { conversionError: 'preview is over the size cap.' };
    const html = fs.readFileSync(htmlPath, 'utf-8');
    await rasterizePdfAttachments(bundle!, deps);
    return {
      converterPath: 'qlmanage',
      converterKind: 'quicklook',
      convertedHtml: inlineQuickLookAttachments(html, readQuickLookAttachments(bundle!, maxBytes)),
      ...parseSlideSize(html),
    };
  } catch (err: any) {
    return { conversionError: err?.message ?? 'conversion failed.' };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function convertWithOfficeCom(
  filePath: string,
  family: OfficeFamily,
  maxBytes: number,
  deps: OfficePreviewDeps,
): Promise<OfficeConversion> {
  const converterPath = findPowerShell(deps);
  if (!converterPath) return { conversionError: 'PowerShell was not found.' };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-office-com-preview-'));
  const scriptPath = path.join(outDir, 'convert.ps1');
  const pdfPath = path.join(outDir, 'preview.pdf');
  try {
    // The paths go in as bound parameters rather than interpolated into the
    // script, so a document named `a'; rm -rf …` is data, not code.
    fs.writeFileSync(scriptPath, OFFICE_COM_SCRIPT, 'utf-8');
    await deps.run(
      converterPath,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-In',
        filePath,
        '-Out',
        pdfPath,
        '-Family',
        family,
      ],
      { timeout: OFFICE_COM_TIMEOUT_MS },
    );
    if (!fs.existsSync(pdfPath)) return { converterPath, conversionError: 'produced no PDF.' };
    return { converterPath, converterKind: 'office-com', ...readPdf(pdfPath, maxBytes) };
  } catch (err: any) {
    return { converterPath, conversionError: officeComError(err) };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function readPdf(pdfPath: string, maxBytes: number): OfficeConversion {
  const size = fs.statSync(pdfPath).size;
  if (size > maxBytes) return { conversionError: 'converted PDF is over the size cap.' };
  return {
    convertedPdfDataUrl: `data:application/pdf;base64,${fs.readFileSync(pdfPath).toString('base64')}`,
    convertedPdfSizeBytes: size,
  };
}

/// The absolute path of the first entry in `dir` matching `match`, or ''.
function findFirst(dir: string, match: (name: string) => boolean): string {
  const name = fs.readdirSync(dir).find(match);
  return name ? path.join(dir, name) : '';
}

// --- Quick Look attachments -------------------------------------------------

/// Quick Look exports a slide's vector art as PDF and points an `<img>` at
/// it. WebKit renders PDF in an `<img>`, which is why it looks right in
/// Finder; Chromium does not, so in Electron every one of them is a
/// broken-image icon. `sips` ships with macOS and rasterizes the whole set in
/// a single pass.
///
/// Rasterized at natural size: `sips` re-renders a PDF at its own dimensions
/// and offers no resolution control that survives batching (`-Z` would fit
/// every attachment into one box, scaling art that differs in size by an
/// order of magnitude), so this trades some retina sharpness on decorative
/// art for one 0.2s call instead of one call per attachment.
async function rasterizePdfAttachments(bundleDir: string, deps: OfficePreviewDeps): Promise<void> {
  const pdfs = fs
    .readdirSync(bundleDir)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .map((name) => path.join(bundleDir, name));
  if (!pdfs.length) return;
  try {
    await deps.run('sips', ['-s', 'format', 'png', ...pdfs, '--out', bundleDir], {
      timeout: RASTERIZE_TIMEOUT_MS,
    });
  } catch {
    // Best effort. Without it the art is missing and the text still reads,
    // which beats refusing the whole preview.
  }
}

/// The slide size the generator states in its own stylesheet — 959x540 for a
/// 16:9 deck, 720x540 for 4:3.
export function parseSlideSize(html: string): { slideWidth?: number; slideHeight?: number } {
  const match = /div\.slide\b[^{]*\{[^}]*?width:\s*(\d+)[^}]*?height:\s*(\d+)/i.exec(html);
  if (!match) return {};
  return { slideWidth: Number(match[1]), slideHeight: Number(match[2]) };
}

export interface QuickLookAttachment {
  name: string;
  mimeType: string;
  data: Buffer;
}

/// Everything in a `.qlpreview` bundle that isn't the document itself. When
/// qlmanage dumps to a directory it rewrites the `cid:` references in the HTML
/// to these plain sibling filenames, so the names here are exactly the strings
/// to substitute for.
export function readQuickLookAttachments(bundleDir: string, maxBytes: number): QuickLookAttachment[] {
  const attachments: QuickLookAttachment[] = [];
  let total = 0;
  for (const name of fs.readdirSync(bundleDir).sort()) {
    if (name === 'Preview.html' || name === 'PreviewProperties.plist') continue;
    const full = path.join(bundleDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // A PNG that shadows a PDF is our own rasterization, already emitted
    // under the PDF's name below — listing it again would double-count it
    // against the cap for nothing.
    if (name.toLowerCase().endsWith('.png') && fs.existsSync(swapExtension(full, '.pdf'))) continue;
    // The document still says `Attachment1.pdf`, so the substitution has to
    // happen under that name even though the bytes are now a PNG.
    const rasterized = name.toLowerCase().endsWith('.pdf') ? swapExtension(full, '.png') : '';
    if (rasterized && fs.existsSync(rasterized)) {
      const raster = fs.statSync(rasterized);
      if (total + raster.size > maxBytes) break;
      total += raster.size;
      attachments.push({ name, mimeType: 'image/png', data: fs.readFileSync(rasterized) });
      continue;
    }
    // A deck of full-bleed photos can carry more image bytes than the whole
    // preview budget. Stop inlining at the cap and let the rest 404 into
    // broken-image icons rather than refusing the preview outright.
    if (total + stat.size > maxBytes) break;
    total += stat.size;
    attachments.push({ name, mimeType: attachmentMimeType(name), data: fs.readFileSync(full) });
  }
  return attachments;
}

/// Fold the bundle's siblings into the document so it can render from a
/// srcdoc frame, which has no directory to resolve them against.
///
/// Substitution only — the document is passed through otherwise, and in
/// particular it must keep arriving without a DOCTYPE. Quick Look emits
/// unitless CSS lengths (`div.slide { width: 959; height: 540 }`), which only
/// mean anything in quirks mode; add a DOCTYPE and every slide collapses to
/// zero height. The renderer has to serve this over a real scheme for the
/// same reason — `srcdoc` is parsed in no-quirks mode no matter what the
/// document says.
///
/// Stylesheets become inline `<style>`, not `data:` URLs, because the app's
/// own CSP is `style-src 'self' 'unsafe-inline'` — a srcdoc frame inherits
/// that, and `data:` is not in it, so a `<link href="data:text/css,…">` is
/// refused. Images have `data:` in `img-src` and go in as URLs.
export function inlineQuickLookAttachments(html: string, attachments: QuickLookAttachment[]): string {
  let out = html;
  for (const attachment of attachments) {
    if (attachment.mimeType === 'text/css') {
      const link = new RegExp(`<link\\b[^>]*href="${escapeRegExp(attachment.name)}"[^>]*>`, 'gi');
      out = out.replace(link, `<style type="text/css">${attachment.data.toString('utf-8')}</style>`);
      continue;
    }
    const dataUrl = `data:${attachment.mimeType};base64,${attachment.data.toString('base64')}`;
    out = out.split(`"${attachment.name}"`).join(`"${dataUrl}"`);
  }
  return out;
}

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  css: 'text/css',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function swapExtension(full: string, extension: string): string {
  return path.join(path.dirname(full), `${path.basename(full, path.extname(full))}${extension}`);
}

function attachmentMimeType(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ATTACHMENT_MIME_TYPES[ext] ?? 'application/octet-stream';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Converter discovery ----------------------------------------------------

export function findLibreOfficeBinary(deps: Partial<OfficePreviewDeps> = {}): string | null {
  const resolved: OfficePreviewDeps = { ...defaultDeps, ...deps };
  for (const candidate of libreOfficeCandidates(resolved.platform, resolved.env)) {
    if (isPathLike(candidate)) {
      if (resolved.exists(candidate)) return candidate;
      continue;
    }
    const found = resolveOnPath(candidate, resolved.platform, resolved.env, resolved.exists);
    if (found) return found;
  }
  return null;
}

/// Windows is the reason this function exists as its own thing. The installer
/// there does not put `…\LibreOffice\program` on PATH, so a PATH-only search
/// found nothing on a machine with LibreOffice sitting in Program Files.
export function libreOfficeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      `${env.HOME ?? ''}/Applications/LibreOffice.app/Contents/MacOS/soffice`,
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
      'soffice',
      'libreoffice',
    ];
  }
  if (platform === 'win32') {
    const roots = [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramW6432,
      env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs') : undefined,
    ];
    return [
      ...roots
        .filter((root): root is string => !!root)
        .map((root) => path.win32.join(root, 'LibreOffice', 'program', 'soffice.exe')),
      'soffice',
      'libreoffice',
    ];
  }
  return [
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/libreoffice',
    '/snap/bin/libreoffice',
    '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
    'soffice',
    'libreoffice',
  ];
}

function findPowerShell(deps: OfficePreviewDeps): string | null {
  const systemRoot = deps.env.SystemRoot ?? deps.env.SYSTEMROOT;
  // Windows PowerShell 5.1 is always present and always speaks COM; pwsh 7 may
  // not be installed. Prefer the one that ships with the OS.
  const bundled = systemRoot
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '';
  if (bundled && deps.exists(bundled)) return bundled;
  return (
    resolveOnPath('powershell', deps.platform, deps.env, deps.exists) ??
    resolveOnPath('pwsh', deps.platform, deps.env, deps.exists)
  );
}

function isPathLike(candidate: string): boolean {
  return /[\\/]/.test(candidate);
}

/// The absolute path a bare command resolves to on PATH, or null.
///
/// On Windows the executable is `soffice.exe`, not `soffice`, so a plain
/// `existsSync(join(dir, command))` misses it — PATHEXT is what makes the
/// bare name work in a shell and has to be applied here too.
export function resolveOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
): string | null {
  const windows = platform === 'win32';
  const join = windows ? path.win32.join : path.posix.join;
  const raw = env.PATH ?? env.Path ?? '';
  const extensions = windows
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of raw.split(windows ? ';' : ':').filter(Boolean)) {
    for (const extension of extensions) {
      const full = join(dir, `${command}${extension}`);
      try {
        if (exists(full)) return full;
      } catch {
        // An unreadable PATH entry is not an error, just not a match.
      }
    }
  }
  return null;
}

// --- Office COM -------------------------------------------------------------

/// Drives a locally installed Office to export a PDF.
///
/// Each app is quit in a `finally`, including the throwing path: an orphaned
/// WINWORD/POWERPNT/EXCEL process holds the file open and the next conversion
/// then fails for a reason that has nothing to do with the document.
export const OFFICE_COM_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][ValidateSet('document','spreadsheet','presentation')][string]$Family
)
$ErrorActionPreference = 'Stop'
switch ($Family) {
  'presentation' {
    $app = New-Object -ComObject PowerPoint.Application
    $pres = $null
    try {
      # PowerPoint rejects Visible = $false on the application, so opening
      # WithWindow:$false is the only way to keep it off the screen.
      $pres = $app.Presentations.Open($In, $true, $false, $false)
      $pres.SaveAs($Out, 32)
    } finally {
      if ($pres) { $pres.Close() }
      $app.Quit()
    }
  }
  'document' {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $doc = $null
    try {
      $doc = $app.Documents.Open($In, $false, $true)
      $doc.ExportAsFixedFormat($Out, 17)
    } finally {
      if ($doc) { $doc.Close(0) }
      $app.Quit(0)
    }
  }
  'spreadsheet' {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $wb = $null
    try {
      $wb = $app.Workbooks.Open($In, 0, $true)
      $wb.ExportAsFixedFormat(0, $Out)
    } finally {
      if ($wb) { $wb.Close($false) }
      $app.Quit()
    }
  }
}
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
[GC]::Collect()
`;

/// "Cannot find an object with the ProgID" is what a machine without Office
/// says, and it is worth translating — it reads like a bug otherwise.
function officeComError(err: any): string {
  const message: string = err?.stderr || err?.message || 'conversion failed.';
  if (/ProgID|80040154|Retrieving the COM class factory/i.test(message)) {
    return 'is not installed.';
  }
  return message.trim().split('\n')[0] ?? 'conversion failed.';
}
