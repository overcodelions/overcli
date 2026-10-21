import { describe, expect, it, vi } from 'vitest';

import type { MainToRendererEvent } from '../shared/types';
import { decide, permissionTap, readsOnlyUnder, refuseUserInput } from './permissions';

function responder() {
  return {
    respondPermission: vi.fn(),
    respondCodexApproval: vi.fn(),
    respondUserInput: vi.fn(),
  };
}

function permissionEvent(toolName: string, requestId = 'r1'): MainToRendererEvent {
  return {
    type: 'stream',
    conversationId: 'c1',
    events: [
      {
        kind: {
          type: 'permissionRequest',
          info: { requestId, toolName, description: '', toolInput: '' },
        },
      } as never,
    ],
  } as MainToRendererEvent;
}

describe('decide', () => {
  it('denies everything under deny', () => {
    expect(decide('deny', 'Bash', new Set(['Bash'])).approved).toBe(false);
  });

  it('allows only the listed tools under allow-list', () => {
    const allow = new Set(['Read']);
    expect(decide('allow-list', 'Read', allow).approved).toBe(true);
    expect(decide('allow-list', 'Bash', allow).approved).toBe(false);
  });

  it('allows everything under auto-approve', () => {
    expect(decide('auto-approve', 'Bash', new Set()).approved).toBe(true);
  });

  it('always explains itself, so a silent denial is visible in the log', () => {
    expect(decide('deny', 'Bash', new Set()).reason).toContain('Bash');
    expect(decide('allow-list', 'Bash', new Set()).reason).toContain('--allow-tool');
  });
});

describe('permissionTap', () => {
  it('answers a pending request rather than leaving the run to hang', () => {
    const r = responder();
    const tap = permissionTap({ policy: 'auto-approve', allowTools: [], responder: r });
    tap(permissionEvent('Bash'));
    expect(r.respondPermission).toHaveBeenCalledWith('c1', 'r1', true);
  });

  it('answers each request once, even if the event is replayed', () => {
    const r = responder();
    const tap = permissionTap({ policy: 'deny', allowTools: [], responder: r });
    tap(permissionEvent('Bash'));
    tap(permissionEvent('Bash'));
    expect(r.respondPermission).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-decided request alone — the worker boundary got there first', () => {
    const r = responder();
    const tap = permissionTap({ policy: 'auto-approve', allowTools: [], responder: r });
    tap({
      type: 'stream',
      conversationId: 'c1',
      events: [
        {
          kind: {
            type: 'permissionRequest',
            info: { requestId: 'r1', toolName: 'Bash', description: '', toolInput: '', decided: 'deny' },
          },
        } as never,
      ],
    } as MainToRendererEvent);
    expect(r.respondPermission).not.toHaveBeenCalled();
  });

  it('maps a codex exec approval onto the exec allow-list name', () => {
    const r = responder();
    const tap = permissionTap({ policy: 'allow-list', allowTools: ['exec'], responder: r });
    tap({
      type: 'stream',
      conversationId: 'c1',
      events: [{ kind: { type: 'codexApproval', info: { callId: 'k1', kind: 'exec' } } } as never],
    } as MainToRendererEvent);
    expect(r.respondCodexApproval).toHaveBeenCalledWith('c1', 'k1', 'exec', true);
  });

  it('refuses a question instead of waiting for an answer that cannot come', () => {
    const r = responder();
    const decisions: string[] = [];
    const tap = permissionTap({
      policy: 'auto-approve',
      allowTools: [],
      responder: r,
      onDecision: (d) => decisions.push(d.reason),
    });
    tap({
      type: 'stream',
      conversationId: 'c1',
      events: [
        {
          kind: {
            type: 'userInputRequest',
            info: {
              requestId: 'q1',
              turnId: 't',
              itemId: 'i',
              questions: [{ id: 'a', header: 'h', question: 'Which design?', isOther: false, isSecret: false }],
            },
          },
        } as never,
      ],
    } as MainToRendererEvent);
    expect(r.respondUserInput).toHaveBeenCalled();
    expect(decisions.join(' ')).toContain('Which design?');
  });

  it('ignores events that are not streams', () => {
    const r = responder();
    const tap = permissionTap({ policy: 'auto-approve', allowTools: [], responder: r });
    tap({ type: 'running', conversationId: 'c1', running: true } as unknown as MainToRendererEvent);
    expect(r.respondPermission).not.toHaveBeenCalled();
  });
});

