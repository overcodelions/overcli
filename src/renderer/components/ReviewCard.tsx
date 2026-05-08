import { ReviewInfo } from '@shared/types';
import { backendColor, backendName } from '../theme';
import { Markdown } from './Markdown';
import { useStore } from '../store';

export function ReviewCard({ info }: { info: ReviewInfo }) {
  const openFile = useStore((s) => s.openFile);
  const tint = backendColor(info.backend as any);
  const label = [backendName(info.backend as any), info.mode === 'collab' ? 'collab' : 'review'];
  if (info.mode === 'collab') label.push(`round ${info.round}`);

  return (
    // Indent the whole card so it visually nests under the primary
    // turn it's commenting on — easy to scan as a meta-comment vs.
    // another primary bubble. The subtle background wash + rounded
    // corners group everything (label, activity, thinking, verdict,
    // raw) into one visible "review section" so it reads as a single
    // sub-thread instead of a stack of loose elements.
    <div className="flex flex-col gap-1.5 ml-6 rounded-xl bg-white/[0.02] p-3">
      <div
        className="text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5"
        style={{ color: tint }}
      >
        {/* "↩" prefix signals "reply to the primary turn above" — gives
            the card a recognizable shape regardless of CLI color. */}
        <span className="text-ink-faint">↩</span>
        <span>{label.join(' · ')}</span>
        {info.isRunning && (
          <span className="ml-1 text-ink-faint normal-case tracking-normal">· thinking…</span>
        )}
      </div>
      {info.toolActivity && info.toolActivity.length > 0 && (
        // Live tool activity strip — surfaced so users see the reviewer
        // actually doing work (Read, Grep, Bash) rather than just a
        // spinner. Auto-collapses to the most recent few lines while
        // running, expandable to see them all. Once the review is done
        // it stays visible as proof-of-work alongside the verdict.
        <details
          open={info.isRunning}
          className="rounded-lg text-[11px] text-ink-muted px-3 py-1.5 border border-card bg-card"
        >
          <summary className="cursor-pointer text-ink-faint text-[10px] uppercase tracking-wider">
            {info.backend} activity ({info.toolActivity.length})
          </summary>
          <div className="mt-1 flex flex-col gap-0.5 font-mono text-[10px] select-text">
            {info.toolActivity.map((line, i) => (
              <div key={i} className="truncate text-ink-muted/80">
                {line}
              </div>
            ))}
          </div>
        </details>
      )}
      {info.thinking && (
        // Open by default so the user actually sees the model worked,
        // not just the final verdict. Collapsible if they want to hide
        // it. Matches codex's "narration above the verdict" pattern.
        <details
          open
          className="rounded-lg text-[11px] italic text-ink-muted px-3 py-1.5 border border-card bg-card"
        >
          <summary className="cursor-pointer text-ink-faint text-[10px] uppercase tracking-wider">
            {info.backend} thinking
          </summary>
          <div className="mt-1 whitespace-pre-wrap select-text">{info.thinking}</div>
        </details>
      )}
      {info.error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/8 px-3 py-2 text-xs text-red-300">
          {info.error}
        </div>
      ) : info.text ? (
        // Same visual treatment as a primary assistant bubble
        // (tint-mixed border + background + 2px accent strip). The
        // review's "this is a sub-thread" framing already comes from
        // the wash + indent + ↩ above; the verdict text itself just
        // wants to read as a regular response.
        <div
          className="relative rounded-xl overflow-hidden"
          style={{
            background: `color-mix(in srgb, ${tint} 5%, transparent)`,
            border: `1px solid color-mix(in srgb, ${tint} 18%, transparent)`,
          }}
        >
          <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: tint + 'cc' }} />
          <div className="px-4 py-2.5 pl-[14px]">
            <Markdown source={info.text} onOpenPath={(p) => openFile(p)} />
          </div>
        </div>
      ) : info.isRunning ? (
        <div className="text-xs text-ink-faint italic">waiting for {info.backend}…</div>
      ) : (
        <div className="text-xs text-ink-faint">(no output)</div>
      )}
      {info.raw && info.raw !== info.text && !info.isRunning && (
        <details className="rounded-lg text-[11px] text-ink-muted px-3 py-1 border border-card bg-card">
          <summary className="cursor-pointer text-ink-faint text-[10px] uppercase tracking-wider">
            show raw
          </summary>
          <pre className="mt-1.5 whitespace-pre-wrap break-words select-text font-mono text-[11px] text-ink-muted">
            {info.raw}
          </pre>
        </details>
      )}
    </div>
  );
}
