// On-disk store for Teams and their tasks.
//
//   <userData>/teams/<id>.json         one Team per file
//   <userData>/team-tasks/<id>.json    one TeamTask per file
//   <userData>/team-files/<taskId>/    a task's shared folder
//
// Mirrors schedulesStore's atomic-write + load-all shape. The shared folder is
// plain files on purpose: members' runs read it with ordinary tools, and the
// user can open it in Finder.

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';
import { isSafeIdSegment } from '../../shared/flows/safeId';
import { DEFAULT_TEAM_CHECKPOINTS, type Team, type TeamTask } from '../../shared/flows/team';

function teamsDir(): string {
  return path.join(host().dataDir(), 'teams');
}

function tasksDir(): string {
  return path.join(host().dataDir(), 'team-tasks');
}

function filesRoot(): string {
  return path.join(host().dataDir(), 'team-files');
}

function recordPath(dir: string, id: string, label: string): string {
  if (!isSafeIdSegment(id)) throw new Error(`Unsafe ${label} id: ${id}`);
  return path.join(dir, `${id}.json`);
}

function writeAtomic(target: string, body: string, label: string): void {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    // best-effort — the write below surfaces the real error
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'teams', `Failed to persist ${label}: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function loadAll<T>(dir: string, accept: (raw: unknown) => T | null): T[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    try {
      const value = accept(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      if (value) out.push(value);
    } catch (err) {
      log('warn', 'teams', `Skipping unreadable ${name}: ${String(err)}`);
    }
  }
  return out;
}

export function saveTeam(team: Team): void {
  writeAtomic(recordPath(teamsDir(), team.id, 'team'), JSON.stringify(team), team.id);
}

export function loadAllTeams(): Team[] {
  return loadAll<Team>(teamsDir(), (raw) => {
    const t = raw as Team;
    if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || !Array.isArray(t.members)) return null;
    return {
      ...t,
      members: t.members.filter((m) => m && typeof m.workerId === 'string').map((m) => ({ ...m, role: m.role ?? '' })),
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, ...(t.checkpoints ?? {}) },
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
}

export function deleteTeam(id: string): void {
  try {
    fs.rmSync(recordPath(teamsDir(), id, 'team'), { force: true });
  } catch {
    // best-effort
  }
}

export function saveTeamTask(task: TeamTask): void {
  writeAtomic(recordPath(tasksDir(), task.id, 'team task'), JSON.stringify(task), task.id);
}

export function loadAllTeamTasks(): TeamTask[] {
  return loadAll<TeamTask>(tasksDir(), (raw) => {
    const t = raw as TeamTask;
    if (!t || typeof t.id !== 'string' || typeof t.teamId !== 'string' || !Array.isArray(t.stages)) return null;
    return { ...t, files: Array.isArray(t.files) ? t.files : [] };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteTeamTask(id: string): void {
  try {
    fs.rmSync(recordPath(tasksDir(), id, 'team task'), { force: true });
  } catch {
    // best-effort
  }
}

/// The shared folder of one task. Task ids are UUIDs; guard anyway.
export function teamTaskDir(taskId: string): string {
  if (!isSafeIdSegment(taskId)) throw new Error(`Unsafe team task id: ${taskId}`);
  return path.join(filesRoot(), taskId);
}

/// Resolve a task-relative file name, refusing anything that escapes the folder.
function insideTask(taskId: string, name: string): string {
  const root = teamTaskDir(taskId);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Path escapes the task folder: ${name}`);
  return target;
}

export function writeTeamTaskFile(taskId: string, name: string, body: string): void {
  const target = insideTask(taskId, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
}

/// Write raw bytes (an attachment you sent) into the task folder.
export function writeTeamTaskBytes(taskId: string, name: string, bytes: Buffer): void {
  const target = insideTask(taskId, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

export function readTeamTaskBytes(taskId: string, name: string): Buffer | null {
  try {
    return fs.readFileSync(insideTask(taskId, name));
  } catch {
    return null;
  }
}

/// Copy a file a member's run wrote into the task folder.
export function copyIntoTeamTask(taskId: string, name: string, sourcePath: string): void {
  const target = insideTask(taskId, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sourcePath, target);
}

/// The absolute path of a task file, for the host to open.
export function teamTaskFilePath(taskId: string, name: string): string {
  return insideTask(taskId, name);
}

export function readTeamTaskFile(taskId: string, name: string): string | null {
  try {
    return fs.readFileSync(insideTask(taskId, name), 'utf8');
  } catch {
    return null;
  }
}
