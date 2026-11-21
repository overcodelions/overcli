import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { purgeAgentSessions } from './sessionPurge';

const A = '11111111-2222-4333-8444-5555aaaa5555';
const B = '66666666-7777-4888-8999-0000bbbb0000';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-sessions-'));
  const put = (rel: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  };
  put(`projects/-srv-worktrees-a/${A}.jsonl`);
  put(`projects/-srv-worktrees-a/${A}/tool-results/call.txt`);
  put(`projects/-home-overcli/${A}.jsonl`);
  put(`projects/-home-overcli/${B}.jsonl`);
  put(`file-history/${A}/1.txt`);
  put(`todos/${A}-agent-${A}.json`);
  put(`debug/${A}.txt`);
  return root;
}

describe('purgeAgentSessions', () => {
  it('removes a session wherever it was kept, and nothing else', () => {
    const root = tree();
    expect(purgeAgentSessions([A], root)).toEqual({ purged: 1, refused: 0 });
    const left = (rel: string) => fs.existsSync(path.join(root, rel));
    expect(left(`projects/-srv-worktrees-a/${A}.jsonl`)).toBe(false);
    expect(left(`projects/-srv-worktrees-a/${A}`)).toBe(false);
    expect(left(`projects/-home-overcli/${A}.jsonl`)).toBe(false);
    expect(left(`file-history/${A}`)).toBe(false);
    expect(left(`todos/${A}-agent-${A}.json`)).toBe(false);
    expect(left(`debug/${A}.txt`)).toBe(false);
    expect(left(`projects/-home-overcli/${B}.jsonl`)).toBe(true);
  });

  it('refuses anything that is not a session id', () => {
    const root = tree();
    expect(purgeAgentSessions(['..', '../projects', `${A}/..`, ''], root)).toEqual({ purged: 0, refused: 4 });
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(true);
  });

  it('counts a session with nothing left as not purged', () => {
    expect(purgeAgentSessions([B], fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-empty-')))).toEqual({ purged: 0, refused: 0 });
  });
});
