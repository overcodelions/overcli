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
    <section className="mb-5">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">{title}</div>
      {description && <div className="text-xs text-ink-faint mb-2">{description}</div>}
      <div className="flex flex-col gap-2 rounded-lg bg-card border border-card p-3">
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
