// The visual vocabulary of onboarding: the app mark, the concept cards and
// the little glyphs that label them.
//
// Lives here rather than in WelcomePane because the welcome screen is not
// the only place that has to explain overcli. It is the FIRST place, and it
// disappears the moment a project exists — so the Basics sheet (Help →
// Overcli Basics) renders the same cards for everyone who met them once,
// three weeks ago, and now wants to know what a detached worktree is.

import type { ReactNode } from 'react';

/// The four nouns overcli is built out of. One sentence each: this is the
/// version someone reads standing up, before they have done anything.
export const BASICS: {
  accent: string;
  title: string;
  body: string;
  icon: ReactNode;
}[] = [
  {
    accent: 'var(--c-backend-claude)',
    title: 'Projects',
    body: 'A project is a folder on your machine — a git repo unlocks agents and diffs. Chat with it, run tools, and keep one thread per task.',
    icon: <ProjectGlyph />,
  },
  {
    accent: 'var(--c-backend-codex)',
    title: 'Agents',
    body: 'Build, review, or doc agents run in their own git worktrees so your main checkout stays clean.',
    icon: <BranchGlyph />,
  },
  {
    accent: 'var(--c-accent)',
    title: 'Flows',
    body: 'Chain steps into a pipeline — each its own model, role, and tools — handing artifacts (plan → diff → review) step to step.',
    icon: <FlowGlyph />,
  },
  {
    accent: 'var(--c-backend-gemini)',
    title: 'Workspaces',
    body: 'Group several projects into one workspace and fire agents that span every repo at once.',
    icon: <WorkspaceGlyph />,
  },
];

/// The four concept cards as a grid. Two columns from `sm` up, one below.
export function BasicsCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
      {BASICS.map((b) => (
        <FeatureCard key={b.title} accent={b.accent} title={b.title} body={b.body} icon={b.icon} />
      ))}
    </div>
  );
}

export function FeatureCard({
  accent,
  title,
  body,
  icon,
}: {
  accent: string;
  title: string;
  body: string;
  icon: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-card bg-card/50 p-3.5 transition-colors hover:border-card-strong">
      <div
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg"
        style={{
          background: `color-mix(in srgb, ${accent} 16%, transparent)`,
          color: accent,
        }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <div className="mt-1 text-[12px] leading-[1.55] text-ink-muted">{body}</div>
      </div>
    </div>
  );
}

/// The app mark, reused by the landing hero, both help sheets and About so
/// every surface opens the same way. Same drawing as build/icon.svg, minus
/// the dock finish (shade, rim, drop shadow): in the UI a CSS shadow does
/// that job. The viewBox is cropped to the tile so the shadow hugs it.
/// Below 64px the dock drawing's strokes fall to about two device pixels
/// on a 1x screen and break up, so small marks use a heavier cut of the
/// same shape.
export function HeroArt({ size = 38 }: { size?: number }) {
  const small = size < 64;
  return (
    <svg
      width={size}
      height={size}
      viewBox="100 100 824 824"
      className="shrink-0 shadow-sm rounded-[22%]"
      aria-label="overcli"
    >
      <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#ffffff" />
      {small ? (
        <g fill="none" stroke="#111113" strokeWidth="74" strokeLinecap="round" strokeLinejoin="round">
          <line x1="356" y1="312" x2="668" y2="312" />
          <polyline points="356,428 668,574 356,720" />
        </g>
      ) : (
        <g fill="none" stroke="#111113" strokeWidth="58" strokeLinecap="round" strokeLinejoin="round">
          <line x1="364" y1="318" x2="664" y2="318" />
          <polyline points="364,420 664,565 364,710" />
        </g>
      )}
    </svg>
  );
}

function ProjectGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FlowGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="5.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10.5" y="5.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7.5h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7.8 6.2L9.2 7.5L7.8 8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="6" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 9c0-2 2-3 4-3h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function WorkspaceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2.5H5.7L6.7 3.6H12.5V5.5H3.5V2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 5.5H4L5 6.5H14.5V13.3A1 1 0 0113.5 14.3H2.5A1 1 0 011.5 13.3V5.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
