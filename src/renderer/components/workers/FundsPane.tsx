// The roster's money, as a waterfall.
//
// Every worker used to carry its own monthly budget and nothing carried the
// sum, so the only number that actually mattered — what the whole crew can
// spend this month — existed nowhere and was never approved. And the roster's
// up/down arrows moved names around without moving anything real, which is why
// arranging the list felt like tidying rather than deciding.
//
// This screen is both fixes at once. One pot at the top, and under it the
// roster in priority order with the pot draining down it: each worker is
// funded to its own cap, and what it does not claim falls to the next. So the
// list you drag is the list the money follows, and moving somebody up is a
// budget decision you can watch land.
//
// What the drawing has to make obvious, in order:
//   - THE POT IS ONE NUMBER. Big, editable, at the top. The per-worker caps
//     are ceilings, not allocations — this is the one you defend.
//   - HEIGHT IS PRIORITY, AND PRIORITY IS FUNDING. The rows are the queue.
//   - THE WATERLINE. Each row shows where the pot ran out relative to it, so
//     "everything below here is unfunded" is a place on the screen rather than
//     six statuses you read one at a time.
//   - STARVED IS NOT BROKE. A worker stopped by the POOL is a decision you can
//     reverse (move it up, pause someone above, raise the pot); a worker
//     stopped by its OWN cap is done for the month. Different colours,
//     different sentences.
//
// The order is DRAGGED, because a queue you rearrange by nudging rows one
// place at a time is a queue you stop rearranging: moving someone from sixth
// to first was five clicks and five re-renders, and the thing you were trying
// to express — "this one matters most" — is a single gesture. The arrows stay
// for the keyboard, revealed on hover or focus, since a drag-only list cannot
// be reordered without a mouse.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useWorkersStore } from '../../workersStore';
import {
  describeFundingBlock,
  type FundingBlock,
  type TreasuryAllocation,
  type WorkerFunding,
} from '@shared/flows/treasury';
import type { Worker } from '@shared/flows/worker';
import { WorkerAvatar } from './WorkerAvatar';

const money = (n: number) => `$${n.toFixed(2)}`;
/// Whole dollars where the cents are noise — the pot, and a cap nobody sets in
/// fractions. Spend keeps its cents, because that is a measurement.
const dollars = (n: number) => `$${Math.round(n)}`;

const BLOCK_TONE: Record<FundingBlock, string> = {
  none: 'text-ink-muted',
  cap: 'text-ink-faint',
  pool: 'text-amber-500',
  paused: 'text-ink-faint',
};

export function FundsPane() {
  const workers = useWorkersStore((s) => s.workers);
  const treasury = useWorkersStore((s) => s.treasury);
  const allocation = useWorkersStore((s) => s.allocation);
  const setTreasury = useWorkersStore((s) => s.setTreasury);
  const moveWorker = useWorkersStore((s) => s.moveWorker);
  const dropWorker = useWorkersStore((s) => s.dropWorker);
  const selectWorker = useWorkersStore((s) => s.selectWorker);

  /// The row being dragged, and the GAP it would land in — an index between
  /// rows, so `dropAt === rows.length` is "below everyone". Kept as a gap
  /// rather than as a target row because that is what the indicator draws and
  /// what `placeInRoster` consumes; translating between the two in two places
  /// is how a drop lands one row off.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const endDrag = () => {
    setDragId(null);
    setDropAt(null);
  };

  const commitDrop = () => {
    if (dragId && dropAt != null) void dropWorker(dragId, dropAt);
    endDrag();
  };

  if (!treasury || !allocation) {
    return <div className="px-6 text-sm text-ink-muted">Counting the money…</div>;
  }

  const rows = allocation.byWorker;
  const starved = rows.filter((f) => f.blocked === 'pool');
  // What the enabled roster still has claim on. Above the pot's remainder,
  // this is the overcommitment — the number that says the waterfall is doing
  // something rather than sitting idle.
  const committed = rows
    .filter((f) => f.enabled)
    .reduce((total, f) => total + Math.max(0, f.capUSD - f.spentUSD), 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
      <PotHeader
        allocation={allocation}
        committed={committed}
        onSet={(monthlyUSD) => void setTreasury(monthlyUSD)}
      />

      {rows.length === 0 ? (
        <div className="mt-6 text-sm text-ink-muted">
          Nobody is hired yet, so the pot is untouched.
        </div>
      ) : (
        <>
          <div className="mt-7 flex items-baseline gap-2">
            <div className="text-[11px] uppercase tracking-wider text-ink-faint">
              Funding order
            </div>
            <div className="text-xs text-ink-muted">
              paid top down — each worker draws up to its cap, the rest falls
              through. Drag a row to change who gets paid first.
            </div>
          </div>

          {/* The list owns dragover/drop as well as the rows, so releasing in
              the padding between two rows — or below the last one — still
              lands somewhere rather than silently cancelling. */}
          <div
            className="relative mt-2 border-y border-card-strong"
            onDragOver={(e) => {
              if (dragId) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!dragId) return;
              e.preventDefault();
              commitDrop();
            }}
            onDragLeave={(e) => {
              // Only when the pointer leaves the LIST, not when it crosses
              // between two rows inside it.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
            }}
          >
            {rows.map((funding, index) => {
              const worker = workers[funding.workerId];
              if (!worker) return null;
              return (
                <FundingRow
                  key={funding.workerId}
                  worker={worker}
                  funding={funding}
                  allocation={allocation}
                  index={index}
                  last={index === rows.length - 1}
                  dragging={dragId === funding.workerId}
                  dropBefore={dropAt === index}
                  dropAfter={index === rows.length - 1 && dropAt === rows.length}
                  canMoveUp={index > 0}
                  canMoveDown={index < rows.length - 1}
                  onMove={(direction) => void moveWorker(funding.workerId, direction)}
                  onOpen={() => selectWorker(funding.workerId)}
                  onDragStart={() => {
                    setDragId(funding.workerId);
                    setDropAt(index);
                  }}
                  onDragOverRow={(before) => setDropAt(before)}
                  onDragEnd={endDrag}
                />
              );
            })}
          </div>

          {starved.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs text-ink-muted">
              <span className="text-amber-500">
                {starved.length} worker{starved.length === 1 ? '' : 's'} below
                the waterline.
              </span>{' '}
              {starved.map((f) => f.name).join(', ')}{' '}
              {starved.length === 1 ? 'gets' : 'get'} nothing this month until
              the pot goes up, somebody above{' '}
              {starved.length === 1 ? 'it' : 'them'} is paused, or{' '}
              {starved.length === 1 ? 'it moves' : 'they move'} up the order.
              Shifts skip quietly rather than failing — the desk journals why.
            </div>
          )}

          <p className="mt-5 max-w-2xl text-xs leading-relaxed text-ink-faint">
            A worker&apos;s unspent cap is held for it, not handed down — so the
            worker that runs your morning can&apos;t be starved by the one that
            tidies changelogs, whatever order they happen to burn money in. Cap
            spent, reserve gone: what it no longer needs falls through the same
            month.
          </p>
        </>
      )}
    </div>
  );
}

