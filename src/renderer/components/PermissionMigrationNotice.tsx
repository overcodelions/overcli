import { useStore } from '../store';

export function PermissionMigrationNotice() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  if (!settings.permissionDefaultMovedFromPlan) return null;
  const save = (restore = false) => void saveSettings({
    ...settings,
    ...(restore ? { defaultPermissionMode: 'plan' as const } : {}),
    permissionDefaultMovedFromPlan: false,
  });
  return <div className="px-3 py-2 text-sm bg-amber-100 text-amber-950 flex items-center gap-2">
    <span>Your default changed from Plan to Auto. Auto can make changes.</span>
    <button className="underline" onClick={() => save()}>Keep Auto</button>
    <button className="underline" onClick={() => save(true)}>Restore Plan</button>
  </div>;
}
