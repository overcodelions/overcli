// The pointer form of the `<output>` contract, against a real git repo.
//
// Kept out of runtime.test.ts because that file mocks `../git` wholesale, and
// the question these tests ask — "did this run produce the file?" — is
// answered by git and nothing else.
//
// The failure they pin down: the pointer used to be gated on the file's mtime
// beating the START of the current attempt. A step that re-ran, or that read
// an already-correct file and changed nothing, can never satisfy that — so it
// pointed at its own deliverable, got refused, was nudged, pointed at the
// same file again, and paused the run. Ownership is now measured per RUN.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl, missingOutputReaskPrompt, pathChangedInRun } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';

describe('pathChangedInRun', () => {
  // The run-scoped replacement for the mtime floor: the question is whether
  // the RUN produced the file, not whether this attempt happened to rewrite
  // it. A verify-only turn and a re-run both leave the file untouched.
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-owned-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    git('init');
    writeFileSync(join(dir, 'preexisting.md'), 'was here before the run\n');
    git('add', '.');
    git('commit', '-m', 'baseline');
    return dir;
  }

  const head = (dir: string) =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();

  it('claims an untracked file the run wrote, whatever its mtime', () => {
    const dir = repo();
    try {
      const report = join(dir, 'throughput_report.html');
      writeFileSync(report, '<html></html>');
      // Written minutes before this attempt started — the shape that used to
      // fail forever, because nothing rewrites an already-correct file.
      const old = new Date(Date.now() - 600_000);
      utimesSync(report, old, old);
      expect(pathChangedInRun(dir, head(dir), report, 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claims a file the run committed after its baseline', () => {
    const dir = repo();
    try {
      const baseline = head(dir);
      const report = join(dir, 'report.md');
      writeFileSync(report, '# done\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'report'], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      expect(pathChangedInRun(dir, baseline, report, 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that was already in the repo', () => {
    // The property the mtime floor existed to defend: a mistyped path
    // pointing at an input or a source file is not this run's deliverable.
    const dir = repo();
    try {
      expect(pathChangedInRun(dir, head(dir), join(dir, 'preexisting.md'), 0)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a gitignored file that predates the run, even though git status cannot see it', () => {
    // `git status`/`git diff` never list an ignored path at all, so the
    // ignored-file fallback has no git signal to scope itself to this run —
    // it must fall back to the same mtime floor the tracked-file path uses.
    // Skipping that floor would hand back ANY ignored file that exists on
    // disk (`.env`, `node_modules/**`, …) as though the run had produced it.
    const dir = repo();
    try {
      const secret = join(dir, '.env');
      writeFileSync(join(dir, '.gitignore'), '.env\n');
      execFileSync('git', ['add', '-f', '.gitignore'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'ignore env'], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      writeFileSync(secret, 'SECRET=1\n');
      const old = new Date(Date.now() - 600_000);
      utimesSync(secret, old, old);
      const runStartedAt = Date.now();
      expect(pathChangedInRun(dir, head(dir), secret, runStartedAt)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claims a gitignored file the run wrote after it started', () => {
    const dir = repo();
    try {
      const secret = join(dir, '.env');
      writeFileSync(join(dir, '.gitignore'), '.env\n');
      execFileSync('git', ['add', '-f', '.gitignore'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'ignore env'], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      const runStartedAt = Date.now() - 1000;
      writeFileSync(secret, 'GENERATED=1\n');
      expect(pathChangedInRun(dir, head(dir), secret, runStartedAt)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const RUN_ID = 'run-ptr' as UUID;

function flow(): Flow {
  return {
    id: 'report-flow',
    name: 'Report flow',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'Opus', backend: 'claude', model: 'claude-opus-5', kind: 'primary' },
    ],
    steps: [
      {
        id: 'render-report',
        participantId: 'primary',
        role: 'implementer',
        inputs: ['user_prompt'],
        tools: ['Read', 'Write'],
        output: 'throughput_report.html',
      },
      {
        id: 'design-polish',
        participantId: 'primary',
        role: 'implementer',
        inputs: ['throughput_report.html'],
        tools: ['Read'],
        output: 'polished.html',
      },
    ],
    source: 'user',
    filePath: '/tmp/report.yaml',
  };
}

function harness() {
  const sends: Array<{
    prompt: string;
    displayText?: string;
    permissionMode?: string;
    conversationId?: string;
  }> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: (args: { prompt: string; displayText?: string; permissionMode?: string; conversationId?: string }) => {
      sends.push({
        prompt: args.prompt,
        displayText: args.displayText,
        permissionMode: args.permissionMode,
        conversationId: args.conversationId,
      });
      return { ok: true as const };
    },
    respondPermission: (_convId: string, _reqId: string, _approved: boolean) => {},
  };
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    runner as never,
    (e) => emitted.push(e),
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  return { rt, sends, emitted, runner };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function finishWith(h: ReturnType<typeof harness>, text: string) {
  (h.rt as never as { stepBuffers: Map<UUID, unknown> }).stepBuffers.set(RUN_ID, {
    assistantText: text,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    costUSD: 0,
  });
  (h.rt as never as { onStepFinished: (a: UUID, b: string) => void }).onStepFinished(
    RUN_ID,
    'render-report',
  );
  await flush();
}

describe('a pointer at a file the attempt did not rewrite', () => {
  let h: ReturnType<typeof harness>;
  let r: FlowRun;
  let dir: string;
  let report: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overcli-run-'));
    execFileSync('git', ['init'], { cwd: dir });
    report = join(dir, 'throughput_report.html');
    writeFileSync(report, '<html><body>37 issues</body></html>');
    // The deliverable was written ten minutes before this attempt began —
    // an earlier attempt wrote it and this turn only verified it.
    const old = new Date(Date.now() - 600_000);
    utimesSync(report, old, old);

    h = harness();
    r = {
      id: RUN_ID,
      flowId: 'report-flow',
      flowSnapshot: flow(),
      projectPath: dir,
      userPrompt: 'render the report',
      conversationIds: { primary: 'conv-1' as UUID },
      artifacts: {},
      state: { kind: 'running', currentStepId: 'render-report' },
      createdAt: 1,
      attempts: [
        { stepId: 'render-report', startedAt: Date.now(), conversationId: 'conv-1' as UUID },
      ],
    };
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is accepted when the file is the run\'s own work', async () => {
    await finishWith(
      h,
      'All five fixes are present and verified.\n<output name="throughput_report.html" file="throughput_report.html" />',
    );

    expect(r.artifacts['throughput_report.html']?.body).toBe(
      '<html><body>37 issues</body></html>',
    );
    expect(r.state).toEqual({ kind: 'running', currentStepId: 'design-polish' });
  });

  it('is refused when the file was already in the repo, and says why', async () => {
    // Committed at the baseline: git can see the run did not produce it.
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'baseline'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    r.baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();

    await finishWith(
      h,
      '<output name="throughput_report.html" file="throughput_report.html" />',
    );

    expect(r.artifacts['throughput_report.html']).toBeUndefined();
    // The nudge names the file and the reason instead of repeating the
    // generic "you emitted no block" — the model sent a block, and would
    // send the identical one again.
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.prompt).toContain('throughput_report.html');
    expect(h.sends[0]!.prompt).toContain('nothing in this run wrote or changed that file');
    expect(h.sends[0]!.prompt).toContain('do not point at a file again');
    expect(h.sends[0]!.displayText).toContain('stale');
  });
});

// Round-1 finding RRW-pointer-gitignored-not-owned, exercised end to end
// through `onStepFinished` → `resolveArtifactBody` → `runOwnsPath` →
// `pathChangedInRun` — not by calling `pathChangedInRun` directly. Direct
// calls can't catch a wrong floor being threaded through `runOwnsPath`
// (the round-2 regression this pins down: the branch was reachable only
// with `run.createdAt`, never with the per-attempt floor `runOwnsPath`
// used to be passed).
describe('a pointer at a gitignored file across steps', () => {
  const gitignoreCommit = (dir: string, pattern: string) => {
    writeFileSync(join(dir, '.gitignore'), `${pattern}\n`);
    // Force-add: some machines carry a global excludesfile that ignores
    // `.gitignore` itself, which would otherwise make this a no-op setup.
    execFileSync('git', ['add', '-f', '.gitignore'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'ignore report'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  };

  it('is accepted when an earlier step in this run wrote it, even though it predates this attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-run-ignored-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      gitignoreCommit(dir, 'throughput_report.html');

      const runCreatedAt = Date.now() - 5000;
      const report = join(dir, 'throughput_report.html');
      writeFileSync(report, '<html><body>generated at an earlier step</body></html>');
      // Written after the RUN started but before THIS attempt did — the
      // shape a multi-step run produces when an earlier step wrote the file
      // and a later one just points at it again.
      const producedAt = new Date(runCreatedAt + 2000);
      utimesSync(report, producedAt, producedAt);

      const h = harness();
      const r: FlowRun = {
        id: RUN_ID,
        flowId: 'report-flow',
        flowSnapshot: flow(),
        projectPath: dir,
        userPrompt: 'render the report',
        conversationIds: { primary: 'conv-1' as UUID },
        artifacts: {},
        state: { kind: 'running', currentStepId: 'render-report' },
        createdAt: runCreatedAt,
        attempts: [
          { stepId: 'render-report', startedAt: Date.now(), conversationId: 'conv-1' as UUID },
        ],
      };
      (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

      await finishWith(
        h,
        'Verified the report is correct.\n<output name="throughput_report.html" file="throughput_report.html" />',
      );

      expect(r.artifacts['throughput_report.html']?.body).toBe(
        '<html><body>generated at an earlier step</body></html>',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused when the gitignored file predates the run entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-run-ignored-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      gitignoreCommit(dir, 'throughput_report.html');

      const report = join(dir, 'throughput_report.html');
      writeFileSync(report, '<html><body>stale leftover</body></html>');
      // Predates the run entirely — left behind by something else.
      const old = new Date(Date.now() - 600_000);
      utimesSync(report, old, old);

      const h = harness();
      const r: FlowRun = {
        id: RUN_ID,
        flowId: 'report-flow',
        flowSnapshot: flow(),
        projectPath: dir,
        userPrompt: 'render the report',
        conversationIds: { primary: 'conv-1' as UUID },
        artifacts: {},
        state: { kind: 'running', currentStepId: 'render-report' },
        createdAt: Date.now(),
        attempts: [
          { stepId: 'render-report', startedAt: Date.now(), conversationId: 'conv-1' as UUID },
        ],
      };
      (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

      await finishWith(h, '<output name="throughput_report.html" file="throughput_report.html" />');

      expect(r.artifacts['throughput_report.html']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Round-2 finding B: the auto-deny loop added to close round-1 finding #4
// (an unattended worker hanging on a permission request) must not also
// discard a real human clicking Continue on an `externalAction` pause.
describe('resuming an externalAction pause', () => {
  it('runs the approved step without forcing it through the broker, and consumes the grant once the step finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overcli-run-approve-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });

      const h = harness();
      const r: FlowRun = {
        id: RUN_ID,
        flowId: 'report-flow',
        flowSnapshot: flow(),
        projectPath: dir,
        userPrompt: 'render the report',
        conversationIds: { primary: 'conv-1' as UUID },
        artifacts: {},
        state: { kind: 'paused', nextStepId: 'render-report', reason: 'externalAction' },
        createdAt: Date.now(),
        attempts: [],
        workerId: 'worker-1' as UUID,
        // No allowExternalActions grant — this worker is exactly the
        // "must never auto-approve" case the broker exists to gate.
      };
      (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

      const res = h.rt.resumeRun({ runId: RUN_ID });
      expect(res.ok).toBe(true);
      await flush();

      // The step remains brokered; its first request consumes the approval.
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]!.permissionMode).toBe('acceptEdits');
      expect(r.externalActionApprovedStepId).toBe('render-report');

      const approvals: boolean[] = [];
      h.runner.respondPermission = (_convId: string, _reqId: string, approved: boolean) => approvals.push(approved);
      for (const requestId of ['req-1', 'req-2']) {
        (h.rt as never as { observeEvent: (e: MainToRendererEvent) => void }).observeEvent({
          type: 'stream', conversationId: 'conv-1' as UUID,
          events: [{ timestamp: Date.now(), kind: { type: 'permissionRequest', info: { requestId, toolName: 'Bash', description: '', toolInput: '' } } } as never],
        });
      }
      expect(approvals).toEqual([true, false]);
      expect(r.externalActionApprovedStepId).toBeUndefined();

      // The grant is one-shot: consumed the moment the approved step
      // finishes, so it can't leak into whatever step runs after it.
      await finishWith(h, '<output name="throughput_report.html" file="throughput_report.html" />');
      expect(r.externalActionApprovedStepId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still auto-denies a permission request for a step that was never approved', () => {
    const h = harness();
    const r: FlowRun = {
      id: RUN_ID,
      flowId: 'report-flow',
      flowSnapshot: flow(),
      projectPath: '/tmp/does-not-matter',
      userPrompt: 'render the report',
      conversationIds: { primary: 'conv-1' as UUID },
      artifacts: {},
      state: { kind: 'running', currentStepId: 'render-report' },
      createdAt: Date.now(),
      attempts: [{ stepId: 'render-report', startedAt: Date.now(), conversationId: 'conv-1' as UUID }],
      workerId: 'worker-1' as UUID,
      // Approval on record, but for a DIFFERENT step — must not cover this one.
      externalActionApprovedStepId: 'design-polish',
    };
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
    (h.rt as never as { convIdToRun: Map<UUID, UUID> }).convIdToRun.set('conv-1' as UUID, RUN_ID);

    let denied = false;
    h.runner.respondPermission = (_convId: string, _reqId: string, approved: boolean) => {
      denied = approved === false;
    };
    (h.rt as never as { observeEvent: (e: MainToRendererEvent) => void }).observeEvent({
      type: 'stream',
      conversationId: 'conv-1' as UUID,
      events: [
        {
          timestamp: Date.now(),
          kind: {
            type: 'permissionRequest',
            info: { requestId: 'req-1', toolName: 'Bash', description: '', toolInput: '' },
          },
        } as never,
      ],
    });

    expect(denied).toBe(true);
  });
});

describe('missingOutputReaskPrompt with a rejected pointer', () => {
  it('asks for the contents inline rather than another pointer', () => {
    const prompt = missingOutputReaskPrompt('report.html', true, {
      path: 'out/report.html',
      reason: 'oversized',
    });
    expect(prompt).toContain('out/report.html');
    expect(prompt).toContain('too large');
    expect(prompt).toContain('<output name="report.html">');
    // The pointer form is deliberately absent — offering it again invites
    // the same refusal.
    expect(prompt).not.toContain('file="relative/path');
  });
});
