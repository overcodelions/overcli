// What "set this on all of them" would actually do, service by service.
//
// The bulk controls this replaces each reported afterwards, in a toast: you
// switched, and then learned that three of the eight had no such branch. The
// modal owes an answer before the click, so the whole plan is computed here —
// pure, off the store — and the same plan is what the apply walks.
//
// Two ideas run through it:
//
//   A field left alone is never written. `undefined` on an edit is not "clear
//   it", it is "do not touch it", which is what makes it safe to open this on
//   sixteen services to change one thing.
//
//   Set the shape, keep the specifics. `reload` writes a mode and keeps each
//   service's own watch globs; `ready` writes a probe shape and keeps each
//   service's own port. Both fields look per-service and are not, and that is
//   exactly why they need saying out loud.

import type { ReadinessProbe, ServiceSpec } from '@shared/services';
import { reloadModeOf, watchForMode, type ReloadMode } from './serviceReloadMode';

/// A probe without the part that belongs to the service. The port is never
/// chosen here: it comes from whatever each service already answers on.
export type ReadyShape =
  | { kind: 'http'; path: string }
  | { kind: 'tcp' }
  | { kind: 'log'; pattern: string }
  | { kind: 'none' };

export type FieldKey = 'branch' | 'pin' | 'reload' | 'group' | 'ready';

/// What the user set. Every field is optional, and absent means untouched.
export interface BulkEdits {
  ref?: string;
  /// Pin the services that can reach `ref` to it. Only meaningful with `ref`.
  pin?: boolean;
  reload?: ReloadMode;
  /// `''` clears the group; `undefined` leaves it alone. The two are
  /// different answers and the type has to keep them apart.
  group?: string;
  ready?: ReadyShape;
}

/// One service, with the repo knowledge the plan needs already resolved —
/// worktrees are read once per checkout by the caller, not once per service.
export interface BulkService {
  key: string;
  name: string;
  spec: Pick<ServiceSpec, 'selfReloads' | 'watch' | 'group' | 'ready' | 'port' | 'pinnedRef'>;
  /// The branch this service is on now.
  ref?: string;
  /// Refs that exist in THIS service's repository.
  reachableRefs: readonly string[];
}

export interface RowChange {
  field: FieldKey;
  now: string;
  after: string;
}

/// Why a field cannot be written to this service. Said before the apply, in
/// the row it belongs to — not afterwards, in a count.
export interface RowBlock {
  field: FieldKey;
  reason: string;
}

export interface BulkRow {
  key: string;
  name: string;
  changes: RowChange[];
  blocks: RowBlock[];
}

export interface BulkPlan {
  rows: BulkRow[];
  /// Rows with at least one change. What the apply button counts.
  changing: number;
  /// In the selection, already as asked, nothing to write.
  unchanged: number;
  /// Held back by a pin, a missing branch or a missing port.
  blocked: number;
}

export function planBulkEdit(services: readonly BulkService[], edits: BulkEdits): BulkPlan {
  const rows = services.map((service) => planOne(service, edits));
  return {
    rows,
    changing: rows.filter((r) => r.changes.length > 0).length,
    unchanged: rows.filter((r) => r.changes.length === 0 && r.blocks.length === 0).length,
    blocked: rows.filter((r) => r.blocks.length > 0).length,
  };
}

function planOne(service: BulkService, edits: BulkEdits): BulkRow {
  const changes: RowChange[] = [];
  const blocks: RowBlock[] = [];
  const { spec } = service;

  if (edits.ref !== undefined) {
    const pinnedElsewhere = spec.pinnedRef && spec.pinnedRef !== edits.ref;
    // A pin is a deliberate replacement of an older pin, so it outranks one —
    // but only when the user asked for a pin. Otherwise the pin wins and the
    // row says which box would let it move.
    if (pinnedElsewhere && !edits.pin) {
      blocks.push({ field: 'branch', reason: `pinned to ${spec.pinnedRef} — tick Pin to move it` });
    } else if (!service.reachableRefs.includes(edits.ref)) {
      blocks.push({ field: 'branch', reason: 'no such branch in its repo' });
    } else {
      if (service.ref !== edits.ref) {
        changes.push({ field: 'branch', now: service.ref ?? '—', after: edits.ref });
      }
      // Replacing a pin is a change in its own right. It used to happen
      // quietly behind the move, so a row already sitting on the target ref
      // showed nothing at all while its pin was being rewritten.
      if (edits.pin && spec.pinnedRef !== edits.ref) {
        changes.push({
          field: 'pin',
          now: spec.pinnedRef ? `pinned ${spec.pinnedRef}` : 'not pinned',
          after: `pinned ${edits.ref}`,
        });
      }
    }
  }

  if (edits.reload !== undefined) {
    const now = reloadModeOf(spec);
    if (now !== edits.reload) {
      changes.push({ field: 'reload', now: RELOAD_LABEL[now], after: RELOAD_LABEL[edits.reload] });
    }
  }

  if (edits.group !== undefined) {
    const now = spec.group ?? '';
    if (now !== edits.group) {
      changes.push({ field: 'group', now: now || 'ungrouped', after: edits.group || 'ungrouped' });
    }
  }

  if (edits.ready !== undefined) {
    const port = portFor(spec);
    if ((edits.ready.kind === 'http' || edits.ready.kind === 'tcp') && port === undefined) {
      blocks.push({ field: 'ready', reason: 'no port — give it one first' });
    } else {
      const after = buildProbe(edits.ready, port);
      if (after && describeReady(after) !== describeReady(spec.ready)) {
        changes.push({ field: 'ready', now: describeReady(spec.ready), after: describeReady(after) });
      }
    }
  }

  return { key: service.key, name: service.name, changes, blocks };
}

/// The port a probe should use: the one this service already answers on, or
/// the port it is configured to serve. Never invented.
export function portFor(spec: BulkService['spec']): number | undefined {
  if (spec.ready.kind === 'http' || spec.ready.kind === 'tcp') return spec.ready.port;
  return spec.port;
}

/// The probe to write for a shape, or undefined when this service cannot take
/// it. Keeps `okStatuses` off: a bulk edit sets the shape, and the statuses a
/// service accepts are its own business.
export function buildProbe(shape: ReadyShape, port: number | undefined): ReadinessProbe | undefined {
  switch (shape.kind) {
    case 'http':
      return port === undefined ? undefined : { kind: 'http', path: shape.path || '/', port };
    case 'tcp':
      return port === undefined ? undefined : { kind: 'tcp', port };
    case 'log':
      return { kind: 'log', pattern: shape.pattern };
    case 'none':
      return { kind: 'none' };
  }
}

/// A probe in a few words, for the preview. The renderer's own: the main
/// process has `describeProbe`, and neither side can import the other.
export function describeReady(probe: ReadinessProbe): string {
  switch (probe.kind) {
    case 'http':
      return `GET :${probe.port}${probe.path}`;
    case 'tcp':
      return `:${probe.port} accepts`;
    case 'log':
      return `output matches /${probe.pattern}/`;
    case 'command':
      return probe.command.join(' ');
    case 'none':
      return 'ready on start';
  }
}

const RELOAD_LABEL: Record<ReloadMode, string> = {
  self: 'reloads itself',
  restart: 'restarts',
  off: 'nothing',
};

/// What to write for one service's reload mode, keeping its own globs.
export { watchForMode };
