// Unified Extensions view. Replaces the previous Skills / Agents / Slash
// / Plugins / MCP sheets, which were either empty placeholders or only
// populated after the CLI emitted its init block. This sheet reads from
// a filesystem scan in main (see src/main/capabilities.ts) so it is
// populated on cold-open, and folds in live `lastInit.slashCommands`
// from the current conversation when present.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import type { Backend, CapabilityEntry, CapabilityKind } from '@shared/types';

const TABS: Array<{ key: CapabilityKind; label: string }> = [
  { key: 'skill', label: 'Skills' },
  { key: 'agent', label: 'Agents' },
  { key: 'command', label: 'Slash' },
  { key: 'plugin', label: 'Plugins' },
  { key: 'mcp', label: 'MCP' },
];

const CLI_LABEL: Record<Backend, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

export function CapabilitiesSheet() {
  const capabilities = useStore((s) => s.capabilities);
  const refresh = useStore((s) => s.refreshCapabilities);
  const lastInit = useStore((s) => s.lastInit);

  const [tab, setTab] = useState<CapabilityKind>('skill');
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const scanned = capabilities?.entries ?? [];
    const live = liveSlashCommands(lastInit?.slashCommands ?? [], scanned);
    return [...scanned, ...live];
  }, [capabilities, lastInit]);

  const counts = useMemo(() => countByKind(entries), [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => e.kind === tab)
      .filter((e) => {
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          (e.description ?? '').toLowerCase().includes(q) ||
          (e.pluginId ?? '').toLowerCase().includes(q)
        );
      })
      .sort(byName);
  }, [entries, tab, query]);

  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="px-5 pt-4 pb-2 border-b border-card">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Extensions</div>
            <div className="text-xs text-ink-faint">
              Skills, agents, slash commands, plugins, and MCP servers discovered across your CLIs.
            </div>
          </div>
          <button
            onClick={() => void refresh()}
            className="text-[10px] px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
          >
            Rescan
          </button>
        </div>
        <div className="flex gap-1 mt-3">
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = counts[t.key] ?? 0;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={
                  'text-xs px-2.5 py-1 rounded border ' +
                  (active
                    ? 'border-accent bg-accent/10 text-ink'
                    : 'border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong')
                }
              >
                {t.label}
                <span className="ml-1.5 text-ink-faint">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter"
        className="field mx-5 my-3 px-3 py-1.5 text-xs"
      />

      <div className="overflow-y-auto px-5 pb-4 flex-1">
        {filtered.length === 0 ? (
          <div className="text-xs text-ink-faint py-4">
            {emptyMessage(tab, !capabilities)}
          </div>
        ) : (
          filtered.map((entry) => <CapabilityRow key={entry.id} entry={entry} />)
        )}

        {capabilities?.warnings && capabilities.warnings.length > 0 && (
          <div className="mt-4 pt-3 border-t border-card text-[10px] text-ink-faint">
            <div className="font-semibold mb-1">Scan warnings</div>
            {capabilities.warnings.map((w) => (
              <div key={w} className="font-mono">{w}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CapabilityRow({ entry }: { entry: CapabilityEntry }) {
  return (
    <div className="py-2 border-b border-card">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-sm text-ink">
          {entry.kind === 'command' ? `/${entry.name}` : entry.name}
        </div>
        {entry.pluginId && <Chip tone="plugin">{shortPluginId(entry.pluginId)}</Chip>}
        {entry.source !== 'plugin' && <Chip tone="source">{entry.source}</Chip>}
        {entry.clis.map((cli) => (
          <Chip key={cli} tone="cli">{CLI_LABEL[cli]}</Chip>
        ))}
      </div>
      {entry.description && (
        <div className="text-[11px] text-ink-muted mt-0.5 line-clamp-2">
          {entry.description}
        </div>
      )}
      {entry.path && (
        <div className="text-[10px] text-ink-faint mt-0.5 font-mono truncate" title={entry.path}>
          {entry.path}
        </div>
      )}
    </div>
  );
}

function Chip({ tone, children }: { tone: 'cli' | 'source' | 'plugin'; children: React.ReactNode }) {
  const cls =
    tone === 'cli'
      ? 'bg-accent/10 text-accent border-accent/30'
      : tone === 'plugin'
        ? 'bg-card-strong text-ink-muted border-card-strong'
        : 'bg-transparent text-ink-faint border-card-strong';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>
      {children}
    </span>
  );
}

function byName(a: CapabilityEntry, b: CapabilityEntry): number {
  return a.name.localeCompare(b.name);
}

function countByKind(entries: CapabilityEntry[]): Partial<Record<CapabilityKind, number>> {
  const out: Partial<Record<CapabilityKind, number>> = {};
  for (const e of entries) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

function shortPluginId(fullId: string): string {
  const at = fullId.indexOf('@');
  return at > 0 ? fullId.slice(0, at) : fullId;
}

/// Live slash commands reported by the active CLI's init block that
/// aren't already represented by the filesystem scan. Lets built-in
/// commands (e.g. `/help`, `/clear`) show up even though they have no
/// on-disk file backing them.
function liveSlashCommands(names: string[], scanned: CapabilityEntry[]): CapabilityEntry[] {
  const known = new Set(
    scanned.filter((e) => e.kind === 'command').map((e) => e.name.toLowerCase()),
  );
  return names
    .filter((n) => !known.has(n.toLowerCase()))
    .map<CapabilityEntry>((n) => ({
      kind: 'command',
      id: `command:live:${n}`,
      name: n,
      source: 'builtin',
      clis: ['claude'],
    }));
}

function emptyMessage(tab: CapabilityKind, scanning: boolean): string {
  if (scanning) return 'Scanning…';
  switch (tab) {
    case 'skill':
      return 'No skills found in ~/.claude/skills, ~/.codex/skills, or plugin bundles.';
    case 'agent':
      return 'No subagents found in ~/.claude/agents or plugin bundles.';
    case 'command':
      return 'No slash commands yet. Built-ins appear after sending a first message.';
    case 'plugin':
      return 'No plugins installed. Run /plugins in a conversation to add one.';
    case 'mcp':
      return 'No MCP servers configured in any CLI.';
  }
}
