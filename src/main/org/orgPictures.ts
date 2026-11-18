// Workers' pictures for the Org tab. The window's content policy takes no
// remote images, and opening it to the web for a face would let any address
// a server hands back be loaded from the app. Instead main fetches a picture
// from one of the picture services the server itself uses (avatars.ts), and
// only those, and hands the window a data: URL. Anything else: initials.

const ALLOWED: Array<{ host: string; path: RegExp }> = [
  // DiceBear: drawn and default pictures.
  { host: 'api.dicebear.com', path: /^\/\d+\.x\/[a-z0-9-]+\/(svg|png)$/i },
  // Fluent emoji, pinned in avatars.ts.
  { host: 'raw.githubusercontent.com', path: /^\/microsoft\/fluentui-emoji\/[0-9a-f]{40}\/assets\/[^?#]+\.(svg|png)$/i },
];
const TYPES = /^image\/(svg\+xml|png|jpeg|webp|gif)(;|$)/i;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_CACHED = 300;

export function pictureAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return ALLOWED.some((a) => u.hostname === a.host && a.path.test(u.pathname));
}

/// A picture, or null for initials. A failure that may pass (no network, a
/// timeout, the service busy or down) is kept only a minute, so a face comes
/// back once the service does; an answer that won't change (not a picture,
/// too big, gone) is kept as a picture is.
interface Cached {
  value: string | null;
  until?: number;
}
const RETRY_MS = 60_000;
const cache = new Map<string, Cached>();
/// One fetch per picture at a time: a page full of the same face asks once.
const inFlight = new Map<string, Promise<string | null>>();

/// Forget every picture. For tests.
export function clearOrgPictures(): void {
  cache.clear();
  inFlight.clear();
}

export async function orgPicture(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<string | null> {
  if (!pictureAllowed(url)) return null;
  const hit = cache.get(url);
  if (hit && (hit.until === undefined || hit.until > now())) return hit.value;
  const pending = inFlight.get(url);
  if (pending) return pending;
  const p = fetchPicture(url, fetchImpl)
    .catch(() => ({ value: null, lasting: false }))
    .then(({ value, lasting }) => {
      if (!cache.has(url) && cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
      cache.set(url, lasting ? { value } : { value, until: now() + RETRY_MS });
      return value;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}

/// `lasting`: whether the answer would be the same if asked again soon.
async function fetchPicture(url: string, fetchImpl: typeof fetch): Promise<{ value: string | null; lasting: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'image/*' } });
    // Busy, rate-limited or down: worth asking again later.
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { value: null, lasting: false };
    const type = res.headers.get('content-type') ?? '';
    const size = Number(res.headers.get('content-length') ?? 0);
    if (!res.ok || !TYPES.test(type) || size > MAX_BYTES) return { value: null, lasting: true };
    const body = await readCapped(res, MAX_BYTES);
    if (!body) return { value: null, lasting: true };
    return { value: `data:${type.split(';')[0].toLowerCase()};base64,${body.toString('base64')}`, lasting: true };
  } catch {
    // No network, a timeout, a refused redirect: try again later.
    return { value: null, lasting: false };
  } finally {
    clearTimeout(timer);
  }
}

/// The body, or null once it passes `max` bytes: read no further than that,
/// whatever length the server said it was.
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer());
    return all.length <= max ? all : null;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
