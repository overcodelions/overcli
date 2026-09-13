import { describe, expect, it } from 'vitest';
import { portInUse, triage, type TriageContext } from './triage';
import type { ServiceSpec } from './types';

const spec: ServiceSpec = {
  id: 'proc',
  name: 'AcmeProcessor',
  runner: 'gradle',
  command: ['./gradlew', ':AcmeProcessor:bootRun', '-Dorg.gradle.daemon=false'],
  ready: { kind: 'none' },
  selfReloads: false,
  config: {},
};

function ctx(over: Partial<TriageContext> = {}): TriageContext {
  return {
    lines: ['[INFO ] Starting', '[INFO ] Something happened', '[INFO ] And another thing'],
    spec,
    env: {},
    optionCount: 3,
    binding: { ref: 'feat/x', path: '/wt/x' },
    ...over,
  };
}

describe('the profile contradiction', () => {
  // The one that cost an afternoon: we set a profile, the app announced a
  // different one, and the error three hundred lines later was about a
  // placeholder with no hint that the profile was ever involved.
  const lines = [
    '[INFO ] c.z.p.Application:597 - The following profiles are active: slave',
    "[WARN ] Could not resolve placeholder 'proc.database.ip'",
  ];

  it('notices when the process did not come up on the profile we set', () => {
    const found = triage(ctx({ lines, env: { SPRING_PROFILES_ACTIVE: 'local' } }));
    expect(found[0].id).toBe('profile-mismatch');
    expect(found[0].title).toContain('"slave"');
    expect(found[0].title).toContain('"local"');
  });

  it('shows both halves of the comparison as evidence', () => {
    // A diagnosis you cannot check is one you will not trust twice.
    const found = triage(ctx({ lines, env: { SPRING_PROFILES_ACTIVE: 'local' } }));
    expect(found[0].evidence[0]).toContain('profiles are active: slave');
    expect(found[0].evidence[1]).toContain('SPRING_PROFILES_ACTIVE=local');
  });

  it('says nothing when they agree', () => {
    const agreed = ['The following profiles are active: local'];
    const found = triage(ctx({ lines: agreed, env: { SPRING_PROFILES_ACTIVE: 'local' } }));
    expect(found.some((f) => f.id === 'profile-mismatch')).toBe(false);
  });

  it('says nothing when no profile was asked for', () => {
    const found = triage(ctx({ lines, env: {} }));
    expect(found.some((f) => f.id === 'profile-mismatch')).toBe(false);
  });
});

describe('an unresolved placeholder', () => {
  const lines = ["Could not resolve placeholder 'proc.database.ip' in value \"jdbc:mysql://...\""];

  it('names the file that defines it and whether this checkout has it', () => {
    const found = triage(
      ctx({
        lines,
        findDefinitions: () => [
          { file: 'acme-core/src/main/resources/application-local.properties', presentInBinding: false },
        ],
      }),
    );
    expect(found[0].title).toContain('a file this checkout does not have');
    expect(found[0].action).toBe('mirror-config');
    expect(found[0].evidence[1]).toContain('acme-core');
  });

  it('says it has to come from a startup option when nothing defines it', () => {
    const found = triage(ctx({ lines, findDefinitions: () => [] }));
    expect(found[0].title).toContain('Nothing defines proc.database.ip');
    expect(found[0].action).toBe('edit-options');
  });

  it('points at the profile when the file IS present', () => {
    // Present and unread is a different problem from absent, and the remedy
    // is different too.
    const found = triage(
      ctx({
        lines,
        findDefinitions: () => [{ file: 'acme-core/application-local.properties', presentInBinding: true }],
      }),
    );
    expect(found[0].title).toContain('was not read');
    expect(found[0].detail).toContain('profile');
  });

  it('reports one cause however many times it was printed', () => {
    const repeated = [lines[0], lines[0], lines[0]];
    const found = triage(ctx({ lines: repeated, findDefinitions: () => [] }));
    expect(found.filter((f) => f.id.startsWith('placeholder-'))).toHaveLength(1);
  });
});

