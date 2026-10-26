import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installWhole, npxDirFor, npxSpec } from './npxWarm';

describe('npx tools, installed ahead', () => {
  it('reads the package an npx line runs', () => {
    expect(npxSpec('npx', ['-y', 'zd-mcp-server@0.6.1'])).toBe('zd-mcp-server@0.6.1');
    expect(npxSpec('/usr/bin/npx', ['-y', '@acme/tools-mcp', '--headless'])).toBe('@acme/tools-mcp');
    expect(npxSpec('uvx', ['mcp-acme'])).toBeNull();
    expect(npxSpec('npx', ['-y', '-p', 'a', 'b'])).toBeNull();
  });

  it('finds the folder npm keeps it in, by the spec', () => {
    expect(path.basename(npxDirFor('zd-mcp-server@0.6.1', '/c'))).toBe('7307f59163b71b45');
  });

  it('tells a whole install from one cut off part-way', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npxwarm-'));
    expect(installWhole(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, 'node_modules', '@acme', 'sdk'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/@acme/sdk': {} } }));
    expect(installWhole(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'node_modules', '@acme', 'sdk', 'package.json'), '{}');
    expect(installWhole(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
