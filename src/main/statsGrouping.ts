// Rolls raw per-project stats rows up into the unit a human thinks in.
// A repo's agent worktrees, a flow's disposable coordinator roots and a
// workspace root are all separate `~/.claude/projects` slugs, so the flat
// table showed one repo as forty rows. Grouping happens on segments with a
// leading `.` stripped because `unslug` cannot tell `-` from `/` or `.`.

import path from 'node:path';
import type { ProjectGroupKind, ProjectGroupStats, ProjectStats } from '../shared/types';

/// What we know about the flow run that owns a coordinator root, keyed by
/// lowercased run id (which IS the coordinator directory name — see
/// `ensureCoordinatorSymlinkRoot(runId, …)` in flows/runtime.ts).
export interface CoordinatorRun {
  flowName: string;
  /// `flowRunOwnerPath(run)` — the project/workspace the run was launched
  /// from. Absent for runs the LRU evicted before `ownerPath` was recorded
  /// in the summary log; those can only be grouped by flow name.
  ownerPath?: string;
}

export interface GroupingContext {
  homeDir: string;
  projects: Array<{ name: string; path: string }>;
  workspaces: Array<{ id: string; name: string }>;
  /// lowercased coordinator id → what launched it
  coordinators: Map<string, CoordinatorRun>;
}

export interface ProjectClassification {
  groupId: string;
  groupName: string;
  groupKind: ProjectGroupKind;
  leafName: string;
}

/// Compare two paths that may have been through the lossy slug round trip.
/// The slug replaces `/`, `.` AND spaces with `-`, so all three fold here.
export function pathKey(p: string): string {
  return p.replace(/[/. ]/g, '-').toLowerCase();
}

function segments(p: string): string[] {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s.slice(1) : s));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function indexOfPair(lower: string[], a: string, b: string): number {
  for (let i = 0; i + 1 < lower.length; i += 1) {
    if (lower[i] === a && lower[i + 1] === b) return i;
  }
  return -1;
}

export function classifyProject(
  displayPath: string,
  ctx: GroupingContext,
  /// Set while resolving a coordinator root through its run's owner path,
  /// so a run whose owner is itself a coordinator root (no
  /// `sourceProjectPath` recorded) can't recurse forever.
  resolvingOwner = false,
): ProjectClassification {
  const parts = segments(displayPath);
  const lower = parts.map((s) => s.toLowerCase());

  // 1. Worktrees — ours (`~/.overcli/worktrees/<project>/<name>`) and
  //    Claude Code's (`~/git-worktrees/<project>/<name>`).
  let tail: string[] | null = null;
  const wt = indexOfPair(lower, 'overcli', 'worktrees');
  if (wt >= 0) {
    tail = parts.slice(wt + 2);
  } else {
    const g = indexOfPair(lower, 'git', 'worktrees');
    if (g >= 0) tail = parts.slice(g + 2);
  }
  if (tail && tail.length > 0) {
    // The project segment can itself be multiple slug segments when the
    // project's folder name has a `.`, `/` or space in it (all three
    // collapse to `-` in the slug), so match the longest run of leading
    // segments against a known project's folder name before falling back
    // to a single segment.
    let owner: { name: string; path: string } | undefined;
    let take = 1;
    for (let n = Math.min(tail.length, 6); n >= 1; n -= 1) {
      const cand = pathKey(tail.slice(0, n).join('-'));
      const m = ctx.projects.find((p) => pathKey(path.basename(p.path)) === cand);
      if (m) {
        owner = m;
        take = n;
        break;
      }
    }
    const seg = tail.slice(0, take).join('-');
    const rest = tail.slice(take);
    return {
      groupId: owner ? `repo:${pathKey(owner.path)}` : `worktree:${seg.toLowerCase()}`,
      groupName: owner ? owner.name : seg,
      groupKind: owner ? 'repo' : 'worktree',
      leafName: rest.length ? rest.join('-') : seg,
    };
  }

  // 2. Workspace roots: <dataDir>/workspaces/<uuid>. The uuid's hyphens
  //    became slashes, so rejoin the tail with `-`.
  const wsIdx = lower.findIndex((s, n) => s === 'workspaces' && n > 0 && lower[n - 1] === 'overcli');
  if (wsIdx >= 0) {
    const id = parts.slice(wsIdx + 1).join('-');
    const ws = ctx.workspaces.find((w) => w.id.toLowerCase() === id.toLowerCase());
    return {
      groupId: `workspace:${id.toLowerCase()}`,
      groupName: ws ? ws.name : `Workspace ${UUID_RE.test(id) ? id.slice(0, 8) : id}`,
      groupKind: 'workspace',
      leafName: '',
    };
  }

  // 3. Flow coordinator roots: <dataDir>/coordinators/<uuid>. The directory
  //    is a throwaway symlink farm, so the run belongs to whatever project
  //    or workspace launched it — resolve through the run's owner path and
  //    classify THAT, exactly as `flowRunOwnerPath` prescribes. Only runs
  //    whose owner we no longer know (evicted before `ownerPath` was
  //    recorded) fall back to grouping by flow name.
  const coIdx = lower.findIndex((s, n) => s === 'coordinators' && n > 0 && lower[n - 1] === 'overcli');
  if (coIdx >= 0) {
    const id = parts.slice(coIdx + 1).join('-');
    const run = ctx.coordinators.get(id.toLowerCase());
    const short = UUID_RE.test(id) ? id.slice(0, 8) : id;
    const runLabel = run?.flowName ? `${run.flowName} · ${short}` : short;
    if (run?.ownerPath && !resolvingOwner) {
      const owner = classifyProject(run.ownerPath, ctx, true);
      return { ...owner, leafName: runLabel };
    }
    const flowName = run?.flowName ?? null;
    return {
      groupId: flowName ? `flow:${flowName.toLowerCase()}` : 'flow:unknown',
      groupName: flowName ?? 'Flow runs',
      groupKind: 'flow',
      leafName: short,
    };
  }

  // 4. A real checkout.
  const owner = ctx.projects.find((p) => pathKey(p.path) === pathKey(displayPath));
  if (owner) {
    return {
      groupId: `repo:${pathKey(owner.path)}`,
      groupName: owner.name,
      groupKind: 'repo',
      leafName: 'main checkout',
    };
  }
  if (pathKey(displayPath) === pathKey(ctx.homeDir)) {
    return { groupId: 'other:home', groupName: 'Home (no project)', groupKind: 'other', leafName: '' };
  }
  return {
    groupId: `repo:${pathKey(displayPath)}`,
    groupName: displayPath,
    groupKind: 'repo',
    leafName: '',
  };
}

export function groupProjects(rows: ProjectStats[]): ProjectGroupStats[] {
  const map = new Map<string, ProjectGroupStats>();
  for (const r of rows) {
    let g = map.get(r.groupId);
    if (!g) {
      g = {
        id: r.groupId,
        name: r.groupName,
        kind: r.groupKind,
        sessions: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
        linesAdded: 0,
        linesDeleted: 0,
        children: [],
      };
      map.set(r.groupId, g);
    }
    g.sessions += r.sessions;
    g.turns += r.turns;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.cacheRead += r.cacheRead;
    g.cacheCreation += r.cacheCreation;
    g.linesAdded += r.linesAdded;
    g.linesDeleted += r.linesDeleted;
    g.children.push(r);
  }
  for (const g of map.values()) g.children.sort((a, b) => b.outputTokens - a.outputTokens);
  return Array.from(map.values()).sort((a, b) => b.outputTokens - a.outputTokens);
}
