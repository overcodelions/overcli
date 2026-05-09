export function EasterEggBubble({ text, from }: { text: string; from: string }) {
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[75%] rounded-2xl px-3.5 py-2 select-text"
        style={{
          background:
            'linear-gradient(135deg, rgba(168, 132, 255, 0.18), rgba(124, 139, 255, 0.14))',
          border: '1px solid rgba(186, 156, 255, 0.38)',
          boxShadow: '0 0 22px rgba(168, 132, 255, 0.18)',
        }}
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-[#cbb6ff] mb-0.5 flex items-center gap-1.5">
          <span>🕹️</span>
          <span>{from}</span>
          <span className="text-ink-faint normal-case tracking-normal">· local only</span>
        </div>
        <div className="text-sm whitespace-pre-wrap">{text}</div>
      </div>
    </div>
  );
}
