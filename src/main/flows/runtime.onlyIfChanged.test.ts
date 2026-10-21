// `runChangedBeyondNotes` against a real repository: whether a team piece's
// check step has anything to check. A mock of `../git` could only repeat
// back what we assume `git diff` and `ls-files` report. The runtime suites
// below drive `FlowRuntimeImpl` over the same real repos, with only
// `executeStep` stubbed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';
import type { FlowRun } from '../../shared/flows/schema';

const seeded = vi.hoisted(() => ({ runs: [] as FlowRun[] }));

useTestHost('/tmp/overcli-only-if-changed-tests');
vi.mock('./runsStore', () => ({ loadAllRuns: () => seeded.runs, saveRun: vi.fn(), deleteRun: vi.fn() }));
vi.mock('./storage', () => ({ loadAllFlows: () => [] }));

import { FlowRuntimeImpl, isNoteFile, runChangedBeyondNotes } from './runtime';

let repo: string;
let baseline: string;
/// Every repo a test made, removed after it.
let made: string[] = [];

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function git(...args: string[]): string {
  return gitIn(repo, ...args);
}

/// A repo with one committed `app.ts`, and its HEAD as the baseline.
function makeRepo(): { path: string; commit: string } {
  const path = mkdtempSync(join(tmpdir(), 'overcli-changed-'));
  made.push(path);
  gitIn(path, 'init', '-q', '-b', 'main');
  gitIn(path, 'config', 'user.email', 'test@example.com');
  gitIn(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(path, '.gitignore'), 'dist/\n');
  gitIn(path, 'add', '.');
  gitIn(path, 'commit', '-q', '-m', 'init');
  return { path, commit: gitIn(path, 'rev-parse', 'HEAD') };
}

beforeEach(() => {
  ({ path: repo, commit: baseline } = makeRepo());
});

afterEach(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
  made = [];
  seeded.runs = [];
});

const run = () => ({ projectPath: repo, baselineCommit: baseline });

describe('runChangedBeyondNotes', () => {
  it('is false for an untouched repo, or one that only gained notes', async () => {
    expect(await runChangedBeyondNotes(run())).toBe(false);
    writeFileSync(join(repo, 'piece.md'), '# notes\n');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'ignored');
    expect(await runChangedBeyondNotes(run())).toBe(false);
  });

  it('is true for an edit, a new code file, or a commit since the baseline', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    expect(await runChangedBeyondNotes(run())).toBe(true);
    git('checkout', '-q', 'app.ts');
    writeFileSync(join(repo, 'new.ts'), 'export {};\n');
    expect(await runChangedBeyondNotes(run())).toBe(true);
    git('add', 'new.ts');
    git('commit', '-q', '-m', 'add');
    expect(await runChangedBeyondNotes(run())).toBe(true);
  });

  it('is true when it cannot tell: no baseline, or not a repo', async () => {
    expect(await runChangedBeyondNotes({ projectPath: repo, baselineCommit: undefined })).toBe(true);
    expect(await runChangedBeyondNotes({ projectPath: tmpdir(), baselineCommit: baseline })).toBe(true);
  });
});

describe('runChangedBeyondNotes — renames, deletions and build files', () => {
  it('counts a code file renamed to a note, by its old name', async () => {
    git('mv', 'app.ts', 'app.md');
    expect(await runChangedBeyondNotes(run())).toBe(true);
    git('commit', '-q', '-m', 'rename');
    expect(await runChangedBeyondNotes(run())).toBe(true);
  });

  it('counts a deleted code file', async () => {
    rmSync(join(repo, 'app.ts'));
    expect(await runChangedBeyondNotes(run())).toBe(true);
    git('add', '-A');
    git('commit', '-q', '-m', 'delete');
    expect(await runChangedBeyondNotes(run())).toBe(true);
  });

  it('counts a .txt file that a build reads, but not one that is only notes', async () => {
    writeFileSync(join(repo, 'notes.txt'), 'what I found\n');
    expect(await runChangedBeyondNotes(run())).toBe(false);
    for (const name of ['requirements.txt', 'CMakeLists.txt', 'constraints.txt']) {
      writeFileSync(join(repo, name), 'acme-widgets==1.2\n');
      expect(await runChangedBeyondNotes(run()), name).toBe(true);
      rmSync(join(repo, name));
    }
  });
});

describe('isNoteFile', () => {
  it('takes Markdown and plain text as notes', () => {
    for (const p of ['README.md', 'docs/plan.markdown', 'notes.txt', 'docs/LICENSE.TXT', 'acme/findings.txt']) {
      expect(isNoteFile(p), p).toBe(true);
    }
  });

  it('takes code, and .txt files a build or server reads, as changes', () => {
    for (const p of [
      'app.ts',
      'requirements.txt',
      'requirements-dev.txt',
      'dev-requirements.txt',
      'requirements/base.txt',
      'requirements/sub/dev.txt',
      'testdata/expected_output.txt',
      'pkg/testData/golden.txt',
      'tests/fixtures/acme/response.txt',
      'src/__snapshots__/report.txt',
      'src/main/resources/messages.txt',
      'services/acme/requirements.txt',
      'constraints.txt',
      'CMakeLists.txt',
      'src/cmakelists.txt',
      'runtime.txt',
      'apt.txt',
      'packages.txt',
      'version.txt',
      'public/robots.txt',
      'ads.txt',
      'app-ads.txt',
      '.well-known/security.txt',
      'notes.md.ts',
    ]) {
      expect(isNoteFile(p), p).toBe(false);
    }
  });
});

