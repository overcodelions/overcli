// Validate every bundled template at startup-equivalent time so a typo in
// a template surfaces in CI, not when a user clicks "+ New flow".

import { describe, expect, it } from 'vitest';

import { FLOW_TEMPLATES } from './templates';
import { parseFlowYaml } from './yaml';
import { validateFlow } from './validation';

describe('bundled templates', () => {
  it.each(FLOW_TEMPLATES.map((t) => [t.id, t] as const))('template "%s" parses + validates', (id, t) => {
    const flow = parseFlowYaml({ yaml: t.yaml, id, source: 'user', filePath: '' });
    expect(flow, `parse failed for ${id}`).not.toBeNull();
    const v = validateFlow(flow!);
    expect(v.ok, `${id} validation errors: ${JSON.stringify(v.errors)}`).toBe(true);
  });

  it('every template has a unique id', () => {
    const ids = FLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template has a non-empty name + description + icon', () => {
    for (const t of FLOW_TEMPLATES) {
      expect(t.name.trim()).not.toBe('');
      expect(t.description.trim()).not.toBe('');
      expect(t.icon.trim()).not.toBe('');
    }
  });
});
