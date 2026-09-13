import { describe, expect, it } from 'vitest';
import { parseLogLine, summarizeLong } from './logLine';

describe('reading a log line', () => {
  it('splits the log4j layout AcmeREST writes', () => {
    const line = parseLogLine(
      '[INFO ] 2026-09-12T14:44:08,630 [main] [] [c.z.r.Application:597] - The following profiles are active: local',
    );
    expect(line).toEqual({
      level: 'info',
      time: '14:44:08.630',
      stamp: '2026-09-12T14:44:08,630',
      thread: 'main',
      logger: 'Application',
      loggerFull: 'c.z.r.Application:597',
      message: 'The following profiles are active: local',
    });
  });

  it('keeps the thread when it is not main', () => {
    const line = parseLogLine(
      '[DEBUG] 2026-09-12T14:44:21,055 [localhost-startStop-1] [] [o.s.b.w.s.ServletContextInitializerBeans:139] - Added existing Filter',
    );
    expect(line).toMatchObject({ level: 'debug', thread: 'localhost-startStop-1', logger: 'ServletContextInitializerBeans' });
  });

  it('reads an error with no context bracket at all', () => {
    const line = parseLogLine('[ERROR] 2026-09-12T14:30:36,820 [main] [c.z.c.AwsSecretsContextInitializer:88] - Unable to find secret');
    expect(line).toMatchObject({ level: 'error', thread: 'main', logger: 'AwsSecretsContextInitializer', message: 'Unable to find secret' });
  });

  it('splits Spring Boot’s default layout', () => {
    const line = parseLogLine(
      '2026-09-12 14:44:08.630  WARN 48213 --- [           main] o.s.b.SpringApplication                  : Something odd',
    );
    expect(line).toMatchObject({ level: 'warn', time: '14:44:08.630', thread: 'main', logger: 'SpringApplication', message: 'Something odd' });
  });

  it('splits Logback’s default layout', () => {
    const line = parseLogLine('14:44:08.630 [main] INFO  com.acme.Foo - Started');
    expect(line).toMatchObject({ level: 'info', time: '14:44:08.630', logger: 'Foo', message: 'Started' });
  });

  it('reads a bare level prefix', () => {
    expect(parseLogLine('INFO:     Uvicorn running on http://127.0.0.1:8000')).toEqual({
      level: 'info',
      message: 'Uvicorn running on http://127.0.0.1:8000',
    });
    expect(parseLogLine('[WARN] disk nearly full')).toMatchObject({ level: 'warn', message: 'disk nearly full' });
  });

  it('leaves alone anything it does not recognise', () => {
    // A formatter that mangles output is worse than none.
    for (const text of [
      '> Task :AcmeREST:bootRun',
      '  .   ____          _            __ _ _',
      '\tat org.springframework.boot.SpringApplication.run(SpringApplication.java:303)',
      'Loading class `com.mysql.jdbc.Driver`. This is deprecated.',
      'Info about the build',
      'INFO about the build',
    ]) {
      expect(parseLogLine(text)).toBeNull();
    }
  });
});

describe('folding a very long line', () => {
  it('leaves a short line whole', () => {
    expect(summarizeLong('short', 400)).toEqual({ head: 'short', hidden: 0 });
  });

  it('cuts after a separator near the limit rather than inside a path', () => {
    const classpath = Array.from({ length: 50 }, (_, i) => `file:/Users/x/.gradle/caches/lib-${i}.jar`).join(', ');
    const { head, hidden } = summarizeLong(classpath, 400);
    expect(head.endsWith('.jar')).toBe(true);
    expect(head.length + hidden).toBe(classpath.length);
    expect(head.length).toBeLessThanOrEqual(400);
  });
});
