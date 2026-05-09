import { useStore } from '../../store';

const VERSION = '0.1.0';

const PILLARS = [
  {
    color: '#5b9cff',
    kicker: 'Interaction',
    title: 'Point, click, and direct.',
    body:
      'Approve tool calls with a tap. Jump between sessions, backends, and worktrees with the keyboard. The ergonomics the terminal never had.',
    demo: 'permissions',
  },
  {
    color: '#b587ff',
    kicker: 'Clarity',
    title: 'See what the agent is actually doing.',
    body:
      'Live tool activity, diffs, costs, and context usage — surfaced where you need them instead of scrolling through a wall of text.',
    demo: 'stats',
  },
  {
    color: '#36cfc9',
    kicker: 'Scale',
    title: 'Run many agents at once.',
    body:
      'Each in its own git worktree, side-by-side. Race them in the Colosseum, or pair them up in Rebound for AI-reviewing-AI.',
    demo: 'worktrees',
  },
] as const;

const FEATURES = [
  {
    icon: 'rectangle.stack',
    color: '#5b9cff',
    title: 'Multi-project workspaces',
    body: 'Sidebar-organized projects rooted at a directory. Workspaces span multiple repos.',
  },
  {
    icon: 'arrow.triangle.branch',
    color: '#36cfc9',
    title: 'Multi-agent worktrees',
    body: 'Parallel sessions against one repo, each on its own branch.',
  },
  {
    icon: 'trophy',
    color: '#f59e0b',
    title: 'Agent Colosseum',
    body: 'Race agents on the same task. Compare diffs and pick a winner.',
  },
  {
    icon: 'sparkles.rectangle.stack.fill',
    color: '#b587ff',
    title: 'Rebound',
    body: 'A second model reviews each turn, or collaborates across rounds.',
  },
  {
    icon: 'chart.bar.fill',
    color: '#5b9cff',
    title: 'Stats dashboard',
    body: 'Cost, tokens, cache, rate-limit, and context-window — live.',
  },
  {
    icon: 'cpu',
    color: '#36cfc9',
    title: 'Multi-backend',
    body: 'Claude, Codex, Gemini, Ollama — primary or reviewer.',
  },
] as const;

export function AboutSheet() {
  const close = useStore((s) => s.openSheet);

  return (
    <div className="flex h-[760px] flex-col bg-surface-elevated">
      <div className="relative overflow-hidden border-b border-card bg-gradient-to-b from-accent/18 via-accent/6 to-transparent px-8 pt-9 pb-8">
        <div className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-accent/12 blur-3xl" />
        <div className="pointer-events-none absolute -left-20 -bottom-24 h-56 w-56 rounded-full bg-accent/6 blur-3xl" />

        <div className="relative flex items-start gap-6">
          <AppMark />
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-baseline gap-3">
              <div className="text-[36px] font-bold leading-none tracking-tight text-ink">overcli</div>
              <div className="rounded-full border border-card-strong bg-card/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                v{VERSION}
              </div>
            </div>
            <div className="mt-3 text-[15px] leading-snug text-ink-muted">
              <span className="font-medium text-ink">over·CLI</span>
              <span className="mx-2 text-ink-faint">—</span>
              a GUI that sits over your CLIs.
            </div>
            <div className="mt-1 text-[13px] italic text-ink-faint">Yes, that's the name.</div>
          </div>
        </div>

        <div className="relative mt-7 max-w-[92%] text-[15px] leading-[1.55] text-ink">
          Coding agents are powerful. The terminals they live in aren't.
          <span className="text-ink-muted">
            {' '}
            overcli makes the interaction with every major CLI <em className="not-italic font-semibold text-ink">dramatically
            better</em> — faster to approve, easier to follow, and actually fun to run in parallel.
          </span>
        </div>
      </div>

      <div className="relative flex-1 overflow-y-auto px-7 py-6">
        <SectionLabel>Why overcli</SectionLabel>
        <div className="mt-3 space-y-3">
          {PILLARS.map((pillar, i) => (
            <PillarRow key={pillar.title} index={i + 1} {...pillar} />
          ))}
        </div>

        <SectionLabel className="mt-8">What's in the box</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {FEATURES.map((feature) => (
            <FeatureRow key={feature.title} {...feature} />
          ))}
        </div>

        <div className="mt-8 flex items-center justify-between rounded-2xl border border-card bg-card/40 px-5 py-4">
          <div>
            <div className="text-[13px] font-semibold text-ink">Built by a father and son.</div>
            <div className="mt-1 text-[12px] text-ink-muted">
              Lionel &amp; Owen Farr. Apache-2.0 licensed. Happy to take feedback.
            </div>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-ink-faint">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
            No API keys required
          </div>
        </div>

      </div>

      <div className="flex items-center gap-3 border-t border-card bg-surface-elevated px-6 py-3">
        <div className="text-[11px] text-ink-faint">
          Connects to claude, codex, gemini, ollama — uses your existing CLI auth.
        </div>
        <div className="flex-1" />
        <a
          href="https://github.com/overcodelions/overcli"
          target="_blank"
          rel="noreferrer"
          className="rounded-md px-2.5 py-1.5 text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink"
        >
          GitHub
        </a>
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

