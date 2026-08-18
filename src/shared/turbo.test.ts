import { describe, expect, it } from 'vitest';
import { turboSummary, turboSupported } from './turbo';

describe('turboSupported', () => {
  it('covers the backends with real turbo levers', () => {
    expect(turboSupported('claude')).toBe(true);
    expect(turboSupported('codex')).toBe(true);
  });

  it('excludes backends where the toggle would be decoration', () => {
    // copilot's CLI exposes no effort or MCP flags; ollama and gemini run
    // through transports that never reach claudeBackend/codexBackend args.
    expect(turboSupported('copilot')).toBe(false);
    expect(turboSupported('ollama')).toBe(false);
    expect(turboSupported('gemini')).toBe(false);
  });
});

describe('turboSummary', () => {
  it('only promises MCP removal on claude', () => {
    expect(turboSummary('claude')).toContain('no MCP');
    // `-c mcp_servers={}` does not clear codex's servers, so the UI must not
    // claim it does.
    expect(turboSummary('codex')).not.toContain('MCP');
    expect(turboSummary('codex')).toContain('low effort');
  });
});
