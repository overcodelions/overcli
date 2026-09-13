import { describe, expect, it } from 'vitest';
import { taskPresets } from './taskPresets';
import type { RepoReader } from './detect';

function repo(files: Record<string, string>): RepoReader {
  return {
    exists: (relative) => relative in files,
    read: (relative) => files[relative] ?? null,
  };
}

describe('taskPresets', () => {
  it('offers a publish to Maven local through the wrapper, with the daemon off', () => {
    const found = taskPresets(
      repo({ gradlew: '', 'build.gradle': "plugins { id 'maven-publish' }" }),
      { name: 'acme-common' },
    );
    expect(found.find((p) => p.id === 'gradle-publish-local')).toMatchObject({
      name: 'acme-common-publish',
      command: ['./gradlew', 'publishToMavenLocal', '-Dorg.gradle.daemon=false'],
      why: 'build.gradle applies maven-publish',
    });
  });

  it('still offers the publish when maven-publish is applied out of sight, and says so', () => {
    const found = taskPresets(repo({ 'settings.gradle': "include 'lib'" }), { name: 'common' });
    const publish = found.find((p) => p.id === 'gradle-publish-local');
    expect(publish?.command[0]).toBe('gradle');
    expect(publish?.why).toMatch(/check a module applies it/);
  });

  it('installs a Maven build through mvnw when the repo has one', () => {
    const found = taskPresets(repo({ 'pom.xml': '<project/>', mvnw: '' }), { name: 'core' });
    expect(found.find((p) => p.id === 'maven-install')?.command).toEqual(['./mvnw', 'install', '-DskipTests']);
  });

  it("builds the image from the service's own folder before the root", () => {
    const found = taskPresets(
      repo({ Dockerfile: '', 'api/Dockerfile': '' }),
      { name: 'Billing REST', subpath: 'api' },
    );
    expect(found.find((p) => p.id === 'docker-build')).toMatchObject({
      command: ['docker', 'build', '-t', 'billing-rest', 'api'],
      why: 'api/Dockerfile',
    });
  });

  it('runs a build script with the package manager the lockfile names', () => {
    const found = taskPresets(
      repo({ 'web/package.json': '{"scripts":{"build":"vite build"}}', 'yarn.lock': '' }),
      { name: 'ui', subpath: 'web' },
    );
    expect(found.find((p) => p.id === 'node-build')).toMatchObject({
      command: ['yarn', 'run', 'build'],
      subpath: 'web',
    });
  });

  it('never offers two tasks under one name', () => {
    const found = taskPresets(
      repo({ 'build.gradle': '', 'package.json': '{"scripts":{"build":"tsc"}}' }),
      { name: 'app' },
    );
    const names = found.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers nothing for a repo that announces nothing', () => {
    expect(taskPresets(repo({ 'README.md': '' }), { name: 'x' })).toEqual([]);
  });
});
