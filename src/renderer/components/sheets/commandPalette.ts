// Index + ranking for the ⌘K command palette.
//
// The palette searches EVERYTHING the app knows about — chats, agents,
// flow runs, saved flows, projects, workspaces, archived conversations
// and app actions — from one input. This module is the pure half: it
// flattens those heterogeneous things into one `PaletteItem` shape,
// scores them against a query, and buckets the survivors into sections.
// `QuickSwitcherSheet` owns the rendering and the side effects.
//
// Keeping it pure (no store reads, no `Date.now()`) is what makes the
// ranking testable — the scoring rules below are easy to get subtly
// wrong, and "an exact project name loses to a chat that merely contains
// the word" is exactly the kind of regression a test catches and a
// screenshot doesn't.

import type { Backend, Conversation, Project, UUID, Workspace } from '@shared/types';
import type { Flow, FlowRun } from '@shared/flows/schema';
import { flowRunActivityAt, flowRunOwnerPath, flowRunTitle } from '@shared/flows/schema';
import { conversationPromptAt } from '../../conversationLookup';

export type PaletteKind =
  | 'chat'
  | 'agent'
  | 'run'
  | 'flow'
  | 'project'
  | 'workspace'
  | 'command';

/// What the row's status pill says. `idle` draws nothing — most rows are
/// idle and a pill on every one of them is noise.
export type PaletteStatus =
  | 'running'
  | 'paused'
  | 'watching'
  | 'done'
  | 'failed'
  | 'archived'
  | 'idle';

/// The filter chips under the input. `all` is the default; `archived` is
/// the only scope that shows put-away things without a query.
export type PaletteScope = 'all' | 'chats' | 'flows' | 'places' | 'actions' | 'archived';

export type PaletteSection = 'active' | 'recent' | 'places' | 'flows' | 'actions' | 'archived';

/// Where a row goes when the user hits ↵. The sheet resolves these against
/// the stores; keeping them as data means the ranking layer never has to
/// hold a callback per item (and stays comparable in tests).
export type PaletteTarget =
  | { type: 'conversation'; convId: UUID }
  | { type: 'run'; runId: string }
  | { type: 'flow'; flowId: string }
  | { type: 'project'; projectId: UUID }
  | { type: 'workspace'; workspaceId: UUID }
  | { type: 'command'; commandId: string };

export interface PaletteItem {
  /// Unique across kinds — a project and a chat can share an id space.
  key: string;
  kind: PaletteKind;
  title: string;
  /// Quiet second line: owner, path, description.
  subtitle?: string;
  status: PaletteStatus;
  archived: boolean;
  /// Last activity, epoch ms. 0 for things without a timeline (flows,
  /// commands) — they fall back to declaration order.
  recency: number;
  /// Extra haystacks searched at a discount: branch names, session ids,
  /// paths, tags, command synonyms.
  keywords?: string[];
  /// Backend for chats/agents, so the row can tint its tile.
  backend?: Backend | null;
  /// Name the monogram tile derives its letter + tint from (runs, flows).
  monogram?: string;
  target: PaletteTarget;
}

/// An app action offered in the palette. `run` is carried through the
/// ranking untouched and invoked by the sheet.
export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  run: () => void;
}

export interface PaletteBuildInput {
  projects: Project[];
  workspaces: Workspace[];
  runs: FlowRun[];
  flows: Flow[];
  commands: PaletteCommand[];
  /// Conversation ids currently streaming. Covers flow-run participants
  /// too, which is how a `done` run still reads as live while you're
  /// hijack-chatting one of its participants.
  runningIds: ReadonlySet<string>;
  lastSelectedAt: Record<string, number>;
  lastOpenedAtByRun: Record<string, number>;
}

export interface RankedItem {
  item: PaletteItem;
  score: number;
  /// Character offsets in `item.title` that matched, for highlighting.
  /// Empty when the match came from the subtitle or a keyword.
  positions: number[];
}

export interface PaletteGroup {
  section: PaletteSection;
  items: RankedItem[];
  /// How many matched before the section cap — lets the header say "+7 more".
  total: number;
}

