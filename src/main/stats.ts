// Stats computation. Ports the Swift StatsReader logic so the numbers
// match the Mac build:
//   - Claude: walks ~/.claude/projects/**/**/*.jsonl (recurses into
//     subagent/ subdirs), sums per-`assistant`-event `message.usage`.
//   - Codex: walks ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, pulls
//     `event_msg` / `token_count` / `last_token_usage`, subtracts the
//     cached portion from input, groups by `session_meta.cwd`.
//   - Gemini: walks ~/.gemini/tmp/<hash>/chats/session-*.json and
//     translates hash → cwd via ~/.gemini/projects.json.
// Per-project rows merge across backends by `displayPath` (unslugged for
// claude, cwd for codex/gemini). The 30-day daily series + rolling
// 5h/24h/7d windows drive the activity chart and usage meters.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import {
  Backend,
  BackendStats,
  DailyBackendBucket,
  DailyBucket,
  ProjectStats,
  StatsReport,
} from '../shared/types';
import { logSilent } from './diagnostics';

interface BackendAgg {
  backend: Backend;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  tokensLast5h: number;
  tokensLast24h: number;
  tokensLast7d: number;
  sessionsToday: Set<string>;
  lastActive: number;
  linesAdded: number;
  linesDeleted: number;
}

interface ProjectAgg {
  slug: string;
  displayPath: string;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  firstActivity: number | null;
  lastActivity: number | null;
  models: Set<string>;
  linesAdded: number;
  linesDeleted: number;
}

export function computeStats(): StatsReport {
  const now = Date.now();
  const byModel = new Map<
    string,
    { turns: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number }
  >();
  const daily = new Map<string, DailyBucket>();
  const claudeAgg = newBackendAgg('claude');
  const codexAgg = newBackendAgg('codex');
  const geminiAgg = newBackendAgg('gemini');
  const ollamaAgg = newBackendAgg('ollama');
  const byProject = new Map<string, ProjectAgg>();

  scanClaude(byProject, claudeAgg, byModel, daily, now);
  scanCodex(byProject, codexAgg, byModel, daily, now);
  scanGemini(byProject, geminiAgg, byModel, daily, now);
  scanOllama(byProject, ollamaAgg, byModel, daily, now);

  const byBackend: BackendStats[] = [
    finalizeBackend(claudeAgg),
    finalizeBackend(codexAgg),
    finalizeBackend(geminiAgg),
    finalizeBackend(ollamaAgg),
  ].filter((b) => b.turns > 0 || b.inputTokens > 0 || b.outputTokens > 0 || b.sessions > 0);

  const projectRows: ProjectStats[] = Array.from(byProject.values())
    .map((p) => ({
      id: p.slug,
      name: p.displayPath,
      sessions: p.sessions,
      turns: p.turns,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheRead: p.cacheRead,
      cacheCreation: p.cacheCreation,
      linesAdded: p.linesAdded,
      linesDeleted: p.linesDeleted,
      models: Array.from(p.models).sort(),
      lastActivity: p.lastActivity ?? undefined,
    }))
    .sort((a, b) => b.outputTokens - a.outputTokens);

  const modelRows = Array.from(byModel.entries())
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.outputTokens - a.outputTokens);

  const filledDaily = fillDays(daily, 90, now);

  const totalInput = byBackend.reduce((s, b) => s + b.inputTokens, 0);
  const totalOutput = byBackend.reduce((s, b) => s + b.outputTokens, 0);
  const totalTurns = byBackend.reduce((s, b) => s + b.turns, 0);
  const totalCacheRead = projectRows.reduce((s, p) => s + p.cacheRead, 0);
  const totalCacheCreation = projectRows.reduce((s, p) => s + p.cacheCreation, 0);
  const totalSessions = projectRows.reduce((s, p) => s + p.sessions, 0);
  const totalLinesAdded = byBackend.reduce((s, b) => s + b.linesAdded, 0);
  const totalLinesDeleted = byBackend.reduce((s, b) => s + b.linesDeleted, 0);

  return {
    generatedAt: now,
    totalSessions,
    totalTurns,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheRead,
    totalCacheCreation,
    totalLinesAdded,
    totalLinesDeleted,
    byBackend,
    byProject: projectRows,
    byModel: modelRows,
    daily: filledDaily,
  };
}

// ---------- Claude ----------

