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
      expect(pathChangedInRun(dir, head(dir), report)).toBe(true);
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
      expect(pathChangedInRun(dir, baseline, report)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that was already in the repo', () => {
    // The property the mtime floor existed to defend: a mistyped path
    // pointing at an input or a source file is not this run's deliverable.
    const dir = repo();
    try {
      expect(pathChangedInRun(dir, head(dir), join(dir, 'preexisting.md'))).toBe(false);
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
  const sends: Array<{ prompt: string; displayText?: string }> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: (args: { prompt: string; displayText?: string }) => {
      sends.push({ prompt: args.prompt, displayText: args.displayText });
      return { ok: true as const };
    },
  };
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    runner as never,
    (e) => emitted.push(e),
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  return { rt, sends, emitted };
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
