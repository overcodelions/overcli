// Settings → Auto-tidy. The rules behind Clean up.
//
// Cleaning up by hand is the symptom. A worker on a nightly cadence makes a
// worktree a night forever, so any surface that only lets you clear the pile
// is a surface you visit again next week. These rules decide which finished
// work has earned its exit, and Clean up applies them as a selection you
// confirm — deliberately NOT as an unattended background delete.

import { useStore } from '../../store';
import { Group, SheetActionButton } from './settingsChrome';
import {
  CleanupRules,
  DEFAULT_CLEANUP_RULES,
  KEEP_CHOICES,
  RETIRE_DAY_CHOICES,
  WARN_CHOICES,
  describeRules,
} from '@shared/cleanupRules';

export function AutoTidyPane() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const openSheet = useStore((s) => s.openSheet);
  const rules = settings.cleanup ?? DEFAULT_CLEANUP_RULES;

  const update = (patch: Partial<CleanupRules>) =>
    void saveSettings({ ...settings, cleanup: { ...rules, ...patch } });

  return (
    <div className="space-y-5">
      <Group
        title="Auto-tidy"
        description="Which finished worktrees Clean up offers to retire on its own. Nothing is ever removed without the confirm step — these rules decide what arrives pre-ticked."
      >
        <Row
          label="Retire a finished worktree"
          help="Once its shift or run ended, its branch is merged into the base, and nothing is uncommitted."
        >
          <Choices
            options={RETIRE_DAY_CHOICES.map((d) => ({
              value: d,
              label: d === 0 ? 'Never' : d === 1 ? 'Next day' : `After ${d}d`,
            }))}
            value={rules.retireAfterDays}
            onChange={(v) => update({ retireAfterDays: v })}
          />
        </Row>

        <Row
          label="Keep the last few per worker or flow"
          help="Recent shifts stay reopenable however old they get. Older ones retire on the rule above."
        >
          <Choices
            options={KEEP_CHOICES.map((n) => ({ value: n, label: String(n) }))}
            value={rules.keepPerProducer}
            onChange={(v) => update({ keepPerProducer: v })}
          />
        </Row>

        <Row
          label="Warn me when a producer runs away"
          help="A worker or schedule holding more than this many worktrees gets called out at the top of Clean up."
        >
          <Choices
            options={WARN_CHOICES.map((n) => ({ value: n, label: n === 0 ? 'Off' : String(n) }))}
            value={rules.warnAtCount}
            onChange={(v) => update({ warnAtCount: v })}
          />
        </Row>

        <div className="text-[11px] text-ink-muted border-t border-card pt-3">
          {describeRules(rules)}
        </div>
      </Group>

      <Group
        title="Never at risk"
        description="Two things no rule here can do, whatever you set above."
      >
        <div className="text-xs text-ink-muted flex flex-col gap-2">
          <div>
            <span className="text-ink">Work is never retired on a timer.</span> A worktree holding
            uncommitted files or commits that aren&rsquo;t merged into its base is left for you to
            decide about, however old it gets.
          </div>
          <div>
            <span className="text-ink">Nothing is deleted in the background.</span> Auto-tidy picks
            the rows; removing them is still a click and a confirm step in Clean up.
          </div>
        </div>
        <div>
          <SheetActionButton
            primary
            label="Open Clean up"
            onClick={() => openSheet({ type: 'cleanup' })}
          />
        </div>
      </Group>
    </div>
  );
}

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-ink">{label}</div>
        <div className="text-[11px] text-ink-faint mt-0.5">{help}</div>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Choices({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: number; label: string }>;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-0.5 p-0.5 rounded bg-card w-fit">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={
            'text-[11px] px-2 py-0.5 rounded ' +
            (value === o.value ? 'bg-accent/30 text-accent' : 'text-ink-muted hover:text-ink')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
