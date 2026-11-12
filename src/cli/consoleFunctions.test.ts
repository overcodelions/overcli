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

describe('the loops in a flow', () => {
  const from = CONSOLE_JS.indexOf('function flowLoops(steps)');
  const to = CONSOLE_JS.indexOf('// What a step does when its work');
  const loops = (steps: Array<{ id: string; label?: string; onFail?: { to: string; label?: string; times: number } }>) =>
    new Function('steps', `${CONSOLE_JS.slice(from, to)}\nreturn flowLoops(steps);`)(steps) as { lanes: number; loops: Array<{ top: number; bottom: number; lane: number; times: number }> };
  const send = (id: string, target: string, times = 2) => ({ id, onFail: { to: target, times } });

  it('finds a step that sends work back to an earlier one', () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const r = loops([{ id: 'plan' }, { id: 'build' }, send('review', 'build'), { id: 'push' }]);
    expect(r.lanes).toBe(1);
    expect(r.loops[0]).toMatchObject({ top: 1, bottom: 2, lane: 0, times: 2 });
  });

  it('draws nothing for a retry of itself, a jump forward, or a step that is gone', () => {
    expect(loops([send('a', 'a'), send('b', 'c'), { id: 'c' }, send('d', 'nope')]).lanes).toBe(0);
  });

  it('keeps loops that touch or overlap apart, with the shorter one nearest the steps', () => {
    const nested = loops([{ id: 'a' }, { id: 'b' }, send('c', 'b'), send('d', 'a')]);
    expect(nested.lanes).toBe(2);
    expect(nested.loops.map((l) => [l.top, l.lane])).toEqual([[1, 0], [0, 1]]);
    expect(loops([{ id: 'a' }, send('b', 'a'), send('c', 'b')]).lanes).toBe(2);
  });

  it('lets loops that never meet share a lane', () => {
    expect(loops([{ id: 'a' }, send('b', 'a'), { id: 'c' }, send('d', 'c')]).lanes).toBe(1);
  });
});

