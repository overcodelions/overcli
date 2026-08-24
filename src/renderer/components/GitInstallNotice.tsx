import { useEffect, useState } from 'react';

/// Everyday projects promise "you can undo anything Overcli changes", and
/// that promise is kept by git. On a machine without it the promise silently
/// does not hold — checkpoints are fire-and-forget, so nothing fails loudly —
/// and the first the user hears of it is a raw `spawn git ENOENT` in the
/// versions list. This is the one place that says what is actually wrong and
/// offers the fix, so every surface that depends on history can show the
/// same thing rather than each inventing its own guess.
export type GitAvailability =
  | { state: 'ok'; version: string }
  | { state: 'needs-xcode-tools' }
  | { state: 'missing' };

/// Ask once per mount. The main-side answer is memoised, so a surface that
/// renders often is not re-probing the filesystem every time.
export function useGitAvailability(enabled = true): GitAvailability | null {
  const [availability, setAvailability] = useState<GitAvailability | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void window.overcli.invoke('git:availability').then((res) => {
      if (live) setAvailability(res);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return availability;
}

export function gitAvailabilityMessage(state: GitAvailability['state']): string {
  if (state === 'needs-xcode-tools') {
    return "Saving versions needs Git, which comes with Apple’s command line tools. They aren’t installed yet.";
  }
  return 'Saving versions needs Git, which isn’t installed on this computer.';
}

export function GitInstallNotice({ state, lead }: { state: GitAvailability['state']; lead?: string }) {
  // `command` is set when we could not open a window for them — Linux, where
  // no single install command is right, or an Apple Event macOS refused.
  const [failure, setFailure] = useState<{ error: string; command?: string } | null>(null);
  const [working, setWorking] = useState(false);

  return (
    <div className="rounded border border-card bg-surface-elevated px-3 py-2 text-xs flex flex-col gap-2">
      <div className="text-ink-faint">
        {lead ? `${lead} ` : ''}
        {gitAvailabilityMessage(state)}
      </div>
      {failure ? (
        <div className="flex flex-col gap-1">
          <div className="text-ink-faint">{failure.error}</div>
          {failure.command && (
            <code className="select-all rounded bg-surface px-2 py-1 font-mono text-[11px]">
              {failure.command}
            </code>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={working}
          className="self-start rounded border border-card px-2 py-1 hover:bg-surface disabled:opacity-50"
          onClick={async () => {
            setWorking(true);
            const res = await window.overcli.invoke('git:install');
            setWorking(false);
            if (res.ok) {
              // The install itself runs on in that Terminal window; there is
              // nothing here to wait for and nothing to poll.
              setFailure({
                error: 'Follow the install in the Terminal window, then reopen this project.',
                command: res.command,
              });
            } else {
              setFailure({ error: res.error, command: res.command });
            }
          }}
        >
          {working ? 'Opening Terminal…' : 'Install Git'}
        </button>
      )}
    </div>
  );
}
