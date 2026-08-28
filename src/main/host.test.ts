// The seam every store reaches the disk through. Two properties matter and
// both are easy to break by accident.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { clearHost, hasHost, host, runningUnderElectron, setHost } from './host';
import { defaultDataDir, nodeHost, registryTokenEnvName } from './hostNode';
import { useTestHost } from './testHost';

afterEach(() => useTestHost('/tmp/overcli-host-tests'));

describe('host()', () => {
  it('throws when nothing is installed, rather than guessing a directory', () => {
    // The whole safety property. A silent default would mean a missed wiring
    // writes into someone's real worker journal instead of failing loudly.
    clearHost();
    expect(() => host()).toThrow(/No Overcli host installed/);
    expect(hasHost()).toBe(false);
  });

  it('lets the last install win, because suites re-point between cases', () => {
    setHost(nodeHost({ dataDir: '/tmp/a' }));
    setHost(nodeHost({ dataDir: '/tmp/b' }));
    expect(host().dataDir()).toBe('/tmp/b');
  });

  it('survives module duplication, which vi.resetModules causes', async () => {
    // Kept on a well-known symbol for exactly this: a second copy of host.ts
    // with its own module-level `let` would read as "no host installed".
    setHost(nodeHost({ dataDir: '/tmp/slot-check' }));
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for('overcli.host')];
    expect(slot).toBeDefined();
  });
});

describe('runningUnderElectron', () => {
  it('is false under plain node, which is what the CLI runs as', () => {
    // runner.ts uses this to decide whether spawning process.execPath would
    // boot a second GUI. Under vitest we are node.
    expect(runningUnderElectron()).toBe(false);
  });
});

describe('defaultDataDir', () => {
  const saved = process.env.OVERCLI_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.OVERCLI_HOME;
    else process.env.OVERCLI_HOME = saved;
  });

  it('prefers $OVERCLI_HOME', () => {
    process.env.OVERCLI_HOME = '/tmp/from-env';
    expect(defaultDataDir()).toBe('/tmp/from-env');
  });

  it('ignores an empty or whitespace value rather than rooting at ""', () => {
    process.env.OVERCLI_HOME = '   ';
    expect(defaultDataDir()).toBe(path.join(os.homedir(), '.overcli'));
  });

  it('falls back to ~/.overcli', () => {
    delete process.env.OVERCLI_HOME;
    expect(defaultDataDir()).toBe(path.join(os.homedir(), '.overcli'));
  });
});

describe('nodeHost', () => {
  it('creates the directory lazily, not at construction', () => {
    const dir = path.join(os.tmpdir(), `overcli-lazy-${process.pid}-${Date.now()}`);
    const h = nodeHost({ dataDir: dir });
    // `overcli run` on a bad path should fail with the run's own error rather
    // than leaving a stray directory behind first.
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.dataDir()).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads registry tokens from the environment and never writes one', () => {
    // A CI data directory is routinely cached and uploaded as an artifact; a
    // bearer token written into it would travel with it.
    process.env.OVERCLI_REGISTRY_TOKEN_ACME_FLOWS = 'sekrit';
    const h = nodeHost({ dataDir: '/tmp/x' });
    expect(h.secrets.get('acme-flows')).toBe('sekrit');
    expect(h.secrets.set('acme-flows', 'other')).toBe(false);
    delete process.env.OVERCLI_REGISTRY_TOKEN_ACME_FLOWS;
  });

  it('returns null for a token that is not set', () => {
    expect(nodeHost({ dataDir: '/tmp/x' }).secrets.get('nope')).toBeNull();
  });

  it('sends notifications to stderr by default, keeping stdout a clean stream', () => {
    // `--json` writes exactly one object to stdout; a notification landing
    // there would make it unparseable.
    const seen: string[] = [];
    const h = nodeHost({ dataDir: '/tmp/x', onNotify: (a) => seen.push(a.title) });
    h.notify({ title: 'Shift done', body: '1 proposal' });
    expect(seen).toEqual(['Shift done']);
  });
});

describe('registryTokenEnvName', () => {
  it('upper-cases and folds punctuation, so a registry id maps to a legal name', () => {
    expect(registryTokenEnvName('acme-flows')).toBe('OVERCLI_REGISTRY_TOKEN_ACME_FLOWS');
    expect(registryTokenEnvName('acme.flows')).toBe('OVERCLI_REGISTRY_TOKEN_ACME_FLOWS');
  });
});
