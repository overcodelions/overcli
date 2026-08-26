import type { WorkerFile } from './components/workers/workerDeskSelectors';

type Req = { id: string; task: 'shift' | 'errand'; label: string; title: string; at: number };
const cache = new Map<string, Promise<WorkerFile[]>>();
let queue: Array<{ req: Req; resolve: (f: WorkerFile[]) => void }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (r: Req) => `${r.id}|${r.task}|${r.label}|${r.title}|${r.at}`;

/// The key includes `at` (a done item's `finishedAt`), which never changes
/// for that item — so a cached entry never expires on its own. Bound it and
/// evict oldest-first past the cap rather than growing for the whole session.
const MAX_CACHE_ENTRIES = 500;

/// One IPC per animation frame instead of one per rendered row. A page of 25
/// plan rows previously made 25 round trips to main on every render.
export function fetchDeliverables(req: Req): Promise<WorkerFile[]> {
  const key = keyOf(req);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new Promise<WorkerFile[]>((resolve) => {
    queue.push({ req, resolve });
    if (!timer) {
      timer = setTimeout(() => {
        const batch = queue;
        queue = [];
        timer = null;
        void window.overcli
          .invoke('workers:deliverablesBatch', { requests: batch.map((b) => b.req) })
          .then((res: WorkerFile[][]) => batch.forEach((b, i) => b.resolve(res[i] ?? [])))
          .catch(() => batch.forEach((b) => b.resolve([])));
      }, 16);
    }
  });
  cache.set(key, p);
  // An empty result means either "nothing was filed" or "not filed YET" —
  // the fold that writes the cabinet files can still be in flight, or the
  // batch call itself failed — and this cache has no way to tell those
  // apart. Caching it would freeze the row at "no deliverables" for the rest
  // of the session; drop it instead so the next mount/render re-fetches.
  void p.then((res) => {
    if (res.length === 0) cache.delete(key);
  });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return p;
}
