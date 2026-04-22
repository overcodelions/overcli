export function MetaReminder({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <div
        className="max-w-[85%] rounded-md border px-3 py-1.5 text-[11px] italic select-text"
        style={{
          background: 'rgba(148, 163, 184, 0.06)',
          borderColor: 'rgba(148, 163, 184, 0.18)',
          color: 'rgb(148 163 184)',
        }}
        title="Injected by the Claude Agent SDK harness, not typed by you"
      >
        <span className="mr-1.5 not-italic opacity-70">⟐ harness reminder</span>
        {text}
      </div>
    </div>
  );
}