// ---------------------------------------------------------------- index

export function buildPaletteItems(input: PaletteBuildInput): PaletteItem[] {
  const out: PaletteItem[] = [];
  const { runningIds, lastSelectedAt, lastOpenedAtByRun } = input;

  const pushConversation = (conv: Conversation, ownerName: string, ownerKind: 'project' | 'workspace') => {
    const agent = isAgentLike(conv);
    const archived = !!conv.hidden;
    out.push({
      key: `conv:${conv.id}`,
      kind: agent ? 'agent' : 'chat',
      title: conv.name,
      subtitle: `${ownerKind === 'workspace' ? 'workspace · ' : ''}${ownerName}${conv.branchName ? ` · ${conv.branchName}` : ''}`,
      status: archived ? 'archived' : runningIds.has(conv.id) ? 'running' : 'idle',
      archived,
      recency: Math.max(conversationPromptAt(conv), lastSelectedAt[conv.id] ?? 0),
      keywords: compact([ownerName, conv.branchName, conv.sessionId, agent ? 'agent worktree' : 'chat']),
      backend: conv.primaryBackend ?? null,
      target: { type: 'conversation', convId: conv.id },
    });
  };

  for (const project of input.projects) {
    for (const conv of project.conversations) pushConversation(conv, project.name, 'project');
    out.push({
      key: `project:${project.id}`,
      kind: 'project',
      title: project.name,
      subtitle: shortenPath(project.path),
      status: project.conversations.some((c) => !c.hidden && runningIds.has(c.id)) ? 'running' : 'idle',
      archived: false,
      recency: Math.max(project.lastOpenedAt ?? 0, ...project.conversations.map(conversationPromptAt)),
      keywords: compact(['project repo folder', project.path]),
      target: { type: 'project', projectId: project.id },
    });
  }

  for (const ws of input.workspaces) {
    for (const conv of ws.conversations ?? []) pushConversation(conv, ws.name, 'workspace');
    const memberNames = ws.projectIds
      .map((id) => input.projects.find((p) => p.id === id)?.name)
      .filter((n): n is string => !!n);
    out.push({
      key: `workspace:${ws.id}`,
      kind: 'workspace',
      title: ws.name,
      subtitle: `${ws.projectIds.length} project${ws.projectIds.length === 1 ? '' : 's'} · ${shortenPath(ws.rootPath)}`,
      status: (ws.conversations ?? []).some((c) => !c.hidden && runningIds.has(c.id)) ? 'running' : 'idle',
      archived: false,
      recency: Math.max(ws.createdAt ?? 0, ...(ws.conversations ?? []).map(conversationPromptAt)),
      keywords: compact(['workspace', ws.rootPath, ...memberNames]),
      target: { type: 'workspace', workspaceId: ws.id },
    });
  }

  const ownerNameFor = (path: string): string => {
    const ws = input.workspaces.find((w) => w.rootPath === path);
    if (ws) return `workspace · ${ws.name}`;
    const project = input.projects.find((p) => p.path === path);
    if (project) return project.name;
    return path.split('/').filter(Boolean).pop() ?? path;
  };

  for (const run of input.runs) {
    const live = runIsLive(run, runningIds);
    out.push({
      key: `run:${run.id}`,
      kind: 'run',
      title: flowRunTitle(run),
      subtitle: `${run.flowSnapshot.name} · ${ownerNameFor(flowRunOwnerPath(run))}`,
      status: runStatus(run, live),
      archived: run.state.kind === 'archived',
      recency: Math.max(flowRunActivityAt(run), lastOpenedAtByRun[run.id] ?? 0),
      keywords: compact(['flow run', run.flowSnapshot.name, run.branchName, run.userPrompt?.slice(0, 200)]),
      monogram: run.flowSnapshot.name,
      target: { type: 'run', runId: run.id },
    });
  }

  for (const flow of input.flows) {
    out.push({
      key: `flow:${flow.source}:${flow.id}`,
      kind: 'flow',
      title: flow.name,
      subtitle:
        flow.description?.trim() ||
        `${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'} · ${flow.source} flow`,
      status: 'idle',
      archived: false,
      recency: 0,
      keywords: compact(['flow pipeline', flow.id, flow.source, ...(flow.tags ?? [])]),
      monogram: flow.name,
      target: { type: 'flow', flowId: flow.id },
    });
  }

  for (const command of input.commands) {
    out.push({
      key: `command:${command.id}`,
      kind: 'command',
      title: command.title,
      subtitle: command.subtitle,
      status: 'idle',
      archived: false,
      recency: 0,
      keywords: command.keywords,
      target: { type: 'command', commandId: command.id },
    });
  }

  return out;
}

