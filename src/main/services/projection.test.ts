import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  applyProjection,
  ensureExcluded,
  gitCommonDir,
  isInside,
  planProjection,
  ProjectionError,
  resolveLaunchCwd,
  substitute,
  type ProjectionFs,
} from './projection';
import type { ServiceBinding, ServiceSpec } from './types';

/// Enough of a filesystem to exercise the projection rules without touching
/// disk: files, directories, symlinks and one realpath mapping.
class FakeFs implements ProjectionFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  links = new Map<string, string>();
  /// Path -> the real path it resolves to, for the symlinked-checkout case.
  real = new Map<string, string>();

  async exists(p: string): Promise<boolean> {
    // FOLLOWS links, like the real one — which is why a dangling link reads as
    // absent, and why `applyProjection` cannot use this to decide whether to
    // create one.
    const target = this.links.get(p);
    if (target !== undefined) return this.files.has(target) || this.dirs.has(target);
    return this.files.has(p) || this.dirs.has(p);
  }
  async realpath(p: string): Promise<string> {
    return this.real.get(p) ?? p;
  }
  async readFile(p: string): Promise<string> {
    const value = this.files.get(p);
    if (value === undefined) throw new Error(`ENOENT ${p}`);
    return value;
  }
  async writeFile(p: string, data: string): Promise<void> {
    this.files.set(p, data);
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async symlink(target: string, linkPath: string): Promise<void> {
    this.links.set(linkPath, target);
  }
  async lstat(p: string) {
    // The real one REJECTS for a path with nothing at it, and reports on the
    // link itself rather than its target. Both matter: the dangling-link case
    // depends on exactly this.
    if (!this.files.has(p) && !this.dirs.has(p) && !this.links.has(p)) {
      throw new Error(`ENOENT ${p}`);
    }
    return { isSymbolicLink: () => this.links.has(p) };
  }
  async stat(p: string) {
    return { isDirectory: () => this.dirs.has(p) };
  }
  async readlink(p: string): Promise<string> {
    return this.links.get(p) ?? '';
  }
  async unlink(p: string): Promise<void> {
    this.links.delete(p);
    this.files.delete(p);
  }
}

const spec: ServiceSpec = {
  id: 'billing-rest',
  name: 'billing-rest',
  runner: 'spring-boot',
  command: ['./mvnw', 'spring-boot:run'],
  port: 8080,
  ready: { kind: 'http', path: '/actuator/health', port: 8080 },
  selfReloads: false,
  config: {
    inject: {
      SPRING_PROFILES_ACTIVE: 'local',
      SPRING_CONFIG_ADDITIONAL_LOCATION: '/cfg/billing-rest/',
      BASE_URL: 'http://localhost:${PORT}/${REF}',
    },
    link: { 'application-local.yml': '/cfg/billing-rest/application-local.yml' },
  },
};

const binding: ServiceBinding = {
  serviceId: 'billing-rest',
  ref: 'feat/cost-ceiling',
  path: '/wt/cost-ceiling',
};

function fsWithCheckout(): FakeFs {
  const fs = new FakeFs();
  fs.dirs.add('/wt/cost-ceiling');
  return fs;
}

describe('resolveLaunchCwd', () => {
  it('resolves a symlinked checkout to its real path', async () => {
    const fs = fsWithCheckout();
    fs.dirs.add('/userData/workspaces/w1/billing-rest');
    fs.real.set('/userData/workspaces/w1/billing-rest', '/repos/billing-rest');
    await expect(resolveLaunchCwd('/userData/workspaces/w1/billing-rest', { fs })).resolves.toBe(
      '/repos/billing-rest',
    );
  });

  it('refuses to launch inside the workspace symlink root', async () => {
    // The symlink root exists so the AGENT's cwd can see every member side by
    // side. Launching a process there makes node resolve modules out of the
    // repo into userData and git find the wrong root.
    const fs = fsWithCheckout();
    fs.dirs.add('/userData/workspaces/w1/billing-rest');
    await expect(
      resolveLaunchCwd('/userData/workspaces/w1/billing-rest', {
        fs,
        symlinkRoots: ['/userData/workspaces'],
      }),
    ).rejects.toThrow(ProjectionError);
  });

  it('names the missing checkout rather than failing obscurely', async () => {
    // Flows delete their scratch worktree mid-session, so this is routine.
    await expect(resolveLaunchCwd('/wt/gone', { fs: new FakeFs() })).rejects.toThrow(/no longer exists/);
  });
});

describe('isInside', () => {
  it('does not treat a sibling with a shared prefix as nested', () => {
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });
});

