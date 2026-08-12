// A private scheme for preview documents that need to run scripts.
//
// The renderer's CSP is `script-src 'self'`, and an `about:srcdoc` frame
// inherits its embedder's policy — so a compiled React component dropped
// into a srcDoc iframe is refused before it runs. A document fetched over
// a real scheme carries its own policy instead, which is what this is:
// the renderer publishes a finished document, gets back an
// `overcli-preview://` URL, and points an iframe at it.
//
// The handler serves nothing but documents the renderer published this
// session. It has no filesystem access and no directory listing — the
// only way to get bytes out of it is to have put them in.

import { protocol } from 'electron';
import { randomUUID } from 'node:crypto';

export const PREVIEW_SCHEME = 'overcli-preview';
export const PREVIEW_HOST = 'render';

/// Enough for the frame on screen plus the last few reloads; anything
/// older is unreachable anyway once its URL is gone.
const MAX_DOCUMENTS = 8;
/// A bundled component with React inlined is a few hundred KB. A ceiling
/// well above that still refuses a runaway payload.
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/// The preview's own policy, which replaces the app's rather than
/// extending it: inline script and style (that is the whole point), remote
/// images and fonts so a design that references them still looks right,
/// and no remote script.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  'connect-src https:',
  "frame-src 'none'",
].join('; ');

const documents = new Map<string, string>();

/// Must run before the app is ready — Electron only accepts scheme
/// privileges that early.
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
}

export function handlePreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const html = documents.get(documentIdFromUrl(request.url) ?? '');
    if (html == null) {
      return new Response('This preview is no longer available. Reload it.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PREVIEW_CSP,
        'cache-control': 'no-store',
      },
    });
  });
}

export function publishPreviewDocument(html: string): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof html !== 'string' || !html) return { ok: false, error: 'Preview document is empty.' };
  if (Buffer.byteLength(html, 'utf-8') > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: 'Preview document is too large to render.' };
  }
  const id = randomUUID();
  documents.set(id, html);
  while (documents.size > MAX_DOCUMENTS) {
    const oldest = documents.keys().next();
    if (oldest.done) break;
    documents.delete(oldest.value);
  }
  return { ok: true, url: `${PREVIEW_SCHEME}://${PREVIEW_HOST}/${id}` };
}

export function documentIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.replace(/^\/+/, '');
    return id || null;
  } catch {
    return null;
  }
}

/// Test seam: the store is process-wide, so tests need a way back to zero.
export function resetPreviewDocuments(): void {
  documents.clear();
}
