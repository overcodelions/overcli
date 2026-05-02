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
  { key: 'command', label: 'Slash commands' },
  { key: 'plugin', label: 'Plugins' },
  { key: 'mcp', label: 'MCP servers' },
];

const CLI_LABEL: Record<Backend, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

// ---------- Skill catalog metadata ----------

type IconKey =
  | 'branch' | 'check' | 'flask' | 'doc' | 'image' | 'plug' | 'sparkles'
  | 'download' | 'book' | 'server' | 'chat' | 'terminal' | 'cloud' | 'figma'
  | 'design' | 'library' | 'wand' | 'tile';

interface SkillMeta {
  category: 'Workflow' | 'Build & Deploy' | 'Design' | 'Skills & Plugins' | 'Reference';
  color: string;
  icon: IconKey;
  featured?: boolean;
}

const SKILL_META: Record<string, SkillMeta> = {
  'git-helper':                       { category: 'Workflow',           color: '#5b9cff', icon: 'branch',   featured: true },
  'pr-reviewer':                      { category: 'Workflow',           color: '#b587ff', icon: 'check',    featured: true },
  'test-runner':                      { category: 'Workflow',           color: '#36cfc9', icon: 'flask',    featured: true },
  'doc-writer':                       { category: 'Workflow',           color: '#f59e0b', icon: 'doc',      featured: true },
  'cli-creator':                      { category: 'Build & Deploy',     color: '#a78bfa', icon: 'terminal' },
  'aspnet-core':                      { category: 'Build & Deploy',     color: '#5b9cff', icon: 'server' },
  'cloudflare-deploy':                { category: 'Build & Deploy',     color: '#fb923c', icon: 'cloud' },
  'chatgpt-apps':                     { category: 'Build & Deploy',     color: '#10b981', icon: 'chat' },
  'image-gen':                        { category: 'Design',             color: '#ec4899', icon: 'image' },
  'figma':                            { category: 'Design',             color: '#f24e1e', icon: 'figma' },
  'figma-code-connect-components':    { category: 'Design',             color: '#a259ff', icon: 'tile' },
  'figma-create-design-system-rules': { category: 'Design',             color: '#0acf83', icon: 'library' },
  'figma-create-new-file':            { category: 'Design',             color: '#1abcfe', icon: 'design' },
  'figma-generate-design':            { category: 'Design',             color: '#f24e1e', icon: 'wand' },
  'figma-generate-library':           { category: 'Design',             color: '#a259ff', icon: 'library' },
  'figma-implement-design':           { category: 'Design',             color: '#1abcfe', icon: 'design' },
  'skill-creator':                    { category: 'Skills & Plugins',   color: '#fbbf24', icon: 'sparkles' },
  'skill-installer':                  { category: 'Skills & Plugins',   color: '#36cfc9', icon: 'download' },
  'plugin-creator':                   { category: 'Skills & Plugins',   color: '#b587ff', icon: 'plug' },
  'openai-docs':                      { category: 'Reference',          color: '#94a3b8', icon: 'book' },
  'doc':                              { category: 'Reference',          color: '#5b9cff', icon: 'doc' },
};

const DEFAULT_META: SkillMeta = { category: 'Skills & Plugins', color: '#94a3b8', icon: 'sparkles' };

const CATEGORY_ORDER: SkillMeta['category'][] = [
  'Workflow',
  'Build & Deploy',
  'Design',
  'Skills & Plugins',
  'Reference',
];

function metaFor(skill: MarketplaceSkill): SkillMeta {
  return SKILL_META[skill.id] ?? DEFAULT_META;
}

