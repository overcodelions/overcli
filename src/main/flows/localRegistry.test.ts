import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLocalEntry, scanLocalRegistry, sha256Of } from './localRegistry';

const VALID_YAML = `
name: Ship It
description: Plans then ships
input: user_prompt
steps:
  - id: plan
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: planner
    inputs: [user_prompt]
    tools: [Read]
    output: plan.md
`;

let dir: string;

function write(name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), body, 'utf-8');
}

function scan() {
  return scanLocalRegistry({ registryId: 'private', dir });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-local-registry-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanLocalRegistry', () => {
  it('derives an entry from each flow YAML in the folder', () => {
    write('ship_it.yaml', VALID_YAML);
    const [entry] = scan();
    expect(entry.registryId).toBe('private');
    expect(entry.id).toBe('ship_it');
    expect(entry.name).toBe('Ship It');
    expect(entry.description).toBe('Plans then ships');
    expect(entry.yamlPath).toBe(path.join(dir, 'ship_it.yaml'));
    expect(entry.sha256).toBe(sha256Of(VALID_YAML));
    expect(entry.updatedAt).toBeGreaterThan(0);
  });

  it('reads registry-only metadata the Flow schema drops', () => {
    write('ship_it.yaml', `${VALID_YAML}\nversion: "2.1.0"\ntags: [ci, release]\nauthor: { name: Owen, url: 'https://example.com' }\n`);
    const [entry] = scan();
    expect(entry.version).toBe('2.1.0');
    expect(entry.tags).toEqual(['ci', 'release']);
    expect(entry.author).toEqual({ name: 'Owen', url: 'https://example.com' });
  });

  it('derives a content-based version when the YAML declares none', () => {
    write('ship_it.yaml', VALID_YAML);
    const before = scan()[0].version;
    expect(before).toBe(sha256Of(VALID_YAML).slice(0, 12));

    // Editing the flow must produce a new version — otherwise an install would
    // record a version that no longer describes what's on disk.
    write('ship_it.yaml', VALID_YAML.replace('Ship It', 'Ship It Faster'));
    expect(scan()[0].version).not.toBe(before);
  });

  it('skips non-YAML files, unparseable flows, and ids that are not slugs', () => {
    write('ship_it.yaml', VALID_YAML);
    write('README.md', '# not a flow');
    write('broken.yaml', ':\n  - [unclosed');
    write('Not A Slug.yaml', VALID_YAML);
    expect(scan().map((e) => e.id)).toEqual(['ship_it']);
  });

  it('throws when the folder is gone, so the UI can say so', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => scan()).toThrow();
  });
});

describe('readLocalEntry', () => {
  it('returns the body when the file still matches the listing', () => {
    write('ship_it.yaml', VALID_YAML);
    const result = readLocalEntry(scan()[0]);
    expect(result).toEqual({ ok: true, body: VALID_YAML });
  });

  it('refuses when the file changed since it was listed', () => {
    write('ship_it.yaml', VALID_YAML);
    const entry = scan()[0];
    write('ship_it.yaml', VALID_YAML.replace('Ship It', 'Something Else'));

    const result = readLocalEntry(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Refresh');
  });
});
