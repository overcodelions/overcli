import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runInTerminal = vi.hoisted(() => vi.fn());
vi.mock('./terminal', () => ({ runInTerminal }));

const mockNetworkInterfaces = vi.hoisted(() => vi.fn());
vi.mock('node:os', () => ({ default: { networkInterfaces: mockNetworkInterfaces } }));

const mockHttpGet = vi.hoisted(() => vi.fn());
vi.mock('node:http', () => ({ default: { get: mockHttpGet } }));

import { buildFindings, probeLanExposure, updateOllama } from './ollamaSecurity';

const base = {
  env: {} as NodeJS.ProcessEnv,
  lanExposed: false,
  serverRunning: true,
  serverManaged: true,
};

describe('buildFindings', () => {
  it('flags a version below the offline advisory floor', () => {
    const f = buildFindings({ ...base, installedVersion: '0.1.30' });
    expect(f.some((x) => x.id === 'CVE-2024-37032')).toBe(true);
  });

  it('clears the offline advisories at 0.1.46', () => {
    const f = buildFindings({ ...base, installedVersion: '0.1.46' });
    expect(f.filter((x) => x.id.startsWith('CVE-'))).toHaveLength(0);
  });

  it('reports a nearby update as medium', () => {
    const f = buildFindings({ ...base, installedVersion: '0.32.0', latestVersion: '0.33.1' });
    expect(f.find((x) => x.id === 'outdated')?.severity).toBe('medium');
  });

  it('escalates a version several minors behind to high', () => {
    const f = buildFindings({ ...base, installedVersion: '0.24.0', latestVersion: '0.32.14' });
    expect(f.find((x) => x.id === 'outdated')?.severity).toBe('high');
  });

  it('is quiet when current', () => {
    expect(
      buildFindings({ ...base, installedVersion: '0.32.14', latestVersion: '0.32.14' }),
    ).toHaveLength(0);
  });

  it('ignores wildcard env vars for a server overcli spawned', () => {
    const f = buildFindings({
      ...base,
      installedVersion: '0.32.14',
      latestVersion: '0.32.14',
      env: { OLLAMA_HOST: '0.0.0.0:11434', OLLAMA_ORIGINS: '*' } as NodeJS.ProcessEnv,
    });
    expect(f).toHaveLength(0);
  });

  it('flags wildcard env vars for an externally started server', () => {
    const f = buildFindings({
      ...base,
      serverManaged: false,
      installedVersion: '0.32.14',
      latestVersion: '0.32.14',
      env: { OLLAMA_HOST: '0.0.0.0:11434', OLLAMA_ORIGINS: '*' } as NodeJS.ProcessEnv,
    });
    expect(f.map((x) => x.id).sort()).toEqual(['host-wildcard', 'origins-wildcard']);
    expect(f.every((x) => x.fixId === undefined && !!x.manualCommand)).toBe(true);
  });

  it('offers a restart fix for observed LAN exposure only when managed', () => {
    const managed = buildFindings({
      ...base,
      installedVersion: '0.32.14',
      latestVersion: '0.32.14',
      lanExposed: true,
    });
    expect(managed[0].fixId).toBe('restart-loopback');
    const external = buildFindings({
      ...base,
      serverManaged: false,
      installedVersion: '0.32.14',
      latestVersion: '0.32.14',
      lanExposed: true,
    });
    expect(external[0].fixId).toBeUndefined();
    expect(external[0].manualCommand).toBeTruthy();
  });
});

describe('probeLanExposure', () => {
  afterEach(() => {
    mockNetworkInterfaces.mockReset();
    mockHttpGet.mockReset();
  });

  it('probes an IPv6 address bare, not bracketed — a bracketed host never resolves', () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: [{ family: 'IPv6', internal: false, address: '2001:db8::1', mac: '', netmask: '', cidr: null }],
    });
    const seenHosts: unknown[] = [];
    mockHttpGet.mockImplementation((opts: { host: unknown }) => {
      seenHosts.push(opts.host);
      return { on: vi.fn() };
    });
    void probeLanExposure();
    expect(seenHosts).toEqual(['2001:db8::1']);
  });

  it('skips link-local IPv6 addresses', () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: [{ family: 'IPv6', internal: false, address: 'fe80::1', mac: '', netmask: '', cidr: null }],
    });
    mockHttpGet.mockImplementation(() => ({ on: vi.fn() }));
    void probeLanExposure();
    expect(mockHttpGet).not.toHaveBeenCalled();
  });
});

describe('updateOllama', () => {
  const realPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    runInTerminal.mockReset();
  });

  it('reports the launch failure instead of claiming a Terminal opened', async () => {
    runInTerminal.mockResolvedValue({
      ok: false,
      error: 'macOS blocked overcli from controlling Terminal.',
      command: 'brew upgrade ollama',
    });
    const res = await updateOllama(() => {}, true);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('macOS blocked overcli');
    expect(res.command).toBe('brew upgrade ollama');
  });

  it('still surfaces a copyable command when the launcher gave none', async () => {
    runInTerminal.mockResolvedValue({ ok: false, error: 'osascript exited with code 1.' });
    const res = await updateOllama(() => {}, true);
    expect(res.command).toBe('brew upgrade ollama');
  });

  it('confirms the Terminal only when the launch succeeded', async () => {
    runInTerminal.mockResolvedValue({ ok: true });
    const res = await updateOllama(() => {}, true);
    expect(res).toEqual({ ok: true, message: 'Opened Terminal running `brew upgrade ollama`.' });
  });

  it('sends a non-Homebrew install to the download page rather than `brew upgrade`', async () => {
    const opener = vi.fn();
    const res = await updateOllama(opener, false);
    expect(runInTerminal).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledWith(expect.stringContaining('ollama'));
    expect(res.ok).toBe(true);
  });
});
