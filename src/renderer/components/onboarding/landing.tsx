// The house style for a tab with nothing in it yet.
//
// Five tabs can go empty — Chat, Flows, Orchestrator, Workers, Services — and
// before this module each had invented its own answer: a centred card of
// bullets, a left-aligned posting, a bare sentence in the middle of a black
// screen. They now share one structure, and the structure comes from what
// this product actually is.
//
// THE FORM. Every landing is a page from the same document set:
//
//   ┌──────────────────────────────────────────────┐
//   │  mark · eyebrow                              │   hero band: an accent
//   │  A <noun> is <what it actually is>.          │   wash, the defining
//   │  one paragraph, then one primary action      │   sentence in the serif
//   └──────────────────────────────────────────────┘
//   ┌───────────────── terms ─────┐ ┌── specimen ──┐   terms: what you are
//   │ The job    …                │ │ ●●●  label   │   agreeing to.
//   │ The clock  …                │ ├──────────────┤   specimen: the thing
//   │ The trust  …                │ │ 06:45  …     │   itself, running,
//   └─────────────────────────────┘ └──────────────┘   drawn as a panel.
//
// WHY A SPECIMEN. Terms can only describe an arrangement. What sells any of
// these features is a DAY of it — a rota nobody asked for, a pipeline handing
// artifacts along, four processes and their ports. So every landing shows one,
// panelled like the real surface it stands in for, and never as a screenshot.
//
// The serif appears exactly once per page, on the defining sentence. Nothing
// moves on load: a flourish here would be the one thing that gave the screen
// away.

import type { CSSProperties, ReactNode } from 'react';

/// BRAND. overcli.app's stylesheet says its palette "mirrors the app's dark
/// mode exactly", so colour here needs no reconciling — it is the same set of
/// tokens. What the site carries that this app did not: every label is set in
/// the mono, and nothing on it is rounder than 12px. Both are matched above
/// and below.
///
/// The one display face in the app, and it is the brand's: Bricolage
/// Grotesque, bundled in src/renderer/fonts and declared in styles.css.
///
/// It is what overcli.app renders — its theme loads this font and sets
/// `--f-display` to it. (The overcli page's own stylesheet names Fraunces,
/// but it is linked before the theme and loses; that rule never applies. The
/// site never loads Fraunces at all.)
///
/// Named LANDING_SERIF for the callers that still import it under that name —
/// the brand has no serif, which is the whole correction.
export const LANDING_DISPLAY_FAMILY =
  "'Bricolage Grotesque', 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
export const LANDING_SERIF = LANDING_DISPLAY_FAMILY;

/// The display setting lifted from the site's own `.display` rule: regular
/// weight, tracked in hard, optical size run up so the face switches to its
/// display cut. At -0.03em the sentence sets as one object rather than a row
/// of words, which is what makes the site's headlines look deliberate.
export const LANDING_DISPLAY: CSSProperties = {
  fontFamily: LANDING_DISPLAY_FAMILY,
  fontWeight: 400,
  letterSpacing: '-0.03em',
  fontVariationSettings: '"opsz" 96, "wdth" 100',
};