/// Mirrors `isAgentConversation` in Sidebar.tsx. Duplicated rather than
/// imported so this module stays free of the sidebar's React imports.
function isAgentLike(c: Conversation): boolean {
  if (c.continuedLocally) return false;
  return !!c.worktreePath || (c.workspaceAgentMemberIds?.length ?? 0) > 0;
}

function runIsLive(run: FlowRun, runningIds: ReadonlySet<string>): boolean {
  if (run.state.kind === 'running') return true;
  return Object.values(run.conversationIds).some((id) => runningIds.has(id));
}

function runStatus(run: FlowRun, live: boolean): PaletteStatus {
  if (run.state.kind === 'archived') return 'archived';
  if (live) return 'running';
  switch (run.state.kind) {
    case 'paused':
      return 'paused';
    case 'watching':
      return 'watching';
    case 'aborted':
      return 'failed';
    case 'done':
      return run.state.success ? 'done' : 'failed';
    default:
      return 'idle';
  }
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((v): v is string => !!v && v.trim().length > 0);
}

export function shortenPath(path: string): string {
  const home = /^\/Users\/[^/]+/;
  return path.replace(home, '~');
}

// -------------------------------------------------------------- matching

export interface TextMatch {
  score: number;
  positions: number[];
}

/// Substring first (cheap and by far the most common way people type),
/// subsequence as the fallback so "cvggap" still finds "Coverage gap
/// report". Returns null when the needle isn't in there at all.
export function matchText(text: string, query: string): TextMatch | null {
  if (!query) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (lower === q) return { score: 1000, positions: span(0, q.length) };
  const idx = lower.indexOf(q);
  if (idx === 0) return { score: 820 - lengthPenalty(lower), positions: span(0, q.length) };
  if (idx > 0) {
    const bonus = isBoundary(lower, idx) ? 660 : 560;
    return {
      score: bonus - Math.min(idx, 60) * 1.5 - lengthPenalty(lower),
      positions: span(idx, q.length),
    };
  }
  return subsequenceMatch(lower, q.replace(/\s+/g, ''));
}

function subsequenceMatch(lower: string, needle: string): TextMatch | null {
  if (!needle) return null;
  const positions: number[] = [];
  let score = 300;
  let cursor = 0;
  let previous = -2;
  for (const ch of needle) {
    const found = lower.indexOf(ch, cursor);
    if (found < 0) return null;
    if (found === previous + 1) score += 12;
    else if (isBoundary(lower, found)) score += 10;
    else score -= Math.min(found - previous, 12);
    positions.push(found);
    previous = found;
    cursor = found + 1;
  }
  return { score: Math.max(40, score - lengthPenalty(lower)), positions };
}

function isBoundary(lower: string, index: number): boolean {
  if (index === 0) return true;
  return !/[a-z0-9]/.test(lower[index - 1]!);
}

/// Short titles win ties. Capped so a long chat title isn't buried
/// entirely — it still ranks, just below the tighter match.
function lengthPenalty(text: string): number {
  return Math.min(text.length, 80) * 0.4;
}

