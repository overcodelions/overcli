import { describe, expect, it } from 'vitest';
import {
  classifyOwner,
  commandMatches,
  matchingProcesses,
  withDescendants,
  parseLsofListenerPorts,
  parsePsArgs,
  parseSsListenerPorts,
  describeOwners,
  holderKind,
  parseLsofCwds,
  parseLsofFields,
  parseNetstatListeners,
  portOwners,
  parsePsParents,
  parseSsListeners,
  parseTasklistName,
  type ProcessFacts,
} from './portOwners';

describe('classifyOwner', () => {
  // The real tree from the screenshot. overcli's electron (44090) and its vite
  // (44171) are siblings under `npm run dev`; overgit's vite (53810) was left
  // behind when its concurrently died, so its npm (53691) now belongs to pid 1.
  const facts: ProcessFacts = {
    selfPid: 44090,
    parents: new Map([
      [44090, 44080],
      [44171, 44087],
      [44087, 44080],
      [44080, 900],
      [53810, 53691],
      [53691, 1],
      [60001, 60000],
      [60000, 700],
      [70001, 44090],
    ]),
    cwds: new Map([
      [44090, '/src/overcli'],
      [44171, '/src/overcli'],
      [44087, '/src/overcli'],
      [44080, '/src/overcli'],
      [900, '/Users/me'],
      [53810, '/src/overgit'],
      [53691, '/src/overgit'],
      [60001, '/src/overgit'],
      [60000, '/src/overgit'],
      [700, '/Users/me'],
      [70001, '/src/overcli'],
    ]),
  };
  const ctx = { appRoot: '/src/overcli', servicePath: '/src/overgit' };

  it("recognises overcli's own dev server", () => {
    expect(classifyOwner(44171, ctx, facts)).toBe('self');
    expect(classifyOwner(44090, ctx, facts)).toBe('self');
  });

  it('calls a copy whose launcher has gone stale', () => {
    expect(classifyOwner(53810, ctx, facts)).toBe('stale');
  });

  // A JVM service launched with `./gradlew bootRun` and then outlived: the
  // listening `java` is a Gradle daemon child, and the daemon works in
  // `~/.gradle`, not in the checkout. Its own parent is the wrapper overcli
  // spawned, now reparented to launchd.
  const gradleTree = (wrapperParent: number, extra: [number, string][] = []): ProcessFacts => ({
    selfPid: 44090,
    parents: new Map([[58676, 58602], [58602, 58588], [58588, wrapperParent], ...(
      wrapperParent === 1 ? [] : ([[wrapperParent, 800]] as [number, number][])
    )]),
    cwds: new Map<number, string>([
      [58676, '/src/acme-orders/orders-service'],
      [58602, '/Users/me/.gradle/daemon/4.10.3'],
      [58588, '/src/acme-orders'],
      ...extra,
    ]),
  });

  it('sees past a Gradle daemon to the wrapper overcli left behind', () => {
    expect(classifyOwner(58676, { servicePath: '/src/acme-orders' }, gradleTree(1))).toBe('stale');
  });

  it('still leaves a Gradle service started from a terminal alone', () => {
    // Same shape, but the wrapper's parent is a shell in the checkout rather
    // than launchd, and the shell's parent is the terminal.
    const facts = gradleTree(900, [[900, '/src/acme-orders'], [800, '/']]);
    expect(classifyOwner(58676, { servicePath: '/src/acme-orders' }, facts)).toBe('other');
  });

  it('leaves the same service run from a terminal alone', () => {
    // 60000 is a shell in the checkout whose parent is Terminal, not launchd.
    expect(classifyOwner(60001, ctx, facts)).toBe('other');
  });

  it('does not mistake a service overcli launched for overcli', () => {
    expect(classifyOwner(70001, { appRoot: '/src/overcli' }, facts)).toBe('other');
  });

  it('does not take a sibling folder for the checkout', () => {
    expect(classifyOwner(53810, { servicePath: '/src/over' }, facts)).toBe('other');
  });

  it('knows nothing without a working directory', () => {
    expect(classifyOwner(12345, ctx, facts)).toBe('other');
  });
});

