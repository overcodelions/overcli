export function SystemNotice({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-200 select-text">
      <span className="mr-1">↯</span>
      {text}
    </div>
  );
}
