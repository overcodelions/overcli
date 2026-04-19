import { ResultInfo } from '@shared/types';
import { useStore } from '../store';

export function TurnCaption({ info }: { info: ResultInfo }) {
  const showCost = useStore((s) => s.settings.showCost);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const u of Object.values(info.modelUsage)) {
    input += u.inputTokens;
    output += u.outputTokens;
    cacheRead += u.cacheReadInputTokens;
  }
  // When codex/gemini don't report usage this event becomes
  // "$0.0000 · 0.0s · in 0 · out 0 · cache 0" which is pure noise.
  // Skip the row unless we have at least one meaningful number —
  // errors always render so a failure isn't silently dropped.
  const hasUsage = input > 0 || output > 0 || cacheRead > 0;
  const hasDuration = info.durationMs > 0;
  const hasCost = info.totalCostUSD > 0;
  if (!info.isError && !hasUsage && !hasDuration && !hasCost) return null;

  const parts: string[] = [];
  if (showCost && hasCost) parts.push(`$${info.totalCostUSD.toFixed(4)}`);
  if (hasDuration) parts.push(`${(info.durationMs / 1000).toFixed(1)}s`);
  if (hasUsage) parts.push(`in ${input} · out ${output} · cache ${cacheRead}`);
  const label = parts.join(' · ');
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-ink-faint">
      <span className={info.isError ? 'text-red-400' : 'text-green-400'}>
        {info.isError ? '✗' : '✓'}
      </span>
      {label && <span>{label}</span>}
    </div>
  );
}
