// `overcli workers audit` — standing-worker output that landed a commit and
// was never merged into its base branch.
//
// Read-only. It loads the saved orchestration batches, checks each finished
// worker item's `headSha` against its base (see main/flows/strandedLandings),
// and prints what is still waiting for a human. Exit code follows run.ts:
// NEEDS_HUMAN (2) when anything is stranded, because that is literally what
// it means — work is sitting there until somebody merges or discards it.
//
// Which state directory it reads matters more here than anywhere else in the
// CLI. The desktop app keeps its batches under Electron's userData
// (`~/Library/Application Support/Overcli` on macOS), not under `~/.overcli`,
// so falling back to the daemon's default would audit an empty store and
// report "clean" for a machine with dozens of stranded shifts. See
// `resolveAuditStateDir`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setHost } from '../main/host';
import { nodeHost, defaultDataDir } from '../main/hostNode';
import { loadAllOrchestrations } from '../main/flows/orchestrationsStore';
import { auditWorkerLandings, type LandingAudit, type StrandedLanding } from '../main/flows/strandedLandings';
import type { WorkersAuditOptions } from './args';
import { EXIT } from './run';

/// The desktop app's userData directory for this platform — where Electron
/// puts `app.getPath('userData')` for productName "Overcli".
export function appUserDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Overcli');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Overcli');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Overcli');
}

/// --state-dir, then $OVERCLI_HOME, then the desktop app's userData if it
/// holds batches, then the headless default. The app's directory is
/// preferred over `~/.overcli` because that is where shifts the user actually
/// watched ran; a daemon user who keeps state elsewhere says so with a flag.
export function resolveAuditStateDir(
  stateDir: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  exists: (p: string) => boolean,
): string {
  if (stateDir) return path.resolve(stateDir);
  if (env.OVERCLI_HOME?.trim()) return path.resolve(env.OVERCLI_HOME.trim());
  const app = appUserDataDir(env, platform, home);
  if (exists(path.join(app, 'orchestrations'))) return app;
  return defaultDataDir();
}

function shiftDate(ms: number | undefined): string {
  if (!ms) return '-';
  return new Date(ms).toISOString().slice(0, 10);
}

function verdict(s: StrandedLanding): string {
  const behind = s.baseAdvance == null ? '' : ` (base +${s.baseAdvance})`;
  if (s.landability === 'clean') return `clean${behind}`;
  if (s.landability === 'conflicts') return `conflicts${behind}`;
  return `unknown${behind}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join('  ').trimEnd());
}

export function renderAudit(audit: LandingAudit, stateDir: string): string {
  const lines: string[] = [];
  const { stranded, absorbed, merged, unresolvable, skippedNoSha } = audit;
  lines.push(`overcli workers audit — ${stateDir}`);
  lines.push('');
  if (stranded.length === 0) {
    lines.push('No stranded worker landings.');
  } else {
    lines.push(`${stranded.length} stranded landing(s) — committed, never merged into base:`);
    lines.push('');
    const rows = [['WORKER', 'SHIFT', 'TITLE', 'SHA', 'BRANCH', 'BASE', 'LANDABLE', 'PROJECT']];
    for (const s of stranded) {
      rows.push([
        clip(s.workerName, 24),
        shiftDate(s.finishedAt),
        clip(s.itemTitle, 48),
        s.headSha.slice(0, 10),
        s.branchName && s.branchResolves ? s.branchName : '-',
        s.baseBranch,
        verdict(s),
        s.projectPath,
      ]);
    }
    for (const l of table(rows)) lines.push(`  ${l}`);
  }
  if (unresolvable.length > 0) {
    lines.push('');
    lines.push(`${unresolvable.length} unresolvable (commit or project gone — not counted as stranded):`);
    for (const u of unresolvable) {
      lines.push(`  ${u.headSha.slice(0, 10)}  ${clip(u.itemTitle, 48)}  ${u.projectPath}  — ${u.reason}`);
    }
  }
  lines.push('');
  lines.push(
    `merged ${merged.length} · absorbed ${absorbed.length} (content already in base) · stranded ${stranded.length} · ` +
      `unresolvable ${unresolvable.length} · skipped ${skippedNoSha} done item(s) with no recorded commit`,
  );
  if (stranded.length > 0) {
    lines.push('clean = still merges without conflicts; conflicts = base has moved on, rebuild rather than merge.');
  }
  return `${lines.join('\n')}\n`;
}

export interface WorkersIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export async function workersAuditCommand(opts: WorkersAuditOptions, io: WorkersIo): Promise<number> {
  const env = io.env ?? process.env;
  const stateDir = resolveAuditStateDir(
    opts.stateDir,
    env,
    io.platform ?? process.platform,
    io.home ?? os.homedir(),
    (p) => fs.existsSync(p),
  );
  // An absent store is a wrong path, not a clean bill of health. Saying
  // "nothing stranded" here is exactly the false negative this command
  // exists to prevent.
  if (!fs.existsSync(path.join(stateDir, 'orchestrations'))) {
    io.err(`overcli workers audit: no orchestrations/ under ${stateDir}. Point --state-dir at the app's data directory.\n`);
    return EXIT.BAD_INPUT;
  }

  // Note: loading also applies the store's own retention (it drops completed
  // batches past its cap, see pruneOrchestrations) — the same thing the app
  // does on every launch. The audit adds no write of its own.
  setHost(nodeHost({ dataDir: stateDir }));
  const audit = await auditWorkerLandings(loadAllOrchestrations());

  if (opts.json) {
    io.out(`${JSON.stringify({ stateDir, ...audit }, null, 2)}\n`);
  } else {
    io.out(renderAudit(audit, stateDir));
  }
  return audit.stranded.length > 0 ? EXIT.NEEDS_HUMAN : EXIT.OK;
}
