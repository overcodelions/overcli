import { useStore } from '../../store';

const FEATURES = [
  {
    icon: 'rectangle.stack',
    color: '#5b9cff',
    title: 'Multi-project workspaces',
    body:
      'Organize projects in the sidebar, each rooted at a directory. Switch between them without losing conversation state. Workspaces span multiple projects for cross-repo questions.',
  },
  {
    icon: 'arrow.triangle.branch',
    color: '#36cfc9',
    title: 'Multi-agent worktrees',
    body:
      'Spin up parallel agent sessions against the same repo, each in its own git worktree on its own branch. Watch them work side-by-side and merge back via PR.',
  },
  {
    icon: 'trophy',
    color: '#f59e0b',
    title: 'Agent Colosseum',
    body:
      'Race multiple agents on the same task, each in its own worktree. Compare diffs side-by-side and pick a winner to merge.',
  },
  {
    icon: 'sparkles.rectangle.stack.fill',
    color: '#b587ff',
    title: 'Rebound — AI reviewing AI',
    body:
      'A second model reviews each primary turn, catching mistakes and flagging issues. In Collab mode the two models bounce ideas back and forth across multiple rounds.',
  },
  {
    icon: 'chart.bar.fill',
    color: '#5b9cff',
    title: 'Stats dashboard',
    body:
      'Per-project and cross-project cost, token, and cache tracking broken down by model. Live rate-limit meter and context-window usage bars.',
  },
  {
    icon: 'cpu',
    color: '#36cfc9',
    title: 'Multi-backend',
    body:
      'Switch between Claude, Codex, Gemini, and local Ollama models as your primary agent. Available backends can also serve as reviewers.',
  },
] as const;

export function AboutSheet() {
  const close = useStore((s) => s.openSheet);

  return (
    <div className="flex h-[660px] flex-col bg-surface-elevated">
      <div className="flex items-center gap-5 border-b border-card px-7 py-7 bg-gradient-to-b from-accent/10 to-transparent">
        <AppMark />
        <div className="min-w-0 flex-1">
          <div className="text-[32px] font-bold leading-none text-ink">Overcli</div>
          <div className="mt-2 text-lg text-ink-muted">
            A desktop interface for AI coding agents.
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="grid grid-cols-2 gap-4">
          {FEATURES.map((feature) => (
            <FeatureCard
              key={feature.title}
              icon={feature.icon}
              color={feature.color}
              title={feature.title}
              body={feature.body}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center border-t border-card px-5 py-3">
        <div className="text-xs text-ink-faint">Connects to your existing CLI — no API keys.</div>
        <div className="flex-1" />
        <button
          onClick={() => close(null)}
          className="rounded-md px-3 py-1.5 text-xs text-ink-muted hover:bg-card-strong hover:text-ink"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function AppMark() {
  return (
    <div className="flex h-[84px] w-[84px] items-center justify-center rounded-[22px] border border-card-strong bg-gradient-to-br from-accent/45 to-accent/10 shadow-[0_10px_24px_rgba(0,0,0,0.2)]">
      <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
        <rect x="7" y="9" width="21" height="5" rx="2" fill="currentColor" className="text-ink" />
        <rect x="7" y="18" width="27" height="5" rx="2" fill="currentColor" className="text-ink/80" />
        <rect x="7" y="27" width="16" height="5" rx="2" fill="currentColor" className="text-ink/60" />
        <path
          d="M30 25.5 35 28l-5 2.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent"
        />
      </svg>
    </div>
  );
}

function FeatureCard({
  icon,
  color,
  title,
  body,
}: {
  icon: string;
  color: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex min-h-[170px] flex-col rounded-2xl border border-card bg-card px-4 py-4">
      <div
        className="mb-3 flex h-[38px] w-[38px] items-center justify-center rounded-xl"
        style={{ backgroundColor: `${color}26` }}
      >
        <FeatureIcon icon={icon} color={color} />
      </div>
      <div className="text-base font-semibold text-ink">{title}</div>
      <div className="mt-2 text-sm leading-6 text-ink-muted">{body}</div>
    </div>
  );
}

function FeatureIcon({ icon, color }: { icon: string; color: string }) {
  const common = { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none' as const };

  switch (icon) {
    case 'rectangle.stack':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="10" height="5" rx="1.5" stroke={color} strokeWidth="1.6" />
          <rect x="7" y="10" width="10" height="5" rx="1.5" stroke={color} strokeWidth="1.6" />
        </svg>
      );
    case 'arrow.triangle.branch':
      return (
        <svg {...common}>
          <path d="M6 4v8" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="6" cy="4" r="1.6" fill={color} />
          <circle cx="6" cy="12" r="1.6" fill={color} />
          <path d="M6 8c0 0 2 0 4-2s4-2 4-2" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <path d="M11 14c1.7 0 3 .5 4 2" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="15" cy="4" r="1.6" fill={color} />
          <circle cx="15" cy="16" r="1.6" fill={color} />
        </svg>
      );
    case 'trophy':
      return (
        <svg {...common}>
          <path d="M6 4h8v2a4 4 0 0 1-8 0V4Z" stroke={color} strokeWidth="1.6" />
          <path d="M8 12h4v2a2 2 0 0 1-4 0v-2Z" stroke={color} strokeWidth="1.6" />
          <path d="M5 5H3a2 2 0 0 0 2 3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <path d="M15 5h2a2 2 0 0 1-2 3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <path d="M7 17h6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'sparkles.rectangle.stack.fill':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="12" height="8" rx="2" stroke={color} strokeWidth="1.5" />
          <path d="M15 4v3M13.5 5.5h3" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
          <path d="M8 8.5v2M7 9.5h2" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
          <path d="M6 15h8" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'chart.bar.fill':
      return (
        <svg {...common}>
          <rect x="4" y="10" width="2.5" height="6" rx="1" fill={color} />
          <rect x="8.75" y="7" width="2.5" height="9" rx="1" fill={color} />
          <rect x="13.5" y="4" width="2.5" height="12" rx="1" fill={color} />
        </svg>
      );
    case 'cpu':
      return (
        <svg {...common}>
          <rect x="5.5" y="5.5" width="9" height="9" rx="2" stroke={color} strokeWidth="1.5" />
          <rect x="8" y="8" width="4" height="4" rx="1" stroke={color} strokeWidth="1.5" />
          <path d="M8 3v2M12 3v2M8 15v2M12 15v2M3 8h2M3 12h2M15 8h2M15 12h2" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}
