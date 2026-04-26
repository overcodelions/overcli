// Pure path/permission helpers shared by the runner. Maps overcli
// PermissionMode to each backend's CLI flags, normalizes the
// per-conversation allowed-dir list, and answers "is this path inside
// scope?" questions when a tool requests a file outside the cwd.

import fs from 'node:fs';
import path from 'node:path';
import { PermissionMode } from '../shared/types';

export function codexPermissionMapping(mode: PermissionMode): { sandbox: string; approval: string } {
  switch (mode) {
    case 'plan':
      return { sandbox: 'read-only', approval: 'on-request' };
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approval: 'on-failure' };
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approval: 'never' };
    case 'default':
    default:
      return { sandbox: 'workspace-write', approval: 'on-request' };
  }
}

export function codexTransportPermissions(mode: PermissionMode): { sandbox: string; approval: string } {
  const { sandbox } = codexPermissionMapping(mode);
  return { sandbox, approval: 'never' };
}

export function geminiPermissionMapping(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'auto_edit';
    case 'bypassPermissions':
      return 'yolo';
    case 'default':
    default:
      return 'default';
  }
}

/// Append a rule to Claude Code's project-local allow list at
/// `<cwd>/.claude/settings.json`. Creates the file (and directory) when
/// absent; merges into `permissions.allow` without disturbing the rest of
/// the file. Claude Code reads this on every spawn, so the grant takes
/// effect on the next turn and is shared across every conversation rooted
/// at the same cwd.
export function appendClaudeAllowRule(cwd: string, rule: string): void {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.json');
  let current: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      if (raw.trim().length > 0) current = JSON.parse(raw);
    } catch {
      // Malformed file — leave the user's copy alone.
      return;
    }
  }
  const perms = (current.permissions && typeof current.permissions === 'object')
    ? (current.permissions as Record<string, unknown>)
    : {};
  const existing = Array.isArray(perms.allow) ? (perms.allow as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (existing.includes(rule)) return;
  const next = {
    ...current,
    permissions: { ...perms, allow: [...existing, rule] },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

/// Dedupe + absolute-ify the directory list we'll pass as `--add-dir` to
/// Claude. The cwd is always implicitly allowed, so drop it; remove
/// duplicates and non-absolute entries to avoid confusing Claude Code.
export function normalizeAllowedDirs(cwd: string, dirs: string[] | undefined): string[] {
  if (!dirs || dirs.length === 0) return [];
  const cwdReal = path.resolve(cwd);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    const abs = path.resolve(d);
    if (abs === cwdReal) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/// Best-effort: pluck a filesystem path out of a Claude tool's input so
/// the renderer can show "Allow + add this directory" when it lies
/// outside the session's current scope. Returns null for tools that don't
/// carry a path (or a shell command we can't parse confidently).
export function extractRequestedPath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const candidates: Array<string | undefined> = [
    typeof obj.file_path === 'string' ? obj.file_path : undefined,
    typeof obj.path === 'string' ? obj.path : undefined,
    typeof obj.notebook_path === 'string' ? obj.notebook_path : undefined,
  ];
  for (const c of candidates) if (c && path.isAbsolute(c)) return c;
  if (toolName === 'Bash' && typeof obj.command === 'string') {
    const match = obj.command.match(/(^|[\s'"])(\/[\w.\-/]+)/);
    if (match) return match[2];
  }
  return null;
}

/// True when `p` is inside the cwd or any of the session's explicit
/// allowed dirs. We compare resolved paths so symlinks and trailing
/// slashes don't cause false negatives.
export function isInsideAllowedDirs(p: string, cwd: string, allowed: string[]): boolean {
  const abs = path.resolve(p);
  const roots = [path.resolve(cwd), ...allowed.map((d) => path.resolve(d))];
  for (const root of roots) {
    if (abs === root) return true;
    if (abs.startsWith(root + path.sep)) return true;
  }
  return false;
}