describe('holderKind', () => {
  it('lets one self holder decide', () => {
    expect(
      holderKind([
        { pid: 1, command: 'node', kind: 'stale' },
        { pid: 2, command: 'node', kind: 'self' },
      ]),
    ).toBe('self');
  });

  it('is stale only when every holder is', () => {
    expect(holderKind([{ pid: 1, command: 'node', kind: 'stale' }])).toBe('stale');
    expect(
      holderKind([
        { pid: 1, command: 'node', kind: 'stale' },
        { pid: 2, command: 'java', kind: 'other' },
      ]),
    ).toBe('other');
    expect(holderKind([])).toBeUndefined();
  });
});

describe('process table parsing', () => {
  it('reads ps output', () => {
    expect(parsePsParents('    1     0\n53810 53691\n')).toEqual(
      new Map([
        [1, 0],
        [53810, 53691],
      ]),
    );
  });

  it('reads lsof cwd fields', () => {
    expect(parseLsofCwds('p53810\nfcwd\nn/src/overgit\np44171\nfcwd\nn/src/overcli\n')).toEqual(
      new Map([
        [53810, '/src/overgit'],
        [44171, '/src/overcli'],
      ]),
    );
  });
});

describe('parseSsListeners', () => {
  it('reads the process out of the users column', () => {
    const text = 'LISTEN 0 100 *:8083 *:* users:(("java",pid=4242,fd=12))\n';
    expect(parseSsListeners(text)).toEqual([{ pid: 4242, command: 'java' }]);
  });

  it('counts a process once across its IPv4 and IPv6 sockets', () => {
    const text =
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=7,fd=20))\n' +
      'LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=7,fd=21))\n';
    expect(parseSsListeners(text)).toHaveLength(1);
  });

  it('names nobody for a listener owned by another user', () => {
    expect(parseSsListeners('LISTEN 0 4096 *:8083 *:*\n')).toEqual([]);
  });
});

describe('parseNetstatListeners', () => {
  const text = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:8083           0.0.0.0:0              LISTENING       5120',
    '  TCP    127.0.0.1:8083         127.0.0.1:51234        ESTABLISHED     5120',
    '  TCP    127.0.0.1:51234        127.0.0.1:8083         ESTABLISHED     900',
    '  TCP    [::]:8083              [::]:0                 LISTENING       5120',
    '  TCP    0.0.0.0:18083          0.0.0.0:0              LISTENING       77',
  ].join('\r\n');

  it('finds the listener and not the connections to it', () => {
    expect(parseNetstatListeners(text, 8083)).toEqual([5120]);
  });

  it('does not mistake a port that merely ends in the same digits', () => {
    expect(parseNetstatListeners(text, 18083)).toEqual([77]);
  });

  it('does not depend on the state column, which Windows translates', () => {
    const german = '  TCP    0.0.0.0:8083           0.0.0.0:0              ABHÖREN       5120';
    expect(parseNetstatListeners(german, 8083)).toEqual([5120]);
  });
});

describe('parseTasklistName', () => {
  it('reads the image name', () => {
    expect(parseTasklistName('"java.exe","5120","Console","1","210,332 K"\r\n')).toBe('java.exe');
  });

  it('returns null for the no-match message', () => {
    expect(parseTasklistName('INFO: No tasks are running which match the specified criteria.')).toBeNull();
  });
});

describe('parseLsofFields', () => {
  it('reads a process record out of the field format', () => {
    // Real output, from a node dev server holding :3000.
    expect(parseLsofFields('p96355\ncnode\nf19\nn*:3000\n')).toEqual([
      { pid: 96355, command: 'node' },
    ]);
  });

  it('counts a process once however many files it lists on the port', () => {
    const text = 'p96355\ncnode\nf19\nn*:3000\nf20\nn*:3000\n';
    expect(parseLsofFields(text)).toHaveLength(1);
  });

  it('reads several holders', () => {
    expect(parseLsofFields('p1\ncjava\np2\ncdocker\n')).toEqual([
      { pid: 1, command: 'java' },
      { pid: 2, command: 'docker' },
    ]);
  });

  it('parses the field format rather than the human table, so a command with a space survives', () => {
    expect(parseLsofFields('p42\ncRocket League\n')).toEqual([{ pid: 42, command: 'Rocket League' }]);
  });

  it('ignores a command line with no process before it', () => {
    expect(parseLsofFields('cnode\n')).toEqual([]);
  });

  it('returns nothing for empty output, which is the common case', () => {
    expect(parseLsofFields('')).toEqual([]);
  });
});

