// Which tools are failing, and telling the admins once. A tool that starts
// refusing every call (an expired key, a token that lost access, an API the
// vendor retired) used to show up as workers quietly saying they couldn't
// read something; someone found out by reading run logs. Now the first
// sign-in failure, or a run of errors, raises it with the admins, and the
// next call that works clears it.

import { TEST_SYSTEMS_TOOL } from '../../shared/testSystems';

/// scope: the key signs in, but isn't allowed this call (a permission it was
/// never given). Other calls may work, so like 'failing' it takes a run of them.
export type ToolTroubleKind = 'auth' | 'scope' | 'gone' | 'failing';

/// Kinds raised only after FAILING_AFTER in a row.
const needsRun = (k: ToolTroubleKind) => k === 'failing' || k === 'scope';

export interface ToolTrouble {
  tool: string;
  kind: ToolTroubleKind;
  since: number;
  lastAt: number;
  /// Errors in a row, no success between.
  count: number;
  /// The error as the tool gave it, up to ERROR_KEEP characters.
  lastError: string;
  /// What the error says, without the tool's boilerplate: the API's own
  /// message when it gave one. Absent: lastError is already short.
  gist?: string;
  workers: string[];
  /// What a 'scope' refusal said was needed, when it named it.
  missing?: string[];
  alertedAt?: number;
}

/// An error without the page a browser tool appends after it.
function withoutPageReport(text: string): string {
  const at = text.search(/^#{1,4} (?:Page|Events|Ran Playwright code)\b/m);
  return at >= 0 ? text.slice(0, at) : text;
}

/// What an error says about the tool, not the call: a key or access problem,
/// an API that is gone, or something else (a bad argument, a timeout).
export function classifyToolError(text: string, tool?: string): ToolTroubleKind {
  // A browser tool reports on the page it's on: a 403 there is that page's, not
  // the tool's key.
  const t = withoutPageReport(text).slice(0, 2000);
  // The apps-to-test tool has no key of its own: only a test account that
  // can't sign in is a sign-in problem.
  if (tool === TEST_SYSTEMS_TOOL) return /Still on .* sign-in page|has no test account|has no value for|Signing in to .* failed/i.test(t) ? 'auth' : 'failing';
  // A file a tool wouldn't write where it was asked: the call's fault, not the tool's key.
  if (/outside (the )?allowed roots|file access denied|\bEACCES\b|\bENOENT\b|no such file/i.test(t)) return 'failing';
  // Signed in, but without the permission this call needs: the key is fine.
  if (/lacks? (one or more )?(the )?required (privilege )?scopes?|insufficient[ _]scopes?|missing[ _](required[ _])?(scopes?|permissions?)|required scopes?:|not accessible by (integration|personal access token)|token (is )?missing (the )?.*scopes?/i.test(t)) return 'scope';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?(token|key|credentials)|(token|key|credentials?) (has |have )?(expired|revoked)|authentication (failed|required)|not authenticated|access denied|permission denied/i.test(t)) return 'auth';
  if (/\b410\b|\bgone\b|deprecated|no longer (available|supported)|has been (retired|removed|sunset)|end[- ]of[- ]life/i.test(t)) return 'gone';
  return 'failing';
}