describe('FlowRuntimeImpl — a step that runs only if the run changed something', () => {
  /// build → check (only_if_changed, and paused before) → file. The pause on
  /// `check` stands for any approval it would meet: a skipped check must
  /// never ask for one.
  function seedRun(over: Partial<FlowRun> = {}): FlowRun {
    return {
      id: 'run-check',
      flowId: 'f',
      flowSnapshot: {
        id: 'f',
        name: 'F',
        participants: [],
        steps: [
          { id: 'build', role: 'custom', systemPromptOverride: 'Write the code.', tools: ['Read'], output: 'piece.md' },
          {
            id: 'check',
            role: 'custom',
            systemPromptOverride: 'Check the work.',
            tools: ['Read'],
            output: 'checked.md',
            onlyIfChanged: true,
            pauseBefore: true,
          },
          { id: 'file', role: 'custom', systemPromptOverride: 'File it.', tools: ['Read'], output: 'filed.md' },
        ],
      },
      projectPath: repo,
      baselineCommit: baseline,
      userPrompt: 'add the acme widget',
      conversationIds: {},
      artifacts: {},
      state: { kind: 'running', currentStepId: 'build' },
      createdAt: 1,
      attempts: [],
      ...over,
    } as unknown as FlowRun;
  }

  function runtimeWith(run: FlowRun): { runtime: FlowRuntimeImpl; executed: string[] } {
    seeded.runs = [run];
    const runtime = new FlowRuntimeImpl(
      { send: () => ({ ok: true as const }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );
    const executed: string[] = [];
    (runtime as any).executeStep = async (_runId: string, stepId: string) => {
      executed.push(stepId);
    };
    return { runtime, executed };
  }

  const pausedAtCheck = { kind: 'paused', nextStepId: 'check', reason: 'preStep' };

  it('skips the check, and its approval, when only notes changed', async () => {
    writeFileSync(join(repo, 'piece.md'), '# what I found\n');
    const { runtime, executed } = runtimeWith(seedRun());
    (runtime as any).advanceAfterStep('run-check', 'build');
    await vi.waitFor(() => expect(executed).toEqual(['file']));
    expect(runtime.getRun('run-check')!.state).toEqual({ kind: 'running', currentStepId: 'file' });
  });

  it('enters the check, at its approval, when code changed', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    const { runtime, executed } = runtimeWith(seedRun());
    (runtime as any).advanceAfterStep('run-check', 'build');
    await vi.waitFor(() => expect(runtime.getRun('run-check')!.state).toEqual(pausedAtCheck));
    expect(executed).toEqual([]);
  });

  it('decides on resume when a hold stopped the run before the check', async () => {
    writeFileSync(join(repo, 'piece.md'), '# what I found\n');
    const notesOnly = runtimeWith(seedRun());
    notesOnly.runtime.holdRun({ runId: 'run-check' });
    (notesOnly.runtime as any).advanceAfterStep('run-check', 'build');
    expect(notesOnly.runtime.getRun('run-check')!.state).toEqual({
      kind: 'paused',
      nextStepId: 'check',
      reason: 'held',
    });
    expect(notesOnly.runtime.releaseHold({ runId: 'run-check' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(notesOnly.executed).toEqual(['file']));

    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    const codeChanged = runtimeWith(seedRun());
    codeChanged.runtime.holdRun({ runId: 'run-check' });
    (codeChanged.runtime as any).advanceAfterStep('run-check', 'build');
    expect(codeChanged.runtime.releaseHold({ runId: 'run-check' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(codeChanged.runtime.getRun('run-check')!.state).toEqual(pausedAtCheck));
    expect(codeChanged.executed).toEqual([]);
  });

  it('measures every member of a workspace run from its own baseline', async () => {
    const web = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'overcli-changed-ws-'));
    made.push(root);
    const workspaceRun = () =>
      seedRun({
        projectPath: root,
        baselineCommit: undefined,
        baselineCommitsByMember: {
          api: { path: repo, commit: baseline },
          web: { path: web.path, commit: web.commit },
        },
      });

    writeFileSync(join(repo, 'piece.md'), '# api notes\n');
    writeFileSync(join(web.path, 'piece.md'), '# web notes\n');
    const notesOnly = runtimeWith(workspaceRun());
    (notesOnly.runtime as any).advanceAfterStep('run-check', 'build');
    await vi.waitFor(() => expect(notesOnly.executed).toEqual(['file']));

    // Only the second member changed code: still a change to check.
    writeFileSync(join(web.path, 'app.ts'), 'export const a = 2;\n');
    const codeChanged = runtimeWith(workspaceRun());
    (codeChanged.runtime as any).advanceAfterStep('run-check', 'build');
    await vi.waitFor(() => expect(codeChanged.runtime.getRun('run-check')!.state).toEqual(pausedAtCheck));
    expect(codeChanged.executed).toEqual([]);
  });
});
