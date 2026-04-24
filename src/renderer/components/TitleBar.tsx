import { useStore } from '../store';

/// Custom title bar region. `hiddenInset` window style shows the traffic
/// lights overlaid on our content; pad the left enough to clear them and
/// leave breathing room before the sidebar toggle.
export function TitleBar() {
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const detailMode = useStore((s) => s.detailMode);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const openSheet = useStore((s) => s.openSheet);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const isMac = platform.toLowerCase().includes('mac');
  const leadingInsetClass = isMac ? 'pl-[92px]' : 'pl-2';
  return (
    <div className={`draggable flex items-center h-[38px] ${leadingInsetClass} pr-3 bg-surface border-b border-card select-none`}>
      <button
        onClick={toggleSidebar}
        className="no-drag p-1 mr-2 text-ink-muted hover:text-ink rounded hover:bg-card-strong"
        title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" />
          <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" />
        </svg>
      </button>
      <div className="flex items-center gap-1 no-drag">
        <NavButton label="Chat" active={detailMode === 'conversation'} onClick={() => setDetailMode('conversation')} />
        <NavButton label="Local" active={detailMode === 'local'} onClick={() => setDetailMode('local')} />
        <NavButton label="Usage" active={detailMode === 'stats'} onClick={() => setDetailMode('stats')} />
      </div>
      <div className="flex-1" />
      <button
        onClick={() => openSheet({ type: 'about' })}
        className="no-drag p-1 mr-1 text-ink-muted hover:text-ink rounded hover:bg-card-strong"
        title="About overcli"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 8v5" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="10" cy="5.5" r="0.9" fill="currentColor" />
        </svg>
      </button>
      <button
        onClick={() => openSheet({ type: 'settings' })}
        className="no-drag p-1 text-ink-muted hover:text-ink rounded hover:bg-card-strong"
        title="Settings (⌘,)"
      >
        {/* Clean 8-tooth gear. Previous icon had too many sub-paths at
            16px and rendered fuzzy; this one uses a single stroked path
            plus a center hole so it crisps at display resolution. */}
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path
            d="M10 2.5 11 4.3a6 6 0 0 1 1.4.6L14.3 4l1.7 1.7-.9 1.9a6 6 0 0 1 .6 1.4L17.5 10l-1.8 1a6 6 0 0 1-.6 1.4l.9 1.9L14.3 16l-1.9-.9a6 6 0 0 1-1.4.6L10 17.5l-1-1.8a6 6 0 0 1-1.4-.6L5.7 16 4 14.3l.9-1.9a6 6 0 0 1-.6-1.4L2.5 10l1.8-1a6 6 0 0 1 .6-1.4L4 5.7 5.7 4l1.9.9A6 6 0 0 1 9 4.3L10 2.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </div>
  );
}

function NavButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-1 rounded-md text-xs font-medium ' +
        (active
          ? 'bg-white/10 text-ink'
          : 'text-ink-muted hover:text-ink hover:bg-card-strong')
      }
    >
      {label}
    </button>
  );
}
