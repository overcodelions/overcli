// The part of a finished run that has to outlive the run.
//
// `flow-runs/<id>.json` is LRU-evicted, and when a run goes its hidden
// participant chats go with it — so a week-old run that built something real
// was left as one line in flow-run-summaries.jsonl: a flow name, a cost and a
// timestamp. Nothing you could search for. This log keeps what the Work view
// needs to find and describe it: the ask, the headline, the branch, and the
// cwd its transcripts were filed under.
//
// Append-only JSONL, one line per run id, same bloat guards as the summary
// log (dedup on read, last write wins).
//
// Runs evicted before this log existed are backfilled once: the summary log
// still names them, and a coordinator run's transcripts sit in a Claude
// project dir named for the run id, whose first prompt carries the ask.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { host } from '../host';
import { log } from '../diagnostics';
import { flowRunOwnerPath, type FlowRun } from '../../shared/flows/schema';
import { titleFromPrompt, type WorkLogEntry } from '../../shared/workRecords';
import { loadRunSummaries } from '../flows/runSummaryLog';
import { extractUserPrompt } from './promptIndex';

const PROMPT_CAP = 4000;

function filePath(): string {
  try {
    return path.join(host().dataDir(), 'work-log.jsonl');
  } catch {
    return path.join(process.cwd(), '.overcli-test-work-log.jsonl');
  }
}

let loggedIds: Set<string> | null = null;

export function workLogEntryFor(run: FlowRun, workerName?: string): WorkLogEntry | null {
  const kind = run.state.kind;
  if (kind !== 'done' && kind !== 'archived' && kind !== 'aborted') return null;
  const last = run.attempts?.length ? run.attempts[run.attempts.length - 1] : undefined;
  const ownerPath = flowRunOwnerPath(run);
  const cwd = run.worktreePath ?? run.projectPath;
  const prompt = (run.userPrompt ?? '').slice(0, PROMPT_CAP);
  return {
    runId: run.id,
    flowId: run.flowId,
    flowName: run.flowSnapshot?.name || run.flowId,
    title: titleFromPrompt(prompt) || run.flowSnapshot?.name || run.flowId,
    prompt,
    ...(run.digest?.headline ? { headline: run.digest.headline } : {}),
    ...(run.digest?.summary ? { summary: run.digest.summary } : {}),
    ownerPath,
    ...(cwd && cwd !== ownerPath ? { cwd } : {}),
    ...(run.branchName ? { branchName: run.branchName } : {}),
    // A workspace run has no single branch — one per member repo. Kept so its
    // git status can still be read after the run is evicted.
    ...(run.workspaceWorktrees?.length
      ? { repoBranches: run.workspaceWorktrees.map((w) => ({ repo: w.projectPath, branch: w.branchName })) }
      : {}),
    startedAt: run.createdAt,
    at: last?.endedAt ?? last?.startedAt ?? Date.now(),
    outcome: kind === 'aborted' ? 'failed' : 'done',
    ...(workerName ? { workerName } : {}),
    ...(run.team ? { team: run.team } : {}),
  };
}

export function appendWorkLog(run: FlowRun): void {
  try {
    const ids = ensureIndex();
    if (ids.has(run.id)) return;
    const entry = workLogEntryFor(run);
    if (!entry) return;
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.appendFileSync(filePath(), JSON.stringify(entry) + '\n');
    ids.add(run.id);
  } catch (err) {
    log('error', 'work.appendWorkLog', `failed to log run ${run.id}`, err);
  }
}

function readRaw(): WorkLogEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath(), 'utf-8');
  } catch {
    return [];
  }
  const byId = new Map<string, WorkLogEntry>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as WorkLogEntry;
      if (e && typeof e.runId === 'string') byId.set(e.runId, e);
    } catch {
      // A torn last line from a crash — skip it.
    }
  }
  return [...byId.values()];
}

function ensureIndex(): Set<string> {
  if (!loggedIds) loggedIds = new Set(readRaw().map((e) => e.runId));
  return loggedIds;
}

let backfillDone: Promise<void> | null = null;

/// The log, after a one-time backfill of runs evicted before it existed.
export async function loadWorkLog(): Promise<WorkLogEntry[]> {
  if (!backfillDone) {
    backfillDone = backfill().catch((err) => {
      log('warn', 'work.backfill', 'work log backfill failed', err);
    });
  }
  await backfillDone;
  return readRaw();
}

function runFileExists(runId: string): boolean {
  try {
    return fs.existsSync(path.join(host().dataDir(), 'flow-runs', `${runId}.json`));
  } catch {
    return false;
  }
}

async function backfill(): Promise<void> {
  const have = ensureIndex();
  const missing = loadRunSummaries().filter((s) => !have.has(s.id) && !runFileExists(s.id));
  if (!missing.length) return;
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    // No Claude history on this machine — entries get the flow name only.
  }
  const lines: string[] = [];
  for (const s of missing) {
    const dir = dirs.find((d) => d.toLowerCase().endsWith(s.id.toLowerCase()));
    const found = dir ? await firstPromptIn(path.join(root, dir)) : null;
    const ask = found ? askFromStepPrompt(found.text) : '';
    const entry: WorkLogEntry = {
      runId: s.id,
      ...(s.flowId && s.flowId !== 'unknown' ? { flowId: s.flowId } : {}),
      flowName: s.flowName,
      title: titleFromPrompt(ask) || s.flowName,
      prompt: ask,
      ownerPath: s.ownerPath ?? '',
      ...(found?.cwd ? { cwd: found.cwd } : {}),
      at: s.terminalAt,
      startedAt: s.terminalAt - (s.wallClockMs || 0),
      outcome: s.completed ? 'done' : 'failed',
      backfilled: true,
    };
    if (!entry.ownerPath) continue;
    lines.push(JSON.stringify(entry));
    have.add(s.id);
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.appendFileSync(filePath(), lines.join('\n') + '\n');
  }
}

/// The oldest transcript's first user prompt in a run's project dir.
async function firstPromptIn(dir: string): Promise<{ text: string; cwd: string } | null> {
  let files: Array<{ f: string; t: number }> = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
  } catch {
    return null;
  }
  for (const { f } of files) {
    const stream = fs.createReadStream(f, { encoding: 'utf-8', end: 512 * 1024 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const p = extractUserPrompt(line);
        if (p) return { text: p.text, cwd: p.cwd };
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }
  return null;
}

/// A flow step's prompt opens with a banner the runtime writes:
/// `Overcli · <flow> · <step> (<participant>) — <the ask, cut at 60>…`.
/// The ask itself follows later in the prompt under a heading, but the
/// banner copy is the one place it reliably appears.
export function askFromStepPrompt(text: string): string {
  const withoutAttach = text.replace(/^\[Attached file:[^\]]*\]\s*/g, '');
  const banner = withoutAttach.match(/^Overcli · [^\n]*? — ([^\n]*?)(?:…|\s{2}|\n|$)/);
  if (banner) return banner[1].trim();
  return withoutAttach.trim();
}