function span(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

// -------------------------------------------------------------- ranking

const KIND_WEIGHT: Record<PaletteKind, number> = {
  chat: 12,
  agent: 12,
  run: 10,
  project: 8,
  workspace: 8,
  flow: 6,
  command: 4,
};

const STATUS_BOOST: Record<PaletteStatus, number> = {
  running: 25,
  paused: 18,
  watching: 15,
  done: 0,
  failed: 0,
  archived: 0,
  idle: 0,
};

/// Big enough that an archived row never outranks a live one on a loose
/// match, small enough that an exact title match still surfaces — which
/// is the whole point of being able to search archived things.
const ARCHIVED_PENALTY = -220;

const SUBTITLE_WEIGHT = 0.55;
const KEYWORD_WEIGHT = 0.7;

const SCOPE_KINDS: Record<Exclude<PaletteScope, 'all' | 'archived'>, PaletteKind[]> = {
  chats: ['chat', 'agent'],
  flows: ['run', 'flow'],
  places: ['project', 'workspace'],
  actions: ['command'],
};

export function matchesScope(item: PaletteItem, scope: PaletteScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'archived') return item.archived;
  return SCOPE_KINDS[scope].includes(item.kind);
}

export function recencyBonus(now: number, at: number): number {
  if (!at) return 0;
  const age = now - at;
  if (age < 5 * 60_000) return 40;
  if (age < 60 * 60_000) return 28;
  if (age < 24 * 3_600_000) return 16;
  if (age < 7 * 24 * 3_600_000) return 6;
  return 0;
}

export function scoreItem(item: PaletteItem, query: string, now: number): RankedItem | null {
  let best: TextMatch | null = matchText(item.title, query);
  if (item.subtitle) {
    const m = matchText(item.subtitle, query);
    if (m && m.score * SUBTITLE_WEIGHT > (best?.score ?? -Infinity)) {
      best = { score: m.score * SUBTITLE_WEIGHT, positions: [] };
    }
  }
  for (const keyword of item.keywords ?? []) {
    const m = matchText(keyword, query);
    if (m && m.score * KEYWORD_WEIGHT > (best?.score ?? -Infinity)) {
      best = { score: m.score * KEYWORD_WEIGHT, positions: [] };
    }
  }
  if (!best) return null;
  const score =
    best.score +
    KIND_WEIGHT[item.kind] +
    STATUS_BOOST[item.status] +
    recencyBonus(now, item.recency) +
    (item.archived ? ARCHIVED_PENALTY : 0);
  return { item, score, positions: best.positions };
}

export function sectionFor(item: PaletteItem): PaletteSection {
  if (item.archived) return 'archived';
  switch (item.kind) {
    case 'chat':
    case 'agent':
    case 'run':
      return item.status === 'running' || item.status === 'paused' || item.status === 'watching'
        ? 'active'
        : 'recent';
    case 'project':
    case 'workspace':
      return 'places';
    case 'flow':
      return 'flows';
    case 'command':
      return 'actions';
  }
}

export const SECTION_LABEL: Record<PaletteSection, string> = {
  active: 'Active now',
  recent: 'Recent',
  places: 'Projects & workspaces',
  flows: 'Flows',
  actions: 'Actions',
  archived: 'Archived',
};

const RESTING_ORDER: PaletteSection[] = ['active', 'recent', 'places', 'flows', 'actions', 'archived'];

const CAP_RESTING: Record<PaletteSection, number> = {
  active: 8,
  recent: 8,
  places: 6,
  flows: 5,
  actions: 6,
  archived: 6,
};

const CAP_SEARCHING: Record<PaletteSection, number> = {
  active: 8,
  recent: 10,
  places: 6,
  flows: 6,
  actions: 6,
  archived: 6,
};

