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
});
