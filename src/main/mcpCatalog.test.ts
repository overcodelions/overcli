import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installMcpCatalogEntry, listMcpCatalog } from './mcpCatalog';
import { readMcpServer, writeMcpServer } from './mcpConfig';

let tmp: string;
let paths: { claude: string; codex: string; gemini: string };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-mcp-cat-'));
  paths = {
    claude: path.join(tmp, '.claude', 'settings.json'),
    codex: path.join(tmp, '.codex', 'config.toml'),
    gemini: path.join(tmp, '.gemini', 'settings.json'),
  };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/// The config AWS told everyone to delete — what an overcli user who
/// installed the AWS entry before the migration still has on disk.
const RETIRED_AWS = {
  command: 'uvx',
  args: ['awslabs.aws-api-mcp-server@latest'],
  env: { AWS_REGION: 'us-east-1' },
};

describe('catalog install: value substitution', () => {
  it('substitutes a collected value into args, not env', () => {
    const res = installMcpCatalogEntry('aws', ['claude'], { AWS_REGION: 'eu-west-1' }, paths);
    expect(res.ok).toBe(true);

    const config = readMcpServer('claude', 'aws', paths)!;
    expect(config.args).toContain('AWS_REGION=eu-west-1');
    // The managed server reads its region from proxy metadata; an env var
    // would only steer local credential resolution.
    expect(config.env).toBeUndefined();
  });

  it('falls back to the field default when the value is left blank', () => {
    installMcpCatalogEntry('aws', ['claude'], { AWS_REGION: '   ' }, paths);
    const config = readMcpServer('claude', 'aws', paths)!;
    expect(config.args).toContain('AWS_REGION=us-east-1');
  });

  it('pins the proxy version rather than tracking @latest', () => {
    installMcpCatalogEntry('aws', ['claude'], {}, paths);
    const args = readMcpServer('claude', 'aws', paths)!.args as string[];
    expect(args[0]).toMatch(/^mcp-proxy-for-aws@\d+\.\d+\.\d+$/);
    expect(args).toContain('https://aws-mcp.us-east-1.api.aws/mcp');
  });

  it('still routes non-templated fields into env', () => {
    installMcpCatalogEntry('aws', ['claude'], { AWS_PROFILE: 'prod' }, paths);
    const config = readMcpServer('claude', 'aws', paths)!;
    expect(config.env).toEqual({ AWS_PROFILE: 'prod' });
    // Blank optional fields aren't written as empty keys.
    expect(Object.keys(config.env as object)).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('overwrites a legacy entry in place rather than adding a second server', () => {
    writeMcpServer('claude', 'aws', RETIRED_AWS, paths);
    installMcpCatalogEntry('aws', ['claude'], { AWS_REGION: 'ap-south-1' }, paths);

    const raw = JSON.parse(fs.readFileSync(paths.claude, 'utf-8'));
    expect(Object.keys(raw.mcpServers)).toEqual(['aws']);
    const args = raw.mcpServers.aws.args as string[];
    expect(args.join(' ')).not.toContain('awslabs.aws-api-mcp-server');
    // The stale env block goes with it — leaving AWS_REGION there would
    // read as a live region setting that no longer does anything.
    expect(raw.mcpServers.aws.env).toBeUndefined();
  });
});

describe('catalog listing: legacy detection', () => {
  it('flags an installed config that predates the current template', () => {
    writeMcpServer('claude', 'aws', RETIRED_AWS, paths);
    const aws = listMcpCatalog(paths).find((e) => e.id === 'aws')!;

    expect(aws.installed.claude).toBe(true);
    expect(aws.legacy.claude).toBe(true);
    expect(aws.legacyNote).toBeTruthy();
  });

  it('does not flag a config written from the current template', () => {
    installMcpCatalogEntry('aws', ['claude'], {}, paths);
    const aws = listMcpCatalog(paths).find((e) => e.id === 'aws')!;

    expect(aws.installed.claude).toBe(true);
    expect(aws.legacy.claude).toBe(false);
  });

  it('flags per CLI, so a partial migration is visible', () => {
    writeMcpServer('claude', 'aws', RETIRED_AWS, paths);
    installMcpCatalogEntry('aws', ['gemini'], {}, paths);
    const aws = listMcpCatalog(paths).find((e) => e.id === 'aws')!;

    expect(aws.legacy.claude).toBe(true);
    expect(aws.legacy.gemini).toBe(false);
    expect(aws.legacy.codex).toBe(false);
  });

  it('reports nothing legacy when the server is not installed at all', () => {
    const aws = listMcpCatalog(paths).find((e) => e.id === 'aws')!;
    expect(aws.installed.claude).toBe(false);
    expect(aws.legacy.claude).toBe(false);
  });

  it('survives a hand-edited config with a non-array args', () => {
    writeMcpServer('claude', 'aws', { command: 'uvx', args: 'awslabs.aws-api-mcp-server' } as any, paths);
    expect(() => listMcpCatalog(paths)).not.toThrow();
  });
});
