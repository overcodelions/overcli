// Shared chrome for the Settings sheet and its panes.
//
// Lives apart from SettingsSheet.tsx so a pane can use the same building
// blocks without importing the sheet that renders it — SettingsSheet imports
// its panes, so a pane importing back would be a cycle.

/// Titled card that groups related settings rows.
export function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">{title}</div>
      {description && <div className="text-xs text-ink-muted mb-2">{description}</div>}
      <div className="flex flex-col gap-3 rounded-lg bg-card border border-card p-4">
        {children}
      </div>
    </section>
  );
}

export function SheetActionButton({
  label,
  onClick,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'px-3 py-1 rounded text-xs border disabled:opacity-40 disabled:cursor-not-allowed ' +
        (primary
          ? 'bg-accent/30 border-accent/60 text-accent hover:bg-accent/40'
          : 'border-transparent text-ink-muted hover:text-ink hover:bg-card-strong hover:border-card')
      }
    >
      {label}
    </button>
  );
}

/// A setting: its label on the left, its control on the right, and help
/// under the control.
export function Row({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    // Help sits in its own grid row rather than inside the control column.
    // Inside it, the label could only ever be wrong: `items-center` centred it
    // against control-plus-help, so a long help line pushed it down, and
    // `items-start` left it a few pixels ABOVE the control — visibly so next
    // to a native select, which renders taller than a text input. As its own
    // row the label centres against the control alone, and the help still
    // lines up under the control, with no per-control padding to re-tune.
    <div className="grid grid-cols-[168px_1fr] items-center gap-x-4 gap-y-1">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="min-w-0">{children}</div>
      {help && (
        <>
          <div />
          <div className="text-[11px] text-ink-faint">{help}</div>
        </>
      )}
    </div>
  );
}
