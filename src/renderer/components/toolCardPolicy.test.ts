import { describe, it, expect } from 'vitest';
import { ToolUseBlock } from '@shared/types';
import {
  PERSISTENT_TOOLS,
  hasAlwaysVisibleTool,
  isArtifactPublish,
  rendersWhenToolActivityHidden,
  shouldFlash,
} from './toolCardPolicy';

const use = (name: string, input: unknown = {}, filePath?: string): ToolUseBlock => ({
  id: 'tu_1',
  name,
  inputJSON: typeof input === 'string' ? input : JSON.stringify(input),
  ...(filePath ? { filePath } : {}),
});

// The transient "now doing…" slot and the inline cards are two renderings of
// the same call. A tool that qualifies for both shows up twice — the bug that
// shipped when Artifact was made persistent without leaving the flash set.
describe('shouldFlash', () => {
  it('never flashes a tool that can render inline', () => {
    for (const name of PERSISTENT_TOOLS) {
      expect(shouldFlash(name), `${name} renders inline and must not flash`).toBe(false);
    }
    expect(shouldFlash('AskUserQuestion')).toBe(false);
    expect(shouldFlash('ExitPlanMode')).toBe(false);
  });

  it('flashes everything else, including tools it has never heard of', () => {
    expect(shouldFlash('Bash')).toBe(true);
    expect(shouldFlash('Read')).toBe(true);
    expect(shouldFlash('mcp__some__future_tool')).toBe(true);
  });
});

describe('rendersWhenToolActivityHidden', () => {
  it('keeps edits, live state and subagent dispatches', () => {
    expect(rendersWhenToolActivityHidden(use('Edit', { file_path: 'a.ts' }))).toBe(true);
    expect(rendersWhenToolActivityHidden(use('TodoWrite'))).toBe(true);
    expect(rendersWhenToolActivityHidden(use('Task'))).toBe(true);
  });

  it('hides ordinary lookups', () => {
    expect(rendersWhenToolActivityHidden(use('Read', { file_path: 'a.ts' }))).toBe(false);
    expect(rendersWhenToolActivityHidden(use('Bash', { command: 'ls' }))).toBe(false);
  });

  it('keeps an Artifact publish and hides the other actions', () => {
    expect(rendersWhenToolActivityHidden(use('Artifact', { file_path: 'canvas.html' }))).toBe(true);
    expect(rendersWhenToolActivityHidden(use('Artifact', { action: 'read', url: 'u' }))).toBe(false);
    expect(rendersWhenToolActivityHidden(use('Artifact', { action: 'list' }))).toBe(false);
  });
});

describe('isArtifactPublish', () => {
  it('treats an omitted action as the publish it defaults to', () => {
    expect(isArtifactPublish(use('Artifact', { file_path: 'canvas.html' }))).toBe(true);
    expect(isArtifactPublish(use('Artifact', { action: 'publish', url: 'u' }))).toBe(true);
  });

  it('counts a publish that leaves no local file behind', () => {
    // An update that only swaps supporting `files`.
    expect(isArtifactPublish(use('Artifact', { url: 'u', files: { 'a.css': 'a.css' } }))).toBe(true);
  });

  it('skips the empty shell a type_url create mints, and keeps the call that fills it', () => {
    expect(isArtifactPublish(use('Artifact', { type_url: 't', title: 'Launch deck' }))).toBe(false);
    expect(isArtifactPublish(use('Artifact', { url: 'u', file_path: 'canvas.json' }))).toBe(true);
    // A create that brings its content along in the same call is not a shell.
    expect(isArtifactPublish(use('Artifact', { type_url: 't', file_path: 'a.html' }))).toBe(true);
  });

  it('rejects the read-only and management actions', () => {
    for (const action of ['read', 'list', 'open', 'delete', 'pin', 'unpin', 'quickstart']) {
      expect(isArtifactPublish(use('Artifact', { action })), action).toBe(false);
    }
  });

  it('says no while the input is still streaming, so no card appears then vanishes', () => {
    expect(isArtifactPublish(use('Artifact', '{"action": "re'))).toBe(false);
    expect(isArtifactPublish(use('Artifact', 'null'))).toBe(false);
  });

  it('trusts a recorded filePath, which main only attaches to a written page', () => {
    expect(isArtifactPublish(use('Artifact', '{"file_p', 'canvas.html'))).toBe(true);
  });
});

describe('hasAlwaysVisibleTool', () => {
  it('is what keeps a turn whose only payload is a card from being filtered away', () => {
    expect(hasAlwaysVisibleTool([use('Read'), use('Artifact', { file_path: 'x.html' })])).toBe(true);
    expect(hasAlwaysVisibleTool([use('Read'), use('Artifact', { action: 'read' })])).toBe(false);
    expect(hasAlwaysVisibleTool([])).toBe(false);
  });
});
