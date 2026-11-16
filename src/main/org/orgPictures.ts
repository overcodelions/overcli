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

const cache = new Map<string, string | null>();

export async function orgPicture(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!pictureAllowed(url)) return null;
  if (cache.has(url)) return cache.get(url) ?? null;
  let out: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'image/*' } });
    const type = res.headers.get('content-type') ?? '';
    const size = Number(res.headers.get('content-length') ?? 0);
    if (res.ok && TYPES.test(type) && size <= MAX_BYTES) {
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length <= MAX_BYTES) out = `data:${type.split(';')[0].toLowerCase()};base64,${body.toString('base64')}`;
    }
  } catch {
    out = null;
  } finally {
    clearTimeout(timer);
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(url, out);
  return out;
}
