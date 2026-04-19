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
    <div className="flex flex-col gap-1.5">
      <div
        className="text-[10px] uppercase tracking-wider font-medium"
        style={{ color: tint }}
      >
        {label.join(' · ')}
        {info.isRunning && <span className="ml-2 text-ink-faint normal-case tracking-normal">· thinking…</span>}
      </div>
      {info.thinking && (
        <details className="rounded-lg text-[11px] italic text-ink-muted px-3 py-1.5 border border-card bg-card">
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
        <div
          className="relative rounded-lg overflow-hidden"
          style={{
            border: `1px solid ${tint}30`,
            background: 'rgba(255,255,255,0.02)',
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