interface ClaudeAssistantEvent {
  inT: number;
  outT: number;
  cacheR: number;
  cacheC: number;
  model: string;
  ts: number | null;
  msgAdded: number;
  msgDeleted: number;
}

/// Mtime-keyed cache so repeat stats requests skip the line-by-line
/// JSON.parse on transcripts that haven't changed since the last scan.
/// Module-level — survives across IPC calls within a single app run.
const claudeFileCache = new Map<string, { mtimeMs: number; events: ClaudeAssistantEvent[] }>();

/// Parse a claude transcript file into the per-event contributions the
/// aggregator needs. Returns the cached list when the file's mtime
/// hasn't changed.
export function parseClaudeFileCached(filePath: string): ClaudeAssistantEvent[] {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return [];
  }
  const cached = claudeFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.events;
  const raw = readFileSafe(filePath);
  if (!raw) {
    claudeFileCache.set(filePath, { mtimeMs, events: [] });
    return [];
  }
  const events: ClaudeAssistantEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    if (json?.type !== 'assistant') continue;
    const message = json.message;
    if (!message || typeof message !== 'object') continue;
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const inT = intVal(usage.input_tokens);
    const outT = intVal(usage.output_tokens);
    const cacheR = intVal(usage.cache_read_input_tokens);
    const cacheC = intVal(usage.cache_creation_input_tokens);
    if (inT === 0 && outT === 0 && cacheR === 0 && cacheC === 0) continue;
    const model = typeof message.model === 'string' ? message.model : 'unknown';
    const tsRaw = json.timestamp;
    const tsParsed = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw);
    const ts = !isNaN(tsParsed) ? tsParsed : null;
    let msgAdded = 0;
    let msgDeleted = 0;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== 'tool_use') continue;
        const { added, deleted } = countToolUseLines(block.name, block.input);
        msgAdded += added;
        msgDeleted += deleted;
      }
    }
    events.push({ inT, outT, cacheR, cacheC, model, ts, msgAdded, msgDeleted });
  }
  claudeFileCache.set(filePath, { mtimeMs, events });
  return events;
}

function scanClaude(
  projects: Map<string, ProjectAgg>,
  agg: BackendAgg,
  byModel: Map<string, any>,
  daily: Map<string, DailyBucket>,
  now: number,
): void {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return;
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const slug of slugs) {
    const projDir = path.join(root, slug);
    if (!statIsDirectory(projDir)) continue;
    const displayPath = unslug(slug);
    const proj = ensureProject(projects, slug, displayPath);

    // Walk the directory tree so subagent transcripts at
    // `<session-id>/subagents/*.jsonl` are included. Top-level .jsonl
    // files count as sessions; nested files don't (they're continuations).
    const files = walkJsonl(projDir);
    for (const entry of files) {
      if (entry.isTopLevel) {
        proj.sessions += 1;
      }
      const sessionKey = entry.path;
      const events = parseClaudeFileCached(entry.path);
      for (const e of events) {
        proj.turns += 1;
        proj.inputTokens += e.inT;
        proj.outputTokens += e.outT;
        proj.cacheRead += e.cacheR;
        proj.cacheCreation += e.cacheC;
        proj.models.add(e.model);
        if (e.ts !== null) {
          proj.firstActivity = minNum(proj.firstActivity, e.ts);
          proj.lastActivity = maxNum(proj.lastActivity, e.ts);
        }
        agg.turns += 1;
        agg.inputTokens += e.inT;
        agg.outputTokens += e.outT;
        addRolling(agg, e.inT + e.outT, e.ts, now, sessionKey);
        addModel(byModel, e.model, {
          turns: 1,
          inputTokens: e.inT,
          outputTokens: e.outT,
          cacheRead: e.cacheR,
          cacheCreation: e.cacheC,
        });
        if (e.msgAdded || e.msgDeleted) {
          proj.linesAdded += e.msgAdded;
          proj.linesDeleted += e.msgDeleted;
          agg.linesAdded += e.msgAdded;
          agg.linesDeleted += e.msgDeleted;
        }
        if (e.ts !== null)
          addToDaily(daily, e.ts, 'claude', 1, e.inT, e.outT, e.msgAdded, e.msgDeleted);
      }
    }
  }
  // Count top-level sessions for the backend aggregate too.
  for (const p of projects.values()) {
    if (p.slug.startsWith('/')) continue; // codex/gemini use cwd-paths as slugs
    agg.sessions += p.sessions;
  }
}

// ---------- Codex ----------

