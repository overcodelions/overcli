import { describe, expect, it } from 'vitest';
import { CONSOLE_JS } from './consoleAssets';

// The console is one big script edited in place. A helper cut out by an edit
// (it happened: reachView went with the function next to it) only shows up as
// "x is not defined" on the page that calls it. This catches it here.
describe('the console script', () => {
  it('defines every view, card and helper it calls', () => {
    // Code only: drop string literals and comments so words in copy don't count.
    const code = CONSOLE_JS.replace(/\/\/[^\n]*/g, '').replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
    const params = [...code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
    const defined = new Set([...code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).concat([...code.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1])).concat(params));
    const called = new Set([...code.matchAll(/(?<![\w$.\\])([a-z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]));
    const browser = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'alert', 'confirm', 'open']);
    const missing = [...called].filter((n) => !defined.has(n) && !browser.has(n));
    expect(missing).toEqual([]);
  });
});

describe('what a run did, in plain words', () => {
  // The grouping functions alone, cut from the script and run here.
  const from = CONSOLE_JS.indexOf('  var ACT_HOST');
  const to = CONSOLE_JS.indexOf('  function liveRunView(');
  const groupActivity = new Function(`${CONSOLE_JS.slice(from, to)}; return groupActivity;`)() as (items: Array<{ at: number; kind: string; text: string }>) => Array<{ text: string; cls: string; raw: string[] }>;
  const tool = (at: number, text: string) => ({ at, kind: 'tool', text });

  it('groups calls of one kind into a line with a count, and keeps the exact lines', () => {
    const groups = groupActivity([
      tool(1, 'Looked for **/seo-journal.md'),
      tool(2, 'Ran curl -sSIL -m 20 https://acme.example/ | grep -iE "^(HTTP|location)"'),
      tool(3, 'Ran curl -sSL https://www.acme.example/robots.txt'),
      tool(4, 'Ran mkdir -p /tmp/crawl'),
      { at: 5, kind: 'said', text: 'Starting the report' },
      tool(6, 'acme tracker: get issue (ACME-412)'),
    ]);
    expect(groups.map((g) => g.text)).toEqual([
      'Looked through its files',
      'Fetched pages from acme.example · 2 times',
      'Ran a command in its workspace',
      '“Starting the report”',
      'Used acme tracker',
    ]);
    expect(groups[1].raw).toHaveLength(2);
    expect(groups[3].cls).toBe('said');
  });

  it('makes alternating housekeeping in one minute a single line', () => {
    const groups = groupActivity([
      tool(1000, 'Looked for **/notes.md'),
      tool(2000, 'Ran ls -la'),
      tool(3000, 'Looked for **/*.html'),
      tool(4000, 'Ran wc -l pages.txt'),
      tool(5000, 'Read site/pages.txt'),
      tool(90_000, 'Ran ls /tmp/crawl'),
    ]);
    expect(groups.map((g) => g.text)).toEqual(['Read 1 file, searched its files and ran 2 commands', 'Ran a command in its workspace']);
    expect(groups[0].raw).toHaveLength(5);
  });
});

describe('the inbox, as pieces of work', () => {
  // The grouping and step order alone, cut from the script and run here.
  const part = (from: string, to: string) => {
    const a = CONSOLE_JS.indexOf(from), b = CONSOLE_JS.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error('moved: ' + from);
    return CONSOLE_JS.slice(a, b);
  };
  type Item = { title: string; at: number; minutes?: number; kind?: string };
  const code = part('  function startOf(', '  /// A row whose title is the button') + part("  /// A ticket's key at the head", '  /// One step of a piece of work');
  const { workGroups, workSteps } = new Function('nameOf', 'when', `${code}; return { workGroups, workSteps };`)((x: Item) => x.title, () => '') as {
    workGroups: (items: Item[]) => Array<{ key?: string; title?: string; items: Item[] }>;
    workSteps: (items: Item[]) => { steps: Item[]; began: number; ended: number };
  };
  const H = 3600000, NOW = 100 * H;
  const at = (hoursAgo: number, title: string, more: Partial<Item> = {}): Item => ({ title, at: NOW - hoursAgo * H, ...more });
  const shape = (items: Item[]) => workGroups(items).map((g) => g.items.map((x) => x.title));

  it('keeps a ticket’s trigger, runs and follow-ups together, the key anywhere in a title', () => {
    expect(shape([
      at(1, 'ACME-5: comment the pull request'),
      at(2, 'Fix ACME-5'),
      at(30, 'ACME-5: Sandbox copies drop fields', { kind: 'event' }),
      at(3, 'ACME-6: Something else'),
    ])).toEqual([['ACME-5: comment the pull request', 'Fix ACME-5', 'ACME-5: Sandbox copies drop fields'], ['ACME-6: Something else']]);
  });

  it('leaves a title naming several tickets to itself', () => {
    expect(shape([at(1, 'Move ACME-1, ACME-2 to QA'), at(2, 'ACME-1: fix it')])).toEqual([['Move ACME-1, ACME-2 to QA'], ['ACME-1: fix it']]);
  });

  it('puts a wrap-up with the work it finishes', () => {
    expect(shape([at(1, 'Finishing up now that "Pull partner campaigns" is done'), at(1.2, 'Pull partner campaigns')]))
      .toEqual([['Finishing up now that "Pull partner campaigns" is done', 'Pull partner campaigns']]);
  });

  it('keeps the same scheduled job on different days apart, and a burst of it together', () => {
    expect(shape([at(1, 'Daily exception filing'), at(25, 'Daily exception filing')])).toEqual([['Daily exception filing'], ['Daily exception filing']]);
    expect(shape([at(1, 'Daily exception filing'), at(1.5, 'Daily exception filing', { minutes: 20 })])).toEqual([['Daily exception filing', 'Daily exception filing']]);
  });

  it('reads the steps from what set it off, and spans first start to last finish', () => {
    // A trigger's time is when its work was done; its minutes run from when it fired.
    const fired = at(1, 'ACME-5: bug', { kind: 'event', minutes: 12 });
    const fix = at(1.1, 'ACME-5: fix', { minutes: 5 });
    const note = at(1, 'ACME-5: comment', { minutes: 1 });
    const ws = workSteps([note, fired, fix]);
    expect(ws.steps.map((x) => x.title)).toEqual(['ACME-5: bug', 'ACME-5: fix', 'ACME-5: comment']);
    expect((ws.ended - ws.began) / 60000).toBe(12);
  });
});
