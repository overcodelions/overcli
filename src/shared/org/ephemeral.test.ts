import { describe, expect, it } from 'vitest';
import { isEphemeralMessage, type EphemeralMessageWorker, type EphemeralPolicy } from './ephemeral';

const policy: EphemeralPolicy = { sensitiveTools: ['Acme Logs'], roles: [] };
const roster: EphemeralMessageWorker[] = [
  { name: 'Logan', mcpServers: ['Acme_Logs'], threadSessions: { 'slack:C1:1.1': {} } },
  { name: 'Wiki', mcpServers: ['acme-wiki'], threadSessions: { 'slack:C1:2.2': {} } },
];

describe('whose message is an ephemeral worker’s', () => {
  it('is one posted under its name, signed with it, or in its thread', () => {
    expect(isEphemeralMessage({ username: 'Logan', text: 'hi' }, roster, policy)).toBe(true);
    expect(isEphemeralMessage({ text: '*Logan:* found it' }, roster, policy)).toBe(true);
    expect(isEphemeralMessage({ channel: 'C1', threadTs: '1.1', text: 'hi' }, roster, policy)).toBe(true);
  });

  it('is not another worker’s, in name, signature or thread', () => {
    expect(isEphemeralMessage({ username: 'Wiki' }, roster, policy)).toBe(false);
    expect(isEphemeralMessage({ text: '*Wiki:* done' }, roster, policy)).toBe(false);
    expect(isEphemeralMessage({ channel: 'C1', threadTs: '2.2' }, roster, policy)).toBe(false);
    expect(isEphemeralMessage({ channel: 'C2', threadTs: '1.1' }, roster, policy)).toBe(false);
  });

  it('is nobody’s when the org names no sensitive tools', () => {
    expect(isEphemeralMessage({ username: 'Logan' }, roster, { roles: [] })).toBe(false);
  });
});
