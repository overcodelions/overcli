import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';
import { installFromRegistry } from './registry';
import type { TemplateResolveContext } from '../../shared/flows/templateResolver';

let dataDir = '';
let registryDir = '';
let settings: Record<string, unknown> = {};

useTestHost(() => dataDir);

vi.mock('../store', () => ({
  Store: {
    load: () => ({ settings }),
    saveSettings: (next: typeof settings) => {
      settings = next;
    },
  },
}));

/// A published flow with one step kept local on purpose, beside one on Claude.
const LOCAL_FLOW = `name: Acme local triage
version: "1"
input: user_prompt
participants:
  - id: triage
    name: Triage
    backend: ollama
    model: qwen2.5-coder:7b
  - id: lead
    name: Lead
    backend: claude
    model: claude-opus-5
steps:
  - id: sort
    participant: triage
    role: planner
    inputs: [user_prompt]
    output: plan.md
  - id: decide
    participant: lead
    role: reviewer
    inputs: [user_prompt, plan.md]
    output: review.md
`;

const machine = (over: Partial<TemplateResolveContext>) => async (): Promise<TemplateResolveContext> => ({
  healthyBackends: [],
  ollamaModels: [],
  ...over,
});

const args = { registryId: 'acme', id: 'local-triage', version: '1' };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-registry-data-'));
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-registry-src-'));
  fs.writeFileSync(path.join(registryDir, 'local-triage.yaml'), LOCAL_FLOW, 'utf-8');
  settings = { flowRegistries: [{ id: 'acme', name: 'Acme', dir: registryDir }] };
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(registryDir, { recursive: true, force: true });
});

describe('installFromRegistry — adapting to the machine', () => {
  it('leaves a local step on Ollama when Ollama is down, and reports it', async () => {
    const res = await installFromRegistry(args, machine({ healthyBackends: ['claude', 'codex'] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fs.readFileSync(res.filePath, 'utf-8')).toBe(LOCAL_FLOW);
    expect(res.adapted).toEqual([]);
    expect(res.keptLocal).toEqual([{ where: 'participant Triage', model: 'ollama:qwen2.5-coder:7b' }]);
  });

  it('rebinds only the cloud step, and writes what it reports', async () => {
    const res = await installFromRegistry(args, machine({ healthyBackends: ['codex'] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const written = fs.readFileSync(res.filePath, 'utf-8');
    expect(res.adapted.map((a) => a.where)).toEqual(['participant Lead']);
    expect(written).toContain('backend: ollama');
    expect(written).toContain('model: qwen2.5-coder:7b');
    expect(written).not.toContain('claude-opus-5');
    expect(res.keptLocal.map((k) => k.where)).toEqual(['participant Triage']);
  });

  it('writes the flow as published when no machine is given', async () => {
    const res = await installFromRegistry(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fs.readFileSync(res.filePath, 'utf-8')).toBe(LOCAL_FLOW);
    expect(res.adapted).toEqual([]);
    expect(res.keptLocal).toEqual([]);
  });
});
