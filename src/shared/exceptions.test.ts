import { describe, expect, it } from 'vitest';
import { emptyExceptionLog, feedException, listExceptions, MAX_EXCEPTIONS, type ExceptionLog } from './exceptions';

function feed(lines: string[], log: ExceptionLog = emptyExceptionLog(), now = 1): ExceptionLog {
  return lines.reduce((acc, line) => feedException(acc, line, now), log);
}

const trace = (id: number) => [
  `2026-09-14 10:00:0${id % 10} ERROR 4${id} --- [main] c.acme.OrderService : failed order ${id}`,
  `com.acme.orders.OrderNotFoundException: order ${id} not found`,
  '\tat com.acme.orders.OrderService.load(OrderService.java:42)',
  '\tat com.acme.orders.OrderController.get(OrderController.java:18)',
  'Caused by: java.sql.SQLException: timeout after 3000ms',
  '\tat com.acme.db.Pool.take(Pool.java:7)',
  '\t... 12 more',
  `2026-09-14 10:00:0${id % 10} INFO 4${id} --- [main] c.acme.Next : carrying on`,
];

describe('feedException', () => {
  it('collects a trace with the record above it and its causes', () => {
    const items = listExceptions(feed(trace(1)));
    expect(items).toHaveLength(1);
    expect(items[0].header).toBe('com.acme.orders.OrderNotFoundException: order 1 not found');
    expect(items[0].sample[0]).toContain('ERROR');
    expect(items[0].sample).toContain('Caused by: java.sql.SQLException: timeout after 3000ms');
    expect(items[0].sample.some((l) => l.includes('carrying on'))).toBe(false);
  });

  it('counts the same exception once however its numbers differ', () => {
    let log = feed(trace(1), emptyExceptionLog(), 10);
    log = feed(trace(2), log, 20);
    log = feed(trace(3), log, 30);
    const items = listExceptions(log);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ count: 3, firstAt: 10, lastAt: 30 });
  });

  it('keeps distinct exceptions apart, newest first', () => {
    let log = feed(trace(1), emptyExceptionLog(), 10);
    log = feed(['TypeError: x is undefined', '    at render (/app/src/view.js:3:9)', 'next'], log, 20);
    expect(listExceptions(log).map((e) => e.header)).toEqual([
      'TypeError: x is undefined',
      'com.acme.orders.OrderNotFoundException: order 1 not found',
    ]);
  });

  it('includes a trace nothing has closed yet', () => {
    const log = feed(['boom: Error', '    at main (/app/index.js:1:1)']);
    expect(log.items).toHaveLength(0);
    expect(listExceptions(log)).toHaveLength(1);
  });

  it('strips colour codes and ignores plain output', () => {
    const log = feed(['\x1b[31mready\x1b[0m', 'listening on 8080']);
    expect(listExceptions(log)).toEqual([]);
  });

  it('caps a long trace and says how much was left out', () => {
    const frames = Array.from({ length: 200 }, (_, i) => `\tat com.acme.Deep.f${i}(Deep.java:${i})`);
    const [item] = listExceptions(feed(['java.lang.StackOverflowError', ...frames, 'after']));
    expect(item.sample.length).toBeLessThanOrEqual(81);
    expect(item.sample[item.sample.length - 1]).toMatch(/more lines$/);
  });

  it('drops the least recent past the limit', () => {
    let log = emptyExceptionLog();
    for (let i = 0; i <= MAX_EXCEPTIONS; i++) {
      log = feed([`com.acme.E${String.fromCharCode(65 + (i % 26))}${'x'.repeat(i)}Exception`, '\tat a.B.c(B.java:1)', 'ok'], log, i);
    }
    const items = listExceptions(log);
    expect(items).toHaveLength(MAX_EXCEPTIONS);
    expect(items.some((e) => e.firstAt === 0)).toBe(false);
  });
});
