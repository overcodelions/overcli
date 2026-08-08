import { describe, expect, it } from 'vitest';
import { resolveFilePath, resolveWriteTarget } from './resolveFilePath';

// A workspace conversation whose root symlinks several member projects,
// plus two unrelated registered projects — one of which happens to have a
// top-level `main.py`.
const WORKSPACE = '/Users/x/Library/Application Support/overcli/workspaces/ws-1';
const AWS_COST_REDUX = '/Users/x/git/aws-cost-redux';
const AI_ANALYSIS = '/Users/x/git/ai-analysis';

const TREE: Record<string, string[]> = {
  [WORKSPACE]: [
    `${WORKSPACE}/bedrock-agentcore/main.py`,
    `${WORKSPACE}/bedrock-agentcore/tests/test_frames.py`,
    `${WORKSPACE}/unifyr-local-dev/src/store.ts`,
  ],
  [AWS_COST_REDUX]: [`${AWS_COST_REDUX}/main.py`, `${AWS_COST_REDUX}/scanners/base.py`],
  [AI_ANALYSIS]: [`${AI_ANALYSIS}/src/store.ts`],
};

const ROOTS = [WORKSPACE, AWS_COST_REDUX, AI_ANALYSIS];
const ALL_FILES = Object.values(TREE).flat();

function deps(rootPath?: string) {
  return {
    rootPath,
    roots: ROOTS,
    exists: (c: string) => ALL_FILES.includes(c),
    listFiles: (root: string) => TREE[root] ?? [],
  };
}

describe('resolveFilePath', () => {
  it('keeps a bare filename inside the caller\'s own root', () => {
    // The regression: `main.py` clicked in a workspace conversation used to
    // land on aws-cost-redux/main.py, a project the user never opened.
    expect(resolveFilePath('main.py', deps(WORKSPACE))).toBe(
      `${WORKSPACE}/bedrock-agentcore/main.py`,
    );
  });

  it('still resolves a bare filename via other roots when the caller\'s root has none', () => {
    expect(resolveFilePath('main.py', deps(AI_ANALYSIS))).toBe(`${AWS_COST_REDUX}/main.py`);
  });

  it('prefers a direct join under the caller root over a deeper match', () => {
    expect(resolveFilePath('bedrock-agentcore/main.py', deps(WORKSPACE))).toBe(
      `${WORKSPACE}/bedrock-agentcore/main.py`,
    );
  });

  it('lets a whole-hint match in the caller root beat an exact join elsewhere', () => {
    // `src/store.ts` exists under both roots. The workspace copy matches the
    // entire hint as a path suffix, so the caller's root wins.
    expect(resolveFilePath('src/store.ts', deps(WORKSPACE))).toBe(
      `${WORKSPACE}/unifyr-local-dev/src/store.ts`,
    );
  });

  it('does not let a partial match in the caller root short-circuit the cascade', () => {
    // Only two of the three hint segments match inside the workspace, so the
    // other roots still get their turn — and ai-analysis wins the tie-break.
    expect(resolveFilePath('ai-analysis/src/store.ts', deps(WORKSPACE))).toBe(
      `${AI_ANALYSIS}/src/store.ts`,
    );
  });

  it('returns an existing absolute path as-is', () => {
    expect(resolveFilePath(`${AWS_COST_REDUX}/main.py`, deps(WORKSPACE))).toBe(
      `${AWS_COST_REDUX}/main.py`,
    );
  });

  it('never redirects a missing absolute path to a same-named file elsewhere', () => {
    expect(resolveFilePath('/Users/x/git/gone/main.py', deps(WORKSPACE))).toBeNull();
  });

  it('scores trailing segments when only a fuzzy match exists', () => {
    expect(resolveFilePath('bedrock-agentcore/tests/test_frames.py', deps(AI_ANALYSIS))).toBe(
      `${WORKSPACE}/bedrock-agentcore/tests/test_frames.py`,
    );
  });

  it('returns null for an unknown basename', () => {
    expect(resolveFilePath('nope.rs', deps(WORKSPACE))).toBeNull();
  });

  it('never walks a root outside the caller\'s scope', () => {
    // The pinwheel: a hint that matches nothing used to walk every
    // registered root — hundreds of stale conversation worktrees — before
    // returning null. With a scope, only the scoped trees are listed.
    const walked: string[] = [];
    const result = resolveFilePath('deleted-notes.md', {
      rootPath: WORKSPACE,
      roots: ROOTS,
      scopeRoots: [WORKSPACE],
      exists: () => false,
      listFiles: (root: string) => {
        walked.push(root);
        return TREE[root] ?? [];
      },
    });
    expect(result).toBeNull();
    expect(walked).toEqual([WORKSPACE]);
  });

  it('stops at the first whole-hint match instead of walking the rest of the scope', () => {
    const walked: string[] = [];
    const result = resolveFilePath('scanners/base.py', {
      rootPath: AI_ANALYSIS,
      roots: ROOTS,
      scopeRoots: [AWS_COST_REDUX, WORKSPACE],
      exists: () => false,
      listFiles: (root: string) => {
        walked.push(root);
        return TREE[root] ?? [];
      },
    });
    expect(result).toBe(`${AWS_COST_REDUX}/scanners/base.py`);
    expect(walked).not.toContain(WORKSPACE);
  });

  it('still reaches a scoped sibling root when the caller root has no match', () => {
    // Scoping narrows the search to the worktree plus the project it was
    // forked from — the fallback within that scope must still work.
    expect(
      resolveFilePath('scanners/base.py', {
        rootPath: AI_ANALYSIS,
        roots: ROOTS,
        scopeRoots: [AI_ANALYSIS, AWS_COST_REDUX],
        exists: () => false,
        listFiles: (root: string) => TREE[root] ?? [],
      }),
    ).toBe(`${AWS_COST_REDUX}/scanners/base.py`);
  });

  it('skips a root whose listing throws instead of failing the lookup', () => {
    expect(
      resolveFilePath('main.py', {
        rootPath: AI_ANALYSIS,
        roots: ROOTS,
        exists: () => false,
        listFiles: (root: string) => {
          if (root === AWS_COST_REDUX) throw new Error('EACCES');
          return TREE[root] ?? [];
        },
      }),
    ).toBe(`${WORKSPACE}/bedrock-agentcore/main.py`);
  });
});

