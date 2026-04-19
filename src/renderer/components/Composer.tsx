import { useCallback, useEffect, useRef, useState } from 'react';
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
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(draftKey, e.target.value)}
        onKeyDown={(e) => {
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
