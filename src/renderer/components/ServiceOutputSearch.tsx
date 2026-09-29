// Search the output of every service at once.
//
// A problem in a stack rarely stays in the service that has it: checkout
// times out because pricing is slow because the database refused a
// connection. Finding that meant opening each service's output in turn and
// typing the same search into each one. This is that search, once, across all
// of them — grouped by service, and a click opens the service with its own
// output already searched for the same thing.

import { useEffect, useMemo, useRef, useState } from 'react';

import { lineAtLevel, outputLineLevel, type OutputLevel, type OutputMatch } from '@shared/services';
import { isServiceLive, logKey, useServicesStore } from '../servicesStore';

type Level = OutputLevel;

/// While the query stands, recent output keeps arriving; re-asking this often
/// keeps the results live without a search per line.
const REFRESH_MS = 3000;
const DEBOUNCE_MS = 200;

/// Kept for the session, so flipping back to the service list and returning
/// does not lose the search.
let lastQuery = '';
let lastLevel: Level = 'all';
let lastFiles = false;

export const levelOf = outputLineLevel;

/// The line cut to show its match: long lines keep a little lead-in rather
/// than the start, which for a JVM line is a timestamp and a thread name.
export function snippet(text: string, query: string): { pre: string; match: string; post: string } {
  const i = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (i < 0 || !query.trim()) return { pre: text, match: '', post: '' };
  const end = i + query.trim().length;
  const lead = i > 40 ? '…' + text.slice(i - 30, i) : text.slice(0, i);
  return { pre: lead, match: text.slice(i, end), post: text.slice(end) };
}

