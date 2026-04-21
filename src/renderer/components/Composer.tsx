import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Attachment } from '@shared/types';

export interface ComposerProps {
  /// Key into the store's drafts + attachments maps. Use the conversation
  /// id for an existing conversation, or a sentinel like "__welcome__"
  /// for the start page before a conversation exists.
  draftKey: string;
  /// Invoked when the user hits send. Receives the trimmed prompt and
  /// the list of attached images. The caller owns routing the send to a
  /// runner (existing conversation) vs. creating a new conversation first.
  onSend: (prompt: string, attachments: Attachment[]) => void;
  /// True while a runner is streaming a response — shows a Stop button
  /// instead of Send, and calling it here triggers stop.
  isRunning?: boolean;
  onStop?: () => void;
  /// Visual variant. `welcome` is large + centered for the start page;
  /// `compact` is the in-conversation input bar.
  variant?: 'welcome' | 'compact';
  /// Bottom pills (project/branch/mode/model/effort). Rendered by the
  /// caller so each variant can show the appropriate set.
  footer?: React.ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
  /// Root directory for @-mention file lookup. When set, typing `@` in
  /// the textarea opens a filterable popover of project files; picking
  /// one inserts its path (relative to this root) into the draft. Omit
  /// to disable the feature.
  rootPath?: string;
  /// Slash commands available to the active backend. When a non-empty
  /// list is provided, typing `/` at the start of the draft opens a
  /// filterable popover. Names are bare (no leading `/`).
  slashCommands?: SlashCommandEntry[];
}

