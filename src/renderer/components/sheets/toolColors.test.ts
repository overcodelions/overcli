import { describe, expect, it } from 'vitest';
import { shortToolName, toolColorRamp } from './toolColors';

function hue(color: string): number {
  return Number(/^hsl\((-?\d+)/.exec(color)![1]);
}

describe('toolColorRamp', () => {
  it('runs slowest-first names from red to green', () => {
    const colors = toolColorRamp(['Bash', 'Read', 'Grep']);
    expect(hue(colors.get('Bash')!)).toBe(0);
    expect(hue(colors.get('Grep')!)).toBe(132);
    expect(hue(colors.get('Read')!)).toBeGreaterThan(hue(colors.get('Bash')!));
    expect(hue(colors.get('Read')!)).toBeLessThan(hue(colors.get('Grep')!));
  });

  it('gives a lone tool the slow end rather than a midpoint', () => {
    expect(hue(toolColorRamp(['Bash']).get('Bash')!)).toBe(0);
  });

  it('stays clear of the blue accent the model share is drawn in', () => {
    for (const color of toolColorRamp(['a', 'b', 'c', 'd', 'e']).values()) {
      expect(hue(color)).toBeLessThan(180);
    }
  });
});

describe('shortToolName', () => {
  it('leaves built-in tools alone', () => {
    expect(shortToolName('Bash')).toBe('Bash');
  });

  it('reduces an MCP tool to server and leaf', () => {
    expect(shortToolName('mcp__slack__slack_post_message')).toBe('slack:slack_post_message');
  });
});
