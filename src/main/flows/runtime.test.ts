// Unit tests for the parts of the flow runtime that don't require a real
// RunnerManager (which would need an Electron app context). The full
// orchestration is exercised manually by running a flow end-to-end.

import { describe, expect, it, vi } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';

// Only the one integration-style suite below (`FlowRuntimeImpl — diff
// rescue`) needs these; everything else in this file exercises pure
// functions with no Electron/git dependency. See that suite for why.
vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

vi.mock('./storage', () => ({
  loadAllFlows: () => [
    {
      id: 'diff-flow',
      name: 'Diff flow',
      input: 'user_prompt',
      participants: [
        { id: 'primary', name: 'Primary', backend: 'ollama', model: 'qwen2.5-coder', kind: 'primary' },
      ],
      steps: [
        {
          id: 'build',
          participantId: 'primary',
          role: 'implementer',
          inputs: [],
          tools: ['Bash'],
          output: 'diff',
        },
      ],
      source: 'user',
      filePath: '/tmp/diff-flow.yaml',
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
  worktreeNameTaken: () => false,
  runGitAsync: async (args: string[]) =>
    args[0] === 'rev-parse' && args[1] === 'HEAD'
      ? { stdout: 'baseline-sha\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 },
  // Branches so the diff-rescue suite can drive a real "the tree changed"
  // result off `git status --porcelain` (step 30's cheap pre-check) through
  // to a non-empty `git diff` (the incremental-diff synthesis itself).
  runGit: (args: string[]) => {
    if (args[0] === 'status') return { stdout: ' M file.txt\n', stderr: '', exitCode: 0 };
    if (args[0] === 'write-tree') return { stdout: 'tree-sha\n', stderr: '', exitCode: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/x b/x\n+added\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  },
}));

import {
  buildWorkerRunBoundary,
  buildRetryFeedbackBlock,
  detectArtifactKind,
  extractOutput,
  extractWorkerQuestion,
  isGatingReviewStep,
  verdictGateStopsRun,
  isGatingReviewerRole,
  isReviewApproved,
  stepParticipantKey,
  stuckStepMessage,
  summarizeReviewRejection,
  pauseReasonBeforeStep,
  rebindRunToLocalProject,
  resolveStepEffect,
  workerPromptWritesToPersistentRoot,
  canSynthesizeDiffFromTree,
  treeChanged,
  ollamaConvNeedsReset,
  FlowRuntimeImpl,
} from './runtime';

describe('rebindRunToLocalProject', () => {
  it('moves a checked-out single-project flow off its deleted worktree cwd', () => {
    const run = {
      projectPath: '/worktrees/feature',
      sourceProjectPath: '/repos/app',
      worktreePath: '/worktrees/feature',
    } as unknown as FlowRun;

    expect(rebindRunToLocalProject(run)).toEqual({
      oldProjectPath: '/worktrees/feature',
      projectPath: '/repos/app',
    });
    expect(run).toMatchObject({
      projectPath: '/repos/app',
      sourceProjectPath: '/repos/app',
      checkedOutLocally: true,
    });
    expect(run).not.toHaveProperty('worktreePath');
  });

  it('does not collapse a workspace coordinator run into one member project', () => {
    const run = {
      projectPath: '/coordinators/run',
      sourceProjectPath: '/workspaces/ws',
      worktreePath: '/worktrees/member',
      workspaceWorktrees: [{ name: 'app' }],
    } as unknown as FlowRun;

    expect(rebindRunToLocalProject(run)).toBeNull();
    expect(run.projectPath).toBe('/coordinators/run');
  });
});

describe('extractOutput', () => {
  it('extracts a clean block', () => {
    const text = `chatter before
<output name="plan.md">
# Goal
ship the thing
</output>
chatter after`;
    expect(extractOutput(text, 'plan.md')).toBe('# Goal\nship the thing');
  });

  it('returns null when the block is missing', () => {
    expect(extractOutput('no output here', 'plan.md')).toBeNull();
  });

  it('returns null when the block has the wrong name', () => {
    expect(extractOutput('<output name="other.md">x</output>', 'plan.md')).toBeNull();
  });

  it('matches single-quoted name attribute', () => {
    expect(extractOutput("<output name='diff'>+ hello\n</output>", 'diff')).toBe('+ hello');
  });

  it('matches unquoted name attribute', () => {
    expect(extractOutput('<output name=diff>+ a</output>', 'diff')).toBe('+ a');
  });

  it('handles names with dots and dashes', () => {
    expect(
      extractOutput('<output name="review-2.md">ok</output>', 'review-2.md'),
    ).toBe('ok');
  });

  it('concatenates sibling blocks with the same name', () => {
    // The previous implementation returned only the FIRST match, but
    // smaller models (gpt-5.4-mini, gemma) routinely emit one
    // <output> block per file they touched. Concatenating recovers
    // the full deliverable instead of silently dropping later blocks.
    const text = `<output name="plan.md">first</output><output name="plan.md">second</output>`;
    expect(extractOutput(text, 'plan.md')).toBe('first\nsecond');
  });

  it('strips nested <output> tags from inside the body', () => {
    // Models occasionally interpret the marker as a section heading
    // and nest more <output …> tags inside the artifact. Those leftover
    // tags should be cleaned out so the body is usable downstream.
    const text =
      '<output name="diff">\nAdded foo\n<output name="diff">\nAdded bar\n</output>';
    expect(extractOutput(text, 'diff')).toBe('Added foo\n\nAdded bar');
  });

  it('is case-insensitive on the tag', () => {
    expect(extractOutput('<OUTPUT name="x">y</OUTPUT>', 'x')).toBe('y');
  });
});

describe('detectArtifactKind', () => {
  it('detects markdown names', () => {
    expect(detectArtifactKind('plan.md')).toBe('markdown');
    expect(detectArtifactKind('notes.markdown')).toBe('markdown');
  });

  it('detects diff names', () => {
    expect(detectArtifactKind('diff')).toBe('diff');
    expect(detectArtifactKind('changes.diff')).toBe('diff');
    expect(detectArtifactKind('fix.patch')).toBe('diff');
  });

  it('detects url names', () => {
    expect(detectArtifactKind('pr_url')).toBe('url');
    expect(detectArtifactKind('releaseUrl')).toBe('url');
  });

  it('falls back to text', () => {
    expect(detectArtifactKind('notes.txt')).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(detectArtifactKind('PLAN.MD')).toBe('markdown');
    expect(detectArtifactKind('FIX.PATCH')).toBe('diff');
  });
});

describe('isGatingReviewerRole', () => {
  it('is true for reviewer-family roles', () => {
    for (const role of [
      'reviewer',
      'plan-reviewer',
      'code-reviewer',
      'security-reviewer',
      'adversarial-reviewer',
    ] as const) {
      expect(isGatingReviewerRole(role)).toBe(true);
    }
  });

  it('is false for non-reviewer roles', () => {
    for (const role of [
      'planner',
      'implementer',
      'test-writer',
      'shipper',
      'custom',
    ] as const) {
      expect(isGatingReviewerRole(role)).toBe(false);
    }
  });
});

describe('verdictGateStopsRun', () => {
  const lens = { role: 'security-reviewer' as const };
  const auditFlow = {
    steps: [{ role: 'security-reviewer' as const }, { role: 'technical-writer' as const }],
  } as never;
  const shippingFlow = {
    steps: [{ role: 'implementer' as const }, { role: 'code-reviewer' as const }],
  } as never;

  it('keeps pausing an interactive run — someone is there to see it', () => {
    expect(verdictGateStopsRun({ workerId: undefined, flowSnapshot: auditFlow }, lens)).toBe(true);
  });

  it('lets an unattended worker roll on past an assessor lens', () => {
    // The whole point of a worker: nobody is watching at 08:30, so halting the
    // audit on the shift that found something just produces silence.
    expect(verdictGateStopsRun({ workerId: 'w1', flowSnapshot: auditFlow }, lens)).toBe(false);
  });

  it('still stops a worker before it acts on disapproved work', () => {
    expect(
      verdictGateStopsRun({ workerId: 'w1', flowSnapshot: shippingFlow }, { role: 'code-reviewer' }),
    ).toBe(true);
  });

  it('honors an explicit verdict_gate over the worker reading', () => {
    expect(
      verdictGateStopsRun({ workerId: 'w1', flowSnapshot: auditFlow }, { ...lens, verdictGate: true }),
    ).toBe(true);
    expect(
      verdictGateStopsRun(
        { workerId: undefined, flowSnapshot: auditFlow },
        { ...lens, verdictGate: false },
      ),
    ).toBe(false);
  });

  it('keeps plan-reviewer gating for a worker with no code-writing step', () => {
    const planFlow = {
      steps: [{ role: 'planner' as const }, { role: 'plan-reviewer' as const }],
    } as never;
    expect(
      verdictGateStopsRun({ workerId: 'w1', flowSnapshot: planFlow }, { role: 'plan-reviewer' }),
    ).toBe(true);
  });

  it('never gates a step that was not a review to begin with', () => {
    expect(
      verdictGateStopsRun({ workerId: 'w1', flowSnapshot: auditFlow }, { role: 'researcher' }),
    ).toBe(false);
  });

  it('keeps a custom reviewer gating in a worker flow with no code-writing step', () => {
    const review = {
      role: 'custom' as const,
      systemPromptOverride: 'Reply APPROVED or REJECTED.',
      onFail: { action: 'goto' as const, stepId: 'draft' },
    };
    const run = {
      workerId: 'worker-1',
      flowSnapshot: { steps: [{ role: 'custom' as const }, { role: 'custom' as const }] },
    };
    expect(verdictGateStopsRun(run as never, review as never)).toBe(true);
  });
});

describe('isGatingReviewStep', () => {
  it('gates a custom review with an explicit two-sided verdict contract', () => {
    expect(
      isGatingReviewStep({
        role: 'custom',
        systemPromptOverride:
          'End with APPROVED only if every check passes; otherwise end with CHANGES REQUESTED.',
        verdictGate: true,
      }),
    ).toBe(true);
  });

  it('keeps legacy custom reviewer loops gating', () => {
    expect(
      isGatingReviewStep({
        role: 'custom',
        systemPromptOverride: 'Return APPROVED or REJECTED.',
        onFail: { action: 'goto', target: 'build', maxRetries: 2 },
      }),
    ).toBe(true);
    expect(
      isGatingReviewStep({
        role: 'custom',
        systemPromptOverride: 'Finish with APPROVED; use NOT APPROVED when incomplete.',
        onFail: { action: 'goto', target: 'build', maxRetries: 2 },
      }),
    ).toBe(true);
  });

  it('does not turn ordinary custom action steps into verdict gates', () => {
    expect(
      isGatingReviewStep({
        role: 'custom',
        systemPromptOverride: 'Create the ticket and return its URL.',
      }),
    ).toBe(false);
    expect(
      isGatingReviewStep({
        role: 'custom',
        systemPromptOverride: 'Describe whether the request was approved by the customer.',
      }),
    ).toBe(false);
    expect(
      isGatingReviewStep({
        role: 'custom',
        systemPromptOverride:
          'Send the Slack DM only after the prior reviewer says APPROVED. If it said NOT APPROVED, do not send.',
      }),
    ).toBe(false);
  });
});

describe('worker effect boundary', () => {
  const step = (systemPromptOverride: string, extra = {}) => ({
    id: 'step',
    role: 'custom' as const,
    systemPromptOverride,
    tools: ['Read'],
    output: 'receipt.md',
    ...extra,
  });

  it('allows local code edits, commands, tests, and builds without a pause', () => {
    expect(resolveStepEffect(step('Edit the controller locally and run its tests.'))).toBe('local');
    expect(resolveStepEffect(step('Run the build and write report.md.'))).toBe('local');
    expect(resolveStepEffect(step('Edit the code and do not push the branch.'))).toBe('local');
    expect(pauseReasonBeforeStep({ workerId: 'worker-1' }, step('Edit local code.'))).toBeNull();
  });

  it('gates pushes, messages, and service mutations for worker runs', () => {
    expect(resolveStepEffect(step('Push the branch and open a pull request.'))).toBe('external');
    expect(resolveStepEffect(step('Send the final brief in a Slack DM.'))).toBe('external');
    expect(resolveStepEffect(step('Create the approved ProductBoard insight.'))).toBe('external');
    expect(
      pauseReasonBeforeStep({ workerId: 'worker-1' }, step('Update the Jira ticket.')),
    ).toBe('externalAction');
  });

  it('honors explicit metadata and leaves ordinary flows unchanged', () => {
    const external = step('Write a local file.', { effect: 'external' as const });
    expect(resolveStepEffect(external)).toBe('external');
    expect(
      resolveStepEffect(step('Push the branch.', { effect: 'local' as const })),
    ).toBe('external');
    expect(pauseReasonBeforeStep({ workerId: undefined }, external)).toBeNull();
  });

  it('lets an explicitly authorized worker cross external boundaries but keeps authored pauses', () => {
    const run = { workerId: 'worker-1', allowExternalActions: true };
    expect(pauseReasonBeforeStep(run, step('Update the Jira ticket.'))).toBeNull();
    expect(
      pauseReasonBeforeStep(run, step('Push the branch.', { pauseBefore: true })),
    ).toBe('preStep');
  });

  // Regression: the fail-closed tool allowlist only listed Claude-style tool
  // names, so the Ollama built-in kit (read_file/list_dir/write_file/
  // edit_file — see ollamaTools.ts) fell through as "unknown" and every
  // shipped template's `build`/`tests` step (templates.ts's
  // SOLVE_TICKET_YAML, among others) paused an unattended worker for
  // approval on an ordinary local edit.
  it('does not fail closed on the Ollama built-in tool kit shipped templates use', () => {
    expect(
      resolveStepEffect(
        step('Implement the plan locally.', {
          tools: ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file'],
        }),
      ),
    ).toBe('local');
    expect(
      pauseReasonBeforeStep(
        { workerId: 'worker-1' },
        step('Implement the plan locally.', {
          tools: ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file'],
        }),
      ),
    ).toBeNull();
  });
});

describe('extractWorkerQuestion', () => {
  it('extracts the explicit flow-to-worker protocol', () => {
    expect(extractWorkerQuestion('<worker_question>Blank or Unknown?</worker_question>')).toBe(
      'Blank or Unknown?',
    );
  });

  it('accepts a direct final question but ignores ordinary prose', () => {
    expect(extractWorkerQuestion('I checked the inputs.\n\nWhich fallback should I use?')).toBe(
      'Which fallback should I use?',
    );
    expect(extractWorkerQuestion('I checked the inputs and found no answer.')).toBeNull();
  });

  it('does not reinterpret tag-shaped text as a legacy plain-text question', () => {
    expect(
      extractWorkerQuestion(
        '<scr<script>ipt>alert(1)</script>Which fallback should I use?</script>',
      ),
    ).toBeNull();
  });
});

describe('worker run file boundary', () => {
  const source = '/Users/lionel/Library/Application Support/overcli/workspaces/ws-1';

  it('rejects an absolute persistent-workspace output destination', () => {
    expect(
      workerPromptWritesToPersistentRoot(
        `Create a copy named ${source}/report.html and verify it.`,
        source,
      ),
    ).toBe(true);
    expect(
      workerPromptWritesToPersistentRoot(`Write the report to ${source}/report.html.`, source),
    ).toBe(true);
  });

  it('allows reading persistent inputs and negated write instructions', () => {
    expect(
      workerPromptWritesToPersistentRoot(`Read ${source}/prior.html, then write report.html.`, source),
    ).toBe(false);
    expect(
      workerPromptWritesToPersistentRoot(`Do not modify ${source}/prior.html.`, source),
    ).toBe(false);
  });

  it('allows a prompt that names the persistent root only to exclude it', () => {
    expect(
      workerPromptWritesToPersistentRoot(
        `Write this page to a relative output path inside this run's own directory (never into ${source}) and report its path.`,
        source,
      ),
    ).toBe(false);
    expect(
      workerPromptWritesToPersistentRoot(
        `Save the report under the run root, not under ${source}.`,
        source,
      ),
    ).toBe(false);
    expect(
      workerPromptWritesToPersistentRoot(
        `Write the file to the run root rather than ${source}/out.html.`,
        source,
      ),
    ).toBe(false);
  });

  it('still refuses a real destination that merely follows a negation elsewhere', () => {
    expect(
      workerPromptWritesToPersistentRoot(
        `Do not stop until you write the report to ${source}/report.html.`,
        source,
      ),
    ).toBe(true);
  });

  it('places worker output in the disposable root and marks the source read-only', () => {
    const block = buildWorkerRunBoundary({
      workerId: 'worker-1',
      projectPath: '/tmp/coordinators/run-1',
      sourceProjectPath: source,
    });
    expect(block).toContain('Disposable run root (your cwd): /tmp/coordinators/run-1');
    expect(block).toContain(`Persistent source project/workspace (READ-ONLY): ${source}`);
    expect(block).toContain('relative filename');
  });

  it('adds no worker boundary to ordinary or in-place runs', () => {
    expect(
      buildWorkerRunBoundary({
        workerId: undefined,
        projectPath: '/tmp/project',
        sourceProjectPath: '/tmp/source',
      }),
    ).toBe('');
    expect(
      buildWorkerRunBoundary({
        workerId: 'worker-1',
        projectPath: '/tmp/project',
        sourceProjectPath: undefined,
      }),
    ).toBe('');
  });
});

describe('isReviewApproved', () => {
  it('approves on a bare APPROVED line', () => {
    expect(isReviewApproved('APPROVED\nLooks correct.')).toBe(true);
    expect(isReviewApproved('Verified the diff.\nAPPROVED — ships clean.')).toBe(true);
  });

  it('approves through markdown decoration', () => {
    expect(isReviewApproved('**APPROVED**\nrationale')).toBe(true);
    expect(isReviewApproved('- APPROVED')).toBe(true);
    expect(isReviewApproved('## APPROVED')).toBe(true);
  });

  it('is case-insensitive on the verdict word', () => {
    expect(isReviewApproved('approved')).toBe(true);
  });

  it('approves through a leading verdict label', () => {
    expect(isReviewApproved('Verdict: APPROVED (against the current repo state)')).toBe(true);
    expect(isReviewApproved('# Review\n\n**Verdict: APPROVED**\nrationale')).toBe(true);
    expect(isReviewApproved('Decision - APPROVED')).toBe(true);
    expect(isReviewApproved('Status: APPROVED')).toBe(true);
  });

  it('does NOT approve a negated labelled verdict', () => {
    expect(isReviewApproved('Verdict: NOT APPROVED — needs work')).toBe(false);
  });

  it('does NOT approve an explicit rejection', () => {
    expect(isReviewApproved('Status: REJECTED\nThe diff does not implement the plan.')).toBe(
      false,
    );
  });

  it('does NOT approve when no verdict line is present', () => {
    expect(isReviewApproved('Here are some problems:\n- missing edge case')).toBe(false);
  });

  it('does NOT approve "NOT APPROVED"', () => {
    expect(isReviewApproved('NOT APPROVED — needs work')).toBe(false);
    expect(isReviewApproved('This is not approved yet.')).toBe(false);
  });
});

describe('stuckStepMessage', () => {
  // Regression: a run only ever leaves `running` on an inbound event
  // (`running: false` → onStepFinished). A step whose backend died quietly
  // — or whose send never reached a CLI at all — held the run there
  // forever, and since that transition isn't checkpointed, a restart
  // couldn't recover it either.
  const timeoutMs = 30 * 60_000;

  it('says nothing while the step is within its silence budget', () => {
    expect(stuckStepMessage({ stepId: 'build', silentMs: 29 * 60_000, timeoutMs })).toBeNull();
  });

  it('is inclusive at the boundary', () => {
    expect(stuckStepMessage({ stepId: 'build', silentMs: timeoutMs, timeoutMs })).toBeNull();
  });

  it('names the step and how long it was silent once past the timeout', () => {
    expect(stuckStepMessage({ stepId: 'build', silentMs: 45 * 60_000, timeoutMs })).toBe(
      'Step "build" produced no output for 45 minutes — treating it as failed.',
    );
  });
});

describe('stepParticipantKey', () => {
  it('files a step under its participant so steps share one conversation', () => {
    expect(stepParticipantKey({ id: 'build', participantId: 'impl' })).toBe('impl');
  });

  // Regression: `executeStep` minted the conversation under the step id
  // when participantId was blank, but the `running: false` guard looked it
  // up under the blank participantId. The lookup missed, the step's own
  // completion event was discarded as "a different conversation", and the
  // run spun on that step forever.
  it('falls back to the step id when no participant is assigned', () => {
    expect(stepParticipantKey({ id: 'build', participantId: '' })).toBe('build');
  });
});

describe('summarizeReviewRejection', () => {
  it('prefers an explicit verdict line', () => {
    const body = `# Review — RED-6648\n\n**Verdict: CHANGES REQUESTED.** The diff compiles but…\n\nmore text`;
    expect(summarizeReviewRejection(body)).toBe(
      'Verdict: CHANGES REQUESTED. The diff compiles but…',
    );
  });

  it('falls back to the first substantive line', () => {
    expect(summarizeReviewRejection('\n\n- the regex drops SSO links\nrest')).toBe(
      'the regex drops SSO links',
    );
  });

  it('caps very long lines', () => {
    const gist = summarizeReviewRejection('x'.repeat(500));
    expect(gist).toHaveLength(201); // 200 chars + ellipsis
    expect(gist?.endsWith('…')).toBe(true);
  });

  it('returns null for an empty body', () => {
    expect(summarizeReviewRejection('   \n\n  ')).toBeNull();
  });
});

describe('buildRetryFeedbackBlock', () => {
  const base = {
    fromStepId: 'review',
    artifactName: 'review.md',
    reason: 'Reviewer step "review" did not approve — Verdict: CHANGES REQUESTED.',
    attempt: 1,
    maxRetries: 2,
  };

  it('states the retry budget and who rejected the work', () => {
    const block = buildRetryFeedbackBlock(base);
    expect(block).toContain('RETRY 1 of 2');
    expect(block).toContain('REJECTED');
    expect(block).toContain('Rejected by step "review"');
    expect(block).toContain('Verdict: CHANGES REQUESTED');
    expect(block).toContain("Repair the rejected attempt's own files in place");
    expect(block).toContain('older successful files still are');
  });

  it('points at the feedback artifact when there is one', () => {
    expect(buildRetryFeedbackBlock(base)).toContain('input "review.md"');
  });

  it('omits the artifact pointer when the failing step produced none', () => {
    const block = buildRetryFeedbackBlock({ ...base, artifactName: null });
    expect(block).not.toContain('input "');
    // Still tells the implementer not to start from scratch.
    expect(block).toContain('Do NOT start over');
  });
});

describe('canSynthesizeDiffFromTree', () => {
  // A local diff step does its work with edit_file, so the change is already
  // on disk when it writes its closing message. gemma4 routinely finishes the
  // edits and then just stops, with no <output name="diff"> wrapper — and
  // failing there discarded several minutes of correct work over a missing tag.
  const base = { hasOutputBlock: false, kind: 'diff', backend: 'ollama' as const };

  it('rescues a local diff step that made its edits but skipped the wrapper', () => {
    expect(canSynthesizeDiffFromTree(base)).toBe(true);
  });

  it('leaves a step that DID emit the wrapper on the normal path', () => {
    expect(canSynthesizeDiffFromTree({ ...base, hasOutputBlock: true })).toBe(false);
  });

  it('does not rescue non-diff artifacts — prose cannot be read off the tree', () => {
    expect(canSynthesizeDiffFromTree({ ...base, kind: 'markdown' })).toBe(false);
  });

  // For a cloud backend a missing <output> more often means the step derailed
  // partway, leaving partial edits — promoting that to success hides a real
  // failure.
  it('keeps the strict contract for cloud backends', () => {
    for (const backend of ['claude', 'codex', 'gemini', 'copilot'] as const) {
      expect(canSynthesizeDiffFromTree({ ...base, backend })).toBe(false);
    }
  });
});

describe('treeChanged', () => {
  it('treats a real increment as work worth rescuing', () => {
    expect(treeChanged('diff --git a/x b/x\n+added\n')).toBe(true);
  });

  // No wrapper AND no edits means the step genuinely failed: there is nothing
  // to rescue, and passing it on would hand the next step an empty diff.
  it('does not rescue a step that touched nothing', () => {
    expect(treeChanged('')).toBe(false);
    expect(treeChanged('   \n  ')).toBe(false);
    expect(treeChanged(null)).toBe(false);
  });
});

describe('ollamaConvNeedsReset', () => {
  // Ollama replays the whole transcript every round, so a conversation
  // shared across steps carries a finished step's <output name="…">
  // contract into the next one. Observed with gemma4:26b: a test step
  // (output test_report.md) reading the build step's prompt (output diff)
  // reasoned itself to a standstill — "I can't have both" — and emitted
  // neither. It was right; we had handed it two contradictory contracts.
  it('resets when the same participant moves to a new step', () => {
    expect(
      ollamaConvNeedsReset({ backend: 'ollama', openedFor: 'impl:build', wantedFor: 'impl:test' }),
    ).toBe(true);
  });

  // A retry genuinely wants the failed attempt and the rejection feedback in
  // context, and its contract has not changed.
  it('keeps the conversation when the same step retries', () => {
    expect(
      ollamaConvNeedsReset({ backend: 'ollama', openedFor: 'impl:build', wantedFor: 'impl:build' }),
    ).toBe(false);
  });

  // Cloud backends deliberately share one conv across steps — continuity and
  // prompt-cache hits, neither of which a local model gets.
  it('leaves cloud backends on the shared conversation', () => {
    for (const backend of ['claude', 'codex', 'gemini', 'copilot'] as const) {
      expect(ollamaConvNeedsReset({ backend, openedFor: 'impl:build', wantedFor: 'impl:test' })).toBe(
        false,
      );
    }
  });

  it('does not reset when there is no conversation to reset', () => {
    expect(
      ollamaConvNeedsReset({ backend: 'ollama', openedFor: undefined, wantedFor: 'impl:build' }),
    ).toBe(false);
  });
});

describe('FlowRuntimeImpl — diff rescue', () => {
  // Regression: the diff-rescue path (an Ollama diff step with no <output>
  // block, synthesized from the worktree) used to overwrite `artifactBody`
  // with the diff before a worker's <worker_question> in the same reply was
  // ever read, so the question never reached the worker's journal.
  it('a worker question survives the diff rescue', async () => {
    const runtime = new FlowRuntimeImpl(
      { send: () => ({ ok: true as const }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );
    // Never resolves — the assertion below reads the exchange the instant
    // it's raised, before any answer could possibly land.
    runtime.setWorkerSupervisor(() => new Promise(() => {}));

    const result = await runtime.startRun({
      flowId: 'diff-flow',
      projectPath: '/tmp/project',
      userPrompt: 'Refactor the module.',
      workerId: 'worker-1',
      workerName: 'Scout',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const run = runtime.getRun(result.runId)!;
    const conversationId = run.conversationIds.primary;

    runtime.observeEvent({
      type: 'stream',
      conversationId,
      events: [
        {
          id: 'answer-1',
          timestamp: Date.now(),
          raw: '',
          revision: 0,
          kind: {
            type: 'assistant',
            info: {
              model: 'qwen2.5-coder',
              text: '<worker_question>Which branch?</worker_question>',
              toolUses: [],
              thinking: [],
            },
          },
        },
      ],
    });
    // Tree genuinely changed (`git status --porcelain` and `git diff` are
    // both mocked non-empty above), so the diff-rescue path fires and would
    // previously have clobbered the question with the synthesized diff.
    runtime.observeEvent({ type: 'running', conversationId, isRunning: false });

    expect(run.workerExchanges).toMatchObject([
      { stepId: 'build', question: 'Which branch?', status: 'asking' },
    ]);
  });
});
