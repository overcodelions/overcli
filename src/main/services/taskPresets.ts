// One-off tasks worth offering for a checkout.
//
// What a dependent service needs done first is nearly always one of a handful
// of things — publish a library to Maven local, build an image, build a
// frontend bundle — and each is announced by a file in the repo. Offering
// those, with the command already right for this repo's wrapper and lockfile,
// beats a blank command field that has to be typed from memory.
//
// Offers, not detections: nothing is added until someone picks one, so a
// preset that turns out not to apply costs a click, not a broken service.

import type { RepoReader } from './detect';
import type { TaskPreset } from '../../shared/services';

/// Same reason detection adds it to bootRun: a reused daemon keeps the
/// environment it was born with.
const DAEMON_OFF = '-Dorg.gradle.daemon=false';

export function taskPresets(
  repo: RepoReader,
  context: { name: string; subpath?: string },
): TaskPreset[] {
  const out: TaskPreset[] = [];
  const name = context.name;
  // The service's own folder first, then the checkout root: a Dockerfile or a
  // package.json beside the module is the one that builds it.
  const dirs = [...new Set([context.subpath ?? '', ''])];
  const at = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);

  const gradleBuild = repo.read('build.gradle') ?? repo.read('build.gradle.kts');
  const gradleSettings = repo.read('settings.gradle') ?? repo.read('settings.gradle.kts');
  if (gradleBuild !== null || gradleSettings !== null) {
    const gradle = repo.exists('gradlew') ? './gradlew' : 'gradle';
    const source = gradleBuild !== null ? 'build.gradle' : 'settings.gradle';
    out.push({
      id: 'gradle-publish-local',
      label: 'Publish to Maven local',
      name: `${name}-publish`,
      command: [gradle, 'publishToMavenLocal', DAEMON_OFF],
      // Convention plugins often apply it per module, out of sight of the root
      // build — so its absence here is said, not treated as a reason to hide.
      why: /maven-publish/.test(gradleBuild ?? '')
        ? `${source} applies maven-publish`
        : `a Gradle build — maven-publish is not in the root ${source}, so check a module applies it`,
    });
    out.push({
      id: 'gradle-build',
      label: 'Build, skipping tests',
      name: `${name}-build`,
      command: [gradle, 'build', '-x', 'test', DAEMON_OFF],
      why: `${gradle} in the repo root`,
    });
  }

  if (repo.exists('pom.xml')) {
    const mvn = repo.exists('mvnw') ? './mvnw' : 'mvn';
    out.push({
      id: 'maven-install',
      label: 'Install to Maven local',
      name: `${name}-install`,
      command: [mvn, 'install', '-DskipTests'],
      why: 'pom.xml in the repo root',
    });
  }

  const dockerDir = dirs.find((dir) => repo.exists(at(dir, 'Dockerfile')));
  if (dockerDir !== undefined) {
    out.push({
      id: 'docker-build',
      label: 'Build the Docker image',
      name: `${name}-image`,
      command: ['docker', 'build', '-t', imageName(name), dockerDir || '.'],
      why: at(dockerDir, 'Dockerfile'),
    });
  }

  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].find(
    (file) => repo.exists(file),
  );
  if (compose) {
    out.push({
      id: 'compose-build',
      label: 'Build the compose images',
      name: `${name}-compose-build`,
      command: ['docker', 'compose', 'build'],
      why: compose,
    });
  }

  for (const dir of dirs) {
    const pkg = parseJson(repo.read(at(dir, 'package.json')));
    const scripts = pkg?.scripts as Record<string, unknown> | undefined;
    if (typeof scripts?.build !== 'string') continue;
    const manager = packageManager(repo, dir);
    out.push({
      id: 'node-build',
      label: `${manager} run build`,
      name: `${name}-build`,
      command: [manager, 'run', 'build'],
      subpath: dir || undefined,
      why: `a build script in ${at(dir, 'package.json')}`,
    });
    break;
  }

  if (/^build\s*:/m.test(repo.read('Makefile') ?? '')) {
    out.push({
      id: 'make-build',
      label: 'make build',
      name: `${name}-make`,
      command: ['make', 'build'],
      why: 'a build target in the Makefile',
    });
  }

  // Two presets can want the same name — a Gradle build and an npm build in
  // one repo. The list would then show two rows nobody can tell apart.
  const seen = new Set<string>();
  return out.map((preset) => {
    let candidate = preset.name;
    for (let n = 2; seen.has(candidate); n++) candidate = `${preset.name}-${n}`;
    seen.add(candidate);
    return { ...preset, name: candidate };
  });
}

/// The lockfile decides, looked for beside the package.json and then at the
/// root, where a workspace keeps it.
function packageManager(repo: RepoReader, dir: string): string {
  for (const base of [...new Set([dir, ''])]) {
    const at = (file: string) => (base ? `${base}/${file}` : file);
    if (repo.exists(at('pnpm-lock.yaml'))) return 'pnpm';
    if (repo.exists(at('yarn.lock'))) return 'yarn';
    if (repo.exists(at('bun.lockb')) || repo.exists(at('bun.lock'))) return 'bun';
  }
  return 'npm';
}

/// Docker refuses uppercase and most punctuation in a tag.
function imageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'app';
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
