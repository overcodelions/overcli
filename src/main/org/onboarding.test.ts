import { describe, expect, it } from 'vitest';
import { learnPrompt, readKnowledge } from './orgService';

describe('a worker’s onboarding', () => {
  it('asks it to read only, and to check last time’s notes when there are some', () => {
    const first = learnPrompt({ name: 'Joe', mcpServers: ['acme-tracker'] });
    expect(first).toContain('READ ONLY');
    expect(first).not.toContain('<previous>');
    const again = learnPrompt({ name: 'Joe', mcpServers: ['acme-tracker'] }, 'Projects: WOW, RED.');
    expect(again).toContain('<previous>\nProjects: WOW, RED.\n</previous>');
  });

  it('keeps what is inside the knowledge tags, and nothing too thin to use', () => {
    expect(readKnowledge('Here you go.\n<knowledge>\n## Projects\nWOW (web), RED (platform), DEVOPS (infrastructure).\n</knowledge>\nDone.')).toBe('## Projects\nWOW (web), RED (platform), DEVOPS (infrastructure).');
    expect(readKnowledge('<knowledge>ok</knowledge>')).toBeNull();
  });

  it('ends notes that run long at a whole section or line, never mid-sentence', () => {
    const line = 'A fact that was checked against the tracker today.\n';
    const sections = `## One\n${line.repeat(120)}## Two\n${line.repeat(120)}## Three\n${line.repeat(120)}`;
    const cut = readKnowledge(`<knowledge>${sections}</knowledge>`)!;
    expect(cut.length).toBeLessThanOrEqual(10_000);
    expect(cut.endsWith('today.')).toBe(true);
    expect(cut).not.toContain('## Three');
    // No heading late enough: back to the last whole line.
    const lines = readKnowledge(`<knowledge>${line.repeat(400)}</knowledge>`)!;
    expect(lines.length).toBeLessThanOrEqual(10_000);
    expect(lines.endsWith('today.')).toBe(true);
    // Nothing to do when it fits.
    expect(readKnowledge(`<knowledge>${line.repeat(10)}</knowledge>`)).toBe(line.repeat(10).trim());
  });

  it('hands back all of last time’s notes, and asks for room to spare', () => {
    const before = `${'x'.repeat(9000)}THE END`;
    const prompt = learnPrompt({ name: 'Joe', mcpServers: [] }, before);
    expect(prompt).toContain('THE END');
    expect(prompt).toContain('under 8,000 characters');
  });
});
