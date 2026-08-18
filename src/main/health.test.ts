import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockResolve, mockExists, mockHome } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockResolve: vi.fn(() => '/fake/backend'),
  mockExists: vi.fn<(file: string) => boolean>(() => false),
  mockHome: vi.fn(() => '/home/test'),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('node:os', () => ({ default: { homedir: mockHome } }));
vi.mock('node:fs', () => ({ existsSync: mockExists, readFileSync: vi.fn() }));
vi.mock('./backendPaths', () => ({
  backendNeedsShell: vi.fn(() => false),
  buildBackendEnv: vi.fn((env) => env),
  resolveBackendPath: mockResolve,
}));

import { invalidateHealthCache, probeBackendHealth } from './health';

const HEALTH_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;
const originalHealthEnv = Object.fromEntries(HEALTH_ENV_NAMES.map((name) => [name, process.env[name]]));

function processFor(options: { status?: number; stdout?: string; delay?: number } = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: { end: () => void };
    kill: () => void;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn(() => {
    proc.emit('close', null);
  });
  const finish = () => {
    if (options.stdout) proc.stdout.emit('data', options.stdout);
    proc.emit('close', options.status ?? 0);
  };
  if (options.delay === undefined) queueMicrotask(finish);
  else setTimeout(finish, options.delay);
  return proc;
}

describe('backend health', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    mockSpawn.mockReset();
    mockResolve.mockReturnValue('/fake/backend');
    mockExists.mockReturnValue(false);
    for (const name of HEALTH_ENV_NAMES) delete process.env[name];
    invalidateHealthCache();
  });

  afterEach(() => {
    for (const name of HEALTH_ENV_NAMES) {
      const value = originalHealthEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.useRealTimers();
  });

  it('allows Gemini version probes to take between four and ten seconds', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockSpawn.mockReturnValue(processFor({ delay: 5_000 }));
    const result = probeBackendHealth('gemini');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({ kind: 'ready' });
  });

  it('returns unknown for an initial version timeout', async () => {
    mockSpawn.mockReturnValue(processFor({ delay: 20_000 }));
    const result = probeBackendHealth('gemini');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('retains a cached ready result through a timed-out refresh', async () => {
    mockSpawn
      .mockImplementationOnce(() => processFor())
      .mockImplementationOnce(() => processFor({ stdout: '{"loggedIn":true}' }));
    await expect(probeBackendHealth('claude')).resolves.toMatchObject({ kind: 'ready' });
    await vi.advanceTimersByTimeAsync(15_001);
    mockSpawn.mockReturnValue(processFor({ delay: 20_000 }));
    const result = probeBackendHealth('claude');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({ kind: 'ready' });
  });

  it('uses Claude loggedIn rather than credential-file presence', async () => {
    mockExists.mockImplementation((file: string) => file === '/home/test/.claude.json');
    mockSpawn
      .mockImplementationOnce(() => processFor())
      .mockImplementationOnce(() =>
        processFor({ stdout: '{"loggedIn":false,"authMethod":"none"}' }),
      );
    await expect(probeBackendHealth('claude')).resolves.toMatchObject({ kind: 'unauthenticated' });
    invalidateHealthCache();
    mockSpawn
      .mockImplementationOnce(() => processFor())
      .mockImplementationOnce(() => processFor({ stdout: '{"loggedIn":true}' }));
    await expect(probeBackendHealth('claude')).resolves.toMatchObject({ kind: 'ready' });
  });

  it('recognizes Copilot config.json but not an empty legacy directory', async () => {
    mockExists.mockImplementation((file: string) => file === '/home/test/.copilot/config.json');
    mockSpawn.mockImplementation(() => processFor());
    await expect(probeBackendHealth('copilot')).resolves.toMatchObject({ kind: 'ready' });
    invalidateHealthCache();
    mockExists.mockImplementation((file: string) => file.endsWith('GitHub Copilot'));
    await expect(probeBackendHealth('copilot')).resolves.toMatchObject({ kind: 'unauthenticated' });
  });
});
