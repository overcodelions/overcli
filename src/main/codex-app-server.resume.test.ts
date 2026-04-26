// Locks in the request shape used by CodexAppServerClient.startInternal.
// The actual network call (this.request) is integration territory; the
// pure shape helpers below are what we can prove in isolation.
//
// Regression context: before this fix, the client always issued
// thread/start regardless of args.sessionId, so codex sessions lost
// context after every app restart — the fresh thread had no memory of
// prior turns and codex would (correctly, from its POV) report the
// auto-injected environment_context as the user's "first message".

import { describe, expect, it } from 'vitest';
import { buildResumeRequest, buildStartRequest } from './codex-app-server';

const opts = {
  model: 'gpt-5',
  cwd: '/tmp/project',
  approval: 'on-request' as const,
  sandbox: 'workspace-write' as const,
  approvalsReviewer: undefined,
};

describe('buildResumeRequest', () => {
  it('uses thread/resume and carries the threadId', () => {
    const r = buildResumeRequest(opts, 'thr-abc-123');
    expect(r.method).toBe('thread/resume');
    expect(r.params.threadId).toBe('thr-abc-123');
  });

  it('passes model + approvalPolicy + sandbox so codex applies the latest config to the resumed thread', () => {
    const r = buildResumeRequest(opts, 'thr-1');
    expect(r.params.model).toBe('gpt-5');
    expect(r.params.approvalPolicy).toBe('on-request');
    expect(r.params.sandbox).toBe('workspace-write');
  });

  it('coerces an empty model string to null (matches start request shape)', () => {
    const r = buildResumeRequest({ ...opts, model: '' }, 'thr-1');
    expect(r.params.model).toBeNull();
  });
});

describe('buildStartRequest', () => {
  it('uses thread/start and never sets a threadId', () => {
    const r = buildStartRequest(opts);
    expect(r.method).toBe('thread/start');
    expect(r.params.threadId).toBeUndefined();
  });

  it('includes cwd + approvalsReviewer (resume omits both — codex already knows them)', () => {
    const r = buildStartRequest(opts);
    expect(r.params.cwd).toBe('/tmp/project');
    expect(r.params.approvalsReviewer).toBe('user');
  });

  it('coerces an empty model string to null', () => {
    const r = buildStartRequest({ ...opts, model: '' });
    expect(r.params.model).toBeNull();
  });
});
