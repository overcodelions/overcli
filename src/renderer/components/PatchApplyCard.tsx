import { useState } from 'react';
import { PatchApplyInfo, PatchFileChange } from '@shared/types';
import { useStore } from '../store';
import { Diff } from './DiffView';

export function PatchApplyCard({ info }: { info: PatchApplyInfo }) {
  const [expanded, setExpanded] = useState(true);
  const totalAdd = info.files.reduce((s, f) => s + f.additions, 0);
  const totalDel = info.files.reduce((s, f) => s + f.deletions, 0);
  // Codex emits a patchApply event even when the patch turned out empty
  // (success=true, 0 files). That surfaces as "Patch applied · 0 files"
  // which is pure noise — drop it. Failures still render so errors stay
  // visible.
  if (info.success && info.files.length === 0 && !info.stderr) return null;
  return (
    <div
      className={
        'rounded-lg border text-xs ' +
        (info.success
          ? 'border-card bg-card'
          : 'border-red-500/30 bg-red-500/5')
      }
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-ink-muted hover:bg-card-strong"
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span className={'text-[10px] uppercase font-medium ' + (info.success ? 'text-green-400' : 'text-red-400')}>
          {info.success ? 'Patch applied' : 'Patch failed'}
        </span>
        <span className="text-ink-faint">{info.files.length} file{info.files.length === 1 ? '' : 's'}</span>
        <span className="ml-auto text-[10px]">
          <span className="text-green-400">+{totalAdd}</span>{' '}
          <span className="text-red-400">-{totalDel}</span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-card">
          {info.files.map((f) => (
            <PatchFileRow key={f.id} file={f} />
          ))}
          {info.stderr && (
            <pre className="m-3 text-[11px] font-mono text-red-300 bg-black/30 px-2 py-1 rounded overflow-x-auto select-text">
              {info.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PatchFileRow({ file }: { file: PatchFileChange }) {
  const openFile = useStore((s) => s.openFile);
  const [open, setOpen] = useState(true);
  const hasDiff = !!file.diff && file.diff.trim().length > 0;
  return (
    <div className="border-b border-card last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {hasDiff && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-[10px] text-ink-faint hover:text-ink w-3 text-center"
          >
            {open ? '▾' : '▸'}
          </button>
        )}
        <span
          className={'text-[10px] uppercase tracking-wide font-medium ' + kindColor(file.kind)}
        >
          {file.kind}
        </span>
        <code
          className="text-ink hover:underline cursor-pointer flex-1 truncate"
          onClick={() => openFile(file.path)}
        >
          {file.path}
        </code>
        {file.movedFrom && (
          <span className="text-[10px] text-ink-faint">from {file.movedFrom}</span>
        )}
        <span className="text-[10px]">
          <span className="text-green-400">+{file.additions}</span>{' '}
          <span className="text-red-400">-{file.deletions}</span>
        </span>
      </div>
      {hasDiff && open && (
        <div className="border-t border-card overflow-x-auto">
          <Diff unifiedDiff={file.diff!} />
        </div>
      )}
    </div>
  );
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'add':
      return 'text-green-400';
    case 'delete':
      return 'text-red-400';
    case 'move':
      return 'text-blue-400';
    default:
      return 'text-amber-400';
  }
}
