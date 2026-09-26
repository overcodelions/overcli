import { describe, expect, it } from 'vitest';
import { buildsOnJvm, defaultReadyTimeoutSec, DEFAULT_READY_TIMEOUT_SEC, JVM_BUILD_READY_TIMEOUT_SEC } from './services';

describe('buildsOnJvm', () => {
  it('knows a Gradle or Spring service by its runner', () => {
    expect(buildsOnJvm({ runner: 'gradle', command: [] })).toBe(true);
    expect(buildsOnJvm({ runner: 'spring-boot', command: [] })).toBe(true);
  });

  it('knows a task that runs the wrapper, bare or inside a shell line', () => {
    expect(buildsOnJvm({ runner: 'command', command: ['./gradlew', 'publishToMavenLocal'] })).toBe(true);
    expect(buildsOnJvm({ runner: 'command', command: ['sh', '-c', './gradlew :x:build && java -jar x.jar'] })).toBe(true);
    expect(buildsOnJvm({ runner: 'command', command: ['mvn', 'install'] })).toBe(true);
  });

  it('leaves everything else out', () => {
    expect(buildsOnJvm({ runner: 'vite', command: ['npm', 'run', 'dev'] })).toBe(false);
    expect(buildsOnJvm({ runner: 'command', command: ['node', 'gradle-report.js'] })).toBe(false);
  });
});

describe('defaultReadyTimeoutSec', () => {
  it('gives a JVM build longer than a dev server', () => {
    expect(defaultReadyTimeoutSec({ runner: 'gradle', command: [] })).toBe(JVM_BUILD_READY_TIMEOUT_SEC);
    expect(defaultReadyTimeoutSec({ runner: 'vite', command: [] })).toBe(DEFAULT_READY_TIMEOUT_SEC);
  });
});
