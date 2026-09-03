import { describe, expect, it } from 'vitest';
import type { CapabilityEntry, SystemInitInfo } from '@shared/types';
import { liveMcpServers } from './liveMcp';

// Captured with `claude -p --chrome --output-format stream-json --verbose
// --strict-mcp-config "Reply with the single word: ok"` against CLI
// 2.1.258 (see notes/probe-chrome.jsonl) — the real `init` event's `tools`
// and `mcp_servers` fields, trimmed to a representative subset of the
// non-Chrome tools. `--strict-mcp-config` was passed and the Chrome tools
// still showed up, confirming the server is injected internally rather
// than through any `--mcp-config` file.
const CHROME_TOOLS = [
  'Task', 'Bash', 'Edit', 'Read', 'Write', 'WebFetch', 'WebSearch',
  'mcp__claude-in-chrome__browser_batch',
  'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__file_upload',
  'mcp__claude-in-chrome__find',
  'mcp__claude-in-chrome__form_input',
  'mcp__claude-in-chrome__get_page_text',
  'mcp__claude-in-chrome__gif_creator',
  'mcp__claude-in-chrome__javascript_tool',
  'mcp__claude-in-chrome__list_connected_browsers',
  'mcp__claude-in-chrome__navigate',
  'mcp__claude-in-chrome__read_console_messages',
  'mcp__claude-in-chrome__read_network_requests',
  'mcp__claude-in-chrome__read_page',
  'mcp__claude-in-chrome__resize_window',
  'mcp__claude-in-chrome__select_browser',
  'mcp__claude-in-chrome__shortcuts_execute',
  'mcp__claude-in-chrome__shortcuts_list',
  'mcp__claude-in-chrome__switch_browser',
  'mcp__claude-in-chrome__tabs_close_mcp',
  'mcp__claude-in-chrome__tabs_context_mcp',
  'mcp__claude-in-chrome__tabs_create_mcp',
  'mcp__claude-in-chrome__upload_image',
];

const CHROME_MCP_SERVERS = [{ name: 'claude-in-chrome', status: 'connected' }];

// The user-scope filesystem scan on the machine this was captured on (see
// notes/probe-chrome.jsonl and the triage's scratch test) — none of these
// are Chrome, since Chrome's server lives in no config file.
const SCANNED_SERVERS = [
  'atlassian', 'attio-official', 'aws', 'computer-use', 'node_repl',
  'productboard', 'puppeteer', 'slack', 'zendesk',
];

function mcpEntry(name: string): CapabilityEntry {
  return {
    kind: 'mcp',
    id: `mcp:${name}`,
    name,
    source: 'user',
    clis: ['claude'],
  };
}

function scanned(): CapabilityEntry[] {
  return SCANNED_SERVERS.map(mcpEntry);
}

function init(overrides: Partial<SystemInitInfo> = {}): SystemInitInfo {
  return {
    sessionId: 's1',
    model: 'claude-haiku-4-5-20251001',
    cwd: '/repo',
    apiKeySource: 'unknown',
    tools: CHROME_TOOLS,
    slashCommands: [],
    mcpServers: CHROME_MCP_SERVERS,
    ...overrides,
  };
}

describe('liveMcpServers', () => {
  it('surfaces claude-in-chrome from a real init payload when the scan misses it', () => {
    const live = liveMcpServers(init(), scanned());
    expect(live.map((e) => e.name)).toEqual(['claude-in-chrome']);
    expect(live[0].kind).toBe('mcp');
  });

  it('does not duplicate a server the scan already found', () => {
    const live = liveMcpServers(init(), [...scanned(), mcpEntry('claude-in-chrome')]);
    expect(live).toEqual([]);
  });

  it('is case-insensitive when matching against the scan', () => {
    const live = liveMcpServers(init(), [...scanned(), mcpEntry('Claude-In-Chrome')]);
    expect(live).toEqual([]);
  });

  it('still finds the server from tool-name prefixes alone, with no mcpServers entry', () => {
    // Covers the failure mode the ticket originally (if inaccurately)
    // described: a CLI that populates `tools` but not `mcp_servers` on
    // `init`.
    const live = liveMcpServers(init({ mcpServers: [] }), scanned());
    expect(live.map((e) => e.name)).toEqual(['claude-in-chrome']);
  });

  it('ignores a server the CLI reports as not connected', () => {
    const live = liveMcpServers(
      init({ tools: ['Task', 'Bash'], mcpServers: [{ name: 'claude-in-chrome', status: 'failed' }] }),
      scanned(),
    );
    expect(live).toEqual([]);
  });

  it('is unaffected when Chrome is off (no chrome tools, no chrome server)', () => {
    const live = liveMcpServers(
      init({ tools: ['Task', 'Bash', 'Edit'], mcpServers: [] }),
      scanned(),
    );
    expect(live).toEqual([]);
  });

  it('returns nothing when there is no live init yet', () => {
    expect(liveMcpServers(undefined, scanned())).toEqual([]);
  });
});
