// Preload script. Runs in a privileged-but-sandboxed context before the
// renderer loads. Exposes a typed `window.overcli` API via contextBridge so
// the renderer never directly touches Node or Electron internals.

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { IPCInvokeMap, MainToRendererEvent } from '../shared/types';

type InvokeChannel = keyof IPCInvokeMap;

const api = {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: Parameters<IPCInvokeMap[K]>
  ): Promise<ReturnType<IPCInvokeMap[K]>> {
    return ipcRenderer.invoke(channel, ...(args as unknown[])) as Promise<
      ReturnType<IPCInvokeMap[K]>
    >;
  },
  onMainEvent(handler: (event: MainToRendererEvent) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: MainToRendererEvent) => handler(payload);
    ipcRenderer.on('main:event', listener);
    return () => ipcRenderer.off('main:event', listener);
  },
};

contextBridge.exposeInMainWorld('overcli', api);

declare global {
  interface Window {
    overcli: typeof api;
  }
}
