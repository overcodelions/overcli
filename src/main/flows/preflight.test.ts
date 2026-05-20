import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── mock heavy deps before importing the module under test ────────────────────
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: { ...real, statSync: vi.fn() },
    statSync: vi.fn(),
  };
});
vi.mock('../health', () => ({ probeBackendHealth: vi.fn() }));
vi.mock('../ollama', () => ({ detectOllama: vi.fn() }));

import fs from 'node:fs';
import { probeBackendHealth } from '../health';
import { detectOllama } from '../ollama';
import { formatPreflight, preflightRun } from './preflight';
import type { PreflightResult } from './preflight';
import type { AppSettings } from '../../shared/types';
import type { Flow, FlowParticipant, FlowStep } from '../../shared/flows/schema';

// ─── helpers ──────────────────────────────────────────────────────────────────

const mockStatSync = vi.mocked(fs.statSync);
const mockProbeBackendHealth = vi.mocked(probeBackendHealth);
const mockDetectOllama = vi.mocked(detectOllama);

const SETTINGS: AppSettings = {
  backendPaths: { claude: '', codex: '', gemini: '', copilot: '', ollama: '' },
} as unknown as AppSettings;

function participant(overrides: Partial<FlowParticipant> = {}): FlowParticipant {
  return { id: 'primary', name: 'Primary', backend: 'claude', model: 'claude-sonnet-4-6', ...overrides };
}

function step(overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    id: 'plan',
    participantId: 'primary',
    role: 'planner',
    inputs: ['user_prompt'],
    tools: ['Read'],
    output: 'plan.md',
    ...overrides,
  };
}

function flow(participants: FlowParticipant[], steps: FlowStep[]): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants,
    steps,
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
  };
}

beforeEach(() => {
  // Default: project path exists, backend is ready, no ollama needed.
  mockStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
  mockProbeBackendHealth.mockResolvedValue({ kind: 'ready' });
  mockDetectOllama.mockResolvedValue({ installed: true, running: true, models: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── formatPreflight ──────────────────────────────────────────────────────────

describe('formatPreflight', () => {
  it('returns a simple string when result is ok', () => {
    const result: PreflightResult = { ok: true, problems: [] };
    expect(formatPreflight(result)).toBe('Preflight ok.');
  });

  it('lists bullet points for each problem', () => {
    const result: PreflightResult = {
      ok: false,
      problems: [
        { severity: 'error', path: 'project', message: 'Path does not exist.' },
        { severity: 'error', path: 'steps[0].model', message: 'Backend not ready.', hint: 'Log in.' },
      ],
    };
    const text = formatPreflight(result);
    expect(text).toContain('• Path does not exist.');
    expect(text).toContain('• Backend not ready. (Log in.)');
  });

  it('omits the hint when none is provided', () => {
    const result: PreflightResult = {
      ok: false,
      problems: [{ severity: 'error', path: 'p', message: 'Something wrong.' }],
    };
    expect(formatPreflight(result)).toBe('• Something wrong.');
  });
});

// ─── preflightRun — project path checks ───────────────────────────────────────

describe('preflightRun — project path', () => {
  it('errors on empty projectPath', async () => {
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.path === 'project')).toBe(true);
  });

  it('errors when projectPath does not exist', async () => {
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/nonexistent/path',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.path === 'project' && p.message.includes('does not exist'))).toBe(true);
  });

  it('errors when projectPath is a file not a directory', async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as ReturnType<typeof fs.statSync>);
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/some/file.txt',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.path === 'project' && p.message.includes('not a directory'))).toBe(true);
  });
});

// ─── preflightRun — tool check ────────────────────────────────────────────────

