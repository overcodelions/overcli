import { describe, expect, it } from 'vitest';
import { accessTools, commandGrant, levelOf } from './access';

describe('worker access levels', () => {
  it('builds each level on the one below', () => {
    expect(accessTools({ level: 'read' }, 'everything')).not.toContain('Edit');
    expect(accessTools({ level: 'standard' }, 'everything')).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write']));
    expect(accessTools({ level: 'shell', commands: ['npm test', 'jq'] }, 'everything')).toEqual(expect.arrayContaining(['Edit', 'Bash(npm test:*)', 'Bash(jq:*)']));
    expect(accessTools({ level: 'everything' }, 'everything')).toEqual(expect.arrayContaining(['Bash', '*']));
  });

  it('never goes past what the server allows', () => {
    const capped = accessTools({ level: 'everything', commands: ['npm test'] }, 'standard');
    expect(capped).toContain('Edit');
    expect(capped.some((t) => t.startsWith('Bash'))).toBe(false);
    expect(capped).not.toContain('*');
  });

  it('adds named tools at any level', () => {
    expect(accessTools({ level: 'read', tools: ['mcp__zendesk__create_ticket'] }, 'read')).toContain('mcp__zendesk__create_ticket');
  });

  it('refuses a command that could chain or substitute', () => {
    expect(commandGrant('npm test')).toBe('Bash(npm test:*)');
    expect(commandGrant('npm test; rm -rf /')).toBeNull();
    expect(commandGrant('cat $(x)')).toBeNull();
    expect(commandGrant('jq > out')).toBeNull();
  });

  it('reads the server\'s ceiling off its own flags', () => {
    expect(levelOf(['Read', 'Grep'])).toBe('read');
    expect(levelOf(['Read', 'Edit', 'Write'])).toBe('standard');
    expect(levelOf(['Read', 'Bash(git log:*)'])).toBe('shell');
    expect(levelOf(['Bash'])).toBe('everything');
  });
});
