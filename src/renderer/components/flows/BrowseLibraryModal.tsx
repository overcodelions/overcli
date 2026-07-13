import { useEffect, useMemo, useState } from 'react';
import type { FlowRegistryEntry } from '@shared/types';
import { resolveStepModel, type Flow, type FlowStep } from '@shared/flows/schema';
import { useFlowsStore } from '../../flowsStore';
import { TAG_AXES } from '@shared/flows/tagTaxonomy';

export function BrowseLibraryModal({ onClose }: { onClose: () => void }) {
  const { registryEntries, registryLoaded, registryErrors, browseRegistries, installFromRegistry, previewRegistryFlow } = useFlowsStore();
  const [installing, setInstalling] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return registryEntries.filter((e) => {
      if (selectedTags.size > 0) {
        const tags = new Set(e.tags ?? []);
        for (const t of selectedTags) if (!tags.has(t)) return false;
      }
      if (!q) return true;
      return e.name.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q));
    });
  }, [registryEntries, query, selectedTags]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of registryEntries) for (const t of (e.tags ?? [])) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [registryEntries]);

  useEffect(() => {
    void browseRegistries(false);
  }, [browseRegistries]);

  useEffect(() => {
    if (filteredEntries.length === 0) {
      setSelectedKey(null);
      return;
    }
    const stillVisible = selectedKey && filteredEntries.some((e) => `${e.registryId}:${e.id}` === selectedKey);
    if (!stillVisible) {
      const first = filteredEntries[0];
      setSelectedKey(`${first.registryId}:${first.id}`);
    }
  }, [filteredEntries, selectedKey]);

  const selectedEntry = useMemo(
    () => filteredEntries.find((e) => `${e.registryId}:${e.id}` === selectedKey) ?? null,
    [filteredEntries, selectedKey]
  );

  async function handleInstall(entry: FlowRegistryEntry) {
    const key = `${entry.registryId}:${entry.id}`;
    setInstalling(key);
    const result = await installFromRegistry({
      registryId: entry.registryId,
      id: entry.id,
      version: entry.version,
    });
    setInstalling(null);
    if (!result.ok) {
      setInstallErrors((prev) => ({ ...prev, [key]: result.error || 'Install failed' }));
    } else {
      setInstalled((prev) => new Set([...prev, key]));
      setInstallErrors((prev) => {
        const { [key]: _, ...rest } = prev;
        return rest;
      });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[1240px] h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-card">
          <div className="text-lg font-semibold">Browse library</div>
          <button
            onClick={() => browseRegistries(true)}
            className="ml-auto text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
            disabled={!registryLoaded}
          >
            ↻ Refresh
          </button>
          <button
            onClick={onClose}
            className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-[220px] flex-shrink-0 border-r border-card px-3 py-4 overflow-y-auto">
            {TAG_AXES.map((axis) => (
              <div key={axis.axis} className="mb-5">
                <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-2">{axis.axis}</div>
                <div className="flex flex-col gap-1">
                  {axis.tags.filter((tag) => (tagCounts.get(tag) ?? 0) > 0).map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setSelectedTags((prev) => {
                        const n = new Set(prev);
                        if (n.has(tag)) n.delete(tag); else n.add(tag);
                        return n;
                      })}
                      className={'w-full text-left text-xs px-2 py-1 rounded flex items-center justify-between ' +
                        (selectedTags.has(tag) ? 'bg-accent/30 text-accent' : 'text-ink-muted hover:bg-white/5')}
                    >
                      <span>{tag}</span>
                      <span className="text-[10px] text-ink-faint">{tagCounts.get(tag)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-5 py-3 border-b border-card">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, description, or tag (e.g. tickets, design, operations)"
                className="w-full text-sm bg-transparent border border-card rounded px-3 py-2 focus:outline-none focus:border-card-strong"
              />
              {selectedTags.size > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 items-center">
                  {Array.from(selectedTags).map((tag) => (
                    <div key={tag} className="inline-flex items-center gap-1 bg-accent/20 text-accent text-xs px-2 py-1 rounded">
                      <span>{tag}</span>
                      <button
                        onClick={() => setSelectedTags((prev) => {
                          const n = new Set(prev);
                          n.delete(tag);
                          return n;
                        })}
                        className="text-accent/70 hover:text-accent"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setSelectedTags(new Set())}
                    className="text-xs text-ink-faint hover:text-ink px-2 py-1"
                  >
                    clear all
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5">
          {!registryLoaded && (
            <div className="text-center text-ink-faint py-8">Loading flows...</div>
          )}

          {registryErrors.length > 0 && (
            <div className="bg-yellow-500/10 border border-yellow-600/20 rounded px-3 py-2 mb-4 text-xs">
              <div className="text-yellow-700 font-semibold mb-1">Registry errors:</div>
              <div className="text-yellow-600">
                {registryErrors.map((e) => (
                  <div key={e.registryId}>{e.registryId}: {e.error}</div>
                ))}
              </div>
            </div>
          )}

          {registryLoaded && filteredEntries.length === 0 && (
            <div className="text-center text-ink-faint py-8">No flows available</div>
          )}

          <div className="space-y-2">
            {filteredEntries.map((entry) => {
              const key = `${entry.registryId}:${entry.id}`;
              const isInstalled = installed.has(key);
              const isSelected = selectedKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  className={
                    'w-full text-left border rounded-lg px-3 py-2.5 transition-colors ' +
                    (isSelected
                      ? 'border-accent/60 bg-accent/10'
                      : 'border-card bg-transparent hover:bg-white/[0.04] hover:border-card-strong')
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-sm truncate">{entry.name}</div>
                        {isInstalled && (
                          <span className="text-[10px] text-green-500 flex-shrink-0">✓ installed</span>
                        )}
                      </div>
                      {entry.description && (
                        <div className="text-xs text-ink-faint mt-0.5 line-clamp-1">{entry.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px] text-ink-faint">
                      <span className="bg-card rounded px-1.5 py-0.5">{entry.registryId}</span>
                      <span>{entry.version}</span>
                    </div>
                  </div>
                </button>
              );
            })}
            </div>
          </div>
          </div>

          {selectedEntry ? (
            <PreviewPane
              entry={selectedEntry}
              installing={installing === `${selectedEntry.registryId}:${selectedEntry.id}`}
              installed={installed.has(`${selectedEntry.registryId}:${selectedEntry.id}`)}
              error={installErrors[`${selectedEntry.registryId}:${selectedEntry.id}`]}
              onInstall={() => handleInstall(selectedEntry)}
              fetchFlow={previewRegistryFlow}
              onTagClick={(tag) => setSelectedTags((prev) => {
                const n = new Set(prev);
                if (n.has(tag)) n.delete(tag); else n.add(tag);
                return n;
              })}
            />
          ) : (
            <div className="w-[360px] flex-shrink-0 border-l border-card flex items-center justify-center text-xs text-ink-faint p-6 text-center">
              Select a flow to preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewPane({
  entry,
  installing,
  installed,
  error,
  onInstall,
  onTagClick,
  fetchFlow,
}: {
  entry: FlowRegistryEntry;
  installing: boolean;
  installed: boolean;
  error?: string;
  onInstall: () => void;
  onTagClick: (tag: string) => void;
  fetchFlow: (args: { registryId: string; id: string; version: string }) => Promise<{ ok: true; flow: Flow } | { ok: false; error: string }>;
}) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [loadingFlow, setLoadingFlow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFlow(null);
    setFlowError(null);
    setLoadingFlow(true);
    fetchFlow({ registryId: entry.registryId, id: entry.id, version: entry.version }).then((res) => {
      if (cancelled) return;
      setLoadingFlow(false);
      if (res.ok) setFlow(res.flow);
      else setFlowError(res.error);
    });
    return () => { cancelled = true; };
  }, [entry.registryId, entry.id, entry.version, fetchFlow]);

  return (
    <div className="w-[360px] flex-shrink-0 border-l border-card flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-5">
        <div className="text-lg font-semibold leading-tight">{entry.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="bg-card rounded px-1.5 py-0.5">{entry.registryId}</span>
          <span>v{entry.version}</span>
          {/* Local registries only. overcli never pulls the folder, so the
              file's mtime is the only freshness signal it can honestly give. */}
          {entry.updatedAt != null && (
            <span title={new Date(entry.updatedAt).toLocaleString()}>
              · updated {new Date(entry.updatedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {entry.description && (
          <div className="mt-4 text-sm text-ink-muted leading-relaxed">{entry.description}</div>
        )}

        <div className="mt-5">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-2">Pipeline</div>
          {loadingFlow && (
            <div className="text-xs text-ink-faint py-3">Loading…</div>
          )}
          {flowError && (
            <div className="text-xs text-red-600 bg-red-500/10 rounded px-2 py-1.5">
              Could not load pipeline: {flowError}
            </div>
          )}
          {flow && <VerticalPipeline flow={flow} />}
        </div>

        {entry.tags && entry.tags.length > 0 && (
          <div className="mt-5">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-2">Tags</div>
            <div className="flex flex-wrap gap-1">
              {entry.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onTagClick(tag)}
                  className="text-xs bg-white/5 border border-card rounded px-2 py-0.5 hover:bg-white/10 hover:border-card-strong"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        {entry.author && (
          <div className="mt-5">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-1">Author</div>
            <div className="text-xs text-ink-muted">
              {entry.author.url ? (
                <a
                  href={entry.author.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  {entry.author.name}
                </a>
              ) : (
                entry.author.name
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-card p-4 space-y-2">
        {error && (
          <div className="text-xs text-red-600 bg-red-500/10 rounded px-2 py-1">{error}</div>
        )}
        <button
          onClick={onInstall}
          disabled={installing || installed}
          className="w-full text-sm px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-green-600 disabled:opacity-75 text-white transition-colors font-medium"
        >
          {installing ? 'Installing…' : installed ? '✓ Installed' : 'Install flow'}
        </button>
      </div>
    </div>
  );
}

const TIER_COLOR: Record<string, string> = {
  premium: 'border-sky-400/60 bg-sky-500/15 text-sky-800 dark:text-sky-100',
  local: 'border-emerald-400/60 bg-emerald-500/15 text-emerald-800 dark:text-emerald-100',
  other: 'border-card-strong bg-card text-ink',
};

function tierOf(flow: Flow, step: FlowStep): keyof typeof TIER_COLOR {
  const { backend } = resolveStepModel(flow, step);
  if (backend === 'ollama') return 'local';
  if (backend === 'claude' || backend === 'codex' || backend === 'gemini' || backend === 'copilot') return 'premium';
  return 'other';
}

function compactModel(flow: Flow, step: FlowStep): string {
  const m = resolveStepModel(flow, step).model;
  if (!m) return '(no model)';
  if (m.startsWith('claude-')) {
    return m.replace('claude-', '').replace(/(\d)-(\d)/g, '$1.$2').replace(/-/g, ' ');
  }
  if (m.includes(':')) return m.split(':')[0];
  return m;
}

function VerticalPipeline({ flow }: { flow: Flow }) {
  if (flow.steps.length === 0) {
    return (
      <div className="rounded border border-dashed border-card-strong p-3 text-xs text-ink-faint text-center">
        (no steps)
      </div>
    );
  }
  return (
    <div className="flex flex-col items-stretch">
      <div className="rounded-md border border-card bg-card/40 px-3 py-2 text-[11px] text-ink-faint text-center">
        user prompt
      </div>
      {flow.steps.map((step, idx) => {
        const tier = tierOf(flow, step);
        const isLast = idx === flow.steps.length - 1;
        return (
          <div key={step.id} className="flex flex-col items-stretch">
            <DownArrow label={step.inputs.find((i) => i !== 'user_prompt')} />
            <div className={'rounded-lg border px-3 py-2 shadow-sm ' + TIER_COLOR[tier]}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-xs flex items-center gap-1.5">
                  {step.pauseBefore && <span className="text-amber-500 text-[10px]" title="pauses before">⏸</span>}
                  <span>{step.id}</span>
                  {step.rebound && <span className="text-purple-500 text-[10px]" title="rebound critic loop">↻</span>}
                </div>
                <div className="text-[10px] uppercase tracking-wider opacity-70">{step.role}</div>
              </div>
              <div className="text-[10px] opacity-80 mt-0.5">{compactModel(flow, step)}</div>
            </div>
            {isLast && step.output && (
              <>
                <DownArrow label={step.output} />
                <div className="rounded-md border border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200 px-3 py-2 text-[11px] text-center">
                  {step.output}
                </div>
              </>
            )}
          </div>
        );
      })}
      <RetryEdges flow={flow} />
    </div>
  );
}

function DownArrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1">
      <svg width="14" height="18" viewBox="0 0 14 18" className="text-ink-faint">
        <path d="M7 0 V14" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3 11 L7 15 L11 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
      {label && <span className="text-[9px] font-mono text-ink-faint leading-none mt-0.5">{label}</span>}
    </div>
  );
}

function RetryEdges({ flow }: { flow: Flow }) {
  const edges = flow.steps
    .filter((s) => s.onFail?.action === 'goto' && (s.onFail as { target?: string }).target)
    .map((s) => ({ from: s.id, to: (s.onFail as { action: 'goto'; target: string }).target }));
  if (edges.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-1">
      {edges.map((e) => (
        <div key={`${e.from}-${e.to}`} className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
          if <span className="font-mono">{e.from}</span> fails → retry <span className="font-mono">{e.to}</span>
        </div>
      ))}
    </div>
  );
}
