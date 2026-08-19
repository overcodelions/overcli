// Claude's real limit numbers.
//
// Codex stamps `rate_limits` into every rollout file, so its quota is just
// sitting on disk. Claude Code writes nothing equivalent — the transcript scan
// can tell you how many tokens you burned but never what share of your
// allowance that was, which is why the Claude card reads "estimated".
//
// `claude -p "/usage"` prints the real thing headlessly (verified: exit 0,
// same numbers as the interactive slash command). At ~6s it is far too slow to
// block the Usage page, so this module shells out on demand, caches the parsed
// result to disk, and computeStats() reads whatever the last refresh left
// behind. The page kicks off a refresh after it has already rendered.
//
// Parsing text meant for humans is inherently brittle: if the wording changes
// this returns null and the card falls back to the token estimate, which is
// exactly what it showed before this file existed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { QuotaWindow } from '../shared/types';
import { logSilent } from './diagnostics';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';

/// `/usage` took 6–7s on a warm machine. Well past that means something is
/// wrong (auth prompt, hung network) — give up and keep the estimate.
const TIMEOUT_MS = 30_000;

export interface ClaudeUsageSnapshot {
  /// Epoch ms this was captured, so the UI can admit when it's stale.
  capturedAt: number;
  planType?: string;
  windows: QuotaWindow[];
}

/// The three lines we care about look like:
///   Current session: 15% used · resets Aug 19 at 6:59pm (America/New_York)
///   Current week (all models): 22% used · resets Aug 25 at 10:59am (…)
///   Current week (Fable): 9% used · resets Aug 25 at 10:59am (…)
/// Everything below "What's contributing to your limits usage?" is prose we
/// deliberately ignore.
const LINE = /^Current\s+([^:]+):\s*([\d.]+)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/;

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/// A weekly line is any label mentioning "week"; everything else is the
/// rolling session window. Only used to pick which token total to pair the
/// percentage with, so a wording change degrades to "session" rather than
/// breaking the parse.
function minutesFor(label: string): number {
  return /week/i.test(label) ? 10080 : 300;
}

export function parseClaudeUsage(text: string, capturedAt: number): ClaudeUsageSnapshot | null {
  const windows: QuotaWindow[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const label = m[1].trim();
    const percent = Number(m[2]);
    if (!isFinite(percent)) continue;
    windows.push({
      label: titleCase(label),
      usedPercent: percent,
      windowMinutes: minutesFor(label),
      // The printed reset carries no year and a named timezone, so
      // reconstructing an epoch from it would be guesswork. Keep the string
      // Claude Code already formatted for a human and show it verbatim,
      // minus the trailing "(America/New_York)" the card has no room for.
      resetsAt: null,
      resetsLabel: m[3]?.replace(/\s*\([^)]*\)\s*$/, '').trim() || undefined,
      tokens: 0,
    });
  }
  if (windows.length === 0) return null;
  return {
    capturedAt,
    planType: /subscription/i.test(text) ? 'subscription' : undefined,
    windows,
  };
}

function cachePath(): string | null {
  try {
    return path.join(app.getPath('userData'), 'claude-usage.json');
  } catch {
    // No Electron app — a test or the stats CLI harness.
    return null;
  }
}

let memo: ClaudeUsageSnapshot | null = null;

/// Last known snapshot, no subprocess. Safe to call from the synchronous
/// stats scan.
export function readClaudeUsage(): ClaudeUsageSnapshot | null {
  if (memo) return memo;
  const target = cachePath();
  if (!target) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed && Array.isArray(parsed.windows) && typeof parsed.capturedAt === 'number') {
      memo = parsed as ClaudeUsageSnapshot;
      return memo;
    }
  } catch {
    // Missing or unreadable — no snapshot yet.
  }
  return null;
}

function writeCache(snap: ClaudeUsageSnapshot): void {
  memo = snap;
  const target = cachePath();
  if (!target) return;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    logSilent('claudeUsage.writeCache', e);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function runUsage(): Promise<string | null> {
  return new Promise((resolve) => {
    const binary = resolveBackendPath('claude');
    if (!binary) return resolve(null);
    let child;
    try {
      child = spawn(binary, ['-p', '/usage'], {
        // Home is always trusted, so print mode can't stall on a
        // directory-trust prompt the way an arbitrary cwd might.
        cwd: os.homedir(),
        env: buildBackendEnv(process.env, binary),
        shell: backendNeedsShell(binary),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      logSilent('claudeUsage.spawn', e);
      return resolve(null);
    }
    let out = '';
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done(null);
    }, TIMEOUT_MS);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', (e) => {
      logSilent('claudeUsage.run', e);
      done(null);
    });
    child.on('close', (code) => done(code === 0 ? out : null));
  });
}

/// Shell out to `claude -p "/usage"`, parse it, cache it. Returns null when
/// claude isn't installed, isn't logged in, or changed its wording — callers
/// fall back to the token estimate.
export async function refreshClaudeUsage(now = Date.now()): Promise<ClaudeUsageSnapshot | null> {
  const text = await runUsage();
  if (!text) return null;
  const snap = parseClaudeUsage(text, now);
  if (snap) writeCache(snap);
  return snap;
}
