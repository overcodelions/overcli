// Settings → Auto-tidy. The rules behind Clean up.
//
// Cleaning up by hand is the symptom. A worker on a nightly cadence makes a
// worktree a night forever, so any surface that only lets you clear the pile
// is a surface you visit again next week. These rules decide which finished
// work has earned its exit. With "Run on its own" on (the default) they are
// applied on a timer — see cleanupScan.ts — and Clean up also offers them as
// a pre-ticked selection.

import { useState } from 'react';
import type { AppSettings } from '@shared/types';
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

/// Edits the Settings sheet's draft like every other pane — nothing is saved
/// until the sheet's Save. Saving per click here used to reset that draft,
/// throwing away unsaved edits made in the other panes.
export function AutoTidyPane({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (delta: Partial<AppSettings>) => void;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const rules = local.cleanup ?? DEFAULT_CLEANUP_RULES;

  const update = (delta: Partial<CleanupRules>) => patch({ cleanup: { ...rules, ...delta } });
  /// Turning removal on unattended is the one choice here that deletes
  /// things later without asking, so it takes a second, explicit yes.
  const [confirmingOn, setConfirmingOn] = useState(false);
  const autoRunValue = rules.autoRun === true ? 1 : rules.autoRun === false ? 0 : 2;

  return (
    <div className="space-y-5">
      <Group
        title="Auto-tidy"
        description="Which finished worktrees retire on their own. Only clean, merged worktrees are ever touched; the same rules decide what arrives pre-ticked in Clean up."
      >
        <Row
          label="Run on its own"
          help="Checks a few minutes after launch, then every six hours. Ask first shows what is due and waits for a yes; On retires it without asking; Off means the rules only pre-tick rows in Clean up."
        >
          <Choices
            options={[
              { value: 2, label: 'Ask first' },
              { value: 1, label: 'On' },
              { value: 0, label: 'Off' },
            ]}
            value={autoRunValue}
            onChange={(v) => {
              if (v === 1 && rules.autoRun !== true) {
                setConfirmingOn(true);
                return;
              }
              setConfirmingOn(false);
              update({ autoRun: v === 2 ? undefined : v === 1 });
            }}
          />
        </Row>
        {confirmingOn && (
          <div className="text-xs text-amber-800 dark:text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 flex items-center gap-3">
            <span className="flex-1">
              Retire finished worktrees without asking? Only clean, merged ones past the rule below
              are removed; chats keep their conversation and every branch is kept.
            </span>
            <SheetActionButton
              primary
              label="Turn on"
              onClick={() => {
                setConfirmingOn(false);
                update({ autoRun: true });
              }}
            />
            <SheetActionButton label="Cancel" onClick={() => setConfirmingOn(false)} />
          </div>
        )}

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
            <span className="text-ink">No conversation is deleted in the background.</span> When
            auto-tidy retires a chat&rsquo;s worktree it releases the tree and keeps the
            conversation, and it always keeps the branch.
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
