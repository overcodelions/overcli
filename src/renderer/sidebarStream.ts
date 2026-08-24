// The Stream layout's two groupers: time buckets, and owner lanes inside them.
//
// Stream renders one flat, newest-first list of everything you have worked on
// — chats, agents, flow runs, worker runs — instead of a tree of the places
// they live. The tree is not wrong, it just answers "where does this live"
// when the question you navigate by is "what was I doing".
//
// The cost of going flat is that a row no longer sits under its project, so
// you can lose track of which repo you are in. Lanes are the answer: the
// owner is printed ONCE at the top of a run of consecutive rows that share
// it, not repeated on every row. Three chats in the same repo cost one label
// and three single-line rows, which is denser than the per-row subtitle it
// replaces. A day spent switching repos produces many labels — which is true,
// and worth being able to see.

export type StreamBucket = 'today' | 'week' | 'earlier';

/// Buckets are calendar-relative, not rolling windows. "Earlier today" has to
/// mean today: at 09:00 a rolling 24h window would file yesterday afternoon
/// under today, and the label would be a lie.
export function bucketFor(at: number, now: number = Date.now()): StreamBucket {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return 'today';
  // Six further days back, so the bucket is "this week" in the sense of the
  // last seven calendar days rather than since Monday — on a Monday morning,
  // since-Monday would be empty.
  if (at >= startOfToday - 6 * 24 * 60 * 60 * 1000) return 'week';
  return 'earlier';
}

export const BUCKET_LABELS: Record<StreamBucket, string> = {
  today: 'Earlier today',
  week: 'This week',
  earlier: 'Earlier',
};

export interface Lane<T> {
  /// Stable across renders for a given owner, but NOT unique in the list — an
  /// owner you return to later in the day opens a second lane. React keys
  /// need `${ownerId}:${index}`.
  ownerId: string;
  ownerName: string;
  ownerKind: 'project' | 'workspace' | 'worker' | 'unknown';
  items: T[];
}

/// Run-length group an already-sorted list by owner.
///
/// Deliberately run-length rather than "group by owner": collecting every
/// overcli row into one lane would silently re-sort the list, which is the
/// thing Stream exists not to do. A lane is a stretch of the timeline that
/// happens to share an owner, and consecutive rows are the only ones that
/// can share a label without moving.
export function groupIntoLanes<T>(
  items: readonly T[],
  owner: (item: T) => { id: string; name: string; kind: Lane<T>['ownerKind'] },
): Lane<T>[] {
  const lanes: Lane<T>[] = [];
  for (const item of items) {
    const o = owner(item);
    const last = lanes[lanes.length - 1];
    if (last && last.ownerId === o.id) {
      last.items.push(item);
      continue;
    }
    lanes.push({ ownerId: o.id, ownerName: o.name, ownerKind: o.kind, items: [item] });
  }
  return lanes;
}

export interface StreamSection<T> {
  bucket: StreamBucket;
  label: string;
  count: number;
  lanes: Lane<T>[];
}

/// Split a sorted list into time buckets, then lane each bucket. Empty
/// buckets are dropped rather than rendered as a header with nothing under
/// it — a section title that explains an absence is worse than the absence.
export function buildStream<T>(
  items: readonly T[],
  read: (item: T) => {
    at: number;
    owner: { id: string; name: string; kind: Lane<T>['ownerKind'] };
  },
  now: number = Date.now(),
): StreamSection<T>[] {
  const order: StreamBucket[] = ['today', 'week', 'earlier'];
  const byBucket = new Map<StreamBucket, T[]>();
  for (const item of items) {
    const bucket = bucketFor(read(item).at, now);
    const list = byBucket.get(bucket);
    if (list) list.push(item);
    else byBucket.set(bucket, [item]);
  }
  const sections: StreamSection<T>[] = [];
  for (const bucket of order) {
    const list = byBucket.get(bucket);
    if (!list?.length) continue;
    sections.push({
      bucket,
      label: BUCKET_LABELS[bucket],
      count: list.length,
      lanes: groupIntoLanes(list, (item) => read(item).owner),
    });
  }
  return sections;
}
