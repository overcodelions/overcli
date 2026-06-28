// On-disk store for recent orchestrator producer prompts. Every time the user
// starts a FRESH ask (not a refinement) the seed prompt is recorded here, so
// the Ask pane can offer it as a one-click starter next time — even if that
// ask never launched a batch. Global (not per-project): a good ask ("find the
// small docs fixes") is worth reusing across repos.
//
// One JSON array at <userData>/orchestrator-recent-prompts.json, newest-first,
// deduped by exact text and capped. Atomic write (temp + rename) like the
// sibling orchestrationsStore, with a tiny in-memory cache since the list is
// read on every Ask-pane mount.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';

import type { RecentPrompt } from '../../shared/flows/orchestration';

/// Keep the list a quick-pick, not a history archive — drop the oldest past this.
const MAX_RECENT = 30;

function filePath(): string {
  return path.join(app.getPath('userData'), 'orchestrator-recent-prompts.json');
}

let cache: RecentPrompt[] | null = null;

function load(): RecentPrompt[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = Array.isArray(parsed)
      ? parsed
          .filter(
            (p): p is RecentPrompt =>
              p && typeof p.text === 'string' && typeof p.lastUsedAt === 'number',
          )
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      : [];
  } catch {
    // Missing or unreadable file — start empty.
    cache = [];
  }
  return cache;
}

function save(list: RecentPrompt[]): void {
  cache = list;
  const target = filePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'orchestrator', `Failed to persist recent prompts: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/// Recent seed prompts, newest first.
export function listRecentPrompts(): RecentPrompt[] {
  return [...load()];
}

/// Record a fresh seed prompt. An exact-text duplicate bumps the existing
/// entry to the front (refreshing its timestamp) instead of piling up. Returns
/// the updated list. A blank prompt is a no-op.
export function recordRecentPrompt(text: string): RecentPrompt[] {
  const trimmed = text.trim();
  if (!trimmed) return listRecentPrompts();
  const rest = load().filter((p) => p.text !== trimmed);
  const next = [{ text: trimmed, lastUsedAt: Date.now() }, ...rest].slice(0, MAX_RECENT);
  save(next);
  return [...next];
}

/// Forget one prompt by exact text. Returns the updated list.
export function deleteRecentPrompt(text: string): RecentPrompt[] {
  const next = load().filter((p) => p.text !== text);
  save(next);
  return [...next];
}
