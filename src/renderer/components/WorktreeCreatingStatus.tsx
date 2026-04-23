interface Props {
  message?: string;
}

export function WorktreeCreatingStatus({ message = 'Creating worktree…' }: Props) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted rounded border border-card bg-card px-3 py-2">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
      <span>{message}</span>
    </div>
  );
}