describe('substitute', () => {
  it('fills the checkout, ref and port placeholders', () => {
    expect(
      substitute('http://localhost:${PORT}/${REF} in ${CHECKOUT}', {
        root: '/wt',
        cwd: '/wt',
        ref: 'main',
        port: 8080,
      }),
    ).toBe('http://localhost:8080/main in /wt');
  });

  it('renders an unset port as empty rather than "undefined"', () => {
    expect(substitute('${PORT}', { root: '/wt', cwd: '/wt', ref: 'main' })).toBe('');
  });

  it('leaves an unset placeholder alone when asked, for a shell to read', () => {
    expect(substitute('${PORT}', { root: '/wt', cwd: '/wt', ref: 'main' }, { keepUnset: true })).toBe('${PORT}');
  });

  it('does not read a dollar in a path as a replacement pattern', () => {
    expect(substitute('${CHECKOUT}', { root: '/w$&t', cwd: '/w$&t', ref: 'main' })).toBe('/w$&t');
  });
});

describe('planProjection', () => {
  it('resolves paths against the bound checkout and substitutes env', async () => {
    const fs = fsWithCheckout();
    const plan = await planProjection(spec, binding, { fs });
    expect(plan.cwd).toBe('/wt/cost-ceiling');
    expect(plan.env.BASE_URL).toBe('http://localhost:8080/feat/cost-ceiling');
    expect(plan.links[0]).toEqual({
      relative: 'application-local.yml',
      linkPath: path.join('/wt/cost-ceiling', 'application-local.yml'),
      target: '/cfg/billing-rest/application-local.yml',
    });
  });

  it('hands the checkout, branch and port to the process as env', async () => {
    const plan = await planProjection({ ...spec, subpath: 'services/api' }, binding, { fs: fsWithCheckout() });
    expect(plan.env).toMatchObject({
      OVERCLI_CHECKOUT: '/wt/cost-ceiling',
      OVERCLI_ROOT: '/wt/cost-ceiling/services/api',
      OVERCLI_REF: 'feat/cost-ceiling',
      OVERCLI_PORT: '8080',
    });
  });

  it('fills checkout placeholders in the command and keeps a shell\'s own', async () => {
    const withCommand: ServiceSpec = {
      ...spec,
      port: undefined,
      command: ['sh', '-c', 'ln -sfn "${CHECKOUT}" /srv/app-active && echo ${REF} ${PORT} $HOME'],
    };
    const plan = await planProjection(withCommand, binding, { fs: fsWithCheckout() });
    expect(plan.command[2]).toBe('ln -sfn "/wt/cost-ceiling" /srv/app-active && echo feat/cost-ceiling ${PORT} $HOME');
  });

  it('uses the offset port when one was handed in', async () => {
    const fs = fsWithCheckout();
    const plan = await planProjection(spec, binding, { fs, port: 18080 });
    expect(plan.env.BASE_URL).toBe('http://localhost:18080/feat/cost-ceiling');
  });

  it('fills the service config directory into a link target, not just into env', async () => {
    // Left unsubstituted, this produced a symlink to a literal
    // `${SERVICE_CONFIG_DIR}` folder next to the app.
    const fs = fsWithCheckout();
    const withPlaceholder: ServiceSpec = {
      ...spec,
      config: { link: { '.env.local': '${SERVICE_CONFIG_DIR}/.env.local' } },
    };
    const plan = await planProjection(withPlaceholder, binding, { fs, configDir: '/cfg/overgit' });
    expect(plan.links[0].target).toBe('/cfg/overgit/.env.local');
  });

  it('projects into the subpath for a service inside a monorepo', async () => {
    const fs = fsWithCheckout();
    const plan = await planProjection({ ...spec, subpath: 'services/api' }, binding, { fs });
    expect(plan.links[0].linkPath).toBe(path.join('/wt/cost-ceiling/services/api', 'application-local.yml'));
  });

  it('writes nothing during planning', async () => {
    const fs = fsWithCheckout();
    await planProjection(spec, binding, { fs });
    expect(fs.links.size).toBe(0);
    expect(fs.files.size).toBe(0);
  });
});