describe('the two rows of the chrome', () => {
  const below = (crumbs: string[][]) => {
    const from = CONSOLE_JS.indexOf('function crumbsBelow(crumbs)');
    const to = CONSOLE_JS.indexOf('function chromeCrumbs(x)');
    return new Function('crumbs', `${CONSOLE_JS.slice(from, to)}\nreturn crumbsBelow(crumbs);`)(crumbs) as string[][];
  };

  it('leaves the section to the top row, and names what is inside it', () => {
    expect(below([['Workers'], ['Ada']])).toEqual([['Ada']]);
    expect(below([['Teams'], ['Product'], ['A task'], ['Shared folder']])).toEqual([['Product'], ['A task'], ['Shared folder']]);
  });

  it('scrolls to the open tab, not to the name before the tabs', () => {
    // The name is marked as the current page too, so any [aria-current] finds it first.
    expect(CONSOLE_JS).toContain(`next.querySelector(':scope > button[aria-current="page"]')`);
  });

  it('brings an open tab into view, and leaves one that already is', () => {
    const from = CONSOLE_JS.indexOf('function tabScroll(left, row, tab)');
    const to = CONSOLE_JS.indexOf('// Pinned things sit under the chrome');
    const scroll = (left: number, tab: { left: number; right: number }) =>
      new Function('left', 'tab', `${CONSOLE_JS.slice(from, to)}\nreturn tabScroll(left, { left: 0, right: 390 }, tab);`)(left, tab) as number;
    expect(scroll(0, { left: 40, right: 120 })).toBe(0);
    expect(scroll(0, { left: 800, right: 900 })).toBe(655);
    expect(scroll(300, { left: -200, right: -100 })).toBe(0);
  });

  it('opens what belongs to the org from its name, for admins only', () => {
    const from = CONSOLE_JS.indexOf('function orgMenu(me)');
    const to = CONSOLE_JS.indexOf('  var WORKER_TABS = [');
    const stub = "var go = function () {}, navFor = function () { return 'x'; }, navBadges = function () { return null; }, icon = function () { return 'icon'; }, state = { tab: 'x' };";
    const h = (tag: string, attrs: Record<string, unknown>) => ({ tag, attrs });
    const run = (items: unknown[]) => new Function('h', 'adminItems', 'navMenu', `${stub}\n${CONSOLE_JS.slice(from, to)}\nreturn orgMenu({ org: 'Acme' });`)(
      h, () => items, (btn: unknown, list: unknown, cls: string) => ({ menu: cls, list, btn })) as Record<string, any>;
    const setup = { id: 'setup', label: 'Setup' };
    expect(run([setup])).toMatchObject({ menu: 'org-wrap', list: [setup] });
    expect(run([])).toMatchObject({ tag: 'button', attrs: { text: 'Acme', title: 'Inbox' } });
  });

  it('gives the org pages tabs for each other, ahead of any path a page sets', () => {
    const row = CONSOLE_JS.slice(CONSOLE_JS.indexOf('function chromeRow()'), CONSOLE_JS.indexOf('function sectionItems()'));
    expect(row.indexOf("'aria-label': 'Organization'")).toBeGreaterThan(-1);
    expect(row.indexOf("'aria-label': 'Organization'")).toBeLessThan(row.indexOf('liveCtx()'));
  });

  it('ignores the row of a page that finished loading after you left it', () => {
    const from = CONSOLE_JS.indexOf('function setChrome(crumbs, tabs, current, pick, label)');
    const to = CONSOLE_JS.indexOf('function liveCtx()');
    const run = (tab: string, crumb: string) => {
      const state = { tab };
      const chrome = new Function('state', `var chromeCtx = null, syncChromeRow = function () {};
        var ctxKey = function () { return 'k'; };
        var navFor = function (t) { return ({ worker: 'workers', process: 'processes' })[t] || t; };
        var sectionItems = function () { return [{ id: 'workers', label: 'Workers' }, { id: 'processes', label: 'Processes' }]; }, adminItems = function () { return []; };
        ${CONSOLE_JS.slice(from, to)}
        return function (c) { setChrome(c); return chromeCtx; };`)(state) as (c: string[][]) => unknown;
      return chrome([[crumb], ['x']]);
    };
    expect(run('process', 'Workers')).toBeNull();
    expect(run('worker', 'Workers')).not.toBeNull();
    expect(run('process', 'Processes')).not.toBeNull();
    // A crumb that isn't a section can't be judged by it.
    expect(run('read', 'Somewhere else')).not.toBeNull();
  });

  it('keeps a lone crumb', () => {
    expect(below([['Library']])).toEqual([['Library']]);
  });

  it('keeps the chrome height in step when the row changes after loading', () => {
    // Pinned things read --chrome-h, and the second row comes and goes with
    // the page, after render() has measured it.
    const from = CONSOLE_JS.indexOf('function syncChromeRow()');
    expect(CONSOLE_JS.slice(from, from + 600)).toContain('syncChromeHeight();');
    expect(CONSOLE_JS).toContain('    syncChromeRow();\n  }\n  function liveCtx()');
  });
});

describe('who can reach a team or process', () => {
  const fn = (name: string, end: string) => {
    const from = CONSOLE_JS.indexOf(`function ${name}(`);
    return new Function(`${CONSOLE_JS.slice(from, CONSOLE_JS.indexOf(end, from))}\nreturn ${name};`)() as (x: unknown) => string;
  };

  it('says who a process really takes work from', () => {
    const words = fn('processStarters', 'function picturePicker(');
    expect(words({ whoStarts: { who: 'everyone', groups: [] } })).toBe('Anyone can put work in');
    expect(words({ whoStarts: { who: 'private', groups: [] } })).toBe('Only its owner can put work in');
    expect(words({ whoStarts: { who: 'team', groups: ['Support'] } })).toBe('Support can put work in');
    expect(words({ whoStarts: { who: 'people', groups: [] } })).toBe('Picked people can put work in');
  });

  it('says who a team takes tasks from, as its settings have it', () => {
    const words = fn('teamBriefers', '/// Who may put work into a process.');
    expect(words({ picked: true })).toBe('Picked people can give it tasks');
    expect(words({ whoCanBrief: 'org' })).toBe('Anyone can give it tasks');
    expect(words({ whoCanBrief: 'managers' })).toBe('Its members’ managers can give it tasks');
  });

  it('no longer claims anyone can use a process from Slack', () => {
    expect(CONSOLE_JS).not.toContain('Slack, by anyone');
    expect(CONSOLE_JS).not.toContain("detail: 'anyone in the org'");
  });
});

