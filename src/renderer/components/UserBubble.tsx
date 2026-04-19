import { Attachment } from '@shared/types';

export function UserBubble({ text, attachments }: { text: string; attachments?: Attachment[] }) {
  const hasImages = attachments && attachments.length > 0;
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
        {hasImages && (
          <div className="flex flex-wrap gap-1 p-1.5">
            {attachments!.map((a) => (
              <img
                key={a.id}
                src={`data:${a.mimeType};base64,${a.dataBase64}`}
                alt={a.label ?? 'attached image'}
                className="rounded-lg max-h-[220px] max-w-[320px] object-contain bg-black/30"
              />
            ))}
          </div>
        )}
        {hasText && (
          <div className="px-3.5 py-2 text-sm whitespace-pre-wrap">{text}</div>
        )}
      </div>
    </div>
  );
}