describe('refuseUserInput', () => {
  it('answers every question, so no id is left pending', () => {
    const { answers } = refuseUserInput([
      { id: 'a', question: 'one' },
      { id: 'b', question: 'two' },
    ]);
    expect(Object.keys(answers)).toEqual(['a', 'b']);
  });

  it('tells the model to decide rather than just saying no', () => {
    const { answers } = refuseUserInput([{ id: 'a', question: 'one' }]);
    expect(answers.a.answers[0]).toContain('Choose the most reasonable option yourself');
  });
});

// The security property the whole headless permission design rests on.
//
// `--permissions auto-approve` says yes to everything. A worker without
// `caps.allowExternalActions` must still be denied — its caps are set by the
// person who hired it, and a CLI flag typed by whoever wrote the pipeline must
// not be able to widen them. Two things combine to guarantee that:
//
//   1. engines.ts calls `flowRuntime.observeEvent` BEFORE the tap, and the
//      runtime auto-denies on worker runs that lack the grant (runtime.ts:604).
//   2. `RunnerManager.respondPermission` fires the pending callback and then
//      DELETES it, so whoever answers first decides and later answers are
//      no-ops.
//
// Neither half is obvious, and either could be broken by an innocent-looking
// refactor — reordering the tee, or making respondPermission idempotent-by-
// overwrite instead of consume-once. So the composition is asserted here.
describe('a worker’s caps outrank the CLI flag', () => {
  /// Models the runner's consume-once contract: the first answer wins.
  function consumeOnceRunner() {
    const pending = new Map<string, (approved: boolean) => void>();
    const outcomes: Array<{ requestId: string; approved: boolean }> = [];
    return {
      arm(requestId: string) {
        pending.set(requestId, (approved) => outcomes.push({ requestId, approved }));
      },
      outcomes,
      respondPermission(_c: string, requestId: string, approved: boolean) {
        const cb = pending.get(requestId);
        if (!cb) return; // already answered — exactly what runner.ts does
        cb(approved);
        pending.delete(requestId);
      },
      respondCodexApproval: vi.fn(),
      respondUserInput: vi.fn(),
    };
  }

  it('keeps a runtime denial even when the tap would auto-approve', () => {
    const runner = consumeOnceRunner();
    runner.arm('r1');
    const tap = permissionTap({ policy: 'auto-approve', allowTools: [], responder: runner });

    // The order engines.ts uses: the runtime's worker boundary answers first…
    runner.respondPermission('c1', 'r1', false);
    // …then the CLI policy tries to say yes.
    tap(permissionEvent('Bash', 'r1'));

    expect(runner.outcomes).toEqual([{ requestId: 'r1', approved: false }]);
  });

  it('denies a codex escalation for an ungranted worker, even under auto-approve', () => {
    // The runtime's auto-deny loop matches `permissionRequest` only, so a
    // codex exec/patch escalation never reaches it. Without this the CLI flag
    // would widen a cap the boundary was supposed to hold.
    const r = responder();
    const tap = permissionTap({
      policy: 'auto-approve',
      allowTools: ['exec'],
      responder: r,
      denyCodexApprovals: true,
    });
    tap({
      type: 'stream',
      conversationId: 'c1',
      events: [{ kind: { type: 'codexApproval', info: { callId: 'k9', kind: 'exec' } } } as never],
    } as MainToRendererEvent);
    expect(r.respondCodexApproval).toHaveBeenCalledWith('c1', 'k9', 'exec', false);
  });

  it('still answers a request the runtime left alone, so nothing hangs', () => {
    const runner = consumeOnceRunner();
    runner.arm('r2');
    const tap = permissionTap({ policy: 'auto-approve', allowTools: [], responder: runner });
    tap(permissionEvent('Read', 'r2'));
    expect(runner.outcomes).toEqual([{ requestId: 'r2', approved: true }]);
  });
});

