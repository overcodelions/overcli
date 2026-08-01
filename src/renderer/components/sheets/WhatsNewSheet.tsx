import { useEffect, useState } from 'react';
import type { WhatsNewReport } from '../../../shared/types';
import { useStore } from '../../store';
import { Markdown } from '../Markdown';

// Release notes for the version(s) the user just moved onto, parsed from the
// CHANGELOG.md bundled with the app (see src/main/whatsNew.ts).
//
// Opens by itself on the first launch after an update — the update installs on
// quit, so the toast in UpdateToast.tsx fires while the user is still on the
// old build and is the wrong moment to describe what landed. Also reachable
// deliberately from About, in which case there may be nothing unread and the
// panel shows recent history instead.

const CHANGELOG_URL = 'https://github.com/overcodelions/overcli/blob/master/CHANGELOG.md';

// Section accents match the changelog's own vocabulary. Kept to the three
// headings the project actually writes, with a neutral fallback so a future
// "Removed" or "Security" section renders rather than crashing.
const SECTION_COLORS: Record<string, string> = {
  Added: '#36cfc9',
  Changed: '#5b9cff',
  Fixed: '#f59e0b',
};
const DEFAULT_SECTION_COLOR = '#b587ff';

export function WhatsNewSheet() {
  const close = useStore((s) => s.openSheet);
  const setUnseen = useStore((s) => s.setWhatsNewUnseen);
  const [report, setReport] = useState<WhatsNewReport | null>(null);

  useEffect(() => {
    // Opening the panel IS seeing it — mark on mount rather than on dismiss so
    // closing via the backdrop (which this sheet can't intercept) still counts.
    void window.overcli.invoke('app:whatsNew').then(setReport);
    void window.overcli.invoke('app:markWhatsNewSeen').then(() => setUnseen(false));
  }, [setUnseen]);

  const releases = report?.releases ?? [];

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="flex items-baseline gap-2.5 border-b border-card px-5 py-3">
        <div className="text-sm font-medium text-ink">What's new</div>
        {report && (
          <div className="rounded-full border border-card-strong bg-card/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
            v{report.currentVersion}
          </div>
        )}
      </div>

      <div className="overflow-y-auto px-5 py-4">
        {!report ? (
          <div className="py-6 text-xs text-ink-faint">Loading release notes…</div>
        ) : releases.length === 0 ? (
          <div className="py-6 text-xs text-ink-faint">
            No release notes for this build. The full changelog lives on GitHub.
          </div>
        ) : (
          releases.map((release) => (
            <section key={release.version} className="mb-6 last:mb-1">
              <div className="mb-3 flex items-baseline gap-2">
                <div className="text-[15px] font-semibold text-ink">{release.version}</div>
                {release.date && <div className="text-[11px] text-ink-faint">{release.date}</div>}
                <div className="ml-1 h-px flex-1 bg-card" />
              </div>

              {release.sections.map((section) => {
                const color = SECTION_COLORS[section.heading] ?? DEFAULT_SECTION_COLOR;
                return (
                  <div key={section.heading} className="mb-3.5 last:mb-0">
                    {section.heading && (
                      <span
                        className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-[0.14em]"
                        style={{ backgroundColor: `${color}24`, color }}
                      >
                        {section.heading}
                      </span>
                    )}
                    <ul className="mt-2 space-y-2">
                      {section.entries.map((entry, i) => (
                        <li key={i} className="flex gap-2.5">
                          <span
                            className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          {/* The changelog's own prose, links and bold lead-ins
                              intact. Markdown sanitizes; PR links leave for the
                              browser via main's will-navigate handler. */}
                          <div className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-ink-muted [&_strong]:text-ink">
                            <Markdown source={entry} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          ))
        )}

        {report && report.olderCount > 0 && (
          <div className="rounded-lg border border-card bg-card/40 px-3 py-2 text-[11px] text-ink-faint">
            {report.olderCount} older release{report.olderCount === 1 ? '' : 's'} not shown — see the
            full changelog.
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-card px-5 py-3">
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noreferrer"
          className="rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink"
        >
          Full changelog
        </a>
        <div className="flex-1" />
        <button
          onClick={() => close(null)}
          className="rounded-md bg-accent/80 px-3.5 py-1.5 text-[12px] font-medium text-ink hover:bg-accent"
        >
          Done
        </button>
      </div>
    </div>
  );
}
