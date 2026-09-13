import { describe, expect, it } from 'vitest';
import { countLevels, filterLog } from './logFilter';
import { parseLogLine } from './logLine';

// Lines as content-svc writes them — logstash-logback-encoder with a shop layout.
const cms = (level: string, message: string, extra = '') =>
  `{"timestamp":"2026-09-12T15:00:29.805-0400","level":"${level}","thread":"main","logger":"org.springframework.boot.web.embedded.tomcat.TomcatWebServer","line":"90","xray_trace_id":"","message":"${message}","stacktrace":""${extra}}`;

describe('reading a JSON log line', () => {
  it('splits the layout content-svc writes', () => {
    expect(parseLogLine(cms('INFO', 'Tomcat initialized with port(s): 5024 (http)'))).toEqual({
      level: 'info',
      time: '15:00:29.805',
      stamp: '2026-09-12T15:00:29.805-0400',
      thread: 'main',
      logger: 'TomcatWebServer',
      loggerFull: 'org.springframework.boot.web.embedded.tomcat.TomcatWebServer:90',
      message: 'Tomcat initialized with port(s): 5024 (http)',
    });
  });

  it('keeps the fields that say something, and drops the empty ones', () => {
    const line = parseLogLine(cms('WARN', 'slow', ',"xray":{"trace":"1-abc"},"path":"/api","tags":[]'));
    expect(line?.level).toBe('warn');
    expect(line?.fields).toEqual({ 'xray.trace': '1-abc', path: '/api' });
  });

  it('carries a stack trace written into a field', () => {
    const line = parseLogLine(
      cms('ERROR', 'boom').replace('"stacktrace":""', '"stacktrace":"java.lang.IllegalStateException: x\\n\\tat com.acme.A.b(A.java:1)\\n"'),
    );
    expect(line).toMatchObject({ level: 'error', stack: 'java.lang.IllegalStateException: x\n\tat com.acme.A.b(A.java:1)' });
    expect(line?.fields).toBeUndefined();
  });

  it('reads pino: numeric level, epoch time, msg, nested err.stack', () => {
    const line = parseLogLine(
      '{"level":50,"time":1757703629805,"pid":1,"hostname":"mac","msg":"request failed","err":{"type":"Error","stack":"Error: x\\n    at f (a.js:1:1)"},"reqId":"r-1"}',
    );
    expect(line).toMatchObject({ level: 'error', message: 'request failed', stack: 'Error: x\n    at f (a.js:1:1)' });
    expect(line?.time).toMatch(/^\d{2}:\d{2}:\d{2}\.805$/);
    expect(line?.fields).toEqual({ 'err.type': 'Error', reqId: 'r-1' });
  });

  it('reads ECS, with log.level both flat and nested', () => {
    expect(parseLogLine('{"@timestamp":"2026-09-12T15:00:29.805Z","log.level":"warn","message":"flat"}')).toMatchObject({
      level: 'warn',
      message: 'flat',
    });
    const nested = parseLogLine('{"@timestamp":"2026-09-12T15:00:29.805Z","log":{"level":"error","logger":"a.B"},"message":"nested"}');
    expect(nested).toMatchObject({ level: 'error', logger: 'B' });
    expect(nested?.fields).toBeUndefined();
  });

  it('leaves alone JSON that is not a log record', () => {
    for (const text of ['{"status":"ok"}', '{not json}', '{"message":{"nested":true}}', '[1,2,3]']) {
      expect(parseLogLine(text)).toBeNull();
    }
  });

  it('counts and filters JSON records by level', () => {
    const log = ['> Task :cms-service:bootRun', cms('INFO', 'a'), cms('DEBUG', 'b'), cms('ERROR', 'c')];
    expect(countLevels(log)).toMatchObject({ info: 1, debug: 1, error: 1 });
    expect(filterLog(log, { hidden: new Set(['debug'] as const) }).map((l) => l.index)).toEqual([0, 1, 3]);
  });
});