describe('preflightRun — tool check', () => {
  it('flags a non-researcher step with no tools', async () => {
    const result = await preflightRun({
      flow: flow([participant()], [step({ tools: [], role: 'implementer' })]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.path === 'steps[0].tools')).toBe(true);
  });

  it('does NOT flag a researcher step with no tools', async () => {
    const result = await preflightRun({
      flow: flow([participant()], [step({ tools: [], role: 'researcher' })]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    const toolProblems = result.problems.filter(p => p.path === 'steps[0].tools');
    expect(toolProblems).toHaveLength(0);
  });

  it('does NOT flag a custom role step with no tools', async () => {
    const result = await preflightRun({
      flow: flow([participant()], [step({ tools: [], role: 'custom', systemPromptOverride: 'Do things.' })]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    const toolProblems = result.problems.filter(p => p.path === 'steps[0].tools');
    expect(toolProblems).toHaveLength(0);
  });
});

// ─── preflightRun — backend health ───────────────────────────────────────────

describe('preflightRun — backend health', () => {
  it('errors when the backend is unauthenticated', async () => {
    mockProbeBackendHealth.mockResolvedValue({ kind: 'unauthenticated' });
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    const p = result.problems.find(p => p.path.includes('steps[0]'));
    expect(p?.message).toContain('unauthenticated');
  });

  it('errors when the backend is missing (CLI not installed)', async () => {
    mockProbeBackendHealth.mockResolvedValue({ kind: 'missing' });
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    const p = result.problems.find(p => p.message.includes('missing'));
    expect(p?.hint).toContain('Install');
  });

  it('passes when the backend reports "unknown" (not yet probed)', async () => {
    mockProbeBackendHealth.mockResolvedValue({ kind: 'unknown' });
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    const backendProblems = result.problems.filter(p => p.message.includes('not ready'));
    expect(backendProblems).toHaveLength(0);
  });
});

// ─── preflightRun — unknown model id ─────────────────────────────────────────

describe('preflightRun — unknown model id', () => {
  it('flags a model id that is not in the known list', async () => {
    const result = await preflightRun({
      flow: flow(
        [participant({ model: 'claude-fantasy-99' })],
        [step()],
      ),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.message.includes('claude-fantasy-99'))).toBe(true);
  });

  it('passes for a well-known claude model', async () => {
    const result = await preflightRun({
      flow: flow([participant({ model: 'claude-sonnet-4-6' })], [step()]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    const modelProblems = result.problems.filter(p => p.message.includes('isn\'t in the known list'));
    expect(modelProblems).toHaveLength(0);
  });

  it('does not flag unknown ollama model ids (dynamic catalog)', async () => {
    mockDetectOllama.mockResolvedValue({
      installed: true,
      running: true,
      models: [{ name: 'my-custom-model' }],
    } as Awaited<ReturnType<typeof detectOllama>>);
    const result = await preflightRun({
      flow: flow(
        [participant({ backend: 'ollama', model: 'my-custom-model' })],
        [step()],
      ),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    const modelListProblems = result.problems.filter(p =>
      p.message.includes('isn\'t in the known list'),
    );
    expect(modelListProblems).toHaveLength(0);
  });
});

// ─── preflightRun — ollama checks ─────────────────────────────────────────────

describe('preflightRun — ollama', () => {
  it('errors when Ollama is not installed', async () => {
    mockDetectOllama.mockResolvedValue({ installed: false, running: false, models: [] } as Awaited<ReturnType<typeof detectOllama>>);
    const result = await preflightRun({
      flow: flow(
        [participant({ backend: 'ollama', model: 'llama3.2' })],
        [step()],
      ),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.message.includes('not installed'))).toBe(true);
  });

  it('errors when Ollama is installed but not running', async () => {
    mockDetectOllama.mockResolvedValue({ installed: true, running: false, models: [] } as Awaited<ReturnType<typeof detectOllama>>);
    const result = await preflightRun({
      flow: flow(
        [participant({ backend: 'ollama', model: 'llama3.2' })],
        [step()],
      ),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.message.includes('not running'))).toBe(true);
  });

  it('errors when a required Ollama model is not pulled', async () => {
    mockDetectOllama.mockResolvedValue({
      installed: true,
      running: true,
      models: [{ name: 'llama3.2' }],
    } as Awaited<ReturnType<typeof detectOllama>>);
    const result = await preflightRun({
      flow: flow(
        [participant({ backend: 'ollama', model: 'qwen2.5-coder:7b' })],
        [step()],
      ),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.message.includes('"qwen2.5-coder:7b"'))).toBe(true);
  });

  it('passes when the required Ollama model is pulled', async () => {
    mockDetectOllama.mockResolvedValue({
      installed: true,
      running: true,
      models: [{ name: 'qwen2.5-coder:7b' }],
    } as Awaited<ReturnType<typeof detectOllama>>);
    const result = await preflightRun({
      flow: flow(
        [participant({ backend: 'ollama', model: 'qwen2.5-coder:7b' })],
        [step()],
      ),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(true);
  });

  it('does not probe Ollama when no step references an ollama model', async () => {
    await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(mockDetectOllama).not.toHaveBeenCalled();
  });
});

// ─── preflightRun — happy path ────────────────────────────────────────────────

describe('preflightRun — happy path', () => {
  it('returns ok:true for a fully valid claude flow', async () => {
    const result = await preflightRun({
      flow: flow([participant()], [step()]),
      projectPath: '/tmp',
      settings: SETTINGS,
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
  });
});
