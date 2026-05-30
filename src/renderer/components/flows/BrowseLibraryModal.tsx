import { useEffect, useMemo, useState } from 'react';
import type { FlowRegistryEntry } from '@shared/types';
import { useFlowsStore } from '../../flowsStore';

export function BrowseLibraryModal({ onClose }: { onClose: () => void }) {
  const { registryEntries, registryLoaded, registryErrors, browseRegistries, installFromRegistry } = useFlowsStore();
  const [installing, setInstalling] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return registryEntries;
    return registryEntries.filter((e) =>
      e.name.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }, [registryEntries, query]);

  useEffect(() => {
    void browseRegistries(false);
  }, [browseRegistries]);

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
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[760px] max-h-[80vh] overflow-hidden flex flex-col"
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

        <div className="px-5 py-3 border-b border-card">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, description, or tag (e.g. tickets, design, operations)"
            className="w-full text-sm bg-transparent border border-card rounded px-3 py-2 focus:outline-none focus:border-card-strong"
          />
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

          <div className="space-y-3">
            {filteredEntries.map((entry) => {
              const key = `${entry.registryId}:${entry.id}`;
              const isInstalling = installing === key;
              const isInstalled = installed.has(key);
              const error = installErrors[key];
              return (
                <div
                  key={key}
                  className="border border-card rounded-lg p-4 hover:border-card-strong transition-colors"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="font-semibold text-sm">{entry.name}</div>
                      {entry.description && (
                        <div className="text-xs text-ink-faint mt-1">{entry.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <span className="text-xs bg-card rounded px-2 py-1 text-ink-faint">
                        {entry.registryId}
                      </span>
                      <span className="text-xs text-ink-faint">{entry.version}</span>
                    </div>
                  </div>

                  {entry.tags && entry.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {entry.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs bg-white/5 border border-card rounded px-2 py-0.5"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    {entry.author && (
                      <div className="text-xs text-ink-faint">
                        by{' '}
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
                    )}
                    <button
                      onClick={() => handleInstall(entry)}
                      disabled={isInstalling || isInstalled}
                      className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-green-600 disabled:opacity-75 text-white transition-colors"
                    >
                      {isInstalling ? '…' : isInstalled ? '✓ Installed' : 'Install'}
                    </button>
                  </div>

                  {error && (
                    <div className="mt-2 text-xs text-red-600 bg-red-500/10 rounded px-2 py-1">
                      {error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