export function ServiceOutputSearch({ owners }: { owners: { id: string; name: string }[] }) {
  const stacks = useServicesStore((s) => s.stacks);
  const seekOutput = useServicesStore((s) => s.seekOutput);
  const [query, setQuery] = useState(lastQuery);
  const [level, setLevel] = useState<Level>(lastLevel);
  const [files, setFiles] = useState(lastFiles);
  const [results, setResults] = useState<OutputMatch[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  lastQuery = query;
  lastLevel = level;
  lastFiles = files;

  const workspaceIds = useMemo(() => owners.map((o) => o.id), [owners]);
  const running = Object.values(stacks)
    .flatMap((s) => s.runtimes)
    .filter((r) => isServiceLive(r.status)).length;

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Ask main, debounced, and again every few seconds while the query stands:
  // recent output keeps arriving. Only the newest answer is kept.
  const asked = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const run = async () => {
      const id = ++asked.current;
      const found = await window.overcli.invoke('services:searchOutput', {
        workspaceIds,
        query: q,
        includeFiles: files,
        level,
      });
      if (id === asked.current) setResults(found);
    };
    const first = window.setTimeout(() => void run(), DEBOUNCE_MS);
    const again = files ? undefined : window.setInterval(() => void run(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      if (again) window.clearInterval(again);
    };
  }, [query, files, level, workspaceIds]);

  const groups = useMemo(() => {
    // Main already filtered by level; this only covers the moment between
    // switching the level and its answer arriving.
    const shown = (results ?? []).filter((m) => lineAtLevel(m.text, level));
    const out: { key: string; workspaceId: string; serviceId: string; matches: OutputMatch[] }[] = [];
    const byKey = new Map<string, (typeof out)[number]>();
    for (const m of shown) {
      const key = logKey(m.workspaceId, m.serviceId);
      let group = byKey.get(key);
      if (!group) {
        group = { key, workspaceId: m.workspaceId, serviceId: m.serviceId, matches: [] };
        byKey.set(key, group);
        out.push(group);
      }
      group.matches.push(m);
    }
    return out;
  }, [results, level]);
  const total = groups.reduce((n, g) => n + g.matches.length, 0);
  const q = query.trim();

  return (
    <>
      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-card px-2.5 pb-2 pt-2">
        <label className="flex h-[28px] items-center gap-1.5 rounded-md border border-accent/40 bg-card px-2">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="flex-shrink-0 text-accent">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={files ? 'Search every service’s log file' : 'Search output of every running service'}
            aria-label="Search the output of every service"
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:font-sans placeholder:text-ink-faint"
          />
          {q && results && (
            <span className="flex-shrink-0 text-[10.5px] text-ink-faint">
              {total} in {groups.length}
            </span>
          )}
        </label>
        <div className="flex items-center gap-1">
          {(['all', 'warn', 'error'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              aria-pressed={level === l}
              className={
                'h-[22px] rounded px-2 text-[11px] ' +
                (level === l ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
              }
            >
              {l === 'all' ? 'All' : l === 'warn' ? 'WARN+' : 'ERROR'}
            </button>
          ))}
          <span className="flex-1" />
          <button
            onClick={() => setFiles((f) => !f)}
            aria-pressed={files}
            title="Search each service's log file instead: output from before the app opened, past what the pane keeps, and services that are stopped"
            className={
              'h-[22px] rounded px-2 text-[11px] ' +
              (files ? 'bg-green-500/15 text-green-700 dark:text-green-300' : 'text-ink-faint hover:text-ink')
            }
          >
            {files ? '✓ Log files' : 'Include log files'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {!q ? (
          <p className="px-2 py-4 text-[11.5px] leading-relaxed text-ink-faint">
            Type to search what every running service has printed — an error, an order number, a port.
            Results are grouped by service; opening one shows that service’s output, searched for the same
            thing.
          </p>
        ) : results && total === 0 ? (
          <p className="px-2 py-4 text-[11.5px] leading-relaxed text-ink-faint">
            Nothing {files ? 'in any log file' : 'in the recent output of any service'} matches “{q}”.
            {!files && ' Include log files to look further back.'}
          </p>
        ) : (
          groups.map((group) => {
            const stack = stacks[group.workspaceId];
            const spec = stack?.services.find((s) => s.id === group.serviceId);
            const runtime = stack?.runtimes.find((r) => r.serviceId === group.serviceId);
            const live = runtime ? isServiceLive(runtime.status) : false;
            return (
              <div key={group.key} className="mt-2">
                <div className="flex h-[24px] items-center gap-2 px-2">
                  <span
                    aria-hidden
                    className={
                      'h-1.5 w-1.5 flex-shrink-0 rounded-full ' +
                      (live ? 'bg-green-500 dark:bg-green-400' : 'bg-card-border-strong')
                    }
                  />
                  <span className="min-w-0 truncate text-[12px] font-medium">{spec?.name ?? group.serviceId}</span>
                  {runtime?.port !== undefined && (
                    <span className="flex-shrink-0 font-mono text-[10.5px] text-ink-faint">:{runtime.port}</span>
                  )}
                  <span className="flex-1" />
                  <span className="flex-shrink-0 text-[10.5px] text-ink-faint">
                    {group.matches.length === 1 ? '1 match' : `${group.matches.length} matches`}
                  </span>
                </div>
                {group.matches.map((m) => {
                  const key = `${group.key}:${m.source}:${m.index}`;
                  const cut = snippet(m.text, q);
                  const l = levelOf(m.text);
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setPicked(key);
                        void seekOutput(m.workspaceId, m.serviceId, q);
                      }}
                      title={m.text}
                      className={
                        'flex w-full items-baseline gap-2 rounded py-1 pl-5 pr-2 text-left hover:bg-card-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
                        (picked === key ? 'bg-accent/15' : '')
                      }
                    >
                      {m.at && (
                        <span className="w-[52px] flex-shrink-0 font-mono text-[10px] text-ink-faint">
                          {new Date(m.at).toLocaleTimeString(undefined, { hour12: false })}
                        </span>
                      )}
                      {l && (
                        <span
                          className={
                            'w-[34px] flex-shrink-0 font-mono text-[10px] ' +
                            (l === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')
                          }
                        >
                          {l === 'error' ? 'ERROR' : 'WARN'}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
                        {cut.pre}
                        {cut.match && (
                          <mark className="rounded-sm bg-amber-400/30 px-px text-ink">{cut.match}</mark>
                        )}
                        {cut.post}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      <div className="flex h-[26px] flex-shrink-0 items-center border-t border-card px-3 text-[10.5px] text-ink-faint">
        {files
          ? 'Each service’s log file, newest 4 MB'
          : `Recent output · ${running} running`}
      </div>
    </>
  );
}
