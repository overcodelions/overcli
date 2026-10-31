import { describe, it, expect } from 'vitest';
import {
  CLAUDE_ARTIFACT_ENV,
  claudeArtifactEnv,
  isDesignUnavailableNotice,
  isGatedDesignCommand,
  isArtifactPublishTool,
  isMcpArtifactPublish,
  toolInputFilePath,
} from './claudeArtifacts';

describe('claudeArtifactEnv', () => {
  it('sets the gate var when enabled', () => {
    expect(claudeArtifactEnv(true)).toEqual({ [CLAUDE_ARTIFACT_ENV]: '1' });
  });

  // The CLI reads an explicitly falsy value as "artifacts off", which is not
  // the same as leaving the decision alone — so the off state must produce no
  // key at all rather than a '0'.
  it('omits the var entirely when off or unset', () => {
    expect(claudeArtifactEnv(false)).toEqual({});
    expect(claudeArtifactEnv(undefined)).toEqual({});
  });
});

describe('isDesignUnavailableNotice', () => {
  it('matches the gated /design usage line', () => {
    expect(isDesignUnavailableNotice('Usage: /design consent | /design revoke')).toBe(true);
  });

  it('tolerates surrounding whitespace and case', () => {
    expect(isDesignUnavailableNotice('  usage: /design consent | /design revoke  ')).toBe(true);
    expect(isDesignUnavailableNotice('Usage: /design consent  |  /design revoke')).toBe(true);
  });

  it('does not match a reply that merely mentions the command', () => {
    expect(isDesignUnavailableNotice('Run /design consent to grant access.')).toBe(false);
    expect(isDesignUnavailableNotice('Usage: /design consent | /design revoke — and then some')).toBe(false);
    expect(isDesignUnavailableNotice('')).toBe(false);
  });
});

describe('isGatedDesignCommand', () => {
  const off = { backend: 'claude', artifactsOn: false };

  it('catches /design with or without a request when artifacts are off', () => {
    expect(isGatedDesignCommand('/design', off)).toBe(true);
    expect(isGatedDesignCommand('/design what do you think about the dropdown', off)).toBe(true);
    expect(isGatedDesignCommand('  /DESIGN a landing page\nwith two columns', off)).toBe(true);
  });

  it('leaves the stub subcommands alone', () => {
    expect(isGatedDesignCommand('/design consent', off)).toBe(false);
    expect(isGatedDesignCommand('/design revoke ', off)).toBe(false);
  });

  it('passes when artifacts are on or the backend is not claude', () => {
    expect(isGatedDesignCommand('/design a page', { backend: 'claude', artifactsOn: true })).toBe(false);
    expect(isGatedDesignCommand('/design a page', { backend: 'codex', artifactsOn: false })).toBe(false);
  });

  it('ignores other commands and prose', () => {
    expect(isGatedDesignCommand('/designer', off)).toBe(false);
    expect(isGatedDesignCommand('please /design this', off)).toBe(false);
  });
});

describe('MCP artifact publishes', () => {
  it('recognises the publishing calls on the claude-artifacts server', () => {
    expect(isMcpArtifactPublish('mcp__claude-artifacts__publish_files')).toBe(true);
    expect(isMcpArtifactPublish('mcp__claude-artifacts__publish_version')).toBe(true);
    expect(isMcpArtifactPublish('mcp__claude-artifacts__edit_version')).toBe(true);
    expect(isArtifactPublishTool('Artifact')).toBe(true);
  });

  it('leaves lookups and unrelated tools alone', () => {
    expect(isMcpArtifactPublish('mcp__claude-artifacts__read_artifact')).toBe(false);
    expect(isMcpArtifactPublish('mcp__claude-artifacts__guide')).toBe(false);
    expect(isArtifactPublishTool('Write')).toBe(false);
    expect(isArtifactPublishTool(undefined)).toBe(false);
  });

  it('takes the index.html file from publish_files as the source path', () => {
    const input = {
      files: [
        { as: 'css/site.css', path: '/tmp/s/site.css' },
        { as: 'index.html', path: '/tmp/s/workers.html' },
      ],
    };
    expect(toolInputFilePath('mcp__claude-artifacts__publish_files', input)).toBe('/tmp/s/workers.html');
    expect(toolInputFilePath('mcp__claude-artifacts__publish_files', { files: [{ as: 'a.html', path: '/a' }] })).toBe('/a');
  });

  it('keeps file_path as the answer for every other tool', () => {
    expect(toolInputFilePath('Write', { file_path: '/x.ts' })).toBe('/x.ts');
    expect(toolInputFilePath('Write', { files: [{ as: 'index.html', path: '/a' }] })).toBeUndefined();
    expect(toolInputFilePath('mcp__claude-artifacts__publish_version', { content: '<html>' })).toBeUndefined();
  });
});
