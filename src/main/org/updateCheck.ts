// Whether a newer release of the server is out. Once a day the server asks
// GitHub for the latest release and Setup → Readiness says what runs here
// and, when there is one, what's newer, with where to read about it and how
// to upgrade. It never updates itself: a container swapping itself out mid
// run is the operator's call, and their orchestration's.
//
// OVERCLI_UPDATE_CHECK=0 turns it off, for a server with no internet access
// or one whose upgrades come through change control anyway.

import fs from 'node:fs';
import path from 'node:path';
import type { HealthItem } from './orgService';

const RELEASES = 'https://api.github.com/repos/overcodelions/overcli/releases/latest';
const DAY_MS = 24 * 60 * 60 * 1000;
const UPGRADE_DOC = 'deploy/docs/admins.md';

/// The server's own version, from the package.json it shipped with.
export function serverVersion(): string {
  // dist/main/org → the package root (or src/main/org when run through tsx).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/// Whether `latest` is a later release than `current`. Plain x.y.z only:
/// pre-releases and anything odd are never offered as an upgrade.
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class UpdateCheck {
  private latest: { version: string; url: string } | null = null;
  private failed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      current: string;
      enabled: () => boolean;
      fetchImpl?: Fetch;
      log?: (line: string) => void;
    },
  ) {}

  /// First look shortly after start (not in the way of booting), then daily.
  start(): void {
    if (!this.deps.enabled() || this.timer) return;
    const first = setTimeout(() => void this.check(), 30_000);
    first.unref?.();
    this.timer = setInterval(() => void this.check(), DAY_MS);
    this.timer.unref?.();
  }

  async check(): Promise<void> {
    if (!this.deps.enabled()) return;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(RELEASES, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; prerelease?: unknown; draft?: unknown };
      if (typeof body.tag_name !== 'string' || body.prerelease || body.draft) return;
      this.latest = { version: body.tag_name.replace(/^v/, ''), url: typeof body.html_url === 'string' ? body.html_url : 'https://github.com/overcodelions/overcli/releases' };
      this.failed = false;
    } catch (err) {
      this.failed = true;
      this.deps.log?.(`update check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /// The Readiness line: what runs here, and whether something newer is out.
  health(): HealthItem {
    const here = `overcli ${this.deps.current}`;
    if (!this.deps.enabled()) return { name: 'Version', ok: true, detail: `${here}. Checking for newer releases is off (OVERCLI_UPDATE_CHECK=0).` };
    if (this.latest && isNewer(this.latest.version, this.deps.current)) {
      return {
        name: 'Version',
        ok: null,
        detail: `${here}. ${this.latest.version} is out: what's new at ${this.latest.url}. To upgrade, run the new image on the same volume (${UPGRADE_DOC}, Day to day).`,
      };
    }
    if (this.latest) return { name: 'Version', ok: true, detail: `${here}, the latest release.` };
    return { name: 'Version', ok: true, detail: this.failed ? `${here}. Couldn't reach GitHub to check for a newer release.` : `${here}.` };
  }
}
