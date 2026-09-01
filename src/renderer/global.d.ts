/// Bridge type for the `window.overcli` API the preload script exposes.
/// The main-side definition lives in src/preload/index.ts; this shim lets
/// the renderer's TypeScript pass see the same shape.

import type { IPCInvokeMap, MainToRendererEvent } from '../shared/types';

declare global {
  interface Window {
    overcli: {
      invoke<K extends keyof IPCInvokeMap>(
        channel: K,
        ...args: Parameters<IPCInvokeMap[K]>
      ): Promise<ReturnType<IPCInvokeMap[K]>>;
      onMainEvent(handler: (event: MainToRendererEvent) => void): () => void;
      /// Optional: absent under jsdom and in a plain browser, so every caller
      /// needs a fallback for a `File` with no path behind it.
      filePath?(file: File): string | null;
    };
  }
}

export {};
