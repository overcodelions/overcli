import { useMemo, useState } from 'react';
import { SHORTCUTS, ShortcutGroup, formatShortcut } from '../../shortcuts';

const GROUP_ORDER: ShortcutGroup[] = ['Navigation', 'View', 'Editor', 'Conversation', 'App'];

export function ShortcutsHelpSheet() {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = SHORTCUTS.filter((d) => !d.hidden && (!q || d.label.toLowerCase().includes(q)));
    const byGroup = new Map<ShortcutGroup, typeof SHORTCUTS>();
    for (const g of GROUP_ORDER) byGroup.set(g, []);
    for (const d of visible) byGroup.get(d.group)!.push(d);
    return GROUP_ORDER.map((g) => ({ group: g, items: byGroup.get(g)! })).filter((x) => x.items.length > 0);
  }, [query]);

  return (
    <div className="flex flex-col max-h-[70vh]">
      <div className="px-5 py-3 border-b border-card flex items-center justify-between">
        <div className="text-sm font-medium">Keyboard shortcuts</div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="bg-transparent border border-card-strong rounded px-2 py-1 text-xs outline-none w-40 focus:border-accent"
        />
      </div>
      <div className="overflow-y-auto px-5 py-3">
        {groups.length === 0 ? (
          <div className="text-xs text-ink-faint py-4">No matching shortcuts.</div>
        ) : (
          groups.map(({ group, items }) => (
            <section key={group} className="mb-4 last:mb-1">
              <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">{group}</div>
              <ul className="space-y-1">
                {items.map((def) => (
                  <li key={def.id} className="flex items-center justify-between py-1">
                    <span className="text-sm text-ink">{def.label}</span>
                    <span className="flex gap-1">
                      {def.keys.slice(0, 1).map((k, i) => (
                        <kbd
                          key={i}
                          className="rounded border border-card-strong bg-card-strong px-2 py-0.5 text-sm font-mono text-ink"
                        >
                          {formatShortcut(k)}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
