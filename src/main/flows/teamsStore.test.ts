import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

useTestHost(mockGetPath);

vi.mock('../diagnostics', () => ({
  log: vi.fn(),
}));

import type { TeamTask } from '../../shared/flows/team';
import { deleteTeamTask, flushTeamTasks, loadAllTeamTasks, saveTeamTask } from './teamsStore';

function makeTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    teamId: 'team-1',
    teamName: 'Acme release crew',
    brief: 'Ship the thing',
    status: 'running',
    stages: [],
    stageIndex: 0,
    spentUSD: 0,
    budgetUSD: 10,
    folder: '/tmp/folder',
    files: [],
    createdAt: 1,
    ...overrides,
  } as TeamTask;
}

const onDisk = (id: string) => path.join(userDataDir, 'team-tasks', `${id}.json`);

describe('team task writes', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-teams-store-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    flushTeamTasks();
    vi.useRealTimers();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('coalesces a burst of saves into one write of the latest state', () => {
    const task = makeTask();
    const write = vi.spyOn(fs, 'writeFileSync');
    for (let i = 0; i < 20; i++) {
      task.spentUSD = i;
      saveTeamTask(task);
    }
    expect(fs.existsSync(onDisk('task-1'))).toBe(false);
    vi.runAllTimers();
    expect(write.mock.calls.filter(([p]) => String(p).includes('team-tasks')).length).toBe(1);
    expect(JSON.parse(fs.readFileSync(onDisk('task-1'), 'utf8')).spentUSD).toBe(19);
    write.mockRestore();
  });

  it('writes what is pending on flush, and loading sees it', () => {
    saveTeamTask(makeTask({ spentUSD: 3 }));
    expect(loadAllTeamTasks().map((t) => t.spentUSD)).toEqual([3]);
  });

  it('drops a pending write for a task you deleted', () => {
    saveTeamTask(makeTask());
    deleteTeamTask('task-1');
    flushTeamTasks();
    expect(fs.existsSync(onDisk('task-1'))).toBe(false);
  });
});
