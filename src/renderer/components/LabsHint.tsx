import { useMemo } from 'react';
import { useStore } from '../store';
import { LABS, labOn } from '@shared/labs';
import { LABS_HINT_SNOOZE_MS, shouldShowLabsHint } from '@shared/labsHint';

/// A one-time card on the start page for anyone whose Labs are off: without
/// it, a newcomer would never learn that scheduled agents, the orchestrator
/// or model comparison exist. A card rather than a line of text because it
/// has to be noticed once; not a modal, because it must never be in the way.
/// "See Labs" retires it; "Not now" brings it back once, a week later. Labs
/// stays reachable any time from Settings and from ⌘K ("Labs…").
export function LabsHint() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const openSheet = useStore((s) => s.openSheet);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const timestamps = useMemo(
    () => [
      ...projects.flatMap((p) => p.conversations.map((c) => c.createdAt)),
      ...workspaces.flatMap((w) => (w.conversations ?? []).map((c) => c.createdAt)),
    ],
    [projects, workspaces],
  );

  const off = LABS.filter(({ key }) => !labOn(settings.labs, key));
  const show = shouldShowLabsHint({
    anyLabOff: off.length > 0,
    seen: settings.seenLabsHint,
    snoozedUntil: settings.labsHintSnoozedUntil,
    conversationTimestamps: timestamps,
    now: Date.now(),
  });
  if (!show) return null;

  const retire = () => void saveSettings({ ...settings, seenLabsHint: true });
  // Once: a second "Not now" means not ever.
  const snooze = () =>
    settings.labsHintSnoozedUntil
      ? retire()
      : void saveSettings({ ...settings, labsHintSnoozedUntil: Date.now() + LABS_HINT_SNOOZE_MS });

  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-left">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-ink">There's more when you want it</div>
          <div className="text-[11px] text-ink-muted mt-0.5">
            Switched off to keep things simple. Turn any of them on in Settings → Labs.
          </div>
        </div>
        <button
          onClick={snooze}
          className="shrink-0 px-2.5 py-1 rounded text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
        >
          Not now
        </button>
        <button
          onClick={() => {
            retire();
            openSheet({ type: 'settings', section: 'labs' });
          }}
          className="shrink-0 px-2.5 py-1 rounded text-xs border bg-accent/30 border-accent/60 text-accent hover:bg-accent/40"
        >
          See Labs
        </button>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {off.map((lab) => (
          <div key={lab.key} className="text-[11px] leading-snug">
            <span className="text-ink font-medium">{lab.label}</span>
            <span className="text-ink-muted"> — {lab.pitch}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
