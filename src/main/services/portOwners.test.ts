import { describe, expect, it } from 'vitest';
import {
  classifyOwner,
  describeOwners,
  holderKind,
  parseLsofCwds,
  parseLsofFields,
  parseNetstatListeners,
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
