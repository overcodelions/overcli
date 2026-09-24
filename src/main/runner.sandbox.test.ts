// The flag → argv contract at the one spawn chokepoint: with
// `sandboxFsWrites` the backend runs as `sandbox-exec -f <profile> <binary>
// …`, without it the spawn is exactly what it was before the jail existed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: { command: string; args: string[] }[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // Record what the runner asked for, then run something harmless so the
    // listeners it wires onto the child have a real process to attach to.
    spawn: (command: string, args: string[], opts: object) => {
      spawnCalls.push({ command, args });
      return real.spawn('/bin/cat', [], opts as never);
    },
  };
});

import { RunnerManager, shouldSandboxSpawn } from './runner';
import { useTestHost } from './testHost';

const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-sandbox-data-')));
const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-sandbox-cwd-')));
useTestHost(dataDir);
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('shouldSandboxSpawn', () => {
  const base = { backend: 'claude' as const, permissionMode: 'bypassPermissions' as const };

  it('is off unless the send asks for it (chat never does)', () => {
    expect(shouldSandboxSpawn(base, 'darwin')).toBe(false);
    expect(shouldSandboxSpawn({ ...base, sandboxFsWrites: false }, 'darwin')).toBe(false);
    expect(shouldSandboxSpawn({ ...base, sandboxFsWrites: true }, 'darwin')).toBe(true);
  });

  it('passes through unwrapped off macOS', () => {
    expect(shouldSandboxSpawn({ ...base, sandboxFsWrites: true }, 'linux')).toBe(false);
    expect(shouldSandboxSpawn({ ...base, sandboxFsWrites: true }, 'win32')).toBe(false);
  });

  it('jails codex only when its own sandbox is off — Seatbelt cannot nest', () => {
    const codex = { backend: 'codex' as const, sandboxFsWrites: true };
    expect(shouldSandboxSpawn({ ...codex, permissionMode: 'bypassPermissions' }, 'darwin')).toBe(true);
    expect(shouldSandboxSpawn({ ...codex, permissionMode: 'acceptEdits' }, 'darwin')).toBe(false);
    expect(shouldSandboxSpawn({ ...codex, permissionMode: 'default' }, 'darwin')).toBe(false);
  });

  it('never wraps ollama (no child process to jail)', () => {
    expect(shouldSandboxSpawn({ ...base, backend: 'ollama', sandboxFsWrites: true }, 'darwin')).toBe(false);
  });
});

describe('spawnFor', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  function spawnWith(sandboxFsWrites: boolean | undefined) {
    const manager = new RunnerManager(
      () => {},
      () => ({ backends: {}, backendPaths: { copilot: '/usr/bin/true' } }) as never,
    );
    const priv = manager as unknown as {
      spawnFor(args: object): { proc?: { kill(): void }; launchSandbox: boolean };
    };
    const active = priv.spawnFor({
      conversationId: `c-${String(sandboxFsWrites)}`,
      prompt: '',
      backend: 'copilot',
      cwd,
      model: 'm',
      permissionMode: 'bypassPermissions',
      sandboxFsWrites,
    });
    active.proc?.kill();
    return { active, call: spawnCalls[spawnCalls.length - 1] };
  }

  it('spawns the backend binary directly when the flag is off (today’s behavior)', () => {
    const { active, call } = spawnWith(undefined);
    expect(call.command).not.toBe('/usr/bin/sandbox-exec');
    expect(call.args[0]).not.toBe('-f');
    expect(active.launchSandbox).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')(
    'wraps the same argv in sandbox-exec with a profile outside the jail when the flag is on',
    () => {
      const off = spawnWith(false).call;
      const { active, call } = spawnWith(true);
      expect(call.command).toBe('/usr/bin/sandbox-exec');
      expect(call.args[0]).toBe('-f');
      const profile = call.args[1];
      expect(profile.startsWith(path.join(dataDir, 'seatbelt'))).toBe(true);
      expect(call.args.slice(2)).toEqual([off.command, ...off.args]);
      const text = fs.readFileSync(profile, 'utf-8');
      expect(text).toContain(`(allow file-write* (subpath "${cwd}"))`);
      expect(text).not.toContain(`(subpath "${dataDir}")`);
      expect(active.launchSandbox).toBe(true);
    },
  );
});
