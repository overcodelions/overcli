// One attached file, as a removable thumbnail. Images preview themselves;
// everything else shows its extension over a truncated filename. Shared by
// the chat composer and the worker drafting surfaces so an attachment looks
// the same wherever it was attached.

import type { Attachment } from '@shared/types';

export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith('image/');
  const src = `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  return (
    <div className="relative group w-16 h-16 rounded-lg overflow-hidden border border-card-strong bg-black/30">
      {isImage ? (
        <img src={src} alt={attachment.label ?? ''} className="w-full h-full object-cover" />
      ) : (
        <div
          className="w-full h-full flex flex-col items-center justify-center gap-1 px-1 text-center"
          title={attachment.label ?? ''}
        >
          <span className="text-[9px] uppercase tracking-wider text-ink-faint font-mono">
            {fileExtLabel(attachment)}
          </span>
          <span className="text-[9px] leading-tight text-ink-muted truncate w-full">
            {attachment.label ?? 'file'}
          </span>
        </div>
      )}
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

export function fileExtLabel(a: Attachment): string {
  if (a.label) {
    const dot = a.label.lastIndexOf('.');
    if (dot > 0 && dot < a.label.length - 1) return a.label.slice(dot + 1).toLowerCase();
  }
  const slash = a.mimeType.indexOf('/');
  if (slash > 0) return a.mimeType.slice(slash + 1).toLowerCase();
  return 'file';
}
