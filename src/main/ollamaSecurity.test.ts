import { describe, expect, it } from 'vitest';
import { buildFindings } from './ollamaSecurity';

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
