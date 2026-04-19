import { useState } from 'react';
import { useStore } from '../../store';

export function QuickSwitcherSheet() {
  const projects = useStore((s) => s.projects);
  const selectConversation = useStore((s) => s.selectConversation);
  const openSheet = useStore((s) => s.openSheet);
  const [query, setQuery] = useState('');
  const all = projects.flatMap((p) =>
    p.conversations.map((c) => ({ project: p, conv: c })),
  );
  const filtered = query
    ? all.filter(({ conv }) => conv.name.toLowerCase().includes(query.toLowerCase()))
    : all.slice(0, 25);
  return (
    <div className="flex flex-col max-h-[70vh]">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Jump to conversation"
        className="bg-transparent px-5 py-3 border-b border-card text-sm outline-none"
      />
      <div className="overflow-y-auto">
        {filtered.map(({ project, conv }) => (
          <button
            key={conv.id}
            onClick={() => {
              selectConversation(conv.id);
              openSheet(null);
            }}
            className="w-full text-left px-5 py-2 hover:bg-card-strong"
          >
            <div className="text-sm">{conv.name}</div>
            <div className="text-[10px] text-ink-faint">{project.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
