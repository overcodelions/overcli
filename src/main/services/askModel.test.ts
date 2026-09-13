import { describe, expect, it } from 'vitest';
import { buildFixPrompt, splitSuggestedCommand, tidySuggestion } from './askModel';
import type { ServiceSpec } from './types';

const spec: ServiceSpec = {
  id: 'proc',
  name: 'AcmeProcessor',
  runner: 'gradle',
  command: ['./gradlew', ':AcmeProcessor:bootRun'],
  ready: { kind: 'none' },
  selfReloads: false,
  config: {},
};

function ctx(over: Partial<Parameters<typeof buildFixPrompt>[0]> = {}) {
  return {
    spec,
    lines: ['starting', 'boom'],
    env: { SPRING_PROFILES_ACTIVE: 'local' },
    options: [{ key: '-Dproc.database.ip', value: '10.0.0.4' }],
    binding: { ref: 'feat/x', path: '/wt/x' },
    findings: [],
    ...over,
  };
}

describe('the prompt', () => {
  it('carries the command, the checkout and the environment', () => {
    const p = buildFixPrompt(ctx());
    expect(p).toContain('./gradlew :AcmeProcessor:bootRun');
    expect(p).toContain('/wt/x on feat/x');
    expect(p).toContain('SPRING_PROFILES_ACTIVE=local');
  });

  it('sends only the tail of a long log', () => {
    // The useful line is near the end, and a whole Gradle build buys nothing
    // but latency.
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const p = buildFixPrompt(ctx({ lines }));
    expect(p).not.toContain('line 0\n');
    expect(p).toContain('line 499');
  });

  it('tells the model what the rules already said', () => {
    const p = buildFixPrompt(
      ctx({
        findings: [
          { id: 'x', title: 'It started on the "slave" profile', detail: '', evidence: [] },
        ],
      }),
    );
    expect(p).toContain('do not repeat these');
    expect(p).toContain('It started on the "slave" profile');
  });

  it('scrubs credentials out of the options before they leave the machine', () => {
    // Options are exactly where passwords live in this app, and a prompt goes
    // off the box.
    const secret = 'hunter2-correct-horse-battery';
    const p = buildFixPrompt(
      ctx({ options: [{ key: '-Ddb.password', value: secret }], secrets: [secret] }),
    );
    expect(p).not.toContain(secret);
    expect(p).toContain('REDACTED');
  });

  it('says plainly when there was no output at all', () => {
    expect(buildFixPrompt(ctx({ lines: [] }))).toContain('(it printed nothing)');
  });
});

describe('what the file that described it says', () => {
  it('shows the model the Tiltfile resource, not just the detected command', () => {
    // The detected `npm run start` knows nothing of `nvm use v12.22.5`; the
    // Tiltfile does, and that difference is the answer.
    const p = buildFixPrompt(
      ctx({
        spec: {
          ...spec,
          subpath: 'admin-ui',
          importedFrom: {
            source: 'tiltfile',
            project: 'acme-local-dev',
            excerpt: "frontend('admin-console', 'acme-admin-console', 'v12.22.5', 'ng serve --ssl')",
          },
        },
      }),
    );
    expect(p).toContain('imported from the tiltfile in acme-local-dev');
    expect(p).toContain("'v12.22.5'");
    expect(p).toContain('Runs from: admin-ui');
    expect(p).toContain('COMMAND:');
  });
});

describe('a proposed command', () => {
  it('is taken out of the answer so the pane can offer it', () => {
    const out = splitSuggestedCommand(
      'Node 22 cannot build Angular 11.\nSwitch to Node 12.\nCOMMAND: `. ~/.nvm/nvm.sh && nvm use v12.22.5 && npm start`',
    );
    expect(out.command).toBe('. ~/.nvm/nvm.sh && nvm use v12.22.5 && npm start');
    expect(out.text).toBe('Node 22 cannot build Angular 11.\nSwitch to Node 12.');
  });

  it('is absent when the fix is not a command', () => {
    expect(splitSuggestedCommand('Add -Ddb.host=localhost').command).toBeUndefined();
  });
});

describe('tidying the answer', () => {
  it('drops headings, fences and bullets a model adds anyway', () => {
    const out = tidySuggestion('## Diagnosis\n\n- The port is taken\n```\nfoo\n```\n- Stop it');
    expect(out).toBe('The port is taken\nfoo\nStop it');
  });

  it('keeps it short enough to read in a banner', () => {
    const out = tidySuggestion(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    expect(out.split('\n')).toHaveLength(8);
  });
});