/// The pot. An editable number and one bar, because the pot has exactly three
/// states worth seeing at a glance — spent, still claimed, genuinely free.
function PotHeader({
  allocation,
  committed,
  onSet,
}: {
  allocation: TreasuryAllocation;
  committed: number;
  onSet: (monthlyUSD: number) => void;
}) {
  const [text, setText] = useState(String(allocation.poolUSD));
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  // Follow main unless the user is mid-edit — a `treasuryUpdate` landing
  // because some run finished must not rewrite the number being typed.
  useEffect(() => {
    if (!editing) setText(String(allocation.poolUSD));
  }, [allocation.poolUSD, editing]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    const next = Number(text);
    if (!Number.isFinite(next) || next <= 0) {
      setText(String(allocation.poolUSD));
      return;
    }
    if (next !== allocation.poolUSD) onSet(next);
  };

  const pool = Math.max(allocation.poolUSD, 0.01);
  const spentPct = Math.min(100, (allocation.spentUSD / pool) * 100);
  // Claimed is drawn on top of spent, and clipped to what's actually left —
  // a roster whose caps exceed the pot shows a FULL bar, which is the honest
  // picture: there is no free money, there is a queue.
  const claimedPct = Math.min(
    100 - spentPct,
    (Math.min(committed, allocation.remainingUSD) / pool) * 100,
  );
  const free = Math.max(0, allocation.remainingUSD - committed);

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">
          The pot
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-lg text-ink-muted">$</span>
          <input
            type="number"
            min={1}
            step={5}
            value={text}
            onFocus={() => setEditing(true)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                cancelled.current = true;
                setEditing(false);
                setText(String(allocation.poolUSD));
                e.currentTarget.blur();
              }
            }}
            aria-label="Monthly pool for all workers"
            className="w-24 border-b border-card-strong bg-transparent pb-0.5 text-2xl font-semibold tabular-nums text-ink outline-none focus:border-accent"
          />
          <span className="text-sm text-ink-muted">/ month, all workers</span>
        </div>
      </div>

      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-card-strong">
        <div className="h-full bg-accent" style={{ width: `${spentPct}%` }} />
        <div
          className="h-full"
          style={{
            width: `${Math.max(0, claimedPct)}%`,
            background: 'color-mix(in srgb, var(--c-accent) 35%, transparent)',
          }}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted">
        <span>
          <span className="tabular-nums text-ink">
            {money(allocation.spentUSD)}
          </span>{' '}
          spent this month
        </span>
        <span>
          <span className="tabular-nums text-ink">
            {money(Math.min(committed, allocation.remainingUSD))}
          </span>{' '}
          claimed by caps
        </span>
        <span>
          <span className="tabular-nums text-ink">{money(free)}</span>{' '}
          unclaimed
        </span>
      </div>
    </div>
  );
}

