// MCP servers reported live by the active CLI's `init` block that aren't
// already represented by the filesystem scan (see src/main/capabilities.ts).
//
// Some servers are injected by the CLI internally rather than written to
// any config file it reads — Claude in Chrome's is the first one with a
// user-facing toggle (see src/shared/claudeChrome.ts), but the same gap
// applies to any other internally-injected or project-scoped server. The
// scan structurally cannot see these, so the sheet has to fold in what the
// live session reports, the same way it already folds `lastInit.slashCommands`
// into the command tab (see `liveSlashCommands` in CapabilitiesSheet.tsx).
//
// Seeded from two places, merged by name:
//   - `mcpServers`, the CLI's own connected-server list.
//   - the `mcp__<server>__<tool>` prefix of `tools`.
// Reading both means this keeps working even if a CLI version stops
// populating `mcpServers` on `init` but still prefixes tool names that way
// — the failure mode this ticket originally (if inaccurately) described.

import type { CapabilityEntry, SystemInitInfo } from '@shared/types';

export function liveMcpServers(
  info: Pick<SystemInitInfo, 'mcpServers' | 'tools'> | undefined,
  scanned: CapabilityEntry[],
): CapabilityEntry[] {
  const known = new Set(
    scanned.filter((e) => e.kind === 'mcp').map((e) => e.name.toLowerCase()),
  );

  // name -> connected. `mcpServers` entries carry an explicit status;
  // a name seen only via a tool prefix is assumed connected, since the
  // tool wouldn't be listed as available otherwise.
  const live = new Map<string, boolean>();
  for (const server of info?.mcpServers ?? []) {
    if (!server?.name) continue;
    live.set(server.name, server.status === 'connected');
  }
  for (const tool of info?.tools ?? []) {
    const parts = tool.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') continue;
    const name = parts[1];
    if (!live.has(name)) live.set(name, true);
  }

  const out: CapabilityEntry[] = [];
  for (const [name, connected] of live) {
    if (!connected) continue;
    if (known.has(name.toLowerCase())) continue;
    out.push({
      kind: 'mcp',
      id: `mcp:live:${name}`,
      name,
      source: 'builtin',
      clis: ['claude'],
    });
  }
  return out;
}
