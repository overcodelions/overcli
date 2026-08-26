// The Stream layout: one flat, newest-first list of everything you have
// worked on, instead of a tree of the places those things live.
//
// The tree is not wrong — it answers "where does this live", which is the
// right question when you are looking for something. It is just the wrong
// default, because the question you navigate by all day is "what was I
// doing". Stream answers that one, and Places (the tree) stays a click away.
//
// Going flat costs you the sense of which repo you are in, and LANES are what
// buys it back: the owner is printed once at the top of a run of consecutive
// rows that share it, never repeated per row. Three chats in the same project
// cost one label and three single-line rows — denser than the per-row
// subtitle the Working-on section uses. A day spent switching repos produces
// many labels, which is true, and worth being able to see.

import { useMemo, useState } from 'react';

import { useFlowsStore } from '../flowsStore';
import { useStore } from '../store';


import { buildStream, groupIntoLanes, type Lane } from '../sidebarStream';
import { partitionSleeping } from '../sidebarSleep';
import type { StreamEntry } from './sidebarItems';
import { ConversationRow } from './ConversationRow';
import { MomentumMeter, SleepRollup } from './SidebarAtoms';
import { FlowRunRow } from './flows/FlowRunSidebarRow';

export interface SidebarStreamProps {
  entries: StreamEntry[];
  /// Owner of whatever is on screen. Its lane gets the accent rail, so "where
  /// am I" is answered without reading a word.
  currentOwnerId: string | null;
  selectedKey: string | null;
  onOpenConversation: (id: string) => void;
  /// Absent when there is nowhere to start one (no project added yet, or the
  /// CLI is unavailable) — an empty state whose only button cannot work is
  /// worse than one that just says the place is empty.
  onNewConversation?: () => void;
  now: number;
}

// Flow rows open themselves: FlowRunRow already knows that a worker's run
// lives at its desk rather than in the Flows library, and duplicating that
// routing here is how the two would eventually disagree.
export function SidebarStream({
  entries,
  currentOwnerId,
  selectedKey,
  onOpenConversation,
  onNewConversation,
  now,
}: SidebarStreamProps) {
  const [sleepOpen, setSleepOpen] = useState(false);

  const { awake, sleeping } = useMemo(
    () => partitionSleeping(entries, (e) => ({ touchedAt: e.touchedAt, pinned: e.pinned }), { now }),
    [entries, now],
  );
  const sections = useMemo(
    () => buildStream(awake, (e) => ({ at: e.at, owner: e.owner }), now),
    [awake, now],
  );
  const sleepingLanes = useMemo(
    () => (sleepOpen ? groupIntoLanes(sleeping, (e) => e.owner) : []),
    [sleepOpen, sleeping],
  );

  const renderLane = (lane: Lane<StreamEntry>, index: number) => (
    <StreamLane
      key={`${lane.ownerId}:${index}`}
      lane={lane}
      here={lane.ownerId === currentOwnerId}
      selectedKey={selectedKey}
      onOpenConversation={onOpenConversation}
      now={now}
    />
  );

  // The empty stream is the first thing a new user sees, so "start a
  // conversation" has to be something you can press, not advice.
  if (entries.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-faint">
        Nothing here yet.
        {onNewConversation ? (
          <>
            <br />
            <button
              onClick={onNewConversation}
              className="mt-2 px-2 py-1 rounded border border-card-strong text-ink-muted hover:text-ink hover:bg-card-strong"
            >
              Start a conversation
            </button>
          </>
        ) : (
          <>
            <br />
            Start a conversation or run a flow.
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <div key={section.bucket}>
          <div className="mt-3 flex items-center gap-1.5 px-2 text-[10px] uppercase tracking-wide text-ink-faint">
            <span>{section.label}</span>
            <span className="h-px flex-1 bg-card" />
            <span className="tabular-nums opacity-70">{section.count}</span>
          </div>
          {section.lanes.map(renderLane)}
        </div>
      ))}
      {sleeping.length > 0 && (
        <div className="mt-3">
          <SleepRollup
            count={sleeping.length}
            open={sleepOpen}
            onToggle={() => setSleepOpen((v) => !v)}
          />
          {sleepOpen && sleepingLanes.map(renderLane)}
        </div>
      )}
    </>
  );
}

