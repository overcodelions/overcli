// "From an image": a picture of a process someone found (a flowchart, a
// swimlane, a slide) drafted into one. The sheet takes the picture (dropped,
// picked or pasted) and a note; main reads it (org/processDraft.ts) and the
// editor opens with the draft, unsaved, under a banner that keeps the
// picture to hand.

import { useEffect, useRef, useState } from "react";

import type { PictureDraft } from "./processView";

const primaryBtn = "text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40";
const quietBtn = "text-xs px-2 py-1 rounded-md text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40";

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024;

/// What the editor opens with: the draft, what the reading was unsure of,
/// and the picture itself, as a data URL.
export type PictureStart = { draft: PictureDraft; notes: string[]; image: string };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ImageGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-5-5-9 8" />
    </svg>
  );
}

/// The sheet: drop, pick or paste a picture, say what to change, draft it.
export function FromImageSheet({ onClose, onDrafted }: { onClose: () => void; onDrafted: (start: PictureStart) => void }) {
  const [image, setImage] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const take = async (file: File | null | undefined) => {
    if (!file || busy) return;
    if (!TYPES.includes(file.type)) return setError("Use a PNG, JPEG, WebP or GIF picture.");
    if (file.size > MAX_BYTES) return setError("That picture is over 5 MB. A screenshot of the diagram is plenty.");
    try {
      setImage(await readAsDataUrl(file));
      setError(null);
    } catch {
      setError("Couldn't read that file.");
    }
  };

  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // ⌘V an image anywhere while the sheet is open; text pastes as usual.
    const paste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === "file" && i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      void take(item.getAsFile());
    };
    window.addEventListener("keydown", esc);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", esc);
      window.removeEventListener("paste", paste);
    };
  });

  const draft = async () => {
    if (!image) return;
    setBusy(true);
    setError(null);
    const res = await window.overcli
      .invoke("processes:draftFromImage", { image, ...(note.trim() ? { note: note.trim() } : {}) })
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!live.current) return;
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDrafted({ draft: res.draft, notes: res.notes, image });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => !busy && onClose()}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="process-image-title"
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files[0]);
        }}
        className="flex w-[min(580px,100%)] flex-col overflow-hidden rounded-xl border border-card-strong bg-surface-elevated shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-card px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="process-image-title" className="text-base font-semibold text-ink">
              Make a process from a picture
            </h2>
            <span className="text-xs leading-relaxed text-ink-muted">
              A flowchart, a swimlane or a slide you found. Each box becomes a stage, decisions become yours, and rework arrows say where work goes back. Nothing is saved until you check it.
            </span>
          </div>
          <button className={quietBtn} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="flex flex-col gap-4 px-5 py-4">
          <input
            ref={pick}
            type="file"
            accept={TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              void take(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {image ? (
            <div className="flex flex-col items-start gap-1.5">
              <img src={image} alt="The picture you picked" className="max-h-[220px] max-w-full rounded-lg border border-card bg-white object-contain" />
              <button className="text-xs text-accent hover:underline disabled:opacity-40" disabled={busy} onClick={() => pick.current?.click()}>
                Use another picture
              </button>
            </div>
          ) : (
            <button
              type="button"
              autoFocus
              onClick={() => pick.current?.click()}
              className={
                "flex flex-col items-center gap-1.5 rounded-xl border-[1.5px] border-dashed px-4 py-7 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 " +
                (over ? "border-accent bg-accent/10" : "border-card-strong bg-surface hover:border-accent")
              }
            >
              <span className="text-ink-muted">
                <ImageGlyph size={22} />
              </span>
              <span className="text-sm font-semibold text-ink">Drop a picture of the process here</span>
              <span className="text-xs text-ink-faint">Or click to pick one, or paste it with ⌘V. PNG, JPEG, WebP or GIF, under 5 MB.</span>
            </button>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-ink-muted">What to change (optional)</span>
            <textarea
              rows={2}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. use our Product Team for design"
              className="field resize-y px-2.5 py-2 text-sm leading-relaxed"
            />
          </label>
          {busy && (
            <div role="status" className="flex items-center gap-2 text-xs text-ink-muted">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              Reading the diagram… This can take 30 to 60 seconds.
            </div>
          )}
          {error && (
            <div role="alert" className="text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-card px-5 py-3">
          <button className={quietBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} disabled={!image || busy} onClick={() => void draft()}>
            {busy ? "Reading the diagram…" : "Draft it"}
          </button>
        </footer>
      </section>
    </div>
  );
}

/// Above a drafted process: what to check, what the reading was unsure of,
/// and the picture, which opens beside the editor.
export function PictureBanner({ start, open, onToggle }: { start: PictureStart; open: boolean; onToggle: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-start gap-3.5 rounded-xl border border-sky-400/30 bg-sky-400/10 px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        aria-label={open ? "Hide your picture" : "Show your picture beside the editor"}
        title={open ? "Hide it" : "Show it beside the editor"}
        className="h-[72px] w-24 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-card bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <img src={start.image} alt="" className="block h-full w-full object-cover" />
      </button>
      <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink">Drafted from your image — check each stage, who does it and where it sends work back</span>
        {start.notes.length > 0 && (
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-[18px] text-[13px] text-ink">
            {start.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        <span className="text-[11.5px] text-ink-faint">Nothing is saved until you create the process. Click the picture to keep it open beside the editor.</span>
      </div>
    </div>
  );
}

/// The picture, beside the editor while you check the draft against it.
export function PictureViewer({ image, onClose }: { image: string; onClose: () => void }) {
  return (
    <aside aria-label="Your picture" className="flex min-h-0 w-[min(40%,520px)] shrink-0 flex-col gap-2.5 border-l border-card bg-surface-elevated px-4 py-4">
      <span className="flex items-center gap-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Your picture</span>
        <button className={quietBtn} aria-label="Close the picture" onClick={onClose}>
          ×
        </button>
      </span>
      <div className="min-h-0 flex-1 overflow-auto">
        <img src={image} alt="The picture this process was drafted from" className="block h-auto w-full rounded-lg bg-white" />
      </div>
    </aside>
  );
}