export interface SlashCommandEntry {
  name: string;
  description?: string;
  source?: string;
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB per image (claude limit)

/// Stable empty-array reference used by the attachments selector below.
/// Returning a fresh `[]` from the selector made Zustand think the value
/// changed on every store tick, which re-triggered the selector, which
/// re-rendered… infinite loop. Module-scoped constant means the selector
/// always returns the same reference when no attachments are queued.
const EMPTY_ATTACHMENTS: ReadonlyArray<Attachment> = Object.freeze([]);

export function Composer({
  draftKey,
  onSend,
  isRunning,
  onStop,
  variant = 'compact',
  footer,
  placeholder,
  autoFocus,
  rootPath,
  slashCommands,
}: ComposerProps) {
  const draft = useStore((s) => s.conversationDrafts[draftKey] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const attachments = useStore(
    (s) => s.conversationAttachments[draftKey] ?? (EMPTY_ATTACHMENTS as Attachment[]),
  );
  const addAttachment = useStore((s) => s.addAttachment);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  // Auto-grow the textarea up to the variant's max height. Welcome allows a
  // bigger pane since it dominates the screen; compact stays short so the
  // chat above remains visible.
  const maxHeight = variant === 'welcome' ? 260 : 200;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(maxHeight, Math.max(48, el.scrollHeight)) + 'px';
  }, [draft, variant, maxHeight]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // @-mention state. `mention` is the active trigger (position of the `@`
  // in the draft + the live query typed after it); null when no popover
  // is showing. `mentionFiles` caches the project's file list, fetched
  // lazily on first `@` and reused thereafter.
  const [mention, setMention] = useState<{ at: number; query: string } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[] | null>(null);
  const [mentionSelected, setMentionSelected] = useState(0);

  useEffect(() => {
    if (!mention || !rootPath || mentionFiles) return;
    let cancelled = false;
    window.overcli.invoke('fs:listFiles', rootPath).then((list) => {
      if (!cancelled) setMentionFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [mention, rootPath, mentionFiles]);

  const mentionMatches = useMemo(() => {
    if (!mention || !rootPath) return [];
    return rankMentionMatches(mentionFiles ?? [], mention.query, rootPath).slice(0, 8);
  }, [mention, mentionFiles, rootPath]);

  useEffect(() => {
    setMentionSelected(0);
  }, [mention?.query]);

  const closeMention = () => setMention(null);

  const applyMention = (absPath: string) => {
    if (!mention || !rootPath) return;
    const rel = relativeTo(absPath, rootPath);
    const before = draft.slice(0, mention.at);
    const afterStart = mention.at + 1 + mention.query.length;
    const after = draft.slice(afterStart);
    const insertion = `@${rel} `;
    const next = before + insertion + after;
    setDraft(draftKey, next);
    setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const caret = before.length + insertion.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // /-command state. Unlike @-mentions, slash commands are only valid at
  // the very start of the message — the CLIs ignore them anywhere else —
  // so the trigger fires only when the draft begins with `/` and the
  // caret is still inside that first word (no whitespace typed yet).
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashSelected, setSlashSelected] = useState(0);

  const slashMatches = useMemo(() => {
    if (!slash || !slashCommands?.length) return [];
    return rankSlashMatches(slashCommands, slash.query).slice(0, 8);
  }, [slash, slashCommands]);

  useEffect(() => {
    setSlashSelected(0);
  }, [slash?.query]);

  const applySlash = (name: string) => {
    if (!slash) return;
    const firstSpace = draft.indexOf(' ');
    const tail = firstSpace >= 0 ? draft.slice(firstSpace) : '';
    const insertion = `/${name} `;
    const next = insertion + tail.replace(/^\s+/, '');
    setDraft(draftKey, next);
    setSlash(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const caret = insertion.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const updateSlashFromCaret = (value: string, caret: number) => {
    if (!slashCommands?.length) {
      setSlash(null);
      return;
    }
    if (!value.startsWith('/')) {
      setSlash(null);
      return;
    }
    const firstSpace = value.indexOf(' ');
    const wordEnd = firstSpace === -1 ? value.length : firstSpace;
    if (caret > wordEnd) {
      setSlash(null);
      return;
    }
    setSlash({ query: value.slice(1, wordEnd) });
  };

  const updateMentionFromCaret = (value: string, caret: number) => {
    if (!rootPath) return;
    // Walk backward from the caret looking for an `@` that's either at
    // start-of-text or preceded by whitespace, with no whitespace between
    // it and the caret. That's our trigger — anything else closes the
    // popover.
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '@') {
        const prev = i > 0 ? value[i - 1] : '';
        if (i === 0 || /\s/.test(prev)) {
          const query = value.slice(i + 1, caret);
          if (/\s/.test(query)) {
            setMention(null);
            return;
          }
          setMention({ at: i, query });
          return;
        }
        setMention(null);
        return;
      }
      if (/\s/.test(ch)) {
        setMention(null);
        return;
      }
      i -= 1;
    }
    setMention(null);
  };

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setRejection(null);
      const list = Array.from(files);
      for (const f of list) {
        if (!f.type.startsWith('image/')) {
          setRejection(`Skipped ${f.name || 'file'} — only images are supported.`);
          continue;
        }
        if (f.size > MAX_ATTACHMENT_BYTES) {
          setRejection(`${f.name || 'image'} is ${Math.round(f.size / 1024 / 1024)} MB; max is 5 MB.`);
          continue;
        }
        const dataBase64 = await fileToBase64(f);
        const id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);
        addAttachment(draftKey, {
          id,
          mimeType: f.type || 'image/png',
          dataBase64,
          label: f.name,
          size: f.size,
        });
      }
    },
    [addAttachment, draftKey],
  );

  const commit = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    onSend(text, attachments);
  };

