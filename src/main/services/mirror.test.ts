import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  applyMirror,
  findLocalConfig,
  isLocalConfig,
  LOCAL_CONFIG_NAMES,
  planMirror,
  type MirrorFs,
} from './mirror';

/// A directory tree described by its file paths.
class FakeFs implements MirrorFs {
  links = new Map<string, string>();
  dirs = new Set<string>();

  constructor(private files: Set<string>) {}

  static from(paths: string[]): FakeFs {
    return new FakeFs(new Set(paths));
  }

  existsSync(p: string): boolean {
    return this.files.has(p) || this.links.has(p);
  }
  readdirSync(dir: string) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Map<string, boolean>();
    for (const file of [...this.files, ...this.links.keys()]) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
  }
  lstatSync(p: string) {
    if (!this.files.has(p) && !this.links.has(p)) throw new Error(`ENOENT ${p}`);
    return { isSymbolicLink: () => this.links.has(p) };
  }
  mkdirSync(p: string) {
    this.dirs.add(p);
  }
  symlinkSync(target: string, linkPath: string) {
    this.links.set(linkPath, target);
  }
}

/// The real shape: a monorepo whose modules each keep a gitignored local
/// properties file, and a worktree of it that has none of them.
const primary = '/repos/gitrepo';
const worktree = '/wt/ABC-5185';
const localFiles = [
  'AcmeProcessor/src/main/resources/config/application-local.properties',
  'billing-rest/src/main/resources/config/application-local.properties',
  'acme-core/src/main/resources/application-local.properties',
];

function tree(extra: string[] = []): FakeFs {
  return FakeFs.from([
    ...localFiles.map((f) => `${primary}/${f}`),
    `${primary}/AcmeProcessor/build.gradle`,
    `${primary}/AcmeProcessor/build/classes/Application.class`,
    `${primary}/node_modules/pkg/application-local.properties`,
    ...extra,
  ]);
}

describe('findLocalConfig', () => {
  it('finds the local config each module keeps', () => {
    expect(findLocalConfig(primary, { fs: tree() })).toEqual([...localFiles].sort());
  });

  it('does not walk into build output or dependencies', () => {
    // A monorepo's build output dwarfs its source and holds no hand-written
    // config; walking it on every start is a cost nobody agreed to.
    const found = findLocalConfig(primary, { fs: tree() });
    expect(found.some((f) => f.includes('node_modules'))).toBe(false);
    expect(found.some((f) => f.includes('build/'))).toBe(false);
  });

  it('stops at the depth limit', () => {
    const deep = FakeFs.from([`${primary}/a/b/c/d/e/f/g/application-local.properties`]);
    expect(findLocalConfig(primary, { fs: deep, maxDepth: 3 })).toEqual([]);
  });

  it('knows the handful of names worth mirroring', () => {
    const mixed = FakeFs.from([
      `${primary}/svc/.env.local`,
      `${primary}/svc/application.properties`,
      `${primary}/svc/secrets.txt`,
    ]);
    // `application.properties` is committed and already in the worktree;
    // mirroring it would be linking a file over itself.
    expect(findLocalConfig(primary, { fs: mixed })).toEqual(['svc/.env.local']);
    expect(LOCAL_CONFIG_NAMES).toContain('application-local.properties');
  });
});

