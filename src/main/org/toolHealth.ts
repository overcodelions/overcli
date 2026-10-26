// Which tools are failing, and telling the admins once. A tool that starts
// refusing every call (an expired key, a token that lost access, an API the
// vendor retired) used to show up as workers quietly saying they couldn't
// read something; someone found out by reading run logs. Now the first
// sign-in failure, or a run of errors, raises it with the admins, and the
// next call that works clears it.

export type ToolTroubleKind = 'auth' | 'gone' | 'failing';

export interface ToolTrouble {
  tool: string;
  kind: ToolTroubleKind;
  since: number;
  lastAt: number;
  /// Errors in a row, no success between.
  count: number;
  lastError: string;
  workers: string[];
  alertedAt?: number;
}

/// What an error says about the tool, not the call: a key or access problem,
/// an API that is gone, or something else (a bad argument, a timeout).
export function classifyToolError(text: string): ToolTroubleKind {
  const t = text.slice(0, 2000);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?(token|key|credentials)|(token|key|credentials?) (has |have )?(expired|revoked)|authentication (failed|required)|not authenticated|access denied|permission denied/i.test(t)) return 'auth';
  if (/\b410\b|\bgone\b|deprecated|no longer (available|supported)|has been (retired|removed|sunset)|end[- ]of[- ]life/i.test(t)) return 'gone';
  return 'failing';
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
    const kind = classifyToolError(o.text);
    const was = at >= 0 ? this.all[at] : undefined;
    // A run of errors that went quiet for hours starts over.
    const fresh = !was || now - was.lastAt > FAILING_WINDOW_MS;
    const t: ToolTrouble = fresh
      ? { tool: o.tool, kind, since: now, lastAt: now, count: 1, lastError: o.text.slice(0, 300), workers: o.worker ? [o.worker] : [] }
      : {
          ...was!,
          kind: was!.kind === 'failing' ? kind : was!.kind,
          lastAt: now,
          count: was!.count + 1,
          lastError: o.text.slice(0, 300),
          workers: o.worker && !was!.workers.includes(o.worker) ? [...was!.workers, o.worker].slice(-10) : was!.workers,
        };
    if (at >= 0) this.all[at] = t;
    else this.all.push(t);
    const raise = t.kind !== 'failing' || t.count >= FAILING_AFTER;
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
    return this.all.filter((t) => t.kind !== 'failing' || t.count >= FAILING_AFTER);
  }

  /// An admin says it's dealt with; the next failure raises it again.
  clear(tool: string): void {
    this.all = this.all.filter((t) => t.tool !== tool);
    this.deps.save(this.all);
  }
}
