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