describe('the tabs of a team and a process', () => {
  const from = CONSOLE_JS.indexOf('var TEAM_VIEWS = ');
  const to = CONSOLE_JS.indexOf('\n  }\n', CONSOLE_JS.indexOf('function hashFor()'));
  const hash = (state: Record<string, unknown>) =>
    new Function('state', `${CONSOLE_JS.slice(from, to)}\n  }\nreturn hashFor();`)(state) as string;

  it('keeps a tab in the address, and leaves out the one it opens on', () => {
    expect(hash({ tab: 'team', teamId: 't1' })).toBe('team/t1');
    expect(hash({ tab: 'team', teamId: 't1', teamTab: 'reach' })).toBe('team/t1/reach');
    expect(hash({ tab: 'process', processId: 'p1' })).toBe('process/p1');
    expect(hash({ tab: 'process', processId: 'p1', processView: 'how' })).toBe('process/p1/how');
  });

  it('puts an open item in the address ahead of the tab behind it', () => {
    expect(hash({ tab: 'process', processId: 'p1', processView: 'how', processItem: 'i1' })).toBe('process/p1/i1');
  });

  it('starts a different team or process on its first tab', () => {
    const go = CONSOLE_JS.slice(CONSOLE_JS.indexOf('function go(tab, extra)'), CONSOLE_JS.indexOf('function openWorker(id)'));
    expect(go).toContain('extra.teamId !== state.teamId) state.teamTab = null');
    expect(go).toContain('extra.processId !== state.processId) state.processView = null');
  });

  it('keeps a team or process row in place while a new tab loads', () => {
    const key = CONSOLE_JS.slice(CONSOLE_JS.indexOf('function ctxKey()'), CONSOLE_JS.indexOf('function setChrome('));
    expect(key).toContain("state.tab === 'team' ? 't:' + state.teamId");
    expect(key).toContain("state.tab === 'process' ? 'p:' + state.processId");
  });

  it('has moved how to reach a team out of its settings', () => {
    const settings = CONSOLE_JS.slice(CONSOLE_JS.indexOf('function teamSettingsView(t)'), CONSOLE_JS.indexOf('function viewTeam()'));
    expect(settings).not.toContain("reachView('team'");
  });
});

describe('saving several tuning changes', () => {
  it('drops what saved, so another press only tries what failed', () => {
    expect(CONSOLE_JS).toContain('saves.splice(saves.indexOf(one), 1);');
    expect(CONSOLE_JS).toContain("'Save the remaining '");
  });
});