describe('applyProjection', () => {
  it('links the shared config file into the checkout', async () => {
    const fs = fsWithCheckout();
    const plan = await planProjection(spec, binding, { fs });
    const result = await applyProjection(plan, { fs });
    expect(fs.links.get('/wt/cost-ceiling/application-local.yml')).toBe(
      '/cfg/billing-rest/application-local.yml',
    );
    expect(result.linked).toHaveLength(1);
  });

  it('replaces a dangling link left by a failed attempt', async () => {
    // `exists` follows symlinks, so a link pointing at something that no
    // longer exists reads as absent — and the symlink call then fails with
    // EEXIST. This is the bug that stopped a service from starting twice.
    const fs = fsWithCheckout();
    fs.links.set('/wt/cost-ceiling/application-local.yml', '/cfg/gone/application-local.yml');
    await expect(fs.exists('/wt/cost-ceiling/application-local.yml')).resolves.toBe(false);

    await applyProjection(await planProjection(spec, binding, { fs }), { fs });

    expect(fs.links.get('/wt/cost-ceiling/application-local.yml')).toBe(
      '/cfg/billing-rest/application-local.yml',
    );
  });

  it('creates the file being linked to, so the link is never dangling', async () => {
    // A link to a file that does not exist makes the runtime report a missing
    // file rather than an empty one, and there is nothing to open and edit.
    const fs = fsWithCheckout();
    await applyProjection(await planProjection(spec, binding, { fs }), { fs });
    expect(fs.files.get('/cfg/billing-rest/application-local.yml')).toBe('');
  });

  it('repoints a stale symlink at the service config', async () => {
    const fs = fsWithCheckout();
    fs.links.set('/wt/cost-ceiling/application-local.yml', '/cfg/old/application-local.yml');
    await applyProjection(await planProjection(spec, binding, { fs }), { fs });
    expect(fs.links.get('/wt/cost-ceiling/application-local.yml')).toBe(
      '/cfg/billing-rest/application-local.yml',
    );
  });

  it('never clobbers a real file the user wrote themselves', async () => {
    const fs = fsWithCheckout();
    fs.files.set('/wt/cost-ceiling/application-local.yml', 'hand-written: true');
    const result = await applyProjection(await planProjection(spec, binding, { fs }), { fs });
    expect(fs.files.get('/wt/cost-ceiling/application-local.yml')).toBe('hand-written: true');
    expect(result.linked).toEqual([]);
  });

  it('renders a template into the checkout', async () => {
    const fs = fsWithCheckout();
    fs.files.set('/cfg/apache/vhost.conf', 'DocumentRoot /wt');
    const withRender: ServiceSpec = {
      ...spec,
      config: { render: { 'conf/vhost.conf': '/cfg/apache/vhost.conf' } },
    };
    const result = await applyProjection(await planProjection(withRender, binding, { fs }), { fs });
    expect(fs.files.get('/wt/cost-ceiling/conf/vhost.conf')).toBe('DocumentRoot /wt');
    expect(result.rendered).toHaveLength(1);
  });
});

describe('gitCommonDir', () => {
  it('follows a linked worktree back to the shared git directory', async () => {
    // This is what makes one exclude entry cover every worktree of the repo.
    const fs = new FakeFs();
    fs.dirs.add('/wt/cost-ceiling');
    fs.files.set('/wt/cost-ceiling/.git', 'gitdir: /repos/billing-rest/.git/worktrees/cost-ceiling\n');
    fs.files.set('/repos/billing-rest/.git/worktrees/cost-ceiling/commondir', '../..\n');
    await expect(gitCommonDir('/wt/cost-ceiling', { fs })).resolves.toBe('/repos/billing-rest/.git');
  });

  it('uses .git directly in a normal checkout', async () => {
    const fs = new FakeFs();
    fs.dirs.add('/repos/billing-rest');
    fs.dirs.add('/repos/billing-rest/.git');
    await expect(gitCommonDir('/repos/billing-rest', { fs })).resolves.toBe('/repos/billing-rest/.git');
  });

  it('returns null outside a repo', async () => {
    await expect(gitCommonDir('/tmp/loose', { fs: new FakeFs() })).resolves.toBeNull();
  });
});

describe('ensureExcluded', () => {
  function repo(): FakeFs {
    const fs = new FakeFs();
    fs.dirs.add('/repos/billing-rest');
    fs.dirs.add('/repos/billing-rest/.git');
    return fs;
  }

  it('anchors the pattern to the repo root', async () => {
    // Unanchored, `application-local.yml` would also hide a tracked file of
    // the same name deeper in the tree.
    const fs = repo();
    await expect(ensureExcluded('/repos/billing-rest', ['application-local.yml'], { fs })).resolves.toEqual([
      '/application-local.yml',
    ]);
    expect(fs.files.get('/repos/billing-rest/.git/info/exclude')).toContain('/application-local.yml');
  });

  it('adds nothing the second time', async () => {
    const fs = repo();
    await ensureExcluded('/repos/billing-rest', ['application-local.yml'], { fs });
    await expect(ensureExcluded('/repos/billing-rest', ['application-local.yml'], { fs })).resolves.toEqual([]);
  });

  it('keeps entries the user already had', async () => {
    const fs = repo();
    fs.files.set('/repos/billing-rest/.git/info/exclude', '/scratch\n');
    await ensureExcluded('/repos/billing-rest', ['.env.local'], { fs });
    const written = fs.files.get('/repos/billing-rest/.git/info/exclude') ?? '';
    expect(written).toContain('/scratch');
    expect(written).toContain('/.env.local');
  });

  it('does nothing outside a repo', async () => {
    await expect(ensureExcluded('/tmp/loose', ['.env'], { fs: new FakeFs() })).resolves.toEqual([]);
  });
});