function StreamLane({
  lane,
  here,
  selectedKey,
  onOpenConversation,
  now,
}: {
  lane: Lane<StreamEntry>;
  here: boolean;
  selectedKey: string | null;
  onOpenConversation: (id: string) => void;
  now: number;
}) {
  // Read straight from the store rather than taking it as a prop: FlowRunRow
  // decides for itself whether an active run reads as SELECTED (a worker's
  // run counts only while you are on Workers), and it can only do that if it
  // is told which run is active, not which one the Chat tab thinks is.
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  // Recent prints the owner's name and nothing else, so the folder those rows
  // live in was reachable only from Places — you could read the project's
  // name all day with no way to open it. The label is the door: it is already
  // the one place in this layout that names the owner.
  const ownerPath = useStore((s) => ownerPathFor(lane.ownerId, s.projects, s.workspaces));
  const openExplorer = useStore((s) => s.openExplorer);
  return (
    <div className="mt-1.5">
      <div
        className={
          'flex items-center gap-1.5 px-2 pb-0.5 text-[9.5px] uppercase tracking-wider ' +
          (here ? 'text-accent' : 'text-ink-faint')
        }
      >
        {ownerPath ? (
          <button
            onClick={() => openExplorer(ownerPath)}
            title={`Browse the files in ${lane.ownerName}`}
            className="min-w-0 truncate uppercase tracking-wider hover:text-ink hover:underline"
          >
            {lane.ownerName}
          </button>
        ) : (
          <span className="min-w-0 truncate">{lane.ownerName}</span>
        )}
        <span className="h-px flex-1 bg-card" />
        <span className="flex-shrink-0 text-[8.5px] tracking-wide opacity-55">
          {lane.ownerKind === 'unknown' ? '' : lane.ownerKind}
        </span>
      </div>
      <div
        className={
          'ml-3 border-l pl-1 ' + (here ? 'border-accent/45' : 'border-card')
        }
      >
        {lane.items.map((entry) => {
          // Bound out of the entry so the narrowing survives into the click
          // closures — TS widens `entry.item` back to the union inside them.
          const item = entry.item;
          return item.kind === 'conversation' ? (
            <ConversationRow
              key={entry.key}
              conv={item.conv}
              selected={entry.key === selectedKey}
              onClick={() => onOpenConversation(item.conv.id)}
              tail={<RowTail score={entry.momentum} at={entry.at} now={now} />}
            />
          ) : (
            // The tree's own flow row, not a copy of it. It already carries
            // the state badge, double-click-and-✎ rename, and delete behind
            // the dirty guard — reimplementing those for Stream would have
            // meant two rows to keep in step, and the layout you happened to
            // be in deciding which actions a run offers.
            <FlowRunRow
              key={entry.key}
              run={item.run}
              selected={item.run.id === activeRunId}
              isLive={item.isLive}
            />
          );
        })}
      </div>
    </div>
  );
}

/// The folder behind a lane, or `undefined` when there isn't one to open.
///
/// Lane ids are owner ids, and `buildStream` mints four kinds: a project id, a
/// workspace id, `worker:<id>` for a live worker run, and `path:<dir>` for a
/// run whose folder matches no registered project. Only the first three name
/// somewhere the explorer can go — a worker's runs live in its own scratch
/// directory, which is not a place the user put anything.
export function ownerPathFor(
  ownerId: string,
  projects: readonly { id: string; path: string }[],
  workspaces: readonly { id: string; rootPath: string }[],
): string | undefined {
  if (ownerId.startsWith('path:')) return ownerId.slice('path:'.length) || undefined;
  if (ownerId.startsWith('worker:')) return undefined;
  const project = projects.find((p) => p.id === ownerId);
  if (project) return project.path;
  return workspaces.find((w) => w.id === ownerId)?.rootPath;
}

/// What a resting row says about itself on the right: a momentum meter when
/// you are actually working it, otherwise when you last did.
///
/// Never both. Two glyphs plus a name in a 300px row is how the old sidebar
/// got busy — each row gets one thing to say, and which one depends on what
/// is true of it. Liveness is deliberately absent: the row's own marker
/// already pulses, and a second live signal on the same line would be the
/// same fact twice.
function RowTail({ score, at, now }: { score: number; at: number; now: number }) {
  if (score >= 1) return <MomentumMeter score={score} />;
  return <span className="text-[9px] tabular-nums text-ink-faint">{stamp(at, now)}</span>;
}

/// Terser than `relativeTime` in workerDeskSelectors on purpose: this column
/// is a few characters wide, next to a name that wants every pixel, and it is
/// read as a glance rather than a sentence. "2h" beats "2h ago" here; "Fri"
/// beats "4d ago", because within the last week the weekday is what you
/// actually remember.
export function stamp(at: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days <= 6) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
  if (days < 365) return `${days}d`;
  return `${Math.round(days / 365)}y`;
}