describe('a Setup page', () => {
  it('keeps its rules: it strips their title, so nothing may wrap them', () => {
    // Wrapped once, the title strip took the whole rules section with it.
    expect(CONSOLE_JS).not.toMatch(/\bspending = h\(/);
    expect(CONSOLE_JS).toContain("concat([sec]).concat(only === 'spending' ? [budgetsByManager()] : [])");
  });
});

describe('picking a team’s crew', () => {
  // The check above only asks that a name exists somewhere in the script, and
  // other pages have a toggle of their own, so the form's own went missing
  // unnoticed and clicking a worker did nothing. Run it for real.
  const from = CONSOLE_JS.indexOf("      var byId = function (id) { return workers.filter(");
  const to = CONSOLE_JS.indexOf('      // What the file says, as far as it fits who you can put on a team here.');
  const crew = () =>
    new Function('workers', 'draw', `var picked = {}, roles = {}, order = [];\n${CONSOLE_JS.slice(from, to)}\nreturn { toggle: toggle, state: function () { return { picked: picked, roles: roles, order: order }; }, setRole: function (id, r) { roles[id] = r; } };`)(
      [{ id: 'a' }, { id: 'b' }],
      () => {},
    ) as { toggle(id: string, on: boolean): void; state(): { picked: Record<string, boolean>; roles: Record<string, string>; order: string[] }; setRole(id: string, r: string): void };

  it('defines toggle in the form itself', () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(CONSOLE_JS.slice(from, to)).toContain('var toggle = function (id, on)');
  });

  it('puts a worker on the crew, once, in the order picked, and takes them off again', () => {
    const c = crew();
    c.toggle('b', true);
    c.toggle('a', true);
    c.toggle('b', true);
    expect(c.state().order).toEqual(['b', 'a']);
    c.setRole('b', 'Architect');
    c.toggle('b', false);
    expect(c.state().order).toEqual(['a']);
    expect(c.state().picked).toEqual({ a: true });
    expect(c.state().roles).toEqual({});
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
  type Item = { title: string; at: number; minutes?: number; kind?: string; outcome?: string };
  const code = part('  function startOf(', '  /// A row whose title is the button') + part("  /// A ticket's key at the head", '  /// One step of a piece of work');
  const { workGroups, workSteps } = new Function('nameOf', 'askedTitle', 'when', `${code}; return { workGroups, workSteps };`)((x: Item) => x.outcome || x.title, (x: Item) => x.title, () => '') as {
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

  it('groups by what was asked, not by the outcome each run came to', () => {
    expect(shape([at(1, 'Daily exception filing', { outcome: 'Filed 3 exceptions' }), at(1.5, 'Daily exception filing', { outcome: 'Filed nothing new today' })])).toEqual([['Daily exception filing', 'Daily exception filing']]);
    expect(workGroups([at(1, 'ACME-7 is stuck', { outcome: 'Restarted the acme sync job' })])[0].key).toBe('ACME-7');
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

describe('changing every worker’s budget at once', () => {
  const from = CONSOLE_JS.indexOf('  function scaledBudgets(');
  const to = CONSOLE_JS.indexOf('  /// The org’s budgets for an admin') >= 0 ? CONSOLE_JS.indexOf('  /// The org’s budgets for an admin') : CONSOLE_JS.indexOf("  /// The org's budgets for an admin");
  const scaled = new Function(`${CONSOLE_JS.slice(from, to)}; return scaledBudgets;`)() as (w: Array<{ id: string; name: string; capUSD: number; spentUSD: number }>, f: number) => Array<{ id: string; to: number; from: number }>;
  const worker = (id: string, capUSD: number, spentUSD = 0) => ({ id, name: id, capUSD, spentUSD });

  it('scales each to whole dollars', () => {
    expect(scaled([worker('a', 100), worker('b', 50)], 0.9).map((c) => [c.id, c.to])).toEqual([['a', 90], ['b', 45]]);
  });

  it('never goes below what a worker has spent, or below a dollar', () => {
    expect(scaled([worker('a', 100, 95.5)], 0.5)[0].to).toBe(96);
    expect(scaled([worker('a', 1)], 0.1)).toEqual([]);
    expect(scaled([worker('a', 10)], 0.01)[0].to).toBe(1);
  });

  it('leaves out what wouldn’t change', () => {
    expect(scaled([worker('a', 100)], 1)).toEqual([]);
  });

  it('gets close to an org budget, within rounding', () => {
    const caps = [20, 480.03, 336.81, 50, 15, 50, 15, 20, 15, 15, 10, 15].map((c, i) => worker(String(i), c));
    const total = caps.reduce((sum, w) => sum + w.capUSD, 0);
    const changes = scaled(caps, 1000 / total);
    const after = caps.reduce((sum, w) => sum + (changes.find((c) => c.id === w.id)?.to ?? w.capUSD), 0);
    expect(after).toBeGreaterThan(990);
    expect(after).toBeLessThan(1010);
  });
});

describe('the teams and processes board', () => {
  const fn = (name: string) => {
    const at = CONSOLE_JS.indexOf(`  function ${name}(`);
    return CONSOLE_JS.slice(at, CONSOLE_JS.indexOf('\n  }\n', at) + 4);
  };
  const spanShort = new Function(`${fn('spanShort')}\nreturn spanShort;`)() as (ms: number) => string;
  const isQuestion = new Function(`${CONSOLE_JS.match(/function isTeamQuestion\(k\) \{[^\n]*\}/)![0]}\nreturn isTeamQuestion;`)() as (k: object) => boolean;

  it('says a length of time the way the table and the figures do', () => {
    const MIN = 60_000;
    expect(spanShort(18 * MIN)).toBe('18m');
    expect(spanShort(6 * 60 * MIN + 40 * MIN)).toBe('6h 40m');
    expect(spanShort(5 * 1440 * MIN + 2 * 60 * MIN)).toBe('5d 2h');
    expect(spanShort(2 * 1440 * MIN)).toBe('2d');
  });

  it('keeps one-off questions out of the staged work, and never calls a finished one planning', () => {
    expect(isQuestion({ answered: true, status: 'done', stages: [] })).toBe(true);
    expect(isQuestion({ status: 'done', stages: [] })).toBe(true);
    expect(isQuestion({ status: 'planning', stages: [] })).toBe(false);
    expect(isQuestion({ status: 'cancelled', stages: [] })).toBe(false);
    expect(isQuestion({ status: 'done', stages: [{ state: 'done' }] })).toBe(false);
  });
});