function AppMark() {
  return (
    <div className="relative flex h-[92px] w-[92px] items-center justify-center rounded-[24px] border border-card-strong bg-gradient-to-br from-accent/55 via-accent/20 to-accent/5 shadow-[0_14px_30px_rgba(0,0,0,0.28)]">
      <div className="absolute inset-[6px] rounded-[18px] border border-ink/5 bg-surface/30" />
      <svg width="50" height="50" viewBox="0 0 42 42" fill="none" className="relative">
        <rect x="11" y="9" width="20" height="5" rx="2.5" fill="currentColor" className="text-ink" />
        <path
          d="M14 20 L28 27 L14 34"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-ink"
        />
      </svg>
    </div>
  );
}

function SectionLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{children}</div>
      <div className="h-px flex-1 bg-card" />
    </div>
  );
}

function PillarRow({
  index,
  color,
  kicker,
  title,
  body,
  demo,
}: {
  index: number;
  color: string;
  kicker: string;
  title: string;
  body: string;
  demo: 'permissions' | 'stats' | 'worktrees';
}) {
  return (
    <div
      className="group relative flex gap-5 overflow-hidden rounded-2xl border border-card bg-gradient-to-br from-card to-card/30 p-5 transition-colors hover:border-card-strong"
      style={{ boxShadow: `inset 0 1px 0 ${color}20` }}
    >
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full blur-3xl"
        style={{ backgroundColor: `${color}20` }}
      />
      <div className="relative flex w-[150px] shrink-0 items-center justify-center">
        <PillarDemo demo={demo} color={color} />
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ backgroundColor: `${color}24`, color }}
          >
            {String(index).padStart(2, '0')} · {kicker}
          </span>
        </div>
        <div className="mt-2 text-[17px] font-semibold leading-tight text-ink">{title}</div>
        <div className="mt-1.5 text-[13px] leading-[1.55] text-ink-muted">{body}</div>
      </div>
    </div>
  );
}

