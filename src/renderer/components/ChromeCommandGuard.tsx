// Composer guard for `/chrome <prose>` submissions.
//
// The CLI answers `/chrome` locally — the model is never invoked — and the
// picker ignores its arguments, so typing `/chrome navigate to cnn` burns a
// turn and does nothing, every time. See `chromeCommandVerdict` for why the
// two outcomes differ on whether the browser tools are attached.
//
// This lives beside the composers rather than inside `Composer` so the
// generic component stays free of backend/settings coupling: each call site
// already knows its backend, its effective Chrome state, and how to flip it
// (a per-conversation override in chat, a per-run one in a flow).

import { ReactNode, useState } from 'react';
import type { Attachment, Backend } from '@shared/types';
import { chromeCommandVerdict } from '@shared/claudeChrome';

interface Blocked {
  prose: string;
  attachments: Attachment[];
}

export function useChromeCommandGuard(args: {
  backend: Backend | undefined;
  /// Whether the browser tools are attached for this conversation / run.
  chromeOn: boolean;
  /// Turn Chrome on for whatever scope this composer speaks to.
  enableChrome: () => Promise<void> | void;
  send: (prompt: string, attachments: Attachment[]) => void;
}): { send: (prompt: string, attachments: Attachment[]) => void; banner: ReactNode } {
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [rewrote, setRewrote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (prompt: string, attachments: Attachment[]) => {
    const verdict = chromeCommandVerdict(prompt, {
      backend: args.backend,
      chromeOn: args.chromeOn,
    });
    if (verdict.kind === 'blocked') {
      // Deliberately does NOT send. The composer only clears its draft when
      // a send actually happens, so the user's words survive whichever way
      // they resolve the bar below.
      setRewrote(null);
      setBlocked({ prose: verdict.prose, attachments });
      return;
    }
    setBlocked(null);
    setRewrote(verdict.kind === 'rewrite' ? verdict.prose : null);
    args.send(verdict.kind === 'rewrite' ? verdict.prose : prompt, attachments);
  };

  // Enabling is spawn-time, so the tools attach on the turn we're about to
  // send rather than the one after it — which is why this can send straight
  // through instead of asking the user to press enter a second time.
  const enableAndSend = () => {
    if (!blocked) return;
    setBusy(true);
    void Promise.resolve(args.enableChrome())
      .then(() => {
        args.send(blocked.prose, blocked.attachments);
        setBlocked(null);
        setRewrote(blocked.prose);
      })
      .finally(() => setBusy(false));
  };

  const banner = blocked ? (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px]">
      <div className="text-amber-700 dark:text-amber-200">
        <span className="font-medium">
          <span className="font-mono">/chrome</span> can&apos;t carry an instruction.
        </span>{' '}
        The CLI answers it locally without ever asking Claude, and the picker ignores what
        follows it. Chrome is also off here, so the browser tools aren&apos;t attached yet.
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          disabled={busy}
          onClick={enableAndSend}
          className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-200 hover:bg-amber-500/30 border border-amber-500/40 disabled:opacity-50"
        >
          Turn Chrome on and send
        </button>
        <button
          disabled={busy}
          onClick={() => setBlocked(null)}
          className="px-2 py-0.5 rounded border border-card-strong text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Keep editing
        </button>
        <span className="text-ink-faint truncate min-w-0">
          would send: <span className="font-mono">{blocked.prose}</span>
        </span>
      </div>
    </div>
  ) : rewrote ? (
    <div className="rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] text-ink-muted">
      Sent without <span className="font-mono">/chrome</span> — the picker has no headless form,
      but the browser tools do. Just ask in prose next time.
    </div>
  ) : null;

  return { send, banner };
}