/// Rank + bucket in one pass. With no query the palette is a browsing
/// surface (fixed section order, most-recent-first inside each); with a
/// query it's a search surface (sections ordered by their best hit).
///
/// Archived rows are hidden at rest outside the Archived scope — the user
/// deliberately put them away — but any query can reach them.
export function buildPaletteGroups(
  items: PaletteItem[],
  query: string,
  scope: PaletteScope,
  now: number,
): PaletteGroup[] {
  const q = query.trim();
  const buckets = new Map<PaletteSection, RankedItem[]>();

  for (const item of items) {
    if (!matchesScope(item, scope)) continue;
    if (item.archived && scope !== 'archived' && !q) continue;
    const ranked = q ? scoreItem(item, q, now) : { item, score: 0, positions: [] };
    if (!ranked) continue;
    const section = sectionFor(item);
    const list = buckets.get(section);
    if (list) list.push(ranked);
    else buckets.set(section, [ranked]);
  }

  const caps = q ? CAP_SEARCHING : CAP_RESTING;
  const groups: PaletteGroup[] = [];
  for (const [section, list] of buckets) {
    // Array.prototype.sort is stable, so equal-recency rows (commands,
    // flows — everything with recency 0) keep their declared order.
    list.sort(q ? (a, b) => b.score - a.score : (a, b) => b.item.recency - a.item.recency);
    groups.push({ section, items: list.slice(0, caps[section]), total: list.length });
  }

  if (q) {
    groups.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
  } else {
    groups.sort((a, b) => RESTING_ORDER.indexOf(a.section) - RESTING_ORDER.indexOf(b.section));
  }
  return groups;
}

export function flattenGroups(groups: PaletteGroup[]): RankedItem[] {
  return groups.flatMap((g) => g.items);
}

/// Index into the flattened list where each section starts — the stops
/// ⌃←/⌃→ jump between.
export function groupStartIndices(groups: PaletteGroup[]): number[] {
  const out: number[] = [];
  let offset = 0;
  for (const group of groups) {
    out.push(offset);
    offset += group.items.length;
  }
  return out;
}

/// Whether a bare ←/→ in the query field should move the filter chips
/// instead of the caret, and which way. ←/→ drives the chips because the
/// chips are the horizontal control — vertical movement through the list
/// belongs to ↑/↓ (rows) and ⌥↑/⌥↓ (sections).
///
/// It steps only when the caret has nowhere left to go in that direction —
/// so an empty query (the usual browsing case) gets both arrows, and a typed
/// query keeps ← for fixing a typo while → at the end of the text still
/// steps. Any active selection is text navigation, never a chip step.
export function arrowStepFromQueryEdge(
  key: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  length: number,
): -1 | 1 | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  if (selectionStart === null || selectionEnd === null) return null;
  if (selectionStart !== selectionEnd) return null;
  if (key === 'ArrowLeft') return selectionStart === 0 ? -1 : null;
  return selectionStart === length ? 1 : null;
}

/// Where a section step lands from `selected`: the first row of the adjacent
/// section. Deliberately the adjacent one even from mid-section — "back"
/// landing on the top of the section you're already in would take a second
/// press to actually leave it. Clamps at both ends; null when there are no
/// sections to move between.
///
/// Driven by ⌥↑/⌥↓ and PageUp/PageDown. Not ←/→ — those move the filter
/// chips, which is the control that actually runs horizontally.
export function adjacentGroupStart(
  starts: number[],
  selected: number,
  delta: number,
): number | null {
  if (starts.length === 0) return null;
  let current = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! <= selected) current = i;
  }
  const next = Math.min(starts.length - 1, Math.max(0, current + delta));
  return starts[next]!;
}

/// Per-scope counts for the filter chips. Counted off the same visibility
/// rule the groups use, so a chip never promises rows the list won't show.
export function scopeCounts(items: PaletteItem[], query: string, now: number): Record<PaletteScope, number> {
  const q = query.trim();
  const counts: Record<PaletteScope, number> = {
    all: 0,
    chats: 0,
    flows: 0,
    places: 0,
    actions: 0,
    archived: 0,
  };
  const scopes = Object.keys(counts) as PaletteScope[];
  for (const item of items) {
    // Score once per item, not once per scope — the chips are recomputed
    // on every keystroke.
    if (q && !scoreItem(item, q, now)) continue;
    for (const scope of scopes) {
      if (!matchesScope(item, scope)) continue;
      if (item.archived && scope !== 'archived' && !q) continue;
      counts[scope]++;
    }
  }
  return counts;
}