// A flow worktree run: the conversation's cwd is a coordinator dir whose
// `<member>` entries symlink to that member's MINTED WORKTREE, not the
// project's main checkout.
const COORDINATOR = '/Users/x/Library/Application Support/overcli/coordinators/run-1';

describe('resolveWriteTarget', () => {
  it('anchors a member-prefixed path on the coordinator root', () => {
    // The regression: the editor sent this hint unresolved, so
    // `writeFileSync` resolved it against the main process cwd and ENOENTed.
    expect(resolveWriteTarget('zift-lambda-runner/lambda-runner/gradle.properties', COORDINATOR)).toBe(
      `${COORDINATOR}/zift-lambda-runner/lambda-runner/gradle.properties`,
    );
  });

  it('never falls back to a same-named file in another root', () => {
    // The read cascade would happily answer `${AWS_COST_REDUX}/main.py`
    // here. A write must not: that is a different project's file.
    expect(resolveWriteTarget('main.py', undefined)).toBeNull();
  });

  it('passes an absolute path through untouched', () => {
    expect(resolveWriteTarget(`${AI_ANALYSIS}/src/store.ts`, COORDINATOR)).toBe(
      `${AI_ANALYSIS}/src/store.ts`,
    );
  });

  it('anchors a path that is not on disk, so saving restores a deleted file', () => {
    expect(resolveWriteTarget('src/gone.ts', AI_ANALYSIS)).toBe(`${AI_ANALYSIS}/src/gone.ts`);
  });

  it('rejects an empty hint', () => {
    expect(resolveWriteTarget('', AI_ANALYSIS)).toBeNull();
  });
});
