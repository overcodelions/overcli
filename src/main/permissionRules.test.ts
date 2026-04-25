import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaudeAllowRule } from './permissionRules';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'permrules-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readSettings(): any {
  return JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8'));
}

describe('appendClaudeAllowRule', () => {
  it('creates .claude/settings.json with the rule when nothing exists', () => {
    appendClaudeAllowRule(tmp, 'Bash');
    expect(readSettings()).toEqual({ permissions: { allow: ['Bash'] } });
  });

  it('appends to an existing allow list without disturbing other keys', () => {
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.writeFileSync(
      path.join(tmp, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'], deny: ['rm'] } }),
    );
    appendClaudeAllowRule(tmp, 'Bash');
    const got = readSettings();
    expect(got.theme).toBe('dark');
    expect(got.permissions.allow).toEqual(['Read', 'Bash']);
    expect(got.permissions.deny).toEqual(['rm']);
  });

  it('is idempotent — adding the same rule twice keeps a single entry', () => {
    appendClaudeAllowRule(tmp, 'Read');
    appendClaudeAllowRule(tmp, 'Read');
    expect(readSettings().permissions.allow).toEqual(['Read']);
  });

  it('leaves a malformed settings.json untouched', () => {
    fs.mkdirSync(path.join(tmp, '.claude'));
    const malformed = '{ not valid json';
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), malformed);
    appendClaudeAllowRule(tmp, 'Bash');
    expect(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8')).toBe(malformed);
  });

  it('handles a settings.json with no permissions section', () => {
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.writeFileSync(
      path.join(tmp, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'light' }),
    );
    appendClaudeAllowRule(tmp, 'Read');
    expect(readSettings()).toEqual({ theme: 'light', permissions: { allow: ['Read'] } });
  });
});