describe('describeOwners', () => {
  it('names the one process a person has to decide about', () => {
    expect(describeOwners([{ pid: 96355, command: 'node' }])).toBe('node (pid 96355)');
  });

  it('summarises several', () => {
    expect(
      describeOwners([
        { pid: 1, command: 'java' },
        { pid: 2, command: 'node' },
      ]),
    ).toBe('2 processes — java, node');
  });

  it('stays vague when nothing could be identified', () => {
    // lsof may be missing or refuse; "cannot tell" must not read as a name.
    expect(describeOwners([])).toBe('another program on this machine');
  });
});

describe('portOwners async lookup', () => {
  it('uses ss on Linux and enriches listeners without blocking shell execution', async () => {
    const calls: string[] = [];
    const runner = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'ss') return 'LISTEN 0 511 *:3000 *:* users:(("node",pid=77,fd=20))\n';
      if (command === 'ps') return '77 1\n';
      if (command === 'lsof' && args.includes('cwd')) return 'p77\nfcwd\nn/work/service\n';
      return null;
    };

    await expect(portOwners(3000, { servicePath: '/work/service' }, runner, 'linux')).resolves.toEqual([
      { pid: 77, command: 'node', kind: 'stale' },
    ]);
    expect(calls[0]).toBe('ss -ltnpH sport = :3000');
  });

  it('falls back to lsof when ss is unavailable and treats lookup failures as unknown', async () => {
    const calls: string[] = [];
    const runner = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      return null;
    };

    await expect(portOwners(4567, {}, runner, 'linux')).resolves.toEqual([]);
    expect(calls).toEqual([
      'ss -ltnpH sport = :4567',
      'lsof -nP -iTCP:4567 -sTCP:LISTEN -Fpc',
    ]);
  });

  it('uses netstat and tasklist on Windows', async () => {
    const runner = async (command: string, args: string[]) => {
      if (command === 'netstat' && args.at(-1) === 'TCP') {
        return 'TCP 0.0.0.0:8083 0.0.0.0:0 LISTENING 5120\r\n';
      }
      if (command === 'tasklist') return '"java.exe","5120","Console","1","1 K"\r\n';
      return '';
    };

    await expect(portOwners(8083, {}, runner, 'win32')).resolves.toEqual([
      { pid: 5120, command: 'java.exe', kind: 'other' },
    ]);
  });
});

describe('one scan for every listener', () => {
  it('reads each holder and the port it holds out of lsof field output', () => {
    const text = [
      'p1269', 'crapportd', 'f13', 'n*:57737', 'f14', 'n*:57737',
      'p58676', 'cjava', 'f289', 'n127.0.0.1:5002',
      'p53539', 'cnode', 'f23', 'n[::1]:4200',
    ].join('\n');

    expect(parseLsofListenerPorts(text)).toEqual([
      // The same port on two descriptors is one holder of it.
      { pid: 1269, command: 'rapportd', port: 57737 },
      { pid: 58676, command: 'java', port: 5002 },
      { pid: 53539, command: 'node', port: 4200 },
    ]);
  });

  it('reads them out of an ss listing, where the port is in the local address', () => {
    const text = [
      'LISTEN 0 4096 0.0.0.0:8088 0.0.0.0:* users:(("java",pid=60577,fd=804))',
      // No users column: a listener this user may not look into names nobody.
      'LISTEN 0 128 127.0.0.1:631 0.0.0.0:*',
    ].join('\n');

    expect(parseSsListenerPorts(text)).toEqual([{ pid: 60577, command: 'java', port: 8088 }]);
  });
});

