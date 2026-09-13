import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureServiceConfigDir,
  loadStack,
  saveStack,
  serviceConfigDir,
  stackFile,
} from './store';
import type { StackConfig } from './types';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-services-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const stack: StackConfig = {
  workspaceId: 'ws1',
  services: [
    {
      id: 'api',
      name: 'billing-rest',
      runner: 'spring-boot',
      command: ['./mvnw', 'spring-boot:run'],
      port: 8080,
      ready: { kind: 'tcp', port: 8080 },
      selfReloads: false,
      config: {},
    },
  ],
  bindings: [{ serviceId: 'api', ref: 'master', path: '/repos/billing-rest' }],
};

describe('loadStack', () => {
  it('returns an empty stack for a workspace with no services', () => {
    expect(loadStack(dataDir, 'ws1')).toEqual({ workspaceId: 'ws1', services: [], bindings: [] });
  });

  it('writes nothing just by being read', () => {
    // Most workspaces never have services; looking at one must not create a
    // directory tree for it.
    loadStack(dataDir, 'ws1');
    expect(fs.existsSync(path.join(dataDir, 'services'))).toBe(false);
  });

  it('round-trips a saved stack', () => {
    saveStack(dataDir, stack);
    expect(loadStack(dataDir, 'ws1')).toEqual(stack);
  });

  it('degrades to an empty stack rather than throwing on a corrupt file', () => {
    // An empty stack is recoverable by re-scanning. A crash on boot is not.
    saveStack(dataDir, stack);
    fs.writeFileSync(stackFile(dataDir, 'ws1'), '{ truncated', 'utf8');
    expect(loadStack(dataDir, 'ws1').services).toEqual([]);
  });

  it('leaves no temp file behind after a save', () => {
    saveStack(dataDir, stack);
    const entries = fs.readdirSync(path.join(dataDir, 'services', 'ws1'));
    expect(entries).toEqual(['stack.json']);
  });
});

describe('path safety', () => {
  it('refuses an id that would escape the data directory', () => {
    // These ids arrive over IPC and are joined into paths that get written to.
    expect(() => stackFile(dataDir, '../../Documents')).toThrow(/Invalid workspace id/);
    expect(() => serviceConfigDir(dataDir, 'ws1', '../..')).toThrow(/Invalid service id/);
  });
});

describe('ensureServiceConfigDir', () => {
  it('creates the directory a projection points at', () => {
    // The whole point of the directory: local props live here, outside every
    // checkout, so they survive a worktree switch.
    const dir = ensureServiceConfigDir(dataDir, 'ws1', 'api');
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toBe(path.join(dataDir, 'services', 'ws1', 'api'));
  });
});