describe('the ordinary failures', () => {
  it('names the Python debugger dependency when it is missing', () => {
    const found = triage(ctx({
      spec: { ...spec, runner: 'python', debugKind: 'debugpy', debugEnabled: true },
      lines: ['/usr/bin/python: No module named debugpy'],
    }));
    expect(found[0].id).toBe('missing-debugpy');
  });

  it('names Delve rather than the original go command when dlv is missing', () => {
    const found = triage(ctx({
      spec: { ...spec, runner: 'go', command: ['go', 'run', '.'], debugKind: 'delve', debugEnabled: true },
      lines: ['spawn dlv ENOENT'],
    }));
    expect(found[0].id).toBe('missing-delve');
  });

  it('names the process holding the port', () => {
    const found = triage(
      ctx({
        lines: ['Error: Port 5273 is already in use'],
        portOwner: { port: 5273, holder: 'node (pid 96355)' },
      }),
    );
    expect(found[0].title).toContain('node (pid 96355)');
    expect(found[0].action).toBe('free-port');
  });

  it('never offers to stop overcli itself', () => {
    const found = triage(
      ctx({
        lines: ['Error: Port 5173 is already in use'],
        portOwner: { port: 5173, holder: 'node (pid 44171)', kind: 'self' },
      }),
    );
    expect(found[0].title).toContain("overcli's own");
    expect(found[0].action).toBeUndefined();
  });

  it('says a leftover copy is safe to stop', () => {
    const found = triage(
      ctx({
        lines: ['[vite] Error: Port 5273 is already in use'],
        portOwner: { port: 5273, holder: 'node (pid 53810)', kind: 'stale' },
      }),
    );
    expect(found[0].title).toContain('leftover copy');
    expect(found[0].action).toBe('free-port');
    expect(found[0].port).toBe(5273);
  });

  it('points at a saved port that disagrees with the output', () => {
    const found = triage(
      ctx({ spec: { ...spec, port: 5173 }, lines: ['[vite] Error: Port 5273 is already in use'] }),
    );
    expect(found[0].title).toBe('Port 5273 is already taken');
    expect(found[0].port).toBe(5273);
    expect(found[0].evidence).toContain('saved port: 5173');
  });
});

describe('portInUse', () => {
  it('reads the port out of the common phrasings', () => {
    expect(portInUse(['[vite] Error: Port 5273 is already in use'])?.port).toBe(5273);
    expect(portInUse(['Error: listen EADDRINUSE: address already in use :::3000'])?.port).toBe(3000);
    expect(portInUse(['Web server failed to start. Port 8080 was already in use.'])?.port).toBe(8080);
    expect(portInUse(['bind 127.0.0.1:9090: address already in use'])?.port).toBe(9090);
  });

  it('finds the line even when it names no port', () => {
    expect(portInUse(['EADDRINUSE'])).toEqual({ line: 'EADDRINUSE', port: undefined });
    expect(portInUse(['all good'])).toBeNull();
  });

  it('explains a command that could not be run', () => {
    const found = triage(ctx({ lines: ['spawn ./mvnw ENOENT'] }));
    expect(found[0].title).toContain('./gradlew');
    // The PATH a GUI app launches with is not the PATH a shell has, and that
    // is the thing worth saying.
    expect(found[0].detail).toContain('PATH');
  });

  it('does not blame PATH when the command ran but a file it opens is missing', () => {
    // npm in the repo root of a project whose app is in a subfolder.
    const found = triage(
      ctx({
        lines: [
          'npm error code ENOENT',
          "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/repos/admin-console/package.json'",
        ],
      }),
    );
    expect(found[0].id).toBe('missing-file');
    expect(found[0].title).toBe('package.json is not in /repos/admin-console');
    expect(found[0].detail).not.toContain('PATH');
  });

  it('says so when nothing was printed at all', () => {
    const found = triage(ctx({ lines: [] }));
    expect(found[0].id).toBe('silent-exit');
  });

  it('does not call a chatty failure silent', () => {
    const found = triage(ctx({ lines: ['a', 'b', 'c', 'd', 'e'] }));
    expect(found.some((f) => f.id === 'silent-exit')).toBe(false);
  });
});

describe('options sitting next door', () => {
  it('points at a config file that has the options this service lacks', () => {
    // The sentence that would have short-circuited two hours.
    const found = triage(
      ctx({
        lines: ['[ERROR] Application startup failed'],
        optionCount: 0,
        importOptions: { source: 'the IntelliJ run configuration', count: 57 },
      }),
    );
    expect(found[0].title).toContain('57');
    expect(found[0].action).toBe('import-options');
  });

  it('stays quiet when the service already has options', () => {
    const found = triage(
      ctx({ optionCount: 12, importOptions: { source: 'x', count: 57 } }),
    );
    expect(found.some((f) => f.id === 'no-options')).toBe(false);
  });
});

describe('ordering', () => {
  it('leads with the cause rather than a symptom of it', () => {
    // The profile is why the placeholder could not resolve; reporting the
    // placeholder first sends someone to fix the wrong thing.
    const found = triage(
      ctx({
        lines: [
          'The following profiles are active: slave',
          "Could not resolve placeholder 'proc.database.ip'",
        ],
        env: { SPRING_PROFILES_ACTIVE: 'local' },
        findDefinitions: () => [{ file: 'acme-core/application-local.properties', presentInBinding: true }],
      }),
    );
    expect(found[0].id).toBe('profile-mismatch');
    expect(found).toHaveLength(2);
  });
});