  return (
    <div
      className={
        // Theme-aware border so light mode actually shows a line (black
        // alpha) and dark mode stays subtle (white alpha) — same family
        // as the sidebar, which also uses the card border token now.
        'relative flex flex-col rounded-2xl border border-card transition-colors ' +
        (variant === 'welcome'
          ? 'bg-card-strong shadow-xl shadow-black/30 '
          : 'bg-card focus-within:border-card-strong ') +
        (dragging ? 'ring-2 ring-accent/50 border-accent/40' : '')
      }
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear if leaving to somewhere outside the composer — avoids
        // flicker when moving between child elements.
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => removeAttachment(draftKey, a.id)}
            />
          ))}
        </div>
      )}
      {mention && mentionMatches.length > 0 && (
        <MentionPopover
          variant={variant}
          matches={mentionMatches}
          selected={mentionSelected}
          rootPath={rootPath ?? ''}
          onHover={setMentionSelected}
          onPick={applyMention}
        />
      )}
      {slash && slashMatches.length > 0 && !mention && (
        <SlashPopover
          matches={slashMatches}
          selected={slashSelected}
          onHover={setSlashSelected}
          onPick={(entry) => applySlash(entry.name)}
        />
      )}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          const value = e.target.value;
          setDraft(draftKey, value);
          const caret = e.target.selectionStart ?? value.length;
          updateMentionFromCaret(value, caret);
          updateSlashFromCaret(value, caret);
        }}
        onKeyUp={(e) => {
          // Caret may move without the value changing (arrow keys, click).
          // Re-evaluate popover state on those too.
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
            const el = e.currentTarget;
            const caret = el.selectionStart ?? el.value.length;
            updateMentionFromCaret(el.value, caret);
            updateSlashFromCaret(el.value, caret);
          }
        }}
        onClick={(e) => {
          const el = e.currentTarget;
          const caret = el.selectionStart ?? el.value.length;
          updateMentionFromCaret(el.value, caret);
          updateSlashFromCaret(el.value, caret);
        }}
        onBlur={() => {
          // Delay so a click inside a popover can fire first.
          setTimeout(() => {
            setMention(null);
            setSlash(null);
          }, 120);
        }}
        onKeyDown={(e) => {
          if (mention && mentionMatches.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setMentionSelected((s) => Math.min(mentionMatches.length - 1, s + 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setMentionSelected((s) => Math.max(0, s - 1));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const pick = mentionMatches[mentionSelected];
              if (pick) applyMention(pick);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              closeMention();
              return;
            }
          }
          if (slash && slashMatches.length > 0 && !mention) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSlashSelected((s) => Math.min(slashMatches.length - 1, s + 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSlashSelected((s) => Math.max(0, s - 1));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const pick = slashMatches[slashSelected];
              if (pick) applySlash(pick.name);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setSlash(null);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && isRunning) {
            e.preventDefault();
            onStop?.();
          }
        }}
        onPaste={(e) => {
          // Grab any image payloads off the clipboard (e.g. macOS Cmd+Shift+4
          // then paste). Don't preventDefault — plain text paste should
          // still fill the textarea as normal.
          const items = Array.from(e.clipboardData.items);
          const files = items
            .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
            .map((it) => it.getAsFile())
            .filter((f): f is File => !!f);
          if (files.length) {
            e.preventDefault();
            void handleFiles(files);
          }
        }}
        placeholder={placeholder ?? 'Message…'}
        rows={variant === 'welcome' ? 3 : 2}
        className={
          'bg-transparent resize-none outline-none select-text placeholder-ink-faint ' +
          (variant === 'welcome' ? 'text-base px-5 pt-4 pb-2' : 'text-sm px-3.5 py-2.5')
        }
      />
      <div
        className={
          'flex items-center gap-2 ' +
          (variant === 'welcome' ? 'px-3 pb-3' : 'px-2 pb-2')
        }
      >
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-8 h-8 flex items-center justify-center text-ink-muted hover:text-ink rounded-full hover:bg-card"
          title="Attach image"
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            // Clear value so re-picking the same file re-triggers onChange.
            e.target.value = '';
          }}
        />
        {footer}
        <div className="flex-1" />
        {isRunning ? (
          <button
            onClick={onStop}
            className="px-3 py-1 rounded-full bg-red-500/20 text-red-300 hover:bg-red-500/30 text-xs"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={commit}
            disabled={!draft.trim() && attachments.length === 0}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-accent/30 text-ink hover:bg-accent/50 disabled:opacity-30 disabled:hover:bg-accent/30"
            title="Send (⏎)"
          >
            ↑
          </button>
        )}
      </div>
      {rejection && (
        <div className="px-3 pb-2 text-[10px] text-amber-400">{rejection}</div>
      )}
    </div>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const src = `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  return (
    <div className="relative group w-16 h-16 rounded-lg overflow-hidden border border-card-strong bg-black/30">
      <img src={src} alt={attachment.label ?? ''} className="w-full h-full object-cover" />
      <button
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 w-4 h-4 text-[10px] bg-black/70 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

function MentionPopover({
  variant,
  matches,
  selected,
  rootPath,
  onHover,
  onPick,
}: {
  variant: 'welcome' | 'compact';
  matches: string[];
  selected: number;
  rootPath: string;
  onHover: (i: number) => void;
  onPick: (absPath: string) => void;
}) {
  return (
    <div
      className={
        'absolute left-3 right-3 bottom-full mb-2 z-40 bg-surface-elevated border border-card-strong rounded-lg shadow-xl overflow-hidden ' +
        (variant === 'welcome' ? 'max-w-[640px]' : '')
      }
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ink-faint border-b border-card">
        Reference a file
      </div>
      <div className="max-h-[260px] overflow-y-auto py-1">
        {matches.map((p, i) => {
          const rel = relativeTo(p, rootPath);
          const slash = rel.lastIndexOf('/');
          const name = slash >= 0 ? rel.slice(slash + 1) : rel;
          const dir = slash >= 0 ? rel.slice(0, slash) : '';
          return (
            <button
              key={p}
              // Use mousedown so the textarea's onBlur doesn't fire first
              // and tear down the popover before the click registers.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(p);
              }}
              onMouseEnter={() => onHover(i)}
              className={
                'w-full text-left px-3 py-1 text-xs font-mono flex items-baseline gap-2 ' +
                (i === selected ? 'bg-accent/20 text-ink' : 'text-ink-muted hover:bg-card-strong')
              }
            >
              <span className="truncate">{name}</span>
              {dir && <span className="text-[10px] text-ink-faint truncate">{dir}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SlashPopover({
  matches,
  selected,
  onHover,
  onPick,
}: {
  matches: SlashCommandEntry[];
  selected: number;
  onHover: (i: number) => void;
  onPick: (entry: SlashCommandEntry) => void;
}) {
  return (
    <div className="absolute left-3 right-3 bottom-full mb-2 z-40 bg-surface-elevated border border-card-strong rounded-lg shadow-xl overflow-hidden">
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ink-faint border-b border-card">
        Slash command
      </div>
      <div className="max-h-[260px] overflow-y-auto py-1">
        {matches.map((entry, i) => (
          <button
            key={entry.name}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(entry);
            }}
            onMouseEnter={() => onHover(i)}
            className={
              'w-full text-left px-3 py-1 text-xs flex items-baseline gap-2 ' +
              (i === selected ? 'bg-accent/20 text-ink' : 'text-ink-muted hover:bg-card-strong')
            }
          >
            <span className="font-mono">/{entry.name}</span>
            {entry.description && (
              <span className="text-[10px] text-ink-faint truncate">{entry.description}</span>
            )}
            {entry.source && (
              <span className="ml-auto text-[9px] uppercase tracking-wide text-ink-faint">
                {entry.source}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function rankSlashMatches(entries: SlashCommandEntry[], query: string): SlashCommandEntry[] {
  if (!query) {
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }
  const q = query.toLowerCase();
  const scored: Array<[SlashCommandEntry, number]> = [];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    let score = 0;
    if (n === q) score = 1000;
    else if (n.startsWith(q)) score = 500 - n.length;
    else if (n.includes(q)) score = 300 - n.length;
    else if ((e.description ?? '').toLowerCase().includes(q)) score = 100;
    else continue;
    scored.push([e, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.map((x) => x[0]);
}

function relativeTo(full: string, root: string): string {
  if (!root) return full;
  if (full.startsWith(root + '/')) return full.slice(root.length + 1);
  if (full === root) return '';
  if (full.startsWith(root)) return full.slice(root.length);
  return full;
}

function rankMentionMatches(files: string[], query: string, root: string): string[] {
  if (!query.trim()) {
    return files.slice(0, 50);
  }
  const q = query.toLowerCase();
  const scored: Array<[string, number]> = [];
  for (const f of files) {
    const rel = relativeTo(f, root).toLowerCase();
    const name = rel.split('/').pop() ?? '';
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q)) score = 500 - name.length;
    else if (name.includes(q)) score = 300 - name.length;
    else if (rel.includes(q)) score = 100 - rel.length;
    else continue;
    scored.push([f, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.map((x) => x[0]);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // FileReader.readAsDataURL returns `data:image/png;base64,xxx` — we
      // only want the raw base64 body, not the data-URL prefix, because
      // claude's wire format supplies media_type separately.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
