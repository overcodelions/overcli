import { describe, expect, it } from 'vitest';

import type { BackendHealth } from '@shared/types';
import { BASICS } from './basics';
import { CLI_SETUP, cliSetupPlan, joinNames } from './cliSetupPlan';

const health = (kinds: Record<string, BackendHealth['kind']>): Record<string, BackendHealth> =>
  Object.fromEntries(Object.entries(kinds).map(([b, kind]) => [b, { kind }]));

describe('joinNames', () => {
  it('reads as a sentence at every length', () => {
    expect(joinNames([])).toBe('No CLI');
    expect(joinNames(['Claude'])).toBe('Claude');
    expect(joinNames(['Claude', 'Codex'])).toBe('Claude and Codex');
    expect(joinNames(['Claude', 'Codex', 'Ollama'])).toBe('Claude, Codex and Ollama');
  });
});

describe('cliSetupPlan', () => {
  it('treats a backend it has not heard about as missing, not as nothing', () => {
    const plan = cliSetupPlan({});
    expect(plan.rows.map((r) => r.backend)).toEqual(CLI_SETUP.map((c) => c.backend));
    expect(plan.rows.every((r) => r.kind === 'missing')).toBe(true);
    expect(plan.headline).toBe('Install a coding CLI to get started');
    expect(plan.done).toBe(false);
  });

  it('leads with a signed-out CLI, one sign-in being shorter than any install', () => {
    const plan = cliSetupPlan(health({ codex: 'unauthenticated' }));
    expect(plan.signIn.map((r) => r.backend)).toEqual(['codex']);
    // Featured installs still show; the signed-out one is not repeated there.
    expect(plan.featured.map((r) => r.backend)).toEqual(['claude']);
    expect(plan.headline).toBe('Sign in to Codex to get started');
  });

  it('folds the unfeatured CLIs under "Also supported"', () => {
    const plan = cliSetupPlan({});
    expect(plan.featured.map((r) => r.backend)).toEqual(['claude', 'codex']);
    expect(plan.others.map((r) => r.backend)).toEqual(['gemini', 'copilot', 'ollama']);
  });

  // `unknown` is what a backend switched off in Settings reports.
  it('leaves out a backend the user switched off', () => {
    const plan = cliSetupPlan(health({ gemini: 'unknown' }));
    expect(plan.rows.map((r) => r.backend)).not.toContain('gemini');
  });

  it('says a working machine is set up, and names what works', () => {
    const plan = cliSetupPlan(
      health({ claude: 'ready', codex: 'ready', gemini: 'unknown', copilot: 'unknown', ollama: 'unknown' }),
    );
    expect(plan.done).toBe(true);
    expect(plan.headline).toBe("You're set up");
    expect(plan.subline).toMatch(/^Claude and Codex are signed in/);
  });

  it('has nothing to show when every backend is switched off', () => {
    const plan = cliSetupPlan(
      health(Object.fromEntries(CLI_SETUP.map((c) => [c.backend, 'unknown' as const]))),
    );
    expect(plan.rows).toEqual([]);
    expect(plan.ready).toEqual([]);
  });
});

describe('BASICS', () => {
  // A project need not be a git repo — the welcome screen says so too.
  it('does not say a project has to be a git repository', () => {
    const project = BASICS.find((b) => b.title === 'Projects')!;
    expect(project.body).toMatch(/folder/);
    expect(project.body).not.toMatch(/is a git repository/);
  });
});