describe('findLocalConfig from what git ignores', () => {
  it('takes every ignored file that looks like config, whatever it is called', () => {
    const found = findLocalConfig(primary, {
      fs: FakeFs.from([]),
      ignored: [
        'billing-rest/src/main/resources/config/application-local-docker.properties',
        'web/.env',
        'web/.env.development.local',
        'api/appsettings.Development.json',
        'api/config/local.toml',
        'svc/application-dev.yml',
        '.DS_Store',
        'AcmeAdmin/war/temp/partner_export.xls',
        'AcmeAdmin/AcmeAdmin.iml',
      ],
    });
    expect(found).toEqual([
      'api/appsettings.Development.json',
      'api/config/local.toml',
      'billing-rest/src/main/resources/config/application-local-docker.properties',
      'svc/application-dev.yml',
      'web/.env',
      'web/.env.development.local',
    ]);
  });

  it('leaves editor, agent and build folders alone even when they hold json', () => {
    const found = findLocalConfig(primary, {
      fs: FakeFs.from([]),
      ignored: ['.vscode/launch.json', '.claude/settings.local.json', 'web/dist/manifest.json', 'build/', 'node_modules/'],
    });
    expect(found).toEqual([]);
  });

  it('looks inside a folder ignored as a whole, but not one that is build output', () => {
    const fs = FakeFs.from([
      `${primary}/svc/secrets/db.properties`,
      `${primary}/svc/secrets/notes.txt`,
      `${primary}/svc/build/resources/main/application-local.properties`,
    ]);
    expect(findLocalConfig(primary, { fs, ignored: ['svc/secrets/', 'svc/build/'] })).toEqual([
      'svc/secrets/db.properties',
    ]);
  });

  it('mirrors what a service asks for and skips what it rules out', () => {
    const found = findLocalConfig(primary, {
      fs: FakeFs.from([]),
      ignored: ['run-billing-local.sh', 'svc/application-local.properties', 'svc/huge-fixture.json'],
      include: ['run-*-local.sh'],
      exclude: ['svc/*.json'],
    });
    expect(found).toEqual(['run-billing-local.sh', 'svc/application-local.properties']);
  });

  it('falls back to the known names when git cannot say', () => {
    expect(findLocalConfig(primary, { fs: tree(), ignored: null })).toEqual([...localFiles].sort());
  });
});

describe('isLocalConfig', () => {
  it('knows config by its extension or an .env name', () => {
    expect(isLocalConfig('a/b/application-local.properties')).toBe(true);
    expect(isLocalConfig('.env.local')).toBe(true);
    expect(isLocalConfig('a/secrets.txt')).toBe(false);
  });

  it('does not take a lockfile for config', () => {
    expect(isLocalConfig('web/src/package-lock.json')).toBe(false);
    expect(isLocalConfig('web/pnpm-lock.yaml')).toBe(false);
    expect(isLocalConfig('web/yarn.lock')).toBe(false);
  });
});

describe('planMirror', () => {
  it('links every file the worktree is missing', () => {
    const plan = planMirror(primary, worktree, localFiles, { fs: tree() });
    expect(plan.map((l) => l.relative)).toEqual(localFiles);
    expect(plan[0].from).toBe(path.join(primary, localFiles[0]));
    expect(plan[0].to).toBe(path.join(worktree, localFiles[0]));
  });

  it('does nothing for a service running in the main checkout', () => {
    // The ordinary case. Mirroring a checkout into itself must be a no-op,
    // not a file linked over itself.
    expect(planMirror(primary, primary, localFiles, { fs: tree() })).toEqual([]);
  });

  it('never overwrites a file the worktree already has', () => {
    // That one is the user's own, and may be deliberately different.
    const withOwn = tree([`${worktree}/${localFiles[0]}`]);
    const plan = planMirror(primary, worktree, localFiles, { fs: withOwn });
    expect(plan.map((l) => l.relative)).toEqual(localFiles.slice(1));
  });

  it('leaves a link from a previous run alone', () => {
    const fs = tree();
    applyMirror(planMirror(primary, worktree, localFiles, { fs }), { fs });
    expect(planMirror(primary, worktree, localFiles, { fs })).toEqual([]);
  });
});

describe('applyMirror', () => {
  it('symlinks rather than copies, so one file stays the source of truth', () => {
    // Editing it in the main checkout has to reach every worktree at once.
    const fs = tree();
    const done = applyMirror(planMirror(primary, worktree, localFiles, { fs }), { fs });
    expect(done).toEqual(localFiles);
    expect(fs.links.get(`${worktree}/${localFiles[0]}`)).toBe(`${primary}/${localFiles[0]}`);
  });

  it('creates the directories the file needs', () => {
    const fs = tree();
    applyMirror(planMirror(primary, worktree, localFiles, { fs }), { fs });
    expect(fs.dirs.has(`${worktree}/AcmeProcessor/src/main/resources/config`)).toBe(true);
  });

  it('one file failing does not refuse the rest', () => {
    const fs = tree();
    const failing = {
      ...fs,
      readdirSync: fs.readdirSync.bind(fs),
      lstatSync: fs.lstatSync.bind(fs),
      existsSync: fs.existsSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      symlinkSync: (target: string, link: string) => {
        if (link.includes('acme-core')) throw new Error('EACCES');
        fs.symlinkSync(target, link);
      },
    } as MirrorFs;
    const done = applyMirror(planMirror(primary, worktree, localFiles, { fs }), { fs: failing });
    expect(done).toHaveLength(2);
  });
});
