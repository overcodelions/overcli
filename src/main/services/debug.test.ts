import { describe, expect, it } from 'vitest';
import { debugLaunch, defaultDebugPort } from './debug';
import type { ServiceSpec } from './types';

function spec(over: Partial<ServiceSpec>): ServiceSpec {
  return {
    id: 'svc', name: 'svc', runner: 'command', command: ['run'],
    ready: { kind: 'none' }, selfReloads: false, config: {},
    debugEnabled: true, ...over,
  };
}

describe('debugLaunch', () => {
  it('uses a Gradle init script to put JDWP on bootRun', () => {
    const launch = debugLaunch(
      spec({ runner: 'gradle', debugPort: 5909 }),
      ['./gradlew', ':api:bootRun'], {}, 5909, '/app/overcli-debug.init.gradle',
    );
    expect(launch.command).toEqual(['./gradlew', ':api:bootRun', '-I', '/app/overcli-debug.init.gradle']);
    expect(launch.env.OVERCLI_DEBUG_PORT).toBe('5909');
  });

  it('passes JVM arguments through the Spring Boot Maven plugin', () => {
    const launch = debugLaunch(
      spec({ runner: 'spring-boot', debugPort: 5909 }),
      ['./mvnw', 'spring-boot:run'], {}, 5909,
    );
    expect(launch.command.at(-1)).toContain('spring-boot.run.jvmArguments=-agentlib:jdwp');
  });

  it('enables Node inspector for npm lifecycle scripts without inspecting npm itself', () => {
    const launch = debugLaunch(
      spec({ runner: 'npm', debugPort: 9229 }),
      ['npm', 'run', 'dev'], {}, 9229,
    );
    expect(launch.command).toEqual(['npm', 'run', 'dev']);
    expect(launch.env.npm_config_node_options).toBe('--inspect=127.0.0.1:9229');
  });

  it('wraps Python entry points with debugpy', () => {
    const launch = debugLaunch(
      spec({ runner: 'python', debugPort: 5678 }),
      ['uvicorn', 'app.main:app', '--reload'], {}, 5678,
    );
    expect(launch.command).toEqual([
      'python', '-m', 'debugpy', '--listen', '127.0.0.1:5678',
      '-m', 'uvicorn', 'app.main:app', '--reload',
    ]);
  });

  it('replaces go run with a headless Delve server', () => {
    const launch = debugLaunch(
      spec({ runner: 'go', debugPort: 2345 }),
      ['go', 'run', '.', '--config', 'local'], {}, 2345,
    );
    expect(launch.command).toEqual([
      'dlv', 'debug', '.', '--headless', '--listen=127.0.0.1:2345',
      '--api-version=2', '--accept-multiclient', '--continue', '--', '--config', 'local',
    ]);
  });
});

describe('defaultDebugPort', () => {
  it('keeps the Tilt JVM convention and standard ports elsewhere', () => {
    expect(defaultDebugPort('gradle', 5016)).toBe(5916);
    expect(defaultDebugPort('npm', 3000)).toBe(9229);
    expect(defaultDebugPort('python', 8000)).toBe(5678);
    expect(defaultDebugPort('go')).toBe(2345);
  });
});
