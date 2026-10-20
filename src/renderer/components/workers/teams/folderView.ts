// The shared folder, as the desk shows it: grouped by what a file IS to the
// task rather than listed by path. A stage piece's file name is a slug
// (`01-market-and-technical-groundwork-priya.md`) that only makes sense to the
// engine; on the desk it reads as its stage, by its author.

import type { TeamTask } from '@shared/flows/team';

export type FolderItemKind = 'doc' | 'page' | 'image' | 'data' | 'other';

export interface FolderItem {
  /// The task-folder name — what opening it needs.
  name: string;
  label: string;
  detail: string;
  kind: FolderItemKind;
  author: string;
  /// When it was last written.
  at: number;
  /// Rewritten by the latest pack update, so worth reading again.
  fresh?: boolean;
}

export interface FolderSection {
  id: 'pack' | 'task' | 'pieces' | 'made' | 'attachments' | 'earlier';
  title: string;
  /// Beside the title: the pack's version and when it last changed.
  note?: string;
  /// Folded until asked for.
  collapsed?: boolean;
  items: FolderItem[];
}

/// A file's time, as short as it can be and still unambiguous: the clock
/// today, the day name this week, the date before that.
export function fileTime(ts: number, now: number = Date.now()): string {
  const day = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const diff = Math.round((day(now) - day(ts)) / 86_400_000);
  const clock = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff <= 0) return clock;
  if (diff === 1) return `Yesterday ${clock}`;
  if (diff < 7) return new Date(ts).toLocaleDateString([], { weekday: 'short' }) + ` ${clock}`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function fileKind(name: string): FolderItemKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'markdown', 'txt', 'pdf', 'docx'].includes(ext)) return 'doc';
  if (['html', 'htm'].includes(ext)) return 'page';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['json', 'csv', 'tsv', 'yaml', 'yml', 'xml'].includes(ext)) return 'data';
  return 'other';
}

const baseName = (name: string) => name.split('/').pop() ?? name;

