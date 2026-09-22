// Shared chrome for the two help sheets, cut to match About — which is the
// sheet people actually like. A wash behind the mark, a title that is a
// sentence rather than a noun, section labels that separate rather than
// decorate, and a footer that always offers the other help sheet.
//
// Both sheets sit in the same 900px frame (see SheetHost) so moving between
// them does not resize the window under the pointer.

import type { ReactNode } from 'react';
import { HeroArt } from '../onboarding/basics';

export function HelpHeader({
  title,
  lead,
  trailing,
}: {
  title: string;
  lead: ReactNode;
  /// A live status line — CLIs ready, git found. Sits opposite the title
  /// because on the Setup sheet it IS the answer.
  trailing?: ReactNode;
}) {
  return (
    <header
      className="relative shrink-0 overflow-hidden border-b border-card px-7 pb-6 pt-6"
      style={{
        backgroundImage:
          'linear-gradient(180deg, color-mix(in srgb, var(--c-accent) 14%, transparent) 0%, color-mix(in srgb, var(--c-accent) 4%, transparent) 55%, transparent 100%)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full blur-3xl"
        style={{ background: 'color-mix(in srgb, var(--c-accent) 12%, transparent)' }}
      />
      <div className="relative flex items-start gap-4">
        <HeroArt />
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h2>
          <p className="mt-2 max-w-[62ch] text-[12.5px] leading-[1.65] text-ink-muted">{lead}</p>
        </div>
        {trailing}
      </div>
    </header>
  );
}

export function HelpSection({
  title,
  lead,
  children,
  className = 'mt-7',
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {title}
        </span>
        <span className="h-px flex-1 bg-card" />
      </div>
      {lead && (
        <p className="mt-2 max-w-[70ch] text-[12px] leading-[1.65] text-ink-muted">{lead}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/// A definition row: the thing on the left in the app's own words, what it
/// means on the right. Used for run modes and permission modes, where the
/// name alone has never been enough.
export function HelpRow({
  title,
  kicker,
  body,
  tone,
}: {
  title: string;
  kicker?: string;
  body: ReactNode;
  tone?: 'warn';
}) {
  return (
    <div
      className={
        'rounded-lg border p-3.5 ' +
        (tone === 'warn'
          ? 'border-amber-500/40 bg-amber-500/[0.06]'
          : 'border-card bg-card/40')
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[12.5px] font-medium text-ink">{title}</span>
        {kicker && <span className="text-[11px] text-ink-faint">{kicker}</span>}
      </div>
      <div className="mt-1 text-[12px] leading-[1.6] text-ink-muted">{body}</div>
    </div>
  );
}

export function HelpFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-card bg-surface-elevated px-6 py-3">
      {children}
    </footer>
  );
}

export function HelpLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md px-2.5 py-1.5 text-[11.5px] text-ink-muted hover:bg-card-strong hover:text-ink"
    >
      {label}
    </button>
  );
}