/// The page: a measured column with the light behind it. The two washes are
/// the only decoration in the system and they are placed, not scattered —
/// one behind the hero's mark, one under the far corner of the specimen.
export function LandingPage({
  title,
  subtitle,
  gutter = true,
  children,
}: {
  /// The tab's name, for the two panes (Chat, Services) that have no header
  /// of their own. Omitted where the pane already titles itself — two titles
  /// on one screen is how a page stops looking designed.
  title?: string;
  subtitle?: string;
  /// False where the host pane already insets its content. The gutter sits
  /// OUTSIDE the measure so the document is the same width either way: with
  /// it inside, the two panes that pad themselves were rendering 48px wider
  /// than the two that don't.
  gutter?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className={gutter ? 'px-6' : ''}>
        {/* One measure, ranged left — flush with the pane's own title, which
            is the thing it has to line up with. The pane can be 2,000px wide;
            a document that grew to fill it would be unreadable, so the rest
            of the width goes unused on purpose.

            `pt-6` belongs to the header block, so it is applied only when
            this component owns the header. Where the pane titles itself, that
            pane has already left its 24px, and a second one put the hero
            lower on some tabs than others. */}
        <div className={`w-full max-w-[1180px] pb-10 ${title ? 'pt-6' : ''}`}>
          {/* Same metrics as the panes that title themselves (Flows, Workers,
              Orchestrator), so a tab switch never moves the title. */}
          {title && (
            <header className="mb-6">
              <h1 className="m-0 text-2xl font-semibold text-ink">{title}</h1>
              {subtitle && <div className="mt-2 text-xs text-ink-muted">{subtitle}</div>}
            </header>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/// The one surface treatment on a landing. Every block — hero, terms,
/// specimen, starter — is this panel at one of two radii, so a page never
/// looks like three components that met by accident.
const PANEL = 'rounded-xl border border-card-strong bg-surface-elevated';

/// The frame every landing mark is drawn into. An SVG mark sets width to
/// LANDING_MARK_W and keeps its own viewBox, so the whole drawing scales
/// rather than being cropped or re-laid-out per tab.
export const LANDING_MARK_W = 300;
export const LANDING_MARK_H = 104;

/// The band at the top of every landing. Holds the mark, the eyebrow naming
/// the document, the one serif sentence, a paragraph, and the actions —
/// nothing else is allowed in here, which is what keeps five tabs looking
/// like five pages rather than five designs.
export function LandingHero({
  mark,
  eyebrow,
  title,
  lead,
  actions,
  note,
}: {
  /// Rendered opposite the text, where it reads as the document's stamp: the
  /// app mark, a trust ladder, whatever the tab's own vocabulary offers.
  mark?: ReactNode;
  eyebrow: string;
  /// Two or three lines, broken by hand. The break is part of the setting.
  title: ReactNode;
  lead: ReactNode;
  actions?: ReactNode;
  /// The one line that changes with state — what is blocked, what is next.
  note?: ReactNode;
}) {
  return (
    <section className={`relative overflow-hidden ${PANEL} px-8 py-7`}>
      {/* Contained by the panel's own overflow, so it can never show up as a
          loose rectangle in the margin. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-44"
        style={{
          backgroundImage:
            'linear-gradient(180deg, color-mix(in srgb, var(--c-accent) 10%, transparent) 0%, transparent 100%)',
        }}
      />
      <div className="relative flex items-center gap-10">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            {eyebrow}
          </span>
          <h2 className="mt-3 max-w-[26ch] text-[32px] leading-[1.18] text-ink" style={LANDING_DISPLAY}>
            {title}
          </h2>
          <p className="mt-4 max-w-[62ch] text-[13px] leading-[1.7] text-ink-muted">{lead}</p>
          {actions && (
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">{actions}</div>
          )}
          {note && <div className="mt-3 text-[12px] text-ink-faint">{note}</div>}
        </div>
        {/* One frame, the same on every tab, centred against the text rather
            than pinned to a corner. Marks differed by 10px of height and 90px
            of width before this existed, which read as five drawings at five
            sizes; at this size the mark is part of the composition rather
            than a badge, so its box is fixed and the drawing fills it. */}
        {mark && (
          <div
            className="hidden shrink-0 items-center justify-center lg:flex"
            style={{ width: LANDING_MARK_W, height: LANDING_MARK_H }}
          >
            {mark}
          </div>
        )}
      </div>
    </section>
  );
}

/// Terms on the left, specimen on the right; one column when the pane is
/// narrow. `wide` gives the specimen the larger share, for the tabs whose
/// specimen carries more of the argument than their terms do.
export function LandingColumns({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={
        'mt-5 grid items-start gap-5 ' +
        (wide ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]' : 'lg:grid-cols-2')
      }
    >
      {children}
    </div>
  );
}

/// What you are agreeing to. Real fields of the thing — a worker's contract,
/// a service's upkeep — never marketing bullets, and never more than five.
export function Terms({
  title = 'The terms',
  items,
}: {
  title?: string;
  items: { label: string; value: ReactNode }[];
}) {
  return (
    <section className={`overflow-hidden ${PANEL}`}>
      <header className="border-b border-card bg-card/40 px-5 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {title}
        </span>
      </header>
      <dl className="divide-y divide-card">
        {items.map((term) => (
          <div key={term.label} className="px-5 py-3.5">
            <dt className="text-[12px] font-medium text-ink">{term.label}</dt>
            <dd className="mt-1 text-[12px] leading-[1.65] text-ink-muted">{term.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/// The thing itself, drawn as the surface it lives on. The three dots are the
/// app's own window, not decoration: everything in this product happens in a
/// pane, and the specimen is a pane you are looking into.
export function Specimen({
  label,
  aside,
  footnote,
  tint,
  children,
}: {
  label: string;
  aside?: string;
  footnote?: ReactNode;
  /// The domain's colour — a trust ring, a backend, a running process. Tints
  /// the panel's top edge so each tab's specimen is recognisably its own.
  tint?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div
        className={`overflow-hidden ${PANEL}`}
        style={{
          borderTop: tint ? `2px solid color-mix(in srgb, ${tint} 55%, transparent)` : undefined,
        }}
      >
        <header className="flex items-center gap-2.5 border-b border-card bg-card/40 px-4 py-2.5">
          <span className="flex gap-1" aria-hidden>
            <Dot />
            <Dot />
            <Dot />
          </span>
          <span className="font-mono text-[11px] font-medium text-ink">{label}</span>
          {aside && (
            <span className="truncate font-mono text-[10.5px] text-ink-faint">· {aside}</span>
          )}
        </header>
        <div className="divide-y divide-card">{children}</div>
      </div>
      {footnote && (
        <p className="mt-3 px-1 text-[11.5px] leading-relaxed text-ink-faint">{footnote}</p>
      )}
    </section>
  );
}

function Dot() {
  return (
    <span
      className="h-[7px] w-[7px] rounded-full"
      style={{ background: 'color-mix(in srgb, var(--c-ink) 16%, transparent)' }}
    />
  );
}

/// One line of a specimen. A fixed lead column (a time, a step, a name), an
/// optional status dot, the thing, and its state — so every specimen in the
/// app scans down the same four positions.
export function SpecimenRow({
  lead,
  tint,
  title,
  detail,
  trailing,
  leadClass = 'w-12',
  titleClass = 'w-28',
  style,
}: {
  lead?: ReactNode;
  tint?: string;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  leadClass?: string;
  titleClass?: string;
  style?: CSSProperties;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5 text-[11.5px]" style={style}>
      {lead != null && (
        <span className={`${leadClass} shrink-0 font-mono tabular-nums text-ink-faint`}>
          {lead}
        </span>
      )}
      {tint !== undefined && (
        <span
          className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
          style={
            tint
              ? { background: tint }
              : { border: '1px solid color-mix(in srgb, var(--c-ink) 22%, transparent)' }
          }
        />
      )}
      <span className={`${titleClass} shrink-0 truncate text-ink`}>{title}</span>
      {detail != null && <span className="min-w-0 flex-1 text-ink-muted">{detail}</span>}
      {trailing}
    </div>
  );
}

export function PrimaryAction({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-[0_8px_20px_-12px_var(--c-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
    >
      {label}
    </button>
  );
}

/// A second, equal door beside the primary one — for a page that has two
/// real starting points rather than one start and some asides.
export function SecondaryAction({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-lg border border-card-strong px-4 py-2 text-[13px] font-medium text-ink hover:bg-card-strong disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

/// The other ways in, written as continuations of the primary button — "or
/// write the contract yourself" — so the row reads as one sentence.
export function QuietAction({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-1 py-0.5 text-[12px] text-ink-faint hover:text-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}

/// A card of ways to start that are content rather than chrome — canned
/// producer prompts, flow templates. Sits under the columns, never above
/// them: the page has to say what the thing is before it offers shortcuts.
/// Evidence, as a row of chips: the stacks a detector knows, the tools a
/// producer can reach. Informational — nothing here is a button, because on
/// the tabs that use it there is exactly one thing to press and it is in the
/// hero.
export function Chips({
  title,
  aside,
  items,
}: {
  title: string;
  aside?: string;
  items: string[];
}) {
  return (
    <section className="mt-5">
      <div className="flex items-baseline gap-2 px-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {title}
        </span>
        {aside && <span className="text-[10.5px] text-ink-faint">· {aside}</span>}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-full border border-card-strong bg-card/40 px-2.5 py-1 text-[11.5px] text-ink-muted"
          >
            {item}
          </span>
        ))}
      </div>
    </section>
  );
}

export function StarterGrid({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="flex items-baseline gap-2 px-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {title}
        </span>
        {aside && <span className="text-[10.5px] text-ink-faint">· {aside}</span>}
      </div>
      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

export function StarterCard({
  title,
  body,
  onClick,
  tint,
}: {
  title: string;
  body: string;
  onClick: () => void;
  tint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group rounded-lg border border-card-strong bg-surface-elevated px-4 py-3 text-left hover:bg-card/40"
    >
      <div className="flex items-center gap-2">
        {tint && (
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tint }} aria-hidden />
        )}
        <span className="text-[12.5px] font-medium text-ink">{title}</span>
      </div>
      <div className="mt-1 text-[11.5px] leading-[1.6] text-ink-muted">{body}</div>
    </button>
  );
}
