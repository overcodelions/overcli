import { describe, expect, it } from 'vitest';
import { exceptionMessage, groupLog, isStackFrame, isTraceHeader } from './stackFrames';

/// A real Spring failure, trimmed: one sentence that matters, surrounded by
/// frames nobody reads.
const lines = [
  '[ERROR] Application startup failed',
  "org.springframework.beans.factory.BeanDefinitionStoreException: Invalid bean definition with name 'unpooledProcDataSource'",
  '\tat org.springframework.beans.factory.config.PlaceholderConfigurerSupport.doProcessProperties(PlaceholderConfigurerSupport.java:223)',
  '\tat org.springframework.context.support.PropertySourcesPlaceholderConfigurer.processProperties(PropertySourcesPlaceholderConfigurer.java:180)',
  '\tat org.springframework.context.support.AbstractApplicationContext.refresh(AbstractApplicationContext.java:525)',
  '\tat org.springframework.boot.SpringApplication.run(SpringApplication.java:303)',
  '\tat com.acme.processor.Application.main(Application.java:40)',
  "Caused by: java.lang.IllegalArgumentException: Could not resolve placeholder 'proc.database.ip'",
  '\tat org.springframework.util.PropertyPlaceholderHelper.parseStringValue(PropertyPlaceholderHelper.java:174)',
  '\t... 11 more',
  '> Task :AcmeProcessor:bootRun FAILED',
].map((text, index) => ({ index, text }));

describe('isStackFrame', () => {
  it('recognises the three spellings that actually fill a log', () => {
    expect(isStackFrame('\tat com.acme.Thing.method(Thing.java:40)')).toBe(true);
    expect(isStackFrame('    at Object.<anonymous> (/app/index.js:1:2)')).toBe(true);
    expect(isStackFrame('\t... 11 more')).toBe(true);
  });

  it('does not swallow a message that happens to contain "at"', () => {
    expect(isStackFrame('Started at 12:18 with 3 workers')).toBe(false);
    expect(isStackFrame('[ERROR] Application startup failed')).toBe(false);
  });
});

describe('groupLog', () => {
  it('folds a run of frames into one row', () => {
    const items = groupLog(lines);
    const frames = items.filter((i) => i.kind === 'frames');
    expect(frames).toHaveLength(1);
    expect(frames[0].kind === 'frames' && frames[0].indices).toEqual([2, 3, 4, 5, 6]);
  });

  it('leaves the two frames under Caused by alone', () => {
    // The cause's own trace here is two lines. Folding those would cost a
    // click to read what was already readable, and the cause is the part
    // everyone is looking for.
    const items = groupLog(lines);
    const shown = items.filter((i) => i.kind === 'line').map((i) => lines[i.index].text);
    expect(shown).toContain(lines[8].text);
    expect(shown).toContain(lines[9].text);
  });

  it('keeps every message line, in order', () => {
    const items = groupLog(lines);
    const messages = items.filter((i) => i.kind === 'line').map((i) => lines[i.index].text);
    expect(messages).toEqual([
      lines[0].text,
      lines[1].text,
      lines[7].text,
      lines[8].text,
      lines[9].text,
      lines[10].text,
    ]);
  });

  it('leaves a short run alone', () => {
    // Two frames are not a wall, and hiding them costs a click to read
    // something that was already readable.
    const short = [
      { index: 0, text: 'boom' },
      { index: 1, text: '\tat a.B.c(B.java:1)' },
      { index: 2, text: '\tat d.E.f(E.java:2)' },
    ];
    expect(groupLog(short).every((i) => i.kind === 'line')).toBe(true);
  });

  it('does not fold while searching, since the match may be in a frame', () => {
    expect(groupLog(lines, { collapse: false }).every((i) => i.kind === 'line')).toBe(true);
  });

  it('discards nothing — every line is still reachable', () => {
    const reachable = groupLog(lines).flatMap((i) => (i.kind === 'line' ? [i.index] : i.indices));
    expect(reachable).toEqual(lines.map((l) => l.index));
  });
});

describe('exceptionMessage', () => {
  it('separates the type from the sentence', () => {
    // Thirty characters of package before the first word that means anything.
    expect(exceptionMessage(lines[7].text)).toEqual({
      type: 'IllegalArgumentException',
      message: "Could not resolve placeholder 'proc.database.ip'",
    });
  });

  it('handles an exception with no message', () => {
    expect(exceptionMessage('java.lang.NullPointerException')).toEqual({
      type: 'NullPointerException',
      message: '',
    });
  });

  it('returns nothing for an ordinary line', () => {
    expect(exceptionMessage('[INFO ] Tomcat started on port 8083')).toBeNull();
  });
});

describe('isTraceHeader', () => {
  it('keeps the actual cause visible however much is folded', () => {
    expect(isTraceHeader(lines[7].text)).toBe(true);
    expect(isTraceHeader('Suppressed: java.io.IOException')).toBe(true);
    expect(isTraceHeader('[INFO ] ready')).toBe(false);
  });
});
