import { useState } from 'react';

// A shell command the user has to run themselves — because we couldn't drive
// Terminal for them, or because there is no button for it. Rendered as a
// selectable mono row with a copy button rather than buried in a sentence:
// the whole point of showing it is that they are about to paste it somewhere.
export function ManualCommand({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 mt-1 rounded bg-card-strong px-2 py-1">
      <code className="flex-1 min-w-0 truncate select-text text-[11px] font-mono text-ink">
        {command}
      </code>
      <CopyButton value={command} className="hover:bg-card" />
    </div>
  );
}

// Bare copy affordance for rows too tight for the block above — the CLI setup
// guide lines up commands and buttons in a single flex row.
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-muted hover:text-ink ${className ?? 'hover:bg-card-strong'}`}
      title="Copy command"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
