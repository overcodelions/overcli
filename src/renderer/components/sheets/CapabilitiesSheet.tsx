// Unified Extensions view. Replaces the previous Skills / Agents / Slash
// / Plugins / MCP sheets, which were either empty placeholders or only
// populated after the CLI emitted its init block. This sheet reads from
// a filesystem scan in main (see src/main/capabilities.ts) so it is
// populated on cold-open, and folds in live `lastInit.slashCommands`
// from the current conversation when present.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import type {
  Backend,
  CapabilityEntry,
  CapabilityKind,
  MarketplaceSkill,
  SkillTarget,
} from '@shared/types';

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
        {tab === 'skill' && <SkillsExplainer />}

        {tab === 'skill' && filtered.length > 0 && (
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted mt-2 mb-2">
            Installed
          </div>
        )}

        {filtered.length === 0 ? (
          tab === 'skill' ? null : (
            <div className="text-xs text-ink-faint py-4">
              {emptyMessage(tab, !capabilities)}
            </div>
          )
        ) : tab === 'skill' ? (
          filtered.map((entry) => <SkillRow key={entry.id} entry={entry} />)
        ) : (
          filtered.map((entry) => <CapabilityRow key={entry.id} entry={entry} />)
        )}

        {tab === 'skill' && <MarketplaceSection query={query} />}

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

function SkillsExplainer() {
  return (
    <div className="mb-4 p-3 rounded-lg border border-accent/30 bg-accent/5">
      <div className="flex items-start gap-3">
        <div className="text-2xl leading-none mt-0.5">📘</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-ink mb-1">What's a skill?</div>
          <div className="text-[11px] text-ink-muted leading-relaxed">
            A skill is a small markdown file (<span className="font-mono">SKILL.md</span>) that
            tells your CLI how to handle a specific kind of task — git workflows, doc writing,
            running tests, etc. The CLI loads it on relevant turns only, so installing a dozen
            doesn't slow anything down.
          </div>
          <div className="text-[11px] text-ink-faint mt-1.5 font-mono">
            ~/.claude/skills/&lt;id&gt;/SKILL.md  ·  ~/.codex/skills/&lt;id&gt;/SKILL.md
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillRow({ entry }: { entry: CapabilityEntry }) {
  const remove = useStore((s) => s.removeInstalledSkill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRemove = async () => {
    if (!entry.path) return;
    if (!window.confirm(`Remove skill "${entry.name}"?\n\nThis deletes the skill directory from disk.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await remove(entry.path);
    if (!res.ok) setError(res.error);
    setBusy(false);
  };

  return (
    <div className="mb-2 p-3 rounded-md border border-card-strong bg-card hover:border-accent/40 transition-colors">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-medium text-ink">{entry.name}</div>
            {entry.pluginId && <Chip tone="plugin">{shortPluginId(entry.pluginId)}</Chip>}
            {entry.source !== 'plugin' && <Chip tone="source">{entry.source}</Chip>}
            {entry.clis.map((cli) => (
              <Chip key={cli} tone="cli">{CLI_LABEL[cli]}</Chip>
            ))}
          </div>
          {entry.description && (
            <div className="text-[11px] text-ink-muted mt-1 line-clamp-2">
              {entry.description}
            </div>
          )}
          {entry.path && (
            <div className="text-[10px] text-ink-faint mt-1 font-mono truncate" title={entry.path}>
              {entry.path}
            </div>
          )}
          {error && <div className="text-[11px] text-red-400 mt-1 font-mono">{error}</div>}
        </div>
        {entry.path && entry.source !== 'plugin' && (
          <button
            disabled={busy}
            onClick={() => void onRemove()}
            title="Remove skill"
            className="text-[10px] px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/5 disabled:opacity-50"
          >
            {busy ? '…' : 'Remove'}
          </button>
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

function MarketplaceSection({ query }: { query: string }) {
  const skills = useStore((s) => s.marketplaceSkills);
  const install = useStore((s) => s.installMarketplaceSkill);
  const uninstall = useStore((s) => s.uninstallMarketplaceSkill);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!skills) return [];
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  if (!skills) return null;

  const onToggle = async (skill: MarketplaceSkill, target: SkillTarget) => {
    setBusyId(`${skill.id}:${target}`);
    setError(null);
    const res = skill.installed[target]
      ? await uninstall(skill.id, [target])
      : await install(skill.id, [target]);
    if (!res.ok) setError(res.error);
    setBusyId(null);
  };

  const onInstallAll = async (skill: MarketplaceSkill) => {
    const missing = skill.targets.filter((t) => !skill.installed[t]);
    if (missing.length === 0) return;
    setBusyId(`${skill.id}:all`);
    setError(null);
    const res = await install(skill.id, missing);
    if (!res.ok) setError(res.error);
    setBusyId(null);
  };

  return (
    <div className="mt-6 pt-4 border-t border-card">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Recommended
        </div>
        <div className="text-[10px] text-ink-faint">
          {filtered.length} curated · Claude + Codex (Gemini not supported)
        </div>
      </div>
      {error && (
        <div className="mb-2 text-[11px] text-red-400 font-mono">{error}</div>
      )}
      {filtered.length === 0 ? (
        <div className="text-xs text-ink-faint py-2">No matching skills.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filtered.map((skill) => {
            const allInstalled = skill.targets.every((t) => skill.installed[t]);
            const anyInstalled = skill.targets.some((t) => skill.installed[t]);
            return (
              <div
                key={skill.id}
                className={
                  'p-3 rounded-md border transition-colors ' +
                  (anyInstalled
                    ? 'border-accent/30 bg-accent/5'
                    : 'border-card-strong bg-card hover:border-accent/40')
                }
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="text-sm font-medium text-ink truncate">{skill.name}</div>
                  {allInstalled ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30 shrink-0">
                      ✓ Installed
                    </span>
                  ) : !anyInstalled ? (
                    <button
                      disabled={busyId === `${skill.id}:all`}
                      onClick={() => void onInstallAll(skill)}
                      className="text-[10px] px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 shrink-0"
                    >
                      {busyId === `${skill.id}:all` ? '…' : 'Install'}
                    </button>
                  ) : null}
                </div>
                <div className="text-[11px] text-ink-muted line-clamp-2 mb-2 min-h-[2.2em]">
                  {skill.description}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {skill.targets.map((t) => {
                    const installed = !!skill.installed[t];
                    const busy = busyId === `${skill.id}:${t}`;
                    return (
                      <button
                        key={t}
                        disabled={busy}
                        onClick={() => void onToggle(skill, t)}
                        className={
                          'text-[10px] px-1.5 py-0.5 rounded border transition-colors ' +
                          (installed
                            ? 'bg-accent/10 text-accent border-accent/30 hover:bg-red-400/10 hover:text-red-400 hover:border-red-400/30'
                            : 'bg-transparent text-ink-faint border-card-strong hover:text-ink hover:bg-card-strong')
                        }
                        title={installed ? `Click to uninstall from ${CLI_LABEL[t]}` : `Click to install to ${CLI_LABEL[t]}`}
                      >
                        {busy ? '…' : (installed ? '✓ ' : '+ ') + CLI_LABEL[t]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
