import { useState } from 'react';

/// The copy pair every markdown surface in the app carries.
///
/// `copy` yields what you can READ — the rendered text, so a pasted plan
/// arrives as prose rather than a wall of asterisks. `copy raw` yields the
/// markdown that produced it, for pasting somewhere that will render it
/// again. Which one does which is the sort of detail that drifts when three
/// components each grow their own pair, so there is one implementation.
///
/// `getPlain` is a thunk rather than a string because the rendered text only
/// exists once the DOM does — callers pass `() => ref.current?.innerText ?? raw`.
export function CopyActions({
  getPlain,
  raw,
  className = '',
}: {
  getPlain: () => string;
  raw: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<'plain' | 'raw' | null>(null);

  const copy = (kind: 'plain' | 'raw', text: string) => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1200);
  };

  const button =
    'flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors ';
  const tone = (active: boolean) =>
    active ? 'text-accent' : 'text-ink-faint hover:bg-card-strong hover:text-ink';

  return (
    <div className={'flex items-center gap-0.5 ' + className}>
      <button
        onClick={() => copy('plain', getPlain())}
        className={button + tone(copied === 'plain')}
      >
        {copied === 'plain' ? 'copied' : 'copy'}
      </button>
      <button onClick={() => copy('raw', raw)} className={button + tone(copied === 'raw')}>
        {copied === 'raw' ? 'copied' : 'copy raw'}
      </button>
    </div>
  );
}