export function folderSections(task: Pick<TeamTask, 'files' | 'stages' | 'pack'>, now: number = Date.now()): FolderSection[] {
  const pack: FolderItem[] = [];
  const about: FolderItem[] = [];
  const pieces: FolderItem[] = [];
  const made: FolderItem[] = [];
  const attachments: FolderItem[] = [];
  const earlier: FolderItem[] = [];
  const version = task.pack?.version ?? 1;

  for (const f of task.files) {
    const kind = fileKind(f.name);
    const base = { name: f.name, kind, author: f.author, at: f.at };
    const kept = f.name.match(/^pack-v(\d+)\//);
    if (f.name.startsWith('pack/')) {
      // Rewritten by the latest update: the files it actually changed, when
      // that was recorded; every file it wrote, before it was.
      const changed = task.pack?.changed;
      const fresh = version > 1 && (changed ? changed.includes(f.name) : !!task.pack?.updatedAt && f.at >= task.pack.updatedAt);
      pack.push({ ...base, label: baseName(f.name), detail: version > 1 ? `Version ${version}` : 'Final pack', fresh });
    } else if (kept) {
      earlier.push({ ...base, label: baseName(f.name), detail: `Version ${kept[1]}` });
    } else if (f.name === 'brief.md') {
      about.push({ ...base, label: 'Your brief', detail: 'What you asked for' });
    } else if (f.name === 'conversation.md') {
      about.push({ ...base, label: 'Conversation', detail: 'You and the team, after the pack' });
    } else if (f.name.startsWith('attachments/')) {
      attachments.push({ ...base, label: baseName(f.name), detail: 'You attached' });
    } else if (f.name.startsWith('files/')) {
      // files/<member>/<path the run wrote>
      const rest = f.name.split('/').slice(2).join('/');
      const dir = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '';
      made.push({ ...base, label: baseName(f.name), detail: dir ? `${dir}/ · ${f.author}` : f.author });
    } else {
      const n = Number(f.name.match(/^(\d{2})-/)?.[1] ?? NaN);
      const stage = Number.isFinite(n) ? task.stages[n - 1] : undefined;
      pieces.push({
        ...base,
        label: stage?.title ?? baseName(f.name).replace(/\.md$/, ''),
        detail: Number.isFinite(n) ? `Stage ${n} · ${f.author}` : f.author,
      });
    }
  }

  // Pieces read in the order the work happened; files the team made, by who
  // made them and then where they sit.
  pieces.sort((a, b) => a.name.localeCompare(b.name));
  made.sort((a, b) => a.name.localeCompare(b.name));
  // Newest version first.
  earlier.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  for (const item of [...pack, ...about, ...pieces, ...made, ...attachments, ...earlier]) {
    item.detail = `${item.detail} · ${fileTime(item.at, now)}`;
  }
  const packChanged = task.pack?.updatedAt ?? Math.max(0, ...pack.map((f) => f.at));

  const sections: FolderSection[] = [
    {
      id: 'pack',
      title: 'The pack',
      note: pack.length ? `${version > 1 ? `v${version} · ` : ''}${fileTime(packChanged, now)}` : undefined,
      items: pack,
    },
    { id: 'task', title: 'The task', items: about },
    { id: 'pieces', title: 'Pieces', items: pieces },
    { id: 'made', title: 'Files the team made', items: made },
    { id: 'attachments', title: 'You attached', items: attachments },
    { id: 'earlier', title: 'Earlier pack versions', collapsed: true, items: earlier },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/// The side column's "Changed in vN" card: the files the latest pack update
/// added or rewrote, first `top` of them shown and the rest of the pack
/// behind "N more". Null for a first pack, which is all new.
export interface PackChangeCard {
  version: number;
  /// When this version was written.
  note: string;
  shown: FolderItem[];
  /// The rest of the pack — changed ones past `top` first, then unchanged.
  more: FolderItem[];
  /// How many files this version changed; `known` is false for a pack
  /// updated before changes were recorded, where every file counts.
  changedCount: number;
  known: boolean;
}

export function packChangeCard(
  task: Pick<TeamTask, 'files' | 'pack'>,
  now: number = Date.now(),
  top = 4,
): PackChangeCard | null {
  const pack = task.pack;
  const version = pack?.version ?? 1;
  if (!pack || version <= 1) return null;
  const known = Array.isArray(pack.changed);
  const changedSet = new Set(known ? pack.changed : pack.files);
  const before = new Set(
    task.files.filter((f) => f.name.startsWith(`pack-v${version - 1}/`)).map((f) => baseName(f.name)),
  );
  const at = new Map(task.files.map((f) => [f.name, f.at]));
  const item = (name: string, detail: string): FolderItem => ({
    name,
    label: baseName(name),
    detail,
    kind: fileKind(name),
    author: 'Coordinator',
    at: at.get(name) ?? pack.updatedAt ?? now,
  });
  const changed = pack.files
    .filter((n) => changedSet.has(n))
    .map((n) => item(n, !known ? 'Rewritten' : before.size > 0 && !before.has(baseName(n)) ? `New in v${version}` : 'Revised'));
  const same = pack.files.filter((n) => !changedSet.has(n)).map((n) => item(n, `Unchanged since v${version - 1}`));
  return {
    version,
    note: fileTime(pack.updatedAt ?? Math.max(0, ...changed.map((c) => c.at)), now),
    shown: changed.slice(0, top),
    more: [...changed.slice(top), ...same],
    changedCount: changed.length,
    known,
  };
}

/// The pieces, one row per stage: who worked it, when, and its files.
export interface PieceGroup {
  key: string;
  /// 1-based, as the plan numbers them; absent for a piece file that names
  /// no stage.
  stage?: number;
  title: string;
  when: string;
  authors: string[];
  files: FolderItem[];
}

export function pieceGroups(task: Pick<TeamTask, 'files' | 'stages' | 'pack'>, now: number = Date.now()): PieceGroup[] {
  const pieces = folderSections(task, now).find((s) => s.id === 'pieces')?.items ?? [];
  const groups: PieceGroup[] = [];
  const byStage = new Map<number, PieceGroup>();
  const files = new Map<PieceGroup, FolderItem[]>();
  for (const p of pieces) {
    const n = Number(baseName(p.name).match(/^(\d{2})-/)?.[1] ?? NaN);
    let g = Number.isFinite(n) ? byStage.get(n) : undefined;
    if (!g) {
      g = {
        key: Number.isFinite(n) ? `stage-${n}` : `file-${p.name}`,
        ...(Number.isFinite(n) ? { stage: n } : {}),
        title: Number.isFinite(n) ? task.stages[n - 1]?.title ?? p.label : p.label,
        when: '',
        authors: [],
        files: [],
      };
      groups.push(g);
      files.set(g, []);
      if (Number.isFinite(n)) byStage.set(n, g);
    }
    if (!g.authors.includes(p.author)) g.authors.push(p.author);
    // Inside a stage, each file is told apart by who wrote it.
    files.get(g)!.push({ ...p, label: p.author, detail: fileTime(p.at, now) });
  }
  for (const g of groups) {
    g.files = files.get(g)!;
    const times = g.files.map((f) => f.at).sort((a, b) => a - b);
    const first = fileTime(times[0], now);
    const last = fileTime(times.at(-1)!, now);
    const span = g.files.length > 1 && first !== last ? `${first}–${last}` : last;
    const count = g.files.length > 1 ? `${g.files.length} pieces · ` : '';
    g.when = g.stage !== undefined ? `Stage ${g.stage} · ${count}${span}` : `${count}${span}`;
  }
  return groups;
}