describe('matchingProcesses', () => {
  // Four copies of one processor: same command, same checkout, told apart only
  // by the startup options that end up on the command line.
  const psText = [
    '  501   1 ./gradlew :Processor:bootRun -PjvmArgs=-Dqueue=infra',
    '  502   1 ./gradlew :Processor:bootRun -PjvmArgs=-Dqueue=content',
    '  600 900 node scripts/bridge.mjs --watch',
  ].join('\n');
  const lsofCwds = ['p501', 'n/src/acme-procs', 'p502', 'n/src/acme-procs', 'p600', 'n/src/acme-bridge'].join('\n');
  const runner = async (command: string) => {
    if (command === 'ps') return psText;
    if (command === 'lsof') return lsofCwds;
    return null;
  };

  it('tells copies apart by the options on their command line', async () => {
    const found = await matchingProcesses([
      { key: 'infra', tokens: ['./gradlew', ':Processor:bootRun', '-PjvmArgs=-Dqueue=infra'], checkout: '/src/acme-procs' },
      { key: 'content', tokens: ['./gradlew', ':Processor:bootRun', '-PjvmArgs=-Dqueue=content'], checkout: '/src/acme-procs' },
    ], runner, 'darwin');

    expect(found.get('infra')?.pid).toBe(501);
    expect(found.get('content')?.pid).toBe(502);
    expect(found.get('infra')?.kind).toBe('stale');
  });

  it('refuses a process that answers to two services', async () => {
    // Without the distinguishing option both services match both processes,
    // and picking one would be stopping or claiming the wrong work.
    const found = await matchingProcesses([
      { key: 'infra', tokens: ['./gradlew', ':Processor:bootRun'], checkout: '/src/acme-procs' },
      { key: 'content', tokens: ['./gradlew', ':Processor:bootRun'], checkout: '/src/acme-procs' },
    ], runner, 'darwin');

    expect(found.size).toBe(0);
  });

  it('refuses a match running outside the service checkout', async () => {
    const found = await matchingProcesses([
      { key: 'bridge', tokens: ['node', 'scripts/bridge.mjs'], checkout: '/src/somewhere-else' },
    ], runner, 'darwin');

    expect(found.size).toBe(0);
  });

  it('adopts nothing on Windows, where a command line is all there is', async () => {
    const found = await matchingProcesses(
      [{ key: 'infra', tokens: ['./gradlew'], checkout: '/src/acme-procs' }],
      runner,
      'win32',
    );
    expect(found.size).toBe(0);
  });
});

describe('parsePsArgs', () => {
  it('keeps the whole command line, spaces and all', () => {
    expect(parsePsArgs('  501   1 node a.js --flag "x y"')).toEqual([
      { pid: 501, ppid: 1, args: 'node a.js --flag "x y"' },
    ]);
  });
});

describe('commandMatches', () => {
  // What `./gradlew :orders:bootRun …` looks like once the wrapper script has
  // exec'd into the JVM: the word the spec starts with is gone.
  const wrapper =
    '/opt/java/bin/java -Xdock:name=Gradle -classpath /src/acme/gradle/wrapper/gradle-wrapper.jar ' +
    'org.gradle.wrapper.GradleWrapperMain :orders:bootRun -Dorg.gradle.daemon=false -PjvmArgs=-Dqueue=infra -Dregion=local';

  it('recognises a launcher that has replaced itself', () => {
    expect(commandMatches(wrapper, [
      './gradlew', ':orders:bootRun', '-Dorg.gradle.daemon=false', '-PjvmArgs=-Dqueue=infra -Dregion=local',
    ])).toBe(true);
  });

  it('tells copies apart by their options', () => {
    expect(commandMatches(wrapper, [
      './gradlew', ':orders:bootRun', '-Dorg.gradle.daemon=false', '-PjvmArgs=-Dqueue=content -Dregion=local',
    ])).toBe(false);
  });

  it('matches whole arguments, never part of one', () => {
    expect(commandMatches('node server.js restart-worker', ['npm', 'start'])).toBe(false);
    expect(commandMatches('node /usr/lib/npm-cli.js start', ['npm', 'start'])).toBe(true);
  });

  it('claims nothing from a bare program', () => {
    // With the program discounted there is nothing left to identify it by.
    expect(commandMatches('make', ['make'])).toBe(false);
  });
});

describe('withDescendants', () => {
  it('takes the whole tree, deepest first', async () => {
    // wrapper → single-use daemon → app, and an unrelated process beside them.
    const ps = ['100 1', '200 100', '300 200', '400 1'].join('\n');
    const tree = await withDescendants([100], async () => ps);
    expect(tree).toEqual([300, 200, 100]);
  });
});