type CodexCachedEvent =
  | {
      kind: 'modelTurn';
      model: string;
      ts: number | null;
      added: number;
      deleted: number;
    }
  | {
      kind: 'tokens';
      model: string;
      ts: number | null;
      inDelta: number;
      outDelta: number;
      cacheDelta: number;
    };

interface CodexParsedFile {
  cwd: string | null;
  firstTs: number | null;
  lastTs: number | null;
  models: string[];
  sessionTurns: number;
  sessionIn: number;
  sessionOut: number;
  sessionCache: number;
  sessionLinesAdded: number;
  sessionLinesDeleted: number;
  events: CodexCachedEvent[];
}

const codexFileCache = new Map<string, { mtimeMs: number; parsed: CodexParsedFile }>();

function emptyCodexParsed(): CodexParsedFile {
  return {
    cwd: null,
    firstTs: null,
    lastTs: null,
    models: [],
    sessionTurns: 0,
    sessionIn: 0,
    sessionOut: 0,
    sessionCache: 0,
    sessionLinesAdded: 0,
    sessionLinesDeleted: 0,
    events: [],
  };
}

/// Parse a codex rollout file into per-event contributions + finalized
/// session totals. Returns the cached parse when the file's mtime
/// hasn't changed since the last scan.
export function parseCodexFileCached(filePath: string): CodexParsedFile {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return emptyCodexParsed();
  }
  const cached = codexFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.parsed;
  const raw = readFileSafe(filePath);
  if (!raw) {
    const parsed = emptyCodexParsed();
    codexFileCache.set(filePath, { mtimeMs, parsed });
    return parsed;
  }
  const out = emptyCodexParsed();
  // `turn_context` events carry the active codex model; track the most
  // recent one so any turns/token_counts until the next turn_context are
  // attributed to that model. Most sessions stay on one model; mid-
  // session switches are rare but handled.
  let currentModel = 'codex';
  const sessionModels = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const tsRaw = json?.timestamp;
    const ts = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw);
    const tsValid = !isNaN(ts) ? ts : null;
    if (tsValid !== null) {
      out.firstTs = minNum(out.firstTs, tsValid);
      out.lastTs = maxNum(out.lastTs, tsValid);
    }
    const type = json?.type;
    const payload = json?.payload;
    if (type === 'session_meta') {
      if (payload?.cwd && typeof payload.cwd === 'string') out.cwd = payload.cwd;
    } else if (type === 'turn_context' && payload && typeof payload === 'object') {
      if (typeof payload.model === 'string' && payload.model) {
        currentModel = payload.model;
        sessionModels.add(payload.model);
      }
    } else if (type === 'response_item' && payload && typeof payload === 'object') {
      const kind = payload.type;
      if (kind === 'function_call' || (kind === 'message' && payload.role === 'assistant')) {
        out.sessionTurns += 1;
        let itemAdded = 0;
        let itemDeleted = 0;
        if (kind === 'function_call') {
          const { added, deleted } = countCodexFunctionCallLines(payload);
          itemAdded = added;
          itemDeleted = deleted;
          if (added || deleted) {
            out.sessionLinesAdded += added;
            out.sessionLinesDeleted += deleted;
          }
        }
        out.events.push({
          kind: 'modelTurn',
          model: currentModel,
          ts: tsValid,
          added: itemAdded,
          deleted: itemDeleted,
        });
      }
    } else if (type === 'event_msg' && payload?.type === 'token_count') {
      const info = payload.info?.last_token_usage;
      if (info) {
        const rawIn = intVal(info.input_tokens);
        const cacheDelta = intVal(info.cached_input_tokens);
        const inDelta = Math.max(0, rawIn - cacheDelta);
        const outDelta = intVal(info.output_tokens);
        out.sessionIn += inDelta;
        out.sessionOut += outDelta;
        out.sessionCache += cacheDelta;
        out.events.push({
          kind: 'tokens',
          model: currentModel,
          ts: tsValid,
          inDelta,
          outDelta,
          cacheDelta,
        });
      }
    }
  }
  out.models = Array.from(sessionModels);
  codexFileCache.set(filePath, { mtimeMs, parsed: out });
  return out;
}

