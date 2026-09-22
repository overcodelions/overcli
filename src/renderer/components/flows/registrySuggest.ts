// Which registry flows to put in front of someone who has none.
//
// The welcome screen used `registryEntries.slice(0, 3)`, which is the
// registry's own order — alphabetical. That opened on "Architecture Decision
// Record", "Analyze stack trace" and "API contract design": two documents and
// a diagnosis, for a person who has just opened a code editor. The first three
// are the only three most people will ever see, so they have to be the three
// that are worth running.
//
// Ranked, not curated by id, because the registry gains flows without this
// file hearing about it.

import type { CapabilitiesReport, FlowRegistryEntry } from '@shared/types';

/// What a tag says about the kind of work. Positive is work you do inside a
/// checkout; negative is work that mostly happens in someone's tracker or
/// wiki, which is real work but a poor first impression of a code tool.
const TAG_WEIGHT: Record<string, number> = {
  // Above every flavour of review on purpose. A flow that comes back with a
  // diff is a better first impression of the feature than one that comes back
  // with a report, however good the report is.
  implementation: 12,
  review: 7,
  testing: 6,
  debugging: 6,
  refactor: 5,
  security: 4,
  analysis: 3,
  migration: 3,
  issues: 3,
  ci: 2,
  prs: 2,
  logs: 1,
  backend: 1,
  devops: 1,
  design: 1,
  api: 1,
  documentation: 0,
  docs: 0,
  release: 0,
  tickets: 0,
  infra: 0,
  data: 0,
  planning: -1,
  operations: -1,
  triage: -1,
  feedback: -1,
  research: -2,
  communication: -3,
};

/// Runs against the code that is already on disk — the class of flow that
/// works the moment it installs. `implementation` earns it too: the registry
/// tags those flows by where their input comes from ("tickets") rather than
/// by the fact that they edit your checkout, so without this the flows that
/// actually write code score below the ones that only read it.
const REPO_BONUS = 5;
const REPO_TAGS = ['repo', 'implementation'];

/// Needs an MCP server that this machine does NOT have connected. Suggesting
/// one then is suggesting a configuration project, not a flow. Connected, the
/// same flow is fully runnable and takes no penalty at all — which is what
/// lets "solve a ticket end to end" lead on a machine wired to a tracker and
/// stay out of the way on one that is not.
const MCP_PENALTY = 9;

/// Registry tags name a service; a connected server is named by whoever added
/// it. One Atlassian server answers both the Jira and the Confluence tag, and
/// people name it "atlassian", "jira" or "mcp-atlassian" about equally often.
const MCP_ALIASES: Record<string, string[]> = {
  'mcp-jira': ['jira', 'atlassian'],
  'mcp-confluence': ['confluence', 'atlassian'],
};

/// The `mcp-*` tags this machine can satisfy, from the capability scan that
/// already runs at startup (entries are ids like `mcp:atlassian`).
export function connectedMcpTags(capabilities: CapabilitiesReport | null): Set<string> {
  const servers = (capabilities?.entries ?? [])
    .filter((e) => e.kind === 'mcp')
    .map((e) => e.name.toLowerCase());
  if (servers.length === 0) return new Set();
  const satisfied = new Set<string>();
  for (const tag of Object.keys(MCP_ALIASES)) {
    const names = MCP_ALIASES[tag] ?? [];
    if (servers.some((s) => names.some((n) => s.includes(n)))) satisfied.add(tag);
  }
  // Anything not aliased matches on its own name: `mcp-github` ← "github".
  for (const s of servers) satisfied.add(`mcp-${s}`);
  return satisfied;
}

// Which CLIs a flow was published with deliberately plays no part. Install
// rebinds every model the machine cannot run (see `shared/flows/installAdapt`),
// so a Claude-built flow runs on a Codex-only machine as well as any other —
// and the registry's backend tags say what a flow USES, not what it needs, so
// they were never a fair signal anyway.

export function scoreRegistryEntry(
  entry: FlowRegistryEntry,
  connectedMcp: ReadonlySet<string> = new Set(),
): number {
  const tags = entry.tags ?? [];
  let score = 0;
  for (const tag of tags) {
    score += TAG_WEIGHT[tag] ?? 0;
    if (tag.startsWith('mcp-') && !connectedMcp.has(tag)) score -= MCP_PENALTY;
  }
  if (tags.some((t) => REPO_TAGS.includes(t))) score += REPO_BONUS;
  return score;
}

/// Best-first. Ties keep the registry's own order, so the result is stable
/// across reloads rather than reshuffling on every render.
export function suggestRegistryFlows(
  entries: readonly FlowRegistryEntry[],
  capabilities: CapabilitiesReport | null = null,
  limit = 3,
): FlowRegistryEntry[] {
  const mcp = connectedMcpTags(capabilities);
  return entries
    .map((entry, index) => ({ entry, index, score: scoreRegistryEntry(entry, mcp) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.entry);
}
