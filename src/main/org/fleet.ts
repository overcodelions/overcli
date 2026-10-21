// The company's other overcli servers, on one Admin page.
//
// One server serves one Slack app, so a large company runs one per
// department. Each is still its own org; this only reads each one's health
// and spend, with an admin token minted on that server, so an admin of the
// whole company sees everything in one place. Nothing is written remotely.

import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 8_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FleetServer {
  name: string;
  url: string;
  /// Whether this server holds an admin token for it.
  connected: boolean;
  ok: boolean;
  error?: string;
  org?: string;
  spentUSD?: number;
  orgBudgetUSD?: number;
  problems?: string[];
  workers?: string;
}

export function fleetTokensFile(dataDir: string): string {
  return path.join(dataDir, 'org', 'fleet-tokens.json');
}

export function loadFleetTokens(file: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveFleetToken(file: string, url: string, token: string | null): void {
  const all = loadFleetTokens(file);
  if (token) all[url] = token;
  else delete all[url];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/// Only https, bar this machine: the token travels with every request.
export function fleetUrlProblem(url: string): string | null {
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? null : 'Use https:// — the admin token travels with every request.';
  } catch {
    return 'That is not a web address.';
  }
}

export async function fleetStatus(
  servers: ReadonlyArray<{ name: string; url: string }>,
  tokens: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<FleetServer[]> {
  return Promise.all(
    servers.map(async (s): Promise<FleetServer> => {
      const token = tokens[s.url];
      if (!token) return { ...s, connected: false, ok: false, error: 'Not connected yet. Add an admin token from that server.' };
      const bad = fleetUrlProblem(s.url);
      if (bad) return { ...s, connected: true, ok: false, error: bad };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${s.url}/api/admin/health`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, redirect: 'error' });
        if (res.status === 401) return { ...s, connected: true, ok: false, error: 'That server no longer accepts the token. Add a new one.' };
        const body = (await res.json()) as {
          ok?: boolean;
          error?: string;
          org?: { name?: string };
          spend?: { spentUSD?: number; orgBudgetUSD?: number };
          items?: Array<{ name: string; ok: boolean | null; detail: string }>;
        };
        if (body.ok === false) return { ...s, connected: true, ok: false, error: body.error ?? 'It refused.' };
        const problems = (body.items ?? []).filter((i) => i.ok === false).map((i) => `${i.name}: ${i.detail}`);
        return {
          ...s,
          connected: true,
          ok: problems.length === 0,
          ...(body.org?.name ? { org: body.org.name } : {}),
          spentUSD: body.spend?.spentUSD ?? 0,
          ...(body.spend?.orgBudgetUSD ? { orgBudgetUSD: body.spend.orgBudgetUSD } : {}),
          problems,
          ...(body.items?.find((i) => i.name === 'Workers') ? { workers: body.items.find((i) => i.name === 'Workers')!.detail } : {}),
        };
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        return { ...s, connected: true, ok: false, error: aborted ? 'It did not answer in time.' : 'Could not reach it.' };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
