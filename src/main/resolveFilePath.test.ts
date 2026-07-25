import { describe, expect, it } from 'vitest';
import { resolveFilePath } from './resolveFilePath';

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
