// Links to the files a run wrote, for the console to open in a frame or a
// new tab. Neither can send the console's bearer token, so listing a run's
// files hands out one link per file instead: a random id, kept in memory,
// tied to who asked and good for an hour. Opening it checks that person's
// access again, so a link outlives nothing the person lost.
//
// A link alone is not enough: the listing also sets a cookie scripts can't
// read, holding a keyed hash of who listed. Opening a link needs that cookie,
// and it must name the same person, so a link pasted to someone else opens
// nothing for them, even inside the hour.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OrgCaller } from '../shared/org/policy';

const TTL_MS = 60 * 60 * 1000;
const MAX_LINKS = 2000;

export interface FileLink {
  caller: OrgCaller;
  runId: string;
  name: string;
  /// Set for a file in a team task's shared folder, rather than a run's.
  taskId?: string;
  /// Set for a file in a worker's own files.
  workerId?: string;
}

export const FILE_COOKIE = 'ocli_files';

/// Why a link would not open: unknown or out of date, or opened in a browser
/// that isn't the lister's.
export type Redeemed = { ok: true; link: FileLink } | { ok: false; why: 'expired' | 'elsewhere' };

export class FileLinks {
  private links = new Map<string, FileLink & { until: number }>();
  /// Made fresh at start, as the links themselves are: a restart ends both.
  private secret = randomBytes(32);

  constructor(private now: () => number = Date.now) {}

  /// The cookie value that says "this browser is this person".
  keyFor(caller: OrgCaller): string {
    return createHmac('sha256', this.secret).update(`${caller.slackUserId ?? ''}\n${caller.name}\n${caller.admin ? 1 : 0}`).digest('base64url');
  }

  /// The Set-Cookie header a listing sends with the links it hands out.
  cookieFor(caller: OrgCaller, secure: boolean): string {
    return `${FILE_COOKIE}=${this.keyFor(caller)}; Path=/files/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  /// A link, if it is current and this browser's cookie names whoever it was
  /// issued to.
  open(id: string, cookieHeader: string | undefined): Redeemed {
    const link = this.redeem(id);
    if (!link) return { ok: false, why: 'expired' };
    const got = cookieValue(cookieHeader, FILE_COOKIE);
    const want = this.keyFor(link.caller);
    if (!got || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { ok: false, why: 'elsewhere' };
    return { ok: true, link };
  }

  issue(link: FileLink): string {
    const t = this.now();
    for (const [id, l] of this.links) if (l.until <= t) this.links.delete(id);
    // Oldest first when a busy console has handed out a great many.
    while (this.links.size >= MAX_LINKS) this.links.delete(this.links.keys().next().value as string);
    const id = randomBytes(24).toString('base64url');
    this.links.set(id, { ...link, until: t + TTL_MS });
    return id;
  }

  redeem(id: string): FileLink | null {
    const l = this.links.get(id);
    if (!l) return null;
    if (l.until <= this.now()) {
      this.links.delete(id);
      return null;
    }
    return { caller: l.caller, runId: l.runId, name: l.name, ...(l.taskId ? { taskId: l.taskId } : {}), ...(l.workerId ? { workerId: l.workerId } : {}) };
  }
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/// How to send a run's file: an HTML report as a page of its own, on an
/// opaque origin (the CSP sandbox) so its scripts run but cannot reach the
/// console or its token; images and PDFs as themselves; anything else
/// (an SVG included: it can carry script) as plain text.
export function fileHeaders(name: string, download: boolean): Record<string, string> {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase();
  const type = TYPES[ext] ?? 'text/plain; charset=utf-8';
  const base = name.split('/').pop() ?? 'file';
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline' data:; script-src 'unsafe-inline'; img-src data: https:; font-src data:; frame-ancestors 'self'",
    ...(download ? { 'Content-Disposition': `attachment; filename="${base.replace(/[^A-Za-z0-9._-]/g, '_')}"` } : {}),
  };
}