describe('a worker looking at its own files', () => {
  const root = '/data/worker-files';
  const bash = (command: string) => JSON.stringify({ command });

  it('needs every command to name a path inside its files', () => {
    expect(readsOnlyUnder('Bash', bash('printenv; cat /data/worker-files/w1/x'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('cat /data/worker-files/w1/x; ls'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('grep foo /data/worker-files/w1/x'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('cat /data/worker-files/w1/x'), [root])).toBe(true);
  });

  it('lets read-only commands inside its files through', () => {
    expect(readsOnlyUnder('Bash', bash('ls -la /data/worker-files/w1 2>&1; cat /data/worker-files/w1/cursor.json 2>&1'), [root])).toBe(true);
    expect(readsOnlyUnder('Bash', bash('head -50 "/data/worker-files/w1/notes.md"'), [root])).toBe(true);
  });

  it('refuses anything that writes, escapes, or looks elsewhere', () => {
    expect(readsOnlyUnder('Bash', bash('cat /data/worker-files/w1/a > /data/worker-files/w1/b'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('cat /data/worker-files/../secrets.enc'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('cat /etc/passwd'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('ls /data/worker-files-evil'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('cat $(echo /etc/passwd)'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('rm /data/worker-files/w1/notes.md'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('ls'), [root])).toBe(false);
    expect(readsOnlyUnder('Read', bash('ls /data/worker-files'), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash("rg --p''re=/bin/sh -e /data/worker-files /data/worker-files/w1/f"), [root])).toBe(false);
    expect(readsOnlyUnder('Bash', bash('sort -uo /data/worker-files/w1/a /data/worker-files/w1/b'), [root])).toBe(false);
  });

  it('answers yes under an allow-list that would refuse Bash, and says why', () => {
    const r = responder();
    const decisions: Array<{ reason: string }> = [];
    const tap = permissionTap({ policy: 'allow-list', allowTools: ['Read'], responder: r, readOnlyRoots: () => [root], onDecision: (d) => decisions.push(d) });
    tap({
      type: 'stream',
      conversationId: 'c1',
      events: [{ kind: { type: 'permissionRequest', info: { requestId: 'r1', toolName: 'Bash', description: '', toolInput: bash('ls /data/worker-files/w1') } } } as never],
    } as MainToRendererEvent);
    expect(r.respondPermission).toHaveBeenCalledWith('c1', 'r1', true);
    expect(decisions[0].reason).toMatch(/read-only look at a worker's own files/);
    tap(permissionEvent('Bash', 'r2'));
    expect(r.respondPermission).toHaveBeenLastCalledWith('c1', 'r2', false);
  });
});

describe('tool calls that only read, on the org server', () => {
  it('lets a read through the allow-list and still refuses a write, only when asked to', async () => {
    const { permissionTap } = await import('./permissions');
    const answers: Array<[string, boolean]> = [];
    const responder = { respondPermission: (_c: string, id: string, ok: boolean) => answers.push([id, ok]), respondCodexApproval: () => {}, respondUserInput: () => {} };
    const ask = (tap: (e: never) => void, id: string, toolName: string) =>
      tap({ type: 'stream', conversationId: 'c1', events: [{ timestamp: 0, kind: { type: 'permissionRequest', info: { requestId: id, toolName, description: '', toolInput: '{}' } } }] } as never);
    const server = permissionTap({ policy: 'allow-list', allowTools: ['Read'], responder, allowToolReads: true });
    ask(server, 'r1', 'mcp__acme-tracker__release_timeline');
    ask(server, 'r2', 'mcp__acme-tracker__feature_list');
    ask(server, 'r3', 'mcp__acme-tracker__feature_update');
    const strict = permissionTap({ policy: 'allow-list', allowTools: ['Read'], responder });
    ask(strict, 'r4', 'mcp__acme-tracker__feature_list');
    expect(answers).toEqual([['r1', true], ['r2', true], ['r3', false], ['r4', false]]);
  });
});
