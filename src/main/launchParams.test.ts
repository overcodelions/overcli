// Guards the reuse-vs-respawn decision (#266).
//
// `launchParamsChanged` is the only thing standing between a conversation
// and a resident process running with stale argv. When a field that shapes
// argv is stamped but never compared, nothing errors — the header shows the
// new model / permission mode / Chrome state while the process keeps the old
// one. So this file does two things: exercise every compared field, and
// parse runner.ts to prove the stamped set and the compared set are still the
// same set.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROKER_LAUNCH_PARAM_KEYS,
  LAUNCH_PARAM_KEYS,
  LaunchParams,
  launchParamsChanged,
} from './launchParams';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'runner.ts'), 'utf-8');

const BASE: LaunchParams = {
  launchPermissionMode: 'default',
  launchAllowedTools: 'Read Write',
  launchMcpFingerprint: '{"strict":false,"selectedConfig":""}',
  launchModel: 'claude-opus-5',
  launchTurbo: false,
  launchArtifacts: false,
  launchChrome: false,
  launchEffort: 'medium',
  cwd: '/repo',
};

// One different value per field. The mapped type is `-?` so an optional
// field cannot be quietly left out of the table.
const CHANGED: { [K in keyof LaunchParams]-?: LaunchParams[K] } = {
  launchPermissionMode: 'bypassPermissions',
  launchAllowedTools: 'Read',
  launchMcpFingerprint: '{"strict":true,"selectedConfig":"{}"}',
  launchModel: 'claude-sonnet-5',
  launchTurbo: true,
  launchArtifacts: true,
  launchChrome: true,
  launchEffort: 'high',
  cwd: '/other-repo',
};

function withChange<K extends keyof LaunchParams>(key: K): LaunchParams {
  return { ...BASE, [key]: CHANGED[key] };
}

describe('launchParamsChanged', () => {
  it('reuses the resident process when the launch identity is untouched', () => {
    expect(launchParamsChanged(BASE, { ...BASE })).toBe(false);
  });

  it('reuses it for a distinct object with equal values', () => {
    // The comparison is per-field, not identity — two records built by
    // separate `launchParamsFor` calls must still count as a match.
    expect(launchParamsChanged({ ...BASE }, { ...BASE })).toBe(false);
  });

  it.each(LAUNCH_PARAM_KEYS)('respawns when %s changes', (key) => {
    // Each row is only meaningful if it actually differs.
    expect(CHANGED[key]).not.toEqual(BASE[key]);
    expect(launchParamsChanged(BASE, withChange(key))).toBe(true);
    // Symmetric: reverting the field back also trips the check.
    expect(launchParamsChanged(withChange(key), BASE)).toBe(true);
  });

  it('treats an unstamped optional field as a change against a stamped one', () => {
    // This is exactly how the codex app-server record used to behave: it
    // never stamped launchMcpFingerprint, so `undefined !== ''` made every
    // single send look like a parameter change.
    expect(launchParamsChanged({ ...BASE, launchMcpFingerprint: undefined }, BASE)).toBe(true);
  });
});

describe('launchParamsChanged with the broker subset', () => {
  it.each(BROKER_LAUNCH_PARAM_KEYS)('re-registers the broker when %s changes', (key) => {
    expect(launchParamsChanged(BASE, withChange(key), BROKER_LAUNCH_PARAM_KEYS)).toBe(true);
  });

  it.each(LAUNCH_PARAM_KEYS.filter((k) => !BROKER_LAUNCH_PARAM_KEYS.includes(k as never)))(
    'leaves the broker registration alone when %s changes',
    (key) => {
      // The mcp-config the broker wrote does not depend on these, so a
      // change here must cost a respawn but not a re-registration.
      expect(launchParamsChanged(BASE, withChange(key), BROKER_LAUNCH_PARAM_KEYS)).toBe(false);
      expect(launchParamsChanged(BASE, withChange(key))).toBe(true);
    },
  );
});

// --- Source guards ------------------------------------------------------
//
// TypeScript catches a *type* mismatch but cannot catch "someone added
// `launchFoo` to ActiveProcess and never taught the comparison about it".
// These parse runner.ts the way ipcContract.test.ts parses the IPC map.

function braceBody(src: string, from: number): string {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i);
    }
  }
  throw new Error('unbalanced braces in runner.ts');
}

function activeProcessLaunchFields(): string[] {
  const start = RUNNER_SRC.indexOf('interface ActiveProcess {');
  if (start < 0) throw new Error('ActiveProcess interface not found in runner.ts');
  const body = braceBody(RUNNER_SRC, start);
  return [...body.matchAll(/^\s{2}(launch\w+)\??:/gm)].map((m) => m[1]);
}

describe('launch field coverage', () => {
  it('compares every launch* field ActiveProcess declares', () => {
    // Fails the day ActiveProcess grows a `launch*` field that
    // launchParamsChanged does not read — add it to LaunchParams and to the
    // CHANGED table above rather than deleting this assertion.
    const declared = activeProcessLaunchFields();
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(
      LAUNCH_PARAM_KEYS.filter((k) => k.startsWith('launch')).slice().sort(),
    );
  });

  it('stamps every active record through the one shared builder', () => {
    // A field that is compared but never stamped reads as "changed" on every
    // send. Both gaps found in #266 (the sdk record and the codex app-server
    // record, neither stamping launchMcpFingerprint) were of this shape, so
    // every ActiveProcess literal has to take its launch identity from
    // launchParamsFor rather than hand-listing the fields.
    const literals = [...RUNNER_SRC.matchAll(/: ActiveProcess = \{/g)];
    expect(literals.length).toBeGreaterThan(0);
    for (const match of literals) {
      const body = braceBody(RUNNER_SRC, match.index!);
      const line = RUNNER_SRC.slice(0, match.index!).split('\n').length;
      expect(
        { line, usesBuilder: body.includes('...this.launchParamsFor(') },
      ).toEqual({ line, usesBuilder: true });
    }
  });

  it('keeps the comparison in one place', () => {
    // The two call sites drifted precisely because each kept its own copy of
    // the field list. Any `existing.launch*` read in runner.ts means a third
    // copy is growing.
    const inlineReads = [...RUNNER_SRC.matchAll(/existing\.launch\w+/g)].map((m) => m[0]);
    expect(inlineReads).toEqual([]);
  });
});
