// Reading the shape of a log line, so the view can lay it out.
//
// A JVM service with colour turned off — `spring.output.ansi.enabled=NEVER`,
// which is what most shared log configs say — writes every line in one flat
// grey: level, date, thread, a forty-character logger and then, finally, the
// message. The one word that matters, ERROR or WARN, is in the same colour as
// the classpath. The ANSI pass has nothing to work with because there is
// nothing there.
//
// So the common layouts are recognised and split into their parts. Recognised,
// not guessed: a line matching none of them is returned as null and printed as
// it came, because a formatter that mangles output is worse than none.

export type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ParsedLogLine {
  level: Level;
  /// Time of day, normalised to `HH:MM:SS.mmm` — the date is the same on every
  /// line of a run and costs a column.
  time?: string;
  /// The timestamp as written, for the tooltip.
  stamp?: string;
  thread?: string;
  /// The class, without its package or line number.
  logger?: string;
  /// The logger as written, for the tooltip.
  loggerFull?: string;
  message: string;
  /// A structured record's stack trace, when it carries one in a field rather
  /// than on the lines after it.
  stack?: string;
  /// Whatever else a structured record carried — a trace id, a request path —
  /// with the empty ones dropped.
  fields?: Record<string, string>;
}

const LEVEL = String.raw`(ERROR|FATAL|SEVERE|WARN(?:ING)?|INFO|DEBUG|TRACE|FINEST|FINE)`;
const STAMP = String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?`;
const TIME = String.raw`\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?`;

/// `[INFO ] 2026-09-12T14:44:08,630 [main] [] [c.z.r.Application:597] - msg`
/// — log4j with a level-first pattern, and whatever bracketed context a shop
/// adds between the thread and the logger.
const BRACKETED = new RegExp(
  String.raw`^\[${LEVEL}\s*\]\s+(${STAMP})((?:\s+\[[^\]]*\])+)\s+-\s?(.*)$`,
);

/// `2026-09-12 14:44:08.630  INFO 12345 --- [  main] o.s.b.SpringApplication : msg`
/// — Spring Boot's own default.
const SPRING = new RegExp(
  String.raw`^(${STAMP})\s+${LEVEL}\s+\d+\s+---\s+\[\s*([^\]]*?)\s*\]\s+(\S+)\s+:\s?(.*)$`,
);

/// `14:44:08.630 [main] INFO  c.z.Foo - msg` — Logback's default.
const LOGBACK = new RegExp(
  String.raw`^(${STAMP}|${TIME})\s+\[([^\]]+)\]\s+${LEVEL}\s+(\S+)\s+-\s?(.*)$`,
);

/// `INFO:     Uvicorn running…`, `[WARN] …`, `ERROR  …` — a level and nothing
/// else. Needs a colon, brackets or a run of spaces after the word, so a line
/// that merely begins with "Info about" is left alone.
const BARE = new RegExp(String.raw`^(?:\[${LEVEL}\s*\]|${LEVEL}:|${LEVEL}\s{2,})\s*(.*)$`);

export function parseLogLine(text: string): ParsedLogLine | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return parseJsonCached(trimmed);

  let m = BRACKETED.exec(text);
  if (m) {
    const brackets = [...m[3].matchAll(/\[([^\]]*)\]/g)].map((b) => b[1]);
    const logger = brackets.length > 1 ? brackets[brackets.length - 1] : undefined;
    return {
      level: level(m[1]),
      ...stamp(m[2]),
      thread: brackets[0] || undefined,
      ...named(logger),
      message: m[4],
    };
  }

  m = SPRING.exec(text);
  if (m) {
    return { level: level(m[2]), ...stamp(m[1]), thread: m[3] || undefined, ...named(m[4]), message: m[5] };
  }

  m = LOGBACK.exec(text);
  if (m) {
    return { level: level(m[3]), ...stamp(m[1]), thread: m[2], ...named(m[4]), message: m[5] };
  }

  m = BARE.exec(text);
  if (m) {
    return { level: level(m[1] ?? m[2] ?? m[3]), message: m[4] };
  }

  return null;
}

// JSON logging — logstash-logback-encoder, ECS, pino, bunyan, structlog,
// Serilog's compact form. One object per line, and every library names the same
// half-dozen things differently. Recognised the same way the text layouts are:
// a line that is not an object, or is an object with no message, is not a log
// record and prints as it came.

const JSON_LEVEL = ['level', 'severity', 'lvl', 'log.level', '@l', 'levelname'];
const JSON_TIME = ['timestamp', '@timestamp', 'time', 'ts', '@t', 'datetime', 'asctime'];
const JSON_MESSAGE = ['message', 'msg', '@m', '@mt', 'event'];
const JSON_LOGGER = ['logger', 'logger_name', 'log.logger', 'name', 'module'];
const JSON_THREAD = ['thread', 'thread_name', 'process.thread.name', 'threadName'];
const JSON_LINE = ['line', 'lineno', 'log.origin.file.line'];
const JSON_STACK = ['stacktrace', 'stack_trace', 'error.stack_trace', 'exception', 'exc_info', 'err.stack', '@x'];
/// Read but not worth a chip: they say nothing a person reading the line
/// wants, and on a busy service they are the same on every line.
const JSON_NOISE = new Set(['@version', 'level_value', 'pid', 'hostname', 'v', 'ecs.version', 'process.pid']);

/// The view, the level counts and the filter each read every line on every
/// render; JSON.parse three times over a few thousand lines is noticeable.
/// Lines are strings, so this is keyed by content and simply dropped when full.
const jsonCache = new Map<string, ParsedLogLine | null>();
const JSON_CACHE_LIMIT = 5000;

function parseJsonCached(text: string): ParsedLogLine | null {
  const hit = jsonCache.get(text);
  if (hit !== undefined) return hit;
  const parsed = parseJson(text);
  if (jsonCache.size >= JSON_CACHE_LIMIT) jsonCache.clear();
  jsonCache.set(text, parsed);
  return parsed;
}

function parseJson(text: string): ParsedLogLine | null {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const obj = record as Record<string, unknown>;
  const used = new Set<string>();

  // Dotted paths, so a literal `"log.level"` key and a nested `log.level` are
  // the same thing to the chips that come after.
  const take = (keys: readonly string[], ok: (v: unknown) => boolean = () => true): unknown => {
    for (const key of keys) {
      const value = lookup(obj, key);
      if (value === undefined || value === null || value === '' || !ok(value)) continue;
      used.add(key);
      return value;
    }
    return undefined;
  };

  const message = take(JSON_MESSAGE, (v) => typeof v === 'string');
  if (typeof message !== 'string') return null;

  const out: ParsedLogLine = { level: jsonLevel(take(JSON_LEVEL)), message };

  const time = take(JSON_TIME);
  if (typeof time === 'string') Object.assign(out, stamp(time));
  else if (typeof time === 'number') Object.assign(out, epoch(time));

  const logger = take(JSON_LOGGER);
  const line = take(JSON_LINE);
  if (typeof logger === 'string') Object.assign(out, named(line !== undefined ? `${logger}:${line}` : logger));

  const thread = take(JSON_THREAD);
  if (typeof thread === 'string' || typeof thread === 'number') out.thread = String(thread);

  const stack = take(JSON_STACK);
  if (typeof stack === 'string' && stack.trim()) out.stack = stack.replace(/\s+$/, '');
  else if (Array.isArray(stack) && stack.length > 0) out.stack = stack.join('\n');

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (used.has(key)) continue;
    flatten(key, value, fields, used);
  }
  if (Object.keys(fields).length > 0) out.fields = fields;
  return out;
}

/// `log.level` is written both ways: as a literal dotted key (ECS, flat) and as
/// `{"log":{"level":…}}`.
function lookup(obj: Record<string, unknown>, key: string): unknown {
  if (key in obj) return obj[key];
  let at: unknown = obj;
  for (const part of key.split('.')) {
    if (!at || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

function flatten(prefix: string, value: unknown, into: Record<string, string>, used: Set<string>): void {
  if (JSON_NOISE.has(prefix) || used.has(prefix) || used.has(prefix.replace(/\./g, ' '))) return;
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(`${prefix}.${k}`, v, into, used);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0) into[prefix] = JSON.stringify(value);
    return;
  }
  into[prefix] = String(value);
}

/// Level as a word in any case, or pino/bunyan's number.
function jsonLevel(value: unknown): Level {
  if (typeof value === 'number') {
    if (value >= 50) return 'error';
    if (value >= 40) return 'warn';
    if (value >= 30) return 'info';
    if (value >= 20) return 'debug';
    return 'trace';
  }
  return typeof value === 'string' ? level(value.toUpperCase()) : 'info';
}

/// Epoch seconds or milliseconds, shown in local time like a written stamp.
function epoch(value: number): { time: string; stamp: string } {
  const d = new Date(value < 1e12 ? value * 1000 : value);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
    stamp: d.toISOString(),
  };
}

function level(word: string): Level {
  switch (word) {
    case 'ERROR':
    case 'ERR':
    case 'FATAL':
    case 'CRITICAL':
    case 'SEVERE':
      return 'error';
    case 'WARN':
    case 'WARNING':
      return 'warn';
    case 'DEBUG':
    case 'FINE':
      return 'debug';
    case 'TRACE':
    case 'FINEST':
      return 'trace';
    default:
      return 'info';
  }
}

function stamp(raw: string): { time?: string; stamp: string } {
  const t = /(\d{2}:\d{2}:\d{2})(?:[.,](\d{1,6}))?/.exec(raw);
  if (!t) return { stamp: raw };
  return { time: t[2] ? `${t[1]}.${t[2].slice(0, 3).padEnd(3, '0')}` : t[1], stamp: raw };
}

/// `c.z.z.AwsSecretsContextInitializer:77` → `AwsSecretsContextInitializer`.
function named(logger: string | undefined): { logger?: string; loggerFull?: string } {
  if (!logger) return {};
  const bare = logger.replace(/:\d+$/, '');
  return { logger: bare.slice(bare.lastIndexOf('.') + 1), loggerFull: logger };
}

/// Where to cut a very long line so what shows still reads — after a comma or
/// a space near the limit, rather than in the middle of a path.
export function summarizeLong(text: string, limit: number): { head: string; hidden: number } {
  if (text.length <= limit) return { head: text, hidden: 0 };
  const boundary = Math.max(text.lastIndexOf(', ', limit), text.lastIndexOf(' ', limit));
  const at = boundary > limit * 0.6 ? boundary : limit;
  // The separator itself belongs to neither half; a dangling comma reads as a
  // truncation bug.
  const head = text.slice(0, at).replace(/[,\s]+$/, '');
  return { head, hidden: text.length - head.length };
}
