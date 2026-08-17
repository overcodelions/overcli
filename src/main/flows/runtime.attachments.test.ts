// Regression test for the flow runtime's directory scope. Large step
// inputs are handed to the model as absolute paths under userData
// (see attachments.ts); if the send doesn't also widen the session's
// allowed directories, the model receives a path it cannot read and
// reports the input as missing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
}));

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

vi.mock('./storage', () => ({
  loadAllFlows: () => [
    {
      id: 'flow-1',
      name: 'Review flow',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Primary',
          backend: 'claude',
          model: 'claude-sonnet-4-6',
          kind: 'primary',
        },
      ],
      steps: [
        {
          id: 'review',
          participantId: 'primary',
          role: 'implementer',
          inputs: [],
          tools: ['Read'],
          output: 'review.md',
        },
      ],
      source: 'user',
      filePath: '/tmp/review.yaml',
    },
  ],
}));

vi.mock('./preflight', () => ({
  preflightRun: async () => ({ ok: true, problems: [] }),
  formatPreflight: () => '',
}));

vi.mock('../git', () => ({
  baseBranchExistsAsync: vi.fn(),
  createWorktreeAsync: vi.fn(),
  detectBaseBranchAsync: vi.fn(),
  removeWorktreeAsync: vi.fn(),
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));

import { FlowRuntimeImpl } from './runtime';

describe('flow step sends', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-attach-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('grants the run attachment directory so attached inputs are readable', async () => {
    const sends: Array<{ allowedDirs?: string[] }> = [];
    const runtime = new FlowRuntimeImpl(
      {
        send: (args: { allowedDirs?: string[] }) => {
          sends.push(args);
          return { ok: true };
        },
      } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );

    const result = await runtime.startRun({
      flowId: 'flow-1',
      projectPath: '/tmp/project',
      userPrompt: 'Review the latest changes.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const attachmentDir = path.join(userDataDir, 'flow-attachments', result.runId);
    expect(sends).not.toHaveLength(0);
    // Granted on every send in the run — not only the ones that happened
    // to attach something — so the allowed set never shifts mid-session.
    for (const s of sends) {
      expect(s.allowedDirs).toContain(attachmentDir);
    }
    // Created up front for the same reason: the SDK transport reads the
    // allowed set once, when the session starts.
    expect(fs.existsSync(attachmentDir)).toBe(true);
  });
});
