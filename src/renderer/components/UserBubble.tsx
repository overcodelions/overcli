import { Attachment } from '@shared/types';

export function UserBubble({ text, attachments }: { text: string; attachments?: Attachment[] }) {
  const hasAttachments = attachments && attachments.length > 0;
  const hasText = text && text.trim().length > 0;
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[75%] rounded-2xl overflow-hidden select-text"
        style={{
          background: 'rgba(124, 139, 255, 0.18)',
          border: '1px solid rgba(124, 139, 255, 0.28)',
        }}
      >
        {hasAttachments && (
          <div className="flex flex-wrap gap-1 p-1.5">
            {attachments!.map((a) =>
              a.mimeType.startsWith('image/') ? (
                <img
                  key={a.id}
                  src={`data:${a.mimeType};base64,${a.dataBase64}`}
                  alt={a.label ?? 'attached image'}
                  className="rounded-lg max-h-[220px] max-w-[320px] object-contain bg-black/30"
                />
              ) : (
                <div
                  key={a.id}
                  className="rounded-lg bg-black/30 px-2.5 py-1.5 text-xs text-ink-muted font-mono flex items-center gap-2"
                  title={a.label ?? ''}
                >
                  <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                    {fileExtLabel(a)}
                  </span>
                  <span className="truncate max-w-[260px]">{a.label ?? 'file'}</span>
                </div>
              ),
            )}
          </div>
        )}
        {hasText && (
          <div className="px-3.5 py-2 text-sm whitespace-pre-wrap">{text}</div>
        )}
      </div>
    </div>
  );
}

function fileExtLabel(a: Attachment): string {
  if (a.label) {
    const dot = a.label.lastIndexOf('.');
    if (dot > 0 && dot < a.label.length - 1) return a.label.slice(dot + 1).toLowerCase();
  }
  const slash = a.mimeType.indexOf('/');
  if (slash > 0) return a.mimeType.slice(slash + 1).toLowerCase();
  return 'file';
}