function PillarDemo({ demo, color }: { demo: 'permissions' | 'stats' | 'worktrees'; color: string }) {
  if (demo === 'permissions') {
    return (
      <div className="relative h-[104px] w-[140px]">
        <div className="absolute inset-0 rounded-xl border border-card-strong bg-surface-elevated/80 p-2.5 shadow-[0_6px_16px_rgba(0,0,0,0.2)]">
          <div className="flex items-center gap-1">
            <div className="h-1.5 w-1.5 rounded-full bg-ink-faint/60" />
            <div className="h-1.5 w-1.5 rounded-full bg-ink-faint/60" />
            <div className="h-1.5 w-1.5 rounded-full bg-ink-faint/60" />
          </div>
          <div className="mt-2 text-[9px] font-medium text-ink-muted">Run shell command</div>
          <div className="mt-1 rounded border border-card bg-card/60 px-1.5 py-1 font-mono text-[8.5px] text-ink">
            npm test
          </div>
          <div className="mt-2 flex gap-1">
            <div
              className="flex-1 rounded py-1 text-center text-[8.5px] font-semibold text-ink"
              style={{ backgroundColor: color }}
            >
              Allow
            </div>
            <div className="flex-1 rounded border border-card bg-card/50 py-1 text-center text-[8.5px] text-ink-muted">
              Deny
            </div>
          </div>
        </div>
        <div
          className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full shadow-md"
          style={{ backgroundColor: color }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5l2 2 4-4" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    );
  }

  if (demo === 'stats') {
    return (
      <div className="relative h-[104px] w-[140px] rounded-xl border border-card-strong bg-surface-elevated/80 p-2.5 shadow-[0_6px_16px_rgba(0,0,0,0.2)]">
        <div className="flex items-center justify-between text-[8.5px] text-ink-muted">
          <span>Context</span>
          <span style={{ color }}>62%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-card">
          <div className="h-full rounded-full" style={{ width: '62%', backgroundColor: color }} />
        </div>
        <div className="mt-2.5 flex items-end gap-1 px-0.5">
          {[38, 56, 72, 48, 82, 64, 90, 54].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t"
              style={{ height: `${h * 0.42}px`, backgroundColor: `${color}${i % 2 ? 'cc' : '66'}` }}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[8.5px]">
          <span className="text-ink-muted">Cost</span>
          <span className="font-semibold text-ink">$0.42</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[104px] w-[140px]">
      <div className="absolute inset-x-0 top-0 h-[52px] rounded-lg border border-card-strong bg-surface-elevated/80 shadow-[0_4px_12px_rgba(0,0,0,0.18)]">
        <div className="flex items-center gap-1 px-2 pt-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
          />
          <span className="text-[8.5px] text-ink-muted">feat/api</span>
        </div>
        <div className="mx-2 mt-1 space-y-0.5">
          <div className="h-0.5 w-full rounded bg-card" />
          <div className="h-0.5 w-4/5 rounded bg-card" />
          <div className="h-0.5 w-3/5 rounded bg-card" />
        </div>
      </div>
      <div
        className="absolute inset-x-4 top-[30px] h-[52px] rounded-lg border border-card-strong bg-surface-elevated/90 shadow-[0_4px_12px_rgba(0,0,0,0.22)]"
        style={{ borderColor: `${color}66` }}
      >
        <div className="flex items-center gap-1 px-2 pt-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
          />
          <span className="text-[8.5px] text-ink-muted">feat/ui</span>
        </div>
        <div className="mx-2 mt-1 space-y-0.5">
          <div className="h-0.5 w-full rounded bg-card" />
          <div className="h-0.5 w-2/3 rounded bg-card" />
        </div>
      </div>
      <div
        className="absolute inset-x-8 top-[60px] h-[44px] rounded-lg border bg-surface-elevated/95 shadow-[0_4px_14px_rgba(0,0,0,0.28)]"
        style={{ borderColor: color }}
      >
        <div className="flex items-center gap-1 px-2 pt-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
          />
          <span className="text-[8.5px] font-semibold text-ink">fix/auth</span>
        </div>
        <div className="mx-2 mt-1 space-y-0.5">
          <div className="h-0.5 w-full rounded bg-card" />
          <div className="h-0.5 w-3/4 rounded bg-card" />
        </div>
      </div>
    </div>
  );
}

function FeatureRow({
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
    <div className="flex gap-3 rounded-xl border border-card bg-card/50 p-3 transition-colors hover:border-card-strong">
      <div
        className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${color}22` }}
      >
        <FeatureIcon icon={icon} color={color} />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] leading-[1.4] text-ink-muted">{body}</div>
      </div>
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
