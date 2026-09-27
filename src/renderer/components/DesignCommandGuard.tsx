// Composer guard for `/design` while the artifact gate is closed.
//
// With the setting off, the CLI never registers the canvas skill, so every
// `/design …` lands on its consent/revoke stub. The replies read like a
// permissions problem — "run /design consent" — and granting consent
// doesn't help, because the gate is the spawn env, not the account. Users go
// round that loop without ever finding the Settings toggle, so we catch the
// command before it's sent and offer the toggle right there.
//
// Sits beside `useChromeCommandGuard` for the same reason: the composer
// stays free of settings coupling, and the call site chains the two sends.
// It also marks `/design` in the slash menu, so the warning shows up before
// Enter for anyone who picks it from the list.

import { ReactNode, useState } from 'react';
import type { Attachment, Backend } from '@shared/types';
import { isGatedDesignCommand } from '@shared/claudeArtifacts';
import { useStore } from '../store';
import type { SlashCommandEntry } from './Composer';

interface Blocked {
  prompt: string;
  attachments: Attachment[];
}

export function useDesignCommandGuard(args: {
  backend: Backend | undefined;
  send: (prompt: string, attachments: Attachment[]) => void;
}): {
  send: (prompt: string, attachments: Attachment[]) => void;
  banner: ReactNode;
  annotate: (commands: SlashCommandEntry[]) => SlashCommandEntry[];
} {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const gate = { backend: args.backend, artifactsOn: settings.claudeArtifacts ?? false };

  const send = (prompt: string, attachments: Attachment[]) => {
    if (isGatedDesignCommand(prompt, gate)) {
      // Not sent — the composer keeps its draft until a send happens.
      setBlocked({ prompt, attachments });
      return;
    }
    setBlocked(null);
    setEnabled(false);
    args.send(prompt, attachments);
  };

  // The gate is read at spawn time and a changed setting respawns the
  // process, so the held prompt reaches the real skill on this turn.
  const enableAndSend = () => {
    if (!blocked) return;
    setBusy(true);
    void saveSettings({ ...settings, claudeArtifacts: true })
      .then(() => {
        args.send(blocked.prompt, blocked.attachments);
        setBlocked(null);
        setEnabled(true);
      })
      .finally(() => setBusy(false));
  };

  const banner = blocked ? (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px]">
      <div className="text-amber-700 dark:text-amber-200">
        <span className="font-medium">
          Claude Design is off, so <span className="font-mono">/design</span> won&apos;t reach it.
        </span>{' '}
        The CLI only loads the design skill when overcli launches it with artifacts enabled.
        Without that, it just asks you to run <span className="font-mono">/design consent</span>,
        which doesn&apos;t fix it.
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          disabled={busy}
          onClick={enableAndSend}
          className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-200 hover:bg-amber-500/30 border border-amber-500/40 disabled:opacity-50"
        >
          Turn on Claude Design and send
        </button>
        <button
          disabled={busy}
          onClick={() => setBlocked(null)}
          className="px-2 py-0.5 rounded border border-card-strong text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Keep editing
        </button>
        <span className="text-ink-faint">
          Stays on for every chat. Change it anytime in Settings → Claude Design and artifacts.
        </span>
      </div>
    </div>
  ) : enabled ? (
    <div className="rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] text-ink-muted">
      Claude Design is on. <span className="font-mono">/design</span> goes straight through from
      now on. It needs a claude.ai login, and some accounts can&apos;t use it yet.
    </div>
  ) : null;

  const annotate = (commands: SlashCommandEntry[]) =>
    isGatedDesignCommand('/design', gate)
      ? commands.map((c) =>
          c.name === 'design'
            ? { ...c, warning: 'Claude Design is off. Sending it will offer to turn it on.' }
            : c,
        )
      : commands;

  return { send, banner, annotate };
}