function FundingRow({
  worker,
  funding,
  allocation,
  index,
  last,
  dragging,
  dropBefore,
  dropAfter,
  canMoveUp,
  canMoveDown,
  onMove,
  onOpen,
  onDragStart,
  onDragOverRow,
  onDragEnd,
}: {
  worker: Worker;
  funding: WorkerFunding;
  allocation: TreasuryAllocation;
  index: number;
  last: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onOpen: () => void;
  onDragStart: () => void;
  onDragOverRow: (insertBefore: number) => void;
  onDragEnd: () => void;
}) {
  const explanation = useMemo(
    () => describeFundingBlock(funding, allocation),
    [funding, allocation],
  );
  // The row's own bar is scaled to its CAP, not to the pot: the question a row
  // answers is "how much of what this worker was promised has it got", and
  // scaling six rows to a shared pot makes the small ones unreadable.
  const cap = Math.max(funding.capUSD, 0.01);
  const spentPct = Math.min(100, (funding.spentUSD / cap) * 100);
  const availablePct = Math.min(100 - spentPct, (funding.availableUSD / cap) * 100);

  return (
    <div
      draggable
      onDragStart={(e) => {
        // Required for the drag to start at all in some engines; the payload
        // itself is unused — the dragged id lives in React state, which is
        // the only place a dragover handler can read it mid-drag anyway.
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', worker.id);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Top half means "above this row", bottom half "below it". Without
        // the halves you can never express the last slot, and every drop
        // biases one row upward.
        const box = e.currentTarget.getBoundingClientRect();
        onDragOverRow(e.clientY < box.top + box.height / 2 ? index : index + 1);
      }}
      onDragEnd={onDragEnd}
      className={
        'group/row relative flex items-center gap-3 py-2 ' +
        (last ? '' : 'border-b border-card-strong ') +
        // The dragged row stays in place and dims rather than being removed:
        // a list that reflows under the cursor moves the target you are
        // aiming at.
        (dragging ? 'opacity-40' : '')
      }
    >
      {/* The gap indicator. Absolutely positioned so showing it cannot shift
          the rows it sits between — the one thing a drop line must never do. */}
      {(dropBefore || dropAfter) && (
        <span
          aria-hidden
          className={
            'pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-accent ' +
            (dropAfter ? '-bottom-px' : '-top-px')
          }
        />
      )}

      {/* Grip. The whole row is draggable, but a list gives no sign of that
          without one, and the cursor change alone arrives too late. */}
      <span
        aria-hidden
        className="w-2 shrink-0 cursor-grab select-none text-[11px] leading-none text-ink-faint opacity-0 transition-opacity group-hover/row:opacity-100 active:cursor-grabbing"
      >
        ⠿
      </span>

      <div className="w-5 shrink-0 text-right text-xs tabular-nums text-ink-faint">
        {funding.priority}
      </div>

      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus:outline-none"
      >
        <WorkerAvatar worker={worker} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm text-ink group-hover/row:underline">
              {worker.name}
            </span>
            {funding.blocked !== 'none' && (
              <span className={`shrink-0 text-[10px] ${BLOCK_TONE[funding.blocked]}`}>
                {funding.blocked === 'pool'
                  ? 'below the waterline'
                  : funding.blocked === 'cap'
                    ? 'cap spent'
                    : 'paused'}
              </span>
            )}
          </div>
          {/* Cap-scaled: solid is spent, translucent is what it may still
              draw. A gap on the right is the pot failing to reach it. */}
          <div className="mt-1 flex h-1 overflow-hidden rounded-full bg-card-strong">
            <div
              className="h-full"
              style={{
                width: `${spentPct}%`,
                background:
                  funding.blocked === 'pool'
                    ? 'var(--c-ink-faint)'
                    : 'var(--c-accent)',
              }}
            />
            <div
              className="h-full"
              style={{
                width: `${Math.max(0, availablePct)}%`,
                background: 'color-mix(in srgb, var(--c-accent) 30%, transparent)',
              }}
            />
          </div>
          <div className={`mt-1 text-[11px] ${BLOCK_TONE[funding.blocked]}`}>
            {explanation}
          </div>
        </div>
      </button>

      <div className="shrink-0 text-right">
        <div className="text-sm tabular-nums text-ink">
          {funding.funded ? money(funding.availableUSD) : '—'}
        </div>
        <div className="text-[10px] text-ink-faint">
          available of {dollars(funding.capUSD)}
        </div>
      </div>

      {/* The keyboard path. Dragging is the primary gesture on this screen, so
          these recede until you reach for them — but they stay, because a
          drag-only list cannot be reordered without a mouse. */}
      <div className="flex shrink-0 flex-col opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
        <MoveButton
          label={`Fund ${worker.name} sooner`}
          glyph="▲"
          disabled={!canMoveUp}
          onClick={() => onMove(-1)}
        />
        <MoveButton
          label={`Fund ${worker.name} later`}
          glyph="▼"
          disabled={!canMoveDown}
          onClick={() => onMove(1)}
        />
      </div>
    </div>
  );
}

function MoveButton({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded px-1 text-[9px] leading-[1.1] text-ink-faint hover:bg-card-strong hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
    >
      {glyph}
    </button>
  );
}
