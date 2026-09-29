import { useMemo, useState } from 'react';
import type { Backend, UUID } from '@shared/types';
import {
  CLAUDE_IN_CHROME_URL,
  isBrowserMcpName,
  lastChromeToolFailure,
} from '@shared/claudeChrome';
import { useStore } from '../store';
import { useRunnerEvents } from '../runnersStore';

// What "let it use a browser" actually needs, per backend.
//
// The switch means different things underneath: Claude attaches the Claude
// in Chrome extension, Codex gets network access inside its sandbox and
// drives pages through a browser MCP server if one is configured. Both
// have a setup step outside overcli, and the setting used to flip with no
// word about it — so a Codex worker failed every fetch, and a Claude one
// failed until someone happened to find the extension.

function openExternal(url: string) {
  void window.overcli.invoke('app:openExternal', url);
}

export function BrowserSetupHint({ backends }: { backends: Backend[] }) {
  const capabilities = useStore((s) => s.capabilities);
  const openSheet = useStore((s) => s.openSheet);
  const hasClaude = backends.includes('claude');
  const hasCodex = backends.includes('codex');
  const others = backends.filter((b) => b !== 'claude' && b !== 'codex');
  const codexBrowserMcp = (capabilities?.entries ?? []).find(
    (e) => e.kind === 'mcp' && e.clis.includes('codex') && isBrowserMcpName(e.name),
  );
  return (
    <div className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-ink-faint">
      {hasClaude && (
        <div>
          <span className="text-ink-muted">Claude</span> drives your real Chrome through the Claude
          in Chrome extension. Install it in the Chrome profile you browse in, sign in with the
          same Claude account, and keep Chrome open while it works.{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-ink"
            onClick={() => openExternal(CLAUDE_IN_CHROME_URL)}
          >
            Get the extension
          </button>
        </div>
      )}
      {hasCodex && (
        <div>
          <span className="text-ink-muted">Codex</span> can&rsquo;t use the Chrome extension. It
          gets network access instead, so it can fetch pages.{' '}
          {codexBrowserMcp ? (
            <>
              To click through a site it will use{' '}
              <span className="text-ink-muted">{codexBrowserMcp.name}</span>.
            </>
          ) : (
            <>
              To click buttons or fill forms it needs a browser server.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => openSheet({ type: 'capabilities' })}
              >
                Add Puppeteer in Extensions
              </button>
            </>
          )}
        </div>
      )}
      {others.length > 0 && (
        <div>
          {others.join(', ')} can&rsquo;t browse from overcli. Use Claude or Codex for the steps
          that need the web.
        </div>
      )}
    </div>
  );
}

/// Shown above the composer when the turn's last Claude in Chrome call
/// failed. The model usually reports the failure in its own words, which
/// rarely includes "install the extension" — this is the part it can't say.
export function ChromeToolFailureNotice({ conversationId }: { conversationId: UUID }) {
  const events = useRunnerEvents(conversationId);
  const failure = useMemo(() => (events ? lastChromeToolFailure(events) : null), [events]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!failure || failure.id === dismissed) return null;
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px]">
      <div className="flex items-start gap-2">
        <div className="flex-1 text-amber-700 dark:text-amber-200">
          <span className="font-medium">The browser didn&rsquo;t respond.</span> Claude in Chrome
          needs the extension installed and enabled in the Chrome profile you browse in, signed in
          to the same Claude account, with Chrome open.{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => openExternal(CLAUDE_IN_CHROME_URL)}
          >
            Get the extension
          </button>
        </div>
        <button
          type="button"
          className="text-ink-faint hover:text-ink"
          aria-label="Dismiss"
          onClick={() => setDismissed(failure.id)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
