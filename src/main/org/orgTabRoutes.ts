// What the desktop's Org tab may call on an org server, through main.
//
// The tab never holds a token: it names a server, a method and a path, and
// main checks the path against this list before adding the server's token.
// The list is the daily loop and one worker's management. Org-wide admin
// (rules, people, secrets, repos, the fleet) stays on the web console.

const ID = '[^/?#]+';
const ROUTES: Array<{ method: 'GET' | 'POST'; path: RegExp }> = [
  // Who you are, the inbox and the roster.
  ...['/api/whoami', '/api/waiting', '/api/workers', '/api/proposals', '/api/today', '/api/roles', '/api/directory', '/api/hires', '/api/inflight', '/api/work'].map((p) => ({ method: 'GET' as const, path: new RegExp(`^${p}$`) })),
  // One worker, its runs and its history.
  ...['detail', 'runs', 'threads', 'journal', 'triggers', 'shifts', 'feed', 'history', 'tuning', 'how-it-works'].map((p) => ({ method: 'GET' as const, path: new RegExp(`^/api/workers/${ID}/${p}$`) })),
  { method: 'GET', path: new RegExp(`^/api/workers/${ID}$`) },
  ...['', '/steps', '/live', '/changes'].map((p) => ({ method: 'GET' as const, path: new RegExp(`^/api/runs/${ID}${p}$`) })),
  { method: 'GET', path: new RegExp(`^/api/asks/${ID}$`) },
  // Deciding what waits on you.
  ...['/api/answer', '/api/approval', '/api/rate', '/api/ask'].map((p) => ({ method: 'POST' as const, path: new RegExp(`^${p}$`) })),
  { method: 'POST', path: new RegExp(`^/api/proposals/${ID}$`) },
  ...['stop', 'resume', 'push'].map((p) => ({ method: 'POST' as const, path: new RegExp(`^/api/runs/${ID}/${p}$`) })),
  // Managing one worker: the server checks who may do each.
  ...['paused', 'trust', 'update', 'run', 'retire', 'journal', 'journal/forget', 'triggers', 'suggest-job', 'restore', 'review', 'tuning/try', 'how-it-works', 'how-it-works/suggest'].map((p) => ({ method: 'POST' as const, path: new RegExp(`^/api/workers/${ID}/${p}$`) })),
  { method: 'POST', path: new RegExp(`^/api/triggers/${ID}$`) },
  // Tasks workers handed to this desktop.
  { method: 'GET', path: /^\/api\/desktop\/tasks$/ },
  { method: 'POST', path: new RegExp(`^/api/desktop/tasks/${ID}/(claim|decline|result)$`) },
  // Tuning, from overgo: a suggestion marked applied or dismissed, or undone,
  // and a flow change tried on a past job.
  { method: 'POST', path: new RegExp(`^/api/workers/${ID}/reviews/${ID}/suggestions/${ID}(/undo)?$`) },
  { method: 'GET', path: new RegExp(`^/api/workers/${ID}/tuning/try/${ID}$`) },
  // Hiring.
  ...['/api/hires/draft', '/api/hires/confirm', '/api/hires/cancel', '/api/roles/hire'].map((p) => ({ method: 'POST' as const, path: new RegExp(`^${p}$`) })),
];

/// Calls where the server has its model write something (a rewritten job,
/// a flow change, a review of a worker's work, a trial run): a minute or
/// two, not the seconds every other call gets.
const SLOW = /^\/api\/workers\/[^/?#]+\/(suggest-job|review|how-it-works\/suggest|tuning\/try)$/;
export const ORG_TAB_SLOW_MS = 5 * 60_000;

/// How long main waits for this call: longer for the ones a model writes.
export function orgTabTimeout(method: string, rawPath: string): number | undefined {
  return method === 'POST' && SLOW.test(rawPath.split('?')[0]) ? ORG_TAB_SLOW_MS : undefined;
}

/// Whether the Org tab may make this call. The query string is allowed on a
/// GET (paging, filters) and checked separately from the path.
export function orgTabAllowed(method: string, rawPath: string): boolean {
  if (typeof rawPath !== 'string' || rawPath.length > 500 || !rawPath.startsWith('/api/')) return false;
  if (/\.\.|\/\/|\\/.test(rawPath)) return false;
  const [path, query] = rawPath.split('?', 2);
  if (query !== undefined && method !== 'GET') return false;
  // fetch resolves %2e%2e (and .%2e) as "..", so an id spelled that way
  // would land on another route than the one checked here. Only a path that
  // the URL parser leaves exactly as it is goes, and no encoded dot or slash.
  if (/%2e|%2f|%5c/i.test(path)) return false;
  try {
    if (new URL(path, 'http://org.invalid').pathname !== path) return false;
  } catch {
    return false;
  }
  return ROUTES.some((r) => r.method === method && r.path.test(path));
}