/// The permissions a scope refusal names as needed: Bitbucket's
/// `"required": [...]`, GitHub's `X-Accepted-OAuth-Scopes`, Slack's `needed`.
export function missingScopes(text: string): string[] | undefined {
  const list = text.match(/"required"\s*:\s*\[([^\]]*)\]/)?.[1] ?? text.match(/(?:accepted-oauth-scopes|"needed")\s*[:=]\s*"?([^"\n]+)/i)?.[1];
  const out = list ? [...new Set(list.split(/[\s,]+/).map((x) => x.replace(/^["']|["']$/g, '')).filter(Boolean))] : [];
  return out.length ? out.slice(0, 10) : undefined;
}

const ERROR_KEEP = 2000;

/// The line of an error worth reading first. Tools wrap an API's refusal in
/// a paragraph of generic advice; the API's own `"message"` says what's wrong.
export function errorGist(text: string, missing?: string[]): string | undefined {
  const t = withoutPageReport(text);
  const said = t.match(/"(?:message|error_description|detail)"\s*:\s*"((?:[^"\\]|\\.){8,400})"/)?.[1]?.replace(/\\(.)/g, '$1').trim();
  const status = t.match(/\bHTTP(?: Status)?:?\s*(\d{3})\b/i)?.[1];
  const head = said ?? (t.length > 300 ? t.split(/\n/).find((l) => l.trim())?.trim().slice(0, 300) : undefined);
  if (!head) return undefined;
  return `${head}${status && !head.includes(status) ? ` (HTTP ${status})` : ''}${missing?.length ? ` Needs: ${missing.join(', ')}.` : ''}`;
}

/// Other errors need this many in a row before anyone hears: a model calling
/// a tool wrong now and then is not the tool failing.
export const FAILING_AFTER = 5;
const FAILING_WINDOW_MS = 6 * 60 * 60 * 1000;
const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

export interface ToolHealthDeps {
  load(): ToolTrouble[];
  save(all: ToolTrouble[]): void;
  /// Raised: tell the admins.
  alert(t: ToolTrouble): void;
  now?(): number;
}

export class ToolHealth {
  private all: ToolTrouble[];
  constructor(private readonly deps: ToolHealthDeps) {
    this.all = deps.load();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  observe(o: { tool: string; ok: boolean; text: string; worker?: string }): void {
    const at = this.all.findIndex((t) => t.tool === o.tool);
    if (o.ok) {
      if (at >= 0) {
        this.all.splice(at, 1);
        this.deps.save(this.all);
      }
      return;
    }
    const now = this.now();
    const kind = classifyToolError(o.text, o.tool);
    const missing = kind === 'scope' ? missingScopes(o.text) : undefined;
    const lastError = withoutPageReport(o.text).slice(0, ERROR_KEEP);
    const gist = errorGist(o.text, missing);
    const was = at >= 0 ? this.all[at] : undefined;
    // A run of errors that went quiet for hours starts over.
    const fresh = !was || now - was.lastAt > FAILING_WINDOW_MS;
    const t: ToolTrouble = fresh
      ? { tool: o.tool, kind, since: now, lastAt: now, count: 1, lastError, workers: o.worker ? [o.worker] : [], ...(gist ? { gist } : {}), ...(missing ? { missing } : {}) }
      : {
          ...was!,
          // A sign-in or retired-API error outranks a missing permission or a bad call.
          kind: needsRun(was!.kind) && !needsRun(kind) ? kind : was!.kind === 'failing' ? kind : was!.kind,
          ...(missing ? { missing: [...new Set([...(was!.missing ?? []), ...missing])].slice(0, 10) } : {}),
          lastAt: now,
          count: was!.count + 1,
          lastError,
          gist,
          workers: o.worker && !was!.workers.includes(o.worker) ? [...was!.workers, o.worker].slice(-10) : was!.workers,
        };
    if (at >= 0) this.all[at] = t;
    else this.all.push(t);
    const raise = !needsRun(t.kind) || t.count >= FAILING_AFTER;
    if (raise && (!t.alertedAt || now - t.alertedAt > ALERT_EVERY_MS)) {
      t.alertedAt = now;
      this.deps.save(this.all);
      this.deps.alert(t);
      return;
    }
    this.deps.save(this.all);
  }

  /// What is failing now, raised or not.
  list(): ToolTrouble[] {
    return this.all.filter((t) => !needsRun(t.kind) || t.count >= FAILING_AFTER);
  }

  /// An admin says it's dealt with; the next failure raises it again.
  clear(tool: string): void {
    this.all = this.all.filter((t) => t.tool !== tool);
    this.deps.save(this.all);
  }
}