function scanCodex(
  projects: Map<string, ProjectAgg>,
  agg: BackendAgg,
  byModel: Map<string, any>,
  daily: Map<string, DailyBucket>,
  now: number,
): void {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return;
  const files = walkCodexRollouts(root);
  for (const filePath of files) {
    agg.sessions += 1;
    const parsed = parseCodexFileCached(filePath);

    for (const e of parsed.events) {
      if (e.kind === 'modelTurn') {
        addModel(byModel, e.model, {
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheCreation: 0,
        });
        if (e.ts !== null)
          addToDaily(daily, e.ts, 'codex', 1, 0, 0, e.added, e.deleted);
      } else {
        addModel(byModel, e.model, {
          turns: 0,
          inputTokens: e.inDelta,
          outputTokens: e.outDelta,
          cacheRead: e.cacheDelta,
          cacheCreation: 0,
        });
        addRolling(agg, e.inDelta + e.outDelta, e.ts, now, filePath);
        if (e.ts !== null) addToDaily(daily, e.ts, 'codex', 0, e.inDelta, e.outDelta);
      }
    }

    agg.turns += parsed.sessionTurns;
    agg.inputTokens += parsed.sessionIn;
    agg.outputTokens += parsed.sessionOut;
    agg.linesAdded += parsed.sessionLinesAdded;
    agg.linesDeleted += parsed.sessionLinesDeleted;

    const key = parsed.cwd ?? '(unknown)';
    const proj = ensureProject(projects, key, key);
    proj.sessions += 1;
    proj.turns += parsed.sessionTurns;
    proj.inputTokens += parsed.sessionIn;
    proj.outputTokens += parsed.sessionOut;
    proj.cacheRead += parsed.sessionCache;
    proj.linesAdded += parsed.sessionLinesAdded;
    proj.linesDeleted += parsed.sessionLinesDeleted;
    proj.firstActivity = minNum(proj.firstActivity, parsed.firstTs);
    proj.lastActivity = maxNum(proj.lastActivity, parsed.lastTs);
    for (const m of parsed.models) proj.models.add(m);
  }
}

