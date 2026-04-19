import { useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { StreamEvent } from '@shared/types';
import { useStore } from '../store';

/// Aggregate file-change summary for the current conversation. Mirrors
/// codex's "3 files changed +41 -10" bar above the input: scans every
/// Edit / MultiEdit / Write / patchApply event in the turn history and
/// sums adds/dels per path. Writes count the full body as additions
/// since we don't have the prior file content on hand to diff against.
export interface FileChangeSummary {
  path: string;
  additions: number;
  deletions: number;
}

export function computeChangedFiles(events: StreamEvent[]): FileChangeSummary[] {
  const map = new Map<string, { additions: number; deletions: number }>();
  const bump = (path: string, additions: number, deletions: number) => {
    if (!path) return;
    const cur = map.get(path) ?? { additions: 0, deletions: 0 };
    cur.additions += additions;
    cur.deletions += deletions;
    map.set(path, cur);
  };

  for (const e of events) {
    if (e.kind.type === 'assistant') {
      for (const u of e.kind.info.toolUses) {
        const args = parseJSON(u.inputJSON);
        if (u.name === 'Edit') {
          const path = u.filePath ?? args.file_path ?? args.path ?? '';
          const oldS = u.oldString ?? args.old_string ?? args.old_str ?? args.old_text ?? '';
          const newS = u.newString ?? args.new_string ?? args.new_str ?? args.new_text ?? '';
          const { additions, deletions } = countOldNew(oldS, newS);
          bump(path, additions, deletions);
        } else if (u.name === 'MultiEdit') {
          const path = args.file_path ?? args.path ?? '';
          const edits: Array<{ old_string?: string; new_string?: string }> = Array.isArray(args.edits)
            ? args.edits
            : [];
          for (const ed of edits) {
            const { additions, deletions } = countOldNew(ed.old_string ?? '', ed.new_string ?? '');
            bump(path, additions, deletions);
          }
        } else if (u.name === 'Write') {
          const path = u.filePath ?? args.file_path ?? args.path ?? '';
          const content = typeof args.content === 'string' ? args.content : '';
          const lines = content.split('\n').filter((l) => l.length > 0).length;
          bump(path, lines, 0);
        }
      }
    } else if (e.kind.type === 'patchApply') {
      for (const f of e.kind.info.files) {
        bump(f.path, f.additions ?? 0, f.deletions ?? 0);
      }
    }
  }
  return Array.from(map.entries())
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function countOldNew(oldS: string, newS: string): { additions: number; deletions: number } {
  if (!oldS && !newS) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const p of diffLines(oldS, newS)) {
    const count = p.value.split('\n').filter((l) => l.length > 0).length;
    if (p.added) additions += count;
    else if (p.removed) deletions += count;
  }
  return { additions, deletions };
}

function parseJSON(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/// Collapsible bar rendered above the composer. Hidden when the turn
/// history contains no file-changing tool uses.
export function ChangesBar({ files }: { files: FileChangeSummary[] }) {
  const openFile = useStore((s) => s.openFile);
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const totals = files.reduce(
    (acc, f) => {
      acc.additions += f.additions;
      acc.deletions += f.deletions;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
  return (
    <div className="rounded-xl border border-card bg-card text-xs overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-card-strong"
      >
        <span className="text-ink-faint">{expanded ? '▾' : '▸'}</span>
        <span className="text-ink font-medium">
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <span className="text-green-400">+{totals.additions}</span>
        <span className="text-red-400">-{totals.deletions}</span>
      </button>
      {expanded && (
        <div className="border-t border-card">
          {files.map((f) => (
            <button
              key={f.path}
              onClick={() => openFile(f.path, undefined, 'diff')}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-card-strong border-t border-card first:border-t-0"
            >
              <code className="text-ink flex-1 truncate">{f.path}</code>
              <span className="text-green-400 text-[11px]">+{f.additions}</span>
              <span className="text-red-400 text-[11px]">-{f.deletions}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