// ---------- Sheet ----------

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
    <div className="flex h-full flex-col bg-surface-elevated">
      <Header
        tab={tab}
        setTab={setTab}
        counts={counts}
        query={query}
        setQuery={setQuery}
        onRescan={refresh}
      />

      <div className="flex-1 overflow-y-auto">
        {tab === 'skill' ? (
          <SkillsTab installed={filtered} query={query} loading={!capabilities} />
        ) : (
          <GenericTab tab={tab} entries={filtered} loading={!capabilities} />
        )}

        {capabilities?.warnings && capabilities.warnings.length > 0 && (
          <details className="mx-8 mb-6 mt-2 text-[10px] text-ink-faint">
            <summary className="cursor-pointer font-semibold text-ink-muted hover:text-ink">
              Scan warnings ({capabilities.warnings.length})
            </summary>
            <div className="mt-2 space-y-0.5">
              {capabilities.warnings.map((w) => (
                <div key={w} className="font-mono">{w}</div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// ---------- Header (title + tabs + search) ----------

function Header({
  tab,
  setTab,
  counts,
  query,
  setQuery,
  onRescan,
}: {
  tab: CapabilityKind;
  setTab: (t: CapabilityKind) => void;
  counts: Partial<Record<CapabilityKind, number>>;
  query: string;
  setQuery: (s: string) => void;
  onRescan: () => void;
}) {
  return (
    <div className="border-b border-card bg-gradient-to-b from-accent/8 via-accent/3 to-transparent px-8 pt-7 pb-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-[24px] font-bold tracking-tight text-ink">Extensions</div>
          <div className="text-[13px] text-ink-muted mt-1 max-w-[640px]">
            Curated skills, agents, slash commands, plugins, and MCP servers. Install with one click.
          </div>
        </div>
        <button
          onClick={() => void onRescan()}
          className="text-[11px] px-3 py-1.5 rounded-md border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong shrink-0"
        >
          Rescan disk
        </button>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <nav className="flex gap-1">
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = counts[t.key] ?? 0;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={
                  'text-[12.5px] px-3 py-1.5 rounded-md border transition-colors ' +
                  (active
                    ? 'border-accent/50 bg-accent/15 text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink hover:bg-card-strong/50')
                }
              >
                {t.label}
                <span
                  className={
                    'ml-1.5 text-[10px] tabular-nums ' +
                    (active ? 'text-accent' : 'text-ink-faint')
                  }
                >
                  {count}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="flex-1" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${TABS.find((t) => t.key === tab)?.label.toLowerCase()}…`}
          className="field w-[260px] px-3 py-1.5 text-[12px]"
        />
      </div>
    </div>
  );
}

// ---------- Skills tab (the main visual marketplace) ----------

function SkillsTab({
  installed,
  query,
  loading,
}: {
  installed: CapabilityEntry[];
  query: string;
  loading: boolean;
}) {
  return (
    <div className="px-8 py-6">
      {installed.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Installed" count={installed.length} />
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
            {installed.map((entry) => (
              <InstalledSkillCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}

      <Marketplace query={query} loading={loading} />
    </div>
  );
}

// ---------- Marketplace (visual) ----------

function Marketplace({ query, loading }: { query: string; loading: boolean }) {
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

  if (!skills) {
    return loading ? <div className="text-[12px] text-ink-faint">Loading catalog…</div> : null;
  }

  const onInstall = async (skill: MarketplaceSkill) => {
    const missing = skill.targets.filter((t) => !skill.installed[t]);
    if (missing.length === 0) return;
    setBusyId(`${skill.id}:all`);
    setError(null);
    const res = await install(skill.id, missing);
    if (!res.ok) setError(res.error);
    setBusyId(null);
  };

  const onToggle = async (skill: MarketplaceSkill, target: SkillTarget) => {
    setBusyId(`${skill.id}:${target}`);
    setError(null);
    const res = skill.installed[target]
      ? await uninstall(skill.id, [target])
      : await install(skill.id, [target]);
    if (!res.ok) setError(res.error);
    setBusyId(null);
  };

  const featured = filtered.filter((s) => metaFor(s).featured);
  const byCategory = new Map<SkillMeta['category'], MarketplaceSkill[]>();
  for (const s of filtered) {
    const cat = metaFor(s).category;
    const list = byCategory.get(cat) ?? [];
    list.push(s);
    byCategory.set(cat, list);
  }

  return (
    <div>
      <Hero totalCount={skills.length} />

      {error && (
        <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300 font-mono">
          {error}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="mt-8 text-[12px] text-ink-faint">No skills match "{query}".</div>
      )}

      {featured.length > 0 && (
        <section className="mt-8">
          <SectionHeader title="Featured" count={featured.length} />
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {featured.map((skill) => (
              <FeaturedCard
                key={skill.id}
                skill={skill}
                busyId={busyId}
                onInstall={onInstall}
                onToggle={onToggle}
              />
            ))}
          </div>
        </section>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const items = byCategory.get(cat) ?? [];
        if (items.length === 0) return null;
        const visible = items.filter((s) => !metaFor(s).featured || query.trim() !== '');
        if (visible.length === 0) return null;
        return (
          <section key={cat} className="mt-8">
            <SectionHeader title={cat} count={visible.length} />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {visible.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  busyId={busyId}
                  onInstall={onInstall}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </section>
        );
      })}

      <ManualInstallNote />
    </div>
  );
}

// ---------- Hero ----------

function Hero({ totalCount }: { totalCount: number }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-card bg-gradient-to-br from-accent/15 via-accent/5 to-transparent px-6 py-5">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-accent/15 blur-3xl" />
      <div className="pointer-events-none absolute -left-12 -bottom-16 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
      <div className="relative flex items-center justify-between gap-6">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
            Skill catalog
          </div>
          <div className="mt-1.5 text-[20px] font-semibold leading-tight text-ink">
            {totalCount} curated skills, ready to install
          </div>
          <div className="mt-1 text-[12.5px] text-ink-muted max-w-[520px]">
            Skills are small <code className="font-mono text-[11.5px]">SKILL.md</code> files that
            teach Claude or Codex how to handle specific tasks. They only load when relevant, so
            installing many doesn't slow anything down.
          </div>
        </div>
        <div className="hidden sm:flex shrink-0 items-center gap-1">
          <CliBadge label="Claude" />
          <span className="text-ink-faint">+</span>
          <CliBadge label="Codex" />
        </div>
      </div>
    </div>
  );
}

function CliBadge({ label }: { label: string }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-md border border-accent/30 bg-accent/10 text-accent font-medium">
      {label}
    </span>
  );
}

// ---------- Featured card (large, 2-col) ----------

function FeaturedCard({
  skill,
  busyId,
  onInstall,
  onToggle,
}: {
  skill: MarketplaceSkill;
  busyId: string | null;
  onInstall: (s: MarketplaceSkill) => void;
  onToggle: (s: MarketplaceSkill, t: SkillTarget) => void;
}) {
  const meta = metaFor(skill);
  const allInstalled = skill.targets.every((t) => skill.installed[t]);
  const anyInstalled = skill.targets.some((t) => skill.installed[t]);
  const installing = busyId === `${skill.id}:all`;

  return (
    <div
      className={
        'group relative overflow-hidden rounded-xl border p-4 transition-colors ' +
        (anyInstalled
          ? 'border-accent/40 bg-accent/5'
          : 'border-card bg-card/40 hover:border-card-strong')
      }
      style={{ boxShadow: `inset 0 1px 0 ${meta.color}1a` }}
    >
      <div
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full blur-3xl"
        style={{ backgroundColor: `${meta.color}26` }}
      />
      <div className="relative flex items-start gap-3.5">
        <IconTile color={meta.color} icon={meta.icon} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[14px] font-semibold text-ink truncate">{skill.name}</div>
            {allInstalled && <InstalledBadge />}
          </div>
          <div className="mt-1 text-[12px] text-ink-muted line-clamp-2 leading-snug">
            {skill.description}
          </div>
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            {!anyInstalled ? (
              <button
                disabled={installing}
                onClick={() => onInstall(skill)}
                className="text-[11.5px] px-3 py-1.5 rounded-md font-medium text-ink shadow-sm transition-colors"
                style={{ backgroundColor: meta.color }}
              >
                {installing ? 'Installing…' : `Install for ${skill.targets.map((t) => CLI_LABEL[t]).join(' + ')}`}
              </button>
            ) : (
              skill.targets.map((t) => (
                <TargetButton
                  key={t}
                  target={t}
                  installed={!!skill.installed[t]}
                  busy={busyId === `${skill.id}:${t}`}
                  onClick={() => onToggle(skill, t)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Standard card (3-col grid) ----------

function SkillCard({
  skill,
  busyId,
  onInstall,
  onToggle,
}: {
  skill: MarketplaceSkill;
  busyId: string | null;
  onInstall: (s: MarketplaceSkill) => void;
  onToggle: (s: MarketplaceSkill, t: SkillTarget) => void;
}) {
  const meta = metaFor(skill);
  const allInstalled = skill.targets.every((t) => skill.installed[t]);
  const anyInstalled = skill.targets.some((t) => skill.installed[t]);
  const installing = busyId === `${skill.id}:all`;

  return (
    <div
      className={
        'flex flex-col rounded-lg border p-3 transition-colors ' +
        (anyInstalled
          ? 'border-accent/30 bg-accent/[0.04]'
          : 'border-card bg-card/30 hover:border-card-strong')
      }
    >
      <div className="flex items-start gap-2.5">
        <IconTile color={meta.color} icon={meta.icon} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12.5px] font-semibold text-ink truncate">{skill.name}</div>
            {allInstalled && <InstalledBadge compact />}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-muted line-clamp-2 leading-snug">
            {skill.description}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
        {!anyInstalled ? (
          <button
            disabled={installing}
            onClick={() => onInstall(skill)}
            className="text-[11px] px-2.5 py-1 rounded-md border font-medium transition-colors"
            style={{
              borderColor: `${meta.color}66`,
              color: meta.color,
              backgroundColor: `${meta.color}1a`,
            }}
          >
            {installing ? '…' : 'Install'}
          </button>
        ) : (
          skill.targets.map((t) => (
            <TargetButton
              key={t}
              target={t}
              installed={!!skill.installed[t]}
              busy={busyId === `${skill.id}:${t}`}
              onClick={() => onToggle(skill, t)}
              compact
            />
          ))
        )}
      </div>
    </div>
  );
}

function TargetButton({
  target,
  installed,
  busy,
  onClick,
  compact,
}: {
  target: SkillTarget;
  installed: boolean;
  busy: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  const size = compact ? 'text-[10px] px-1.5 py-0.5' : 'text-[10.5px] px-2 py-1';
  return (
    <button
      disabled={busy}
      onClick={onClick}
      className={
        size + ' rounded border transition-colors ' +
        (installed
          ? 'bg-accent/10 text-accent border-accent/30 hover:bg-red-400/10 hover:text-red-400 hover:border-red-400/30'
          : 'bg-transparent text-ink-faint border-card-strong hover:text-ink hover:bg-card-strong')
      }
      title={installed ? `Remove from ${CLI_LABEL[target]}` : `Install for ${CLI_LABEL[target]}`}
    >
      {busy ? '…' : (installed ? '✓ ' : '+ ') + CLI_LABEL[target]}
    </button>
  );
}

function InstalledBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      className={
        'shrink-0 rounded border border-accent/30 bg-accent/10 text-accent font-medium ' +
        (compact ? 'text-[9px] px-1 py-0.5' : 'text-[10px] px-1.5 py-0.5')
      }
    >
      ✓ Installed
    </span>
  );
}

// ---------- Installed skill (compact row) ----------

function InstalledSkillCard({ entry }: { entry: CapabilityEntry }) {
  const remove = useStore((s) => s.removeInstalledSkill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = SKILL_META[entry.name] ?? DEFAULT_META;

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
    <div className="flex items-start gap-3 rounded-lg border border-card bg-card/40 p-3 hover:border-card-strong transition-colors">
      <IconTile color={meta.color} icon={meta.icon} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[12.5px] font-medium text-ink">{entry.name}</div>
          {entry.pluginId && <Chip tone="plugin">{shortPluginId(entry.pluginId)}</Chip>}
          {entry.clis.map((cli) => (
            <Chip key={cli} tone="cli">{CLI_LABEL[cli]}</Chip>
          ))}
        </div>
        {entry.description && (
          <div className="text-[11px] text-ink-muted mt-0.5 line-clamp-1 leading-snug">
            {entry.description}
          </div>
        )}
        {error && <div className="text-[11px] text-red-400 mt-1 font-mono">{error}</div>}
      </div>
      {entry.path && entry.source !== 'plugin' && (
        <button
          disabled={busy}
          onClick={() => void onRemove()}
          title="Remove skill"
          className="text-[10.5px] px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/5 disabled:opacity-50 shrink-0"
        >
          {busy ? '…' : 'Remove'}
        </button>
      )}
    </div>
  );
}

// ---------- Generic tab (agents / commands / plugins / mcp) ----------

function GenericTab({
  tab,
  entries,
  loading,
}: {
  tab: CapabilityKind;
  entries: CapabilityEntry[];
  loading: boolean;
}) {
  return (
    <div className="px-8 py-6">
      <InstallGuide tab={tab} hasInstalled={entries.length > 0} />

      {entries.length === 0 ? (
        <div className="mt-6 rounded-lg border border-card bg-card/30 px-5 py-6 text-center">
          <div className="text-[12.5px] text-ink-muted">
            {loading ? 'Scanning…' : emptyMessage(tab)}
          </div>
        </div>
      ) : (
        <section className="mt-6">
          <SectionHeader title="Installed" count={entries.length} />
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
            {entries.map((entry) => (
              <CapabilityRow key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- Per-tab install guide (for non-skill tabs) ----------

function InstallGuide({ tab, hasInstalled }: { tab: CapabilityKind; hasInstalled: boolean }) {
  const guide = GUIDES[tab];
  if (!guide) return null;
  return (
    <section className="rounded-xl border border-card bg-gradient-to-br from-accent/8 via-accent/3 to-transparent px-5 py-4">
      <div className="flex items-start gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${guide.color}22` }}
        >
          <SkillIcon icon={guide.icon} color={guide.color} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{guide.title}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-muted leading-snug">
            {hasInstalled ? guide.body : guide.bodyEmpty}
          </div>
          <dl className="mt-2.5 space-y-1">
            {guide.paths.map((p) => (
              <div key={p.label} className="flex items-baseline gap-2 text-[10.5px]">
                <dt className="w-[64px] shrink-0 text-ink-faint uppercase tracking-wider font-semibold">
                  {p.label}
                </dt>
                <dd className="font-mono text-ink-muted truncate" title={p.value}>{p.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

interface Guide {
  title: string;
  body: string;
  bodyEmpty: string;
  color: string;
  icon: IconKey;
  paths: Array<{ label: string; value: string }>;
}

const GUIDES: Partial<Record<CapabilityKind, Guide>> = {
  agent: {
    title: 'How to add a subagent',
    color: '#b587ff',
    icon: 'sparkles',
    body: 'Subagents are specialized assistants the main agent can delegate to (code review, search, planning). Add new ones by dropping a markdown file into the agents directory.',
    bodyEmpty: 'Subagents are specialized assistants the main agent can delegate to. None are installed yet — add a markdown file to the agents directory to define one.',
    paths: [
      { label: 'User',   value: '~/.claude/agents/<name>.md' },
      { label: 'Plugin', value: 'Bundled with installed plugins' },
    ],
  },
  command: {
    title: 'How to add a slash command',
    color: '#36cfc9',
    icon: 'terminal',
    body: 'Slash commands are reusable prompts you trigger by typing /name in the composer. Built-ins like /help appear after your first message.',
    bodyEmpty: 'Slash commands are reusable prompts you trigger by typing /name. Built-ins appear after your first message; user-defined ones live as markdown files.',
    paths: [
      { label: 'User',   value: '~/.claude/commands/<name>.md' },
      { label: 'Plugin', value: 'Type /plugins in any chat to install bundles that ship commands' },
    ],
  },
  plugin: {
    title: 'How to install a plugin',
    color: '#fbbf24',
    icon: 'plug',
    body: 'Plugins bundle skills, agents, slash commands, and MCP servers together. Install them from inside any Claude conversation.',
    bodyEmpty: "Plugins bundle skills, agents, slash commands, and MCP servers together. You don't have any installed yet.",
    paths: [
      { label: 'In-chat', value: 'Type /plugins in any Claude conversation, then choose a marketplace and install' },
      { label: 'Disk',    value: '~/.claude/plugins/installed_plugins.json' },
    ],
  },
  mcp: {
    title: 'How to add an MCP server',
    color: '#5b9cff',
    icon: 'server',
    body: 'MCP (Model Context Protocol) servers expose tools and data sources to the CLI — GitHub, Linear, Postgres, custom internal services. Configure once per CLI; reused across conversations.',
    bodyEmpty: 'MCP servers expose tools and data sources to the CLI. None are configured in any of your CLIs yet.',
    paths: [
      { label: 'Claude', value: '~/.claude/settings.json  →  mcpServers' },
      { label: 'Codex',  value: '~/.codex/config.toml  →  [mcp_servers.<name>]' },
      { label: 'Gemini', value: '~/.gemini/settings.json  →  mcpServers' },
    ],
  },
};

// ---------- Generic capability row ----------

function CapabilityRow({ entry }: { entry: CapabilityEntry }) {
  return (
    <div className="rounded-md border border-card bg-card/30 px-3 py-2.5 hover:border-card-strong transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-[12.5px] text-ink">
          {entry.kind === 'command' ? <span className="font-mono">/{entry.name}</span> : entry.name}
        </div>
        {entry.pluginId && <Chip tone="plugin">{shortPluginId(entry.pluginId)}</Chip>}
        {entry.source !== 'plugin' && <Chip tone="source">{entry.source}</Chip>}
        {entry.clis.map((cli) => (
          <Chip key={cli} tone="cli">{CLI_LABEL[cli]}</Chip>
        ))}
      </div>
      {entry.description && (
        <div className="text-[11px] text-ink-muted mt-0.5 line-clamp-2 leading-snug">
          {entry.description}
        </div>
      )}
      {entry.path && (
        <div className="text-[10px] text-ink-faint mt-1 font-mono truncate" title={entry.path}>
          {entry.path}
        </div>
      )}
    </div>
  );
}

// ---------- Manual install footnote (for skill tab) ----------

function ManualInstallNote() {
  return (
    <div className="mt-10 mb-2 rounded-lg border border-card bg-card/20 px-4 py-3 text-[11px] text-ink-muted">
      <span className="font-semibold text-ink">Want a skill not in the catalog?</span> Drop a{' '}
      <code className="font-mono">SKILL.md</code> into{' '}
      <code className="font-mono">~/.claude/skills/&lt;id&gt;/</code> or{' '}
      <code className="font-mono">~/.codex/skills/&lt;id&gt;/</code>, then click <em>Rescan disk</em>.
    </div>
  );
}

// ---------- Section header ----------

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
        {title}
        {typeof count === 'number' && (
          <span className="ml-1.5 text-ink-faint/70 tabular-nums">{count}</span>
        )}
      </div>
      <div className="h-px flex-1 bg-card" />
    </div>
  );
}

// ---------- Chip ----------

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

// ---------- Icon tile + SVG icons ----------

function IconTile({ color, icon, size }: { color: string; icon: IconKey; size: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}1f`,
        boxShadow: `inset 0 1px 0 ${color}33`,
      }}
    >
      <SkillIcon icon={icon} color={color} size={Math.round(size * 0.55)} />
    </div>
  );
}

function SkillIcon({ icon, color, size }: { icon: IconKey; color: string; size: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const };
  const sw = 1.8;

  switch (icon) {
    case 'branch':
      return (
        <svg {...common}>
          <circle cx="6" cy="5" r="2" stroke={color} strokeWidth={sw} />
          <circle cx="6" cy="19" r="2" stroke={color} strokeWidth={sw} />
          <circle cx="18" cy="9" r="2" stroke={color} strokeWidth={sw} />
          <path d="M6 7v10M6 13c4 0 8-1 8-4" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M4 12l5 5L20 6" stroke={color} strokeWidth={sw + 0.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'flask':
      return (
        <svg {...common}>
          <path d="M9 3h6M10 3v6L5 19a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 19l-5-10V3" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7.5 15h9" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'doc':
      return (
        <svg {...common}>
          <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <path d="M14 3v4h4M9 12h6M9 16h6" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke={color} strokeWidth={sw} />
          <circle cx="9" cy="10" r="1.5" fill={color} />
          <path d="M21 17l-5-5-8 8" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'plug':
      return (
        <svg {...common}>
          <path d="M9 4v4M15 4v4" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <rect x="6" y="8" width="12" height="6" rx="1.5" stroke={color} strokeWidth={sw} />
          <path d="M12 14v4M12 18a3 3 0 0 0 3 3" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'sparkles':
      return (
        <svg {...common}>
          <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <path d="M18 16l.8 2 2 .8-2 .8L18 22l-.8-2.4-2-.8 2-.8L18 16Z" fill={color} />
        </svg>
      );
    case 'download':
      return (
        <svg {...common}>
          <path d="M12 4v12M7 11l5 5 5-5" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 19h16" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'book':
      return (
        <svg {...common}>
          <path d="M5 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H5V4Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <path d="M19 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7V4Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'server':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="6" rx="1.5" stroke={color} strokeWidth={sw} />
          <rect x="4" y="14" width="16" height="6" rx="1.5" stroke={color} strokeWidth={sw} />
          <circle cx="8" cy="7" r="0.9" fill={color} />
          <circle cx="8" cy="17" r="0.9" fill={color} />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4V6a1 1 0 0 1 0-1Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'terminal':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke={color} strokeWidth={sw} />
          <path d="M7 10l3 2-3 2M13 14h4" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'cloud':
      return (
        <svg {...common}>
          <path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 11a3.5 3.5 0 0 1 0 7H7Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'figma':
      return (
        <svg {...common}>
          <path d="M8 3h4v6H8a3 3 0 1 1 0-6Z" stroke={color} strokeWidth={sw} />
          <path d="M12 3h4a3 3 0 1 1 0 6h-4V3Z" stroke={color} strokeWidth={sw} />
          <path d="M8 9h4v6H8a3 3 0 1 1 0-6Z" stroke={color} strokeWidth={sw} />
          <circle cx="15" cy="12" r="3" stroke={color} strokeWidth={sw} />
          <path d="M8 15h4v3a3 3 0 1 1-3-3h-1Z" stroke={color} strokeWidth={sw} />
        </svg>
      );
    case 'design':
      return (
        <svg {...common}>
          <path d="M4 20l4-1 11-11-3-3L5 16l-1 4Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <path d="M14 6l3 3" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'library':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="4" height="16" rx="1" stroke={color} strokeWidth={sw} />
          <rect x="10" y="4" width="4" height="16" rx="1" stroke={color} strokeWidth={sw} />
          <rect x="16" y="6" width="4" height="14" rx="1" stroke={color} strokeWidth={sw} transform="rotate(8 18 13)" />
        </svg>
      );
    case 'wand':
      return (
        <svg {...common}>
          <path d="M5 19l11-11M14 6l4 4" stroke={color} strokeWidth={sw + 0.2} strokeLinecap="round" />
          <path d="M18 4l.7 1.6L20 6l-1.3.4L18 8l-.7-1.6L16 6l1.3-.4L18 4Z" fill={color} />
          <path d="M6 11l.5 1.2L7.7 13 6.5 13.5 6 15l-.5-1.5L4 13l1.5-.8L6 11Z" fill={color} />
        </svg>
      );
    case 'tile':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="7" height="7" rx="1.2" stroke={color} strokeWidth={sw} />
          <rect x="13" y="4" width="7" height="7" rx="1.2" stroke={color} strokeWidth={sw} />
          <rect x="4" y="13" width="7" height="7" rx="1.2" stroke={color} strokeWidth={sw} />
          <rect x="13" y="13" width="7" height="7" rx="1.2" stroke={color} strokeWidth={sw} />
        </svg>
      );
  }
}

// ---------- Helpers ----------

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

function emptyMessage(tab: CapabilityKind): string {
  switch (tab) {
    case 'skill':   return 'No skills installed.';
    case 'agent':   return 'No subagents found in any of your CLIs.';
    case 'command': return 'No slash commands yet. Built-ins appear after sending a first message.';
    case 'plugin':  return 'No plugins installed.';
    case 'mcp':     return 'No MCP servers configured.';
  }
}