function walkCodexRollouts(root: string): string[] {
  const out: string[] = [];
  let years: string[] = [];
  try {
    years = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const y of years) {
    const yPath = path.join(root, y);
    if (!statIsDirectory(yPath)) continue;
    let months: string[] = [];
    try {
      months = fs.readdirSync(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      const mPath = path.join(yPath, m);
      if (!statIsDirectory(mPath)) continue;
      let days: string[] = [];
      try {
        days = fs.readdirSync(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        const dPath = path.join(mPath, d);
        if (!statIsDirectory(dPath)) continue;
        let files: string[] = [];
        try {
          files = fs.readdirSync(dPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) {
            out.push(path.join(dPath, f));
          }
        }
      }
    }
  }
  return out;
}

// ---------- Gemini ----------

function scanGemini(
  projects: Map<string, ProjectAgg>,
  agg: BackendAgg,
  byModel: Map<string, any>,
  daily: Map<string, DailyBucket>,
  now: number,
): void {
  const tmpRoot = path.join(os.homedir(), '.gemini', 'tmp');
  if (!fs.existsSync(tmpRoot)) return;

  const hashToCwd = loadGeminiHashMap();

  let hashes: string[] = [];
  try {
    hashes = fs.readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const hash of hashes) {
    const chatsDir = path.join(tmpRoot, hash, 'chats');
    if (!statIsDirectory(chatsDir)) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
      const filePath = path.join(chatsDir, file);
      const raw = readFileSafe(filePath);
      if (!raw) continue;
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      const projectKey = hashToCwd[hash] ?? hash;
      const messages: any[] = Array.isArray(obj?.messages) ? obj.messages : [];

      let sessionTurns = 0;
      let sessionIn = 0;
      let sessionOut = 0;
      let sessionCache = 0;
      let firstTs: number | null = null;
      let lastTs: number | null = null;

      const sessionModels = new Set<string>();
      for (const msg of messages) {
        if (msg?.type !== 'gemini') continue;
        sessionTurns += 1;
        const tsRaw = msg.timestamp;
        const ts = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
        const tsValid = !isNaN(ts) ? ts : null;
        if (tsValid !== null) {
          firstTs = minNum(firstTs, tsValid);
          lastTs = maxNum(lastTs, tsValid);
        }

        let inT = 0;
        let outT = 0;
        let cacheT = 0;
        if (msg.tokens && typeof msg.tokens === 'object') {
          inT = intVal(msg.tokens.input);
          outT =
            intVal(msg.tokens.output) +
            intVal(msg.tokens.thoughts) +
            intVal(msg.tokens.tool);
          cacheT = intVal(msg.tokens.cached);
        }
        sessionIn += inT;
        sessionOut += outT;
        sessionCache += cacheT;

        const model = typeof msg.model === 'string' && msg.model ? msg.model : 'gemini';
        sessionModels.add(model);
        addModel(byModel, model, {
          turns: 1,
          inputTokens: inT,
          outputTokens: outT,
          cacheRead: cacheT,
          cacheCreation: 0,
        });

        if (tsValid !== null) {
          addToDaily(daily, tsValid, 'gemini', 1, inT, outT);
          addRolling(agg, inT + outT, tsValid, now, filePath);
        }
      }

      agg.sessions += 1;
      agg.turns += sessionTurns;
      agg.inputTokens += sessionIn;
      agg.outputTokens += sessionOut;

      const proj = ensureProject(projects, projectKey, projectKey);
      proj.sessions += 1;
      proj.turns += sessionTurns;
      proj.inputTokens += sessionIn;
      proj.outputTokens += sessionOut;
      proj.cacheRead += sessionCache;
      proj.firstActivity = minNum(proj.firstActivity, firstTs);
      proj.lastActivity = maxNum(proj.lastActivity, lastTs);
      for (const m of sessionModels) proj.models.add(m);
    }
  }
}

// ---------- Ollama ----------
//
// Ollama has no on-disk per-turn token log. Its conversation state lives
// in overcli's own store (overcli.json) — we pull sessions, turn counts,
// and model from there. Tokens aren't persisted yet so they stay at 0;
// the dashboard still shows ollama activity (sessions, turns per day).

function scanOllama(
  projects: Map<string, ProjectAgg>,
  agg: BackendAgg,
  byModel: Map<string, any>,
  daily: Map<string, DailyBucket>,
  now: number,
): void {
  const storePath = overcliStorePath();
  if (!storePath || !fs.existsSync(storePath)) return;
  const raw = readFileSafe(storePath);
  if (!raw) return;
  let state: any;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    logSilent('stats.overcliStore', e);
    return;
  }
  const projectList: any[] = Array.isArray(state?.projects) ? state.projects : [];
  for (const p of projectList) {
    const projectPath = typeof p?.path === 'string' ? p.path : null;
    if (!projectPath) continue;
    const conversations: any[] = Array.isArray(p?.conversations) ? p.conversations : [];
    const ollamaConvs = conversations.filter((c) => c?.primaryBackend === 'ollama');
    if (ollamaConvs.length === 0) continue;

    const proj = ensureProject(projects, projectPath, projectPath);

    for (const c of ollamaConvs) {
      const turns = intVal(c?.turnCount);
      const model = typeof c?.currentModel === 'string' && c.currentModel ? c.currentModel : 'ollama';
      const lastActive = intVal(c?.lastActiveAt) || intVal(c?.createdAt);
      const firstActive = intVal(c?.createdAt) || lastActive;

      agg.sessions += 1;
      agg.turns += turns;
      proj.sessions += 1;
      proj.turns += turns;
      proj.models.add(model);
      proj.firstActivity = minNum(proj.firstActivity, firstActive || null);
      proj.lastActivity = maxNum(proj.lastActivity, lastActive || null);

      addModel(byModel, model, {
        turns,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
      });

      if (lastActive) {
        // We only know the conversation's last-active timestamp, not each
        // turn's timestamp. Attribute all turns to that day — good enough
        // for the activity chart; a future enhancement could persist
        // per-turn timestamps in the ollama runner.
        addToDaily(daily, lastActive, 'ollama', turns, 0, 0);
        addRolling(agg, 0, lastActive, now, String(c?.id ?? lastActive));
      }
    }
  }
}

function overcliStorePath(): string | null {
  try {
    // During tests / CLI runs app may be unavailable; fall back to the
    // default macOS userData location so the stats CLI harness still works.
    return path.join(app.getPath('userData'), 'overcli.json');
  } catch {
    const home = os.homedir();
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'overcli', 'overcli.json');
    }
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'overcli', 'overcli.json');
    }
    return path.join(home, '.config', 'overcli', 'overcli.json');
  }
}

function loadGeminiHashMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.join(os.homedir(), '.gemini', 'projects.json');
  if (!fs.existsSync(p)) return out;
  const raw = readFileSafe(p);
  if (!raw) return out;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  // Two known shapes:
  //   { "/path/to/proj": "hash", ... }
  //   { "hash": { "cwd": "/path/to/proj", ... }, ... }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[v] = k;
    } else if (v && typeof v === 'object' && typeof (v as any).cwd === 'string') {
      out[k] = (v as any).cwd;
    }
  }
  return out;
}

// ---------- Shared helpers ----------

function newBackendAgg(name: Backend): BackendAgg {
  return {
    backend: name,
    sessions: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokensLast5h: 0,
    tokensLast24h: 0,
    tokensLast7d: 0,
    sessionsToday: new Set<string>(),
    lastActive: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

function finalizeBackend(agg: BackendAgg): BackendStats {
  return {
    backend: agg.backend,
    sessions: agg.sessions,
    turns: agg.turns,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    tokensLast5h: agg.tokensLast5h,
    tokensLast24h: agg.tokensLast24h,
    tokensLast7d: agg.tokensLast7d,
    sessionsToday: agg.sessionsToday.size,
    lastActive: agg.lastActive || undefined,
    linesAdded: agg.linesAdded,
    linesDeleted: agg.linesDeleted,
  };
}

function addRolling(
  agg: BackendAgg,
  tokens: number,
  ts: number | null,
  now: number,
  sessionKey: string,
): void {
  if (ts === null) return;
  const delta = now - ts;
  if (delta < 0) return;
  if (delta <= 5 * 3600 * 1000) agg.tokensLast5h += tokens;
  if (delta <= 24 * 3600 * 1000) agg.tokensLast24h += tokens;
  if (delta <= 7 * 86400 * 1000) agg.tokensLast7d += tokens;
  if (ts > agg.lastActive) agg.lastActive = ts;
  if (isSameDay(ts, now)) agg.sessionsToday.add(sessionKey);
}

export function isSameDay(a: number, b: number): boolean {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

function addModel(
  map: Map<string, any>,
  model: string,
  delta: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
  },
): void {
  const cur = map.get(model) ?? {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };
  cur.turns += delta.turns;
  cur.inputTokens += delta.inputTokens;
  cur.outputTokens += delta.outputTokens;
  cur.cacheRead += delta.cacheRead;
  cur.cacheCreation += delta.cacheCreation;
  map.set(model, cur);
}

function addToDaily(
  daily: Map<string, DailyBucket>,
  ts: number,
  backend: Backend,
  turns: number,
  inputTokens: number,
  outputTokens: number,
  linesAdded = 0,
  linesDeleted = 0,
): void {
  const key = dayKey(ts);
  const cur = daily.get(key) ?? {
    day: key,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    linesAdded: 0,
    linesDeleted: 0,
    byBackend: {} as Partial<Record<Backend, DailyBackendBucket>>,
  };
  cur.turns += turns;
  cur.inputTokens += inputTokens;
  cur.outputTokens += outputTokens;
  cur.linesAdded += linesAdded;
  cur.linesDeleted += linesDeleted;
  if (!cur.byBackend) cur.byBackend = {};
  const bb = cur.byBackend[backend] ?? {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
  bb.turns += turns;
  bb.inputTokens += inputTokens;
  bb.outputTokens += outputTokens;
  bb.linesAdded += linesAdded;
  bb.linesDeleted += linesDeleted;
  cur.byBackend[backend] = bb;
  daily.set(key, cur);
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fillDays(daily: Map<string, DailyBucket>, count: number, now: number): DailyBucket[] {
  const out: DailyBucket[] = [];
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() - i);
    const key = dayKey(d.getTime());
    out.push(
      daily.get(key) ?? {
        day: key,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        linesAdded: 0,
        linesDeleted: 0,
        byBackend: {},
      },
    );
  }
  return out;
}

function ensureProject(
  projects: Map<string, ProjectAgg>,
  slug: string,
  displayPath: string,
): ProjectAgg {
  // Merge codex/gemini rows into the matching claude project when they
  // share a cwd. Claude's slug → path unslug is lossy (can't tell a `-`
  // inside a component from the `/` separator, e.g. `git-services`), so
  // comparing displayPath alone splits rows for those paths. When we get a
  // real absolute cwd, reverse-slugify it and look for a claude project
  // keyed by that slug — that match is exact.
  if (displayPath.startsWith('/')) {
    const cwdSlug = displayPath.replace(/\//g, '-');
    const byCwdSlug = projects.get(cwdSlug);
    if (byCwdSlug) {
      // Codex/gemini has the authoritative path; claude's unslug may have
      // collapsed dashes to slashes. Replace the lossy displayPath.
      byCwdSlug.displayPath = displayPath;
      return byCwdSlug;
    }
  }
  for (const existing of projects.values()) {
    if (existing.displayPath === displayPath) return existing;
  }
  const fresh: ProjectAgg = {
    slug,
    displayPath,
    sessions: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    firstActivity: null,
    lastActivity: null,
    models: new Set<string>(),
    linesAdded: 0,
    linesDeleted: 0,
  };
  projects.set(slug, fresh);
  return fresh;
}

/// Approximate lines-changed for a Claude tool_use block. Counted at edit
/// time from the tool arguments, so it reflects what the agent *proposed*
/// — rejected / reverted edits still count. Accurate enough to compare
/// workloads across projects; not a substitute for `git diff`.
export function countToolUseLines(
  name: string,
  input: any,
): { added: number; deleted: number } {
  if (!input || typeof input !== 'object') return { added: 0, deleted: 0 };
  if (name === 'Edit') {
    return { added: countLines(input.new_string), deleted: countLines(input.old_string) };
  }
  if (name === 'MultiEdit') {
    let added = 0;
    let deleted = 0;
    const edits = Array.isArray(input.edits) ? input.edits : [];
    for (const e of edits) {
      added += countLines(e?.new_string);
      deleted += countLines(e?.old_string);
    }
    return { added, deleted };
  }
  if (name === 'Write') {
    return { added: countLines(input.content), deleted: 0 };
  }
  if (name === 'NotebookEdit') {
    return { added: countLines(input.new_source), deleted: countLines(input.old_source) };
  }
  return { added: 0, deleted: 0 };
}

export function countLines(s: any): number {
  if (typeof s !== 'string' || s.length === 0) return 0;
  return s.split('\n').length;
}

/// Codex writes edits through `apply_patch`, using its own V4A patch
/// format inside the function_call arguments. Pull the patch body and
/// count `+`/`-` prefixed lines. Context lines carry no prefix and the
/// envelope markers start with `***` / `@@`, so this is a clean count.
export function countCodexFunctionCallLines(payload: any): { added: number; deleted: number } {
  if (!payload || typeof payload !== 'object') return { added: 0, deleted: 0 };
  const args = typeof payload.arguments === 'string' ? payload.arguments : '';
  if (!args.includes('*** Begin Patch')) return { added: 0, deleted: 0 };
  let patch = args;
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed?.input === 'string') patch = parsed.input;
    else if (typeof parsed?.patch === 'string') patch = parsed.patch;
    else if (Array.isArray(parsed?.command)) patch = parsed.command.join('\n');
  } catch {
    // arguments wasn't JSON — fall back to scanning the raw string.
  }
  return countApplyPatchLines(patch);
}

export function countApplyPatchLines(text: string): { added: number; deleted: number } {
  const begin = text.indexOf('*** Begin Patch');
  if (begin < 0) return { added: 0, deleted: 0 };
  const endIdx = text.indexOf('*** End Patch', begin);
  const body = text.slice(begin, endIdx < 0 ? text.length : endIdx);
  let added = 0;
  let deleted = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) deleted += 1;
  }
  return { added, deleted };
}

export function intVal(v: any): number {
  if (typeof v === 'number' && isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export function minNum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

export function maxNum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function statIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

interface ClaudeJsonlEntry {
  path: string;
  isTopLevel: boolean;
}

function walkJsonl(root: string): ClaudeJsonlEntry[] {
  const out: ClaudeJsonlEntry[] = [];
  const rootPrefix = root + path.sep;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(cur, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile() && name.endsWith('.jsonl')) {
        const rel = full.startsWith(rootPrefix) ? full.slice(rootPrefix.length) : name;
        const isTopLevel = !rel.includes(path.sep);
        out.push({ path: full, isTopLevel });
      }
    }
  }
  return out;
}

/// Claude stores project slugs like `-Users-me-projects-myapp`. This
/// rehydrates the original path. Double dashes can't be perfectly
/// recovered (they may come from `.` in a component or adjacent `/` +
/// `-`), but the result is far more readable than the raw slug.
export function unslug(slug: string): string {
  if (slug.startsWith('-')) {
    return '/' + slug.slice(1).replace(/-/g, '/');
  }
  return slug.replace(/-/g, '/');
}
