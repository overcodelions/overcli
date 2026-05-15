// UI-only slice of the renderer store. State that has no dependency on
// projects, workspaces, conversations, or runner events lives here so it
// can be reasoned about (and potentially split into its own Zustand
// store) without touching domain code.
//
// Composed into the main store via spread; consumers still go through
// `useStore((s) => s.openSheet)` etc., so call sites are unchanged.
//
// Future slices to extract from store.ts: a runners slice (events,
// isRunning, currentModel — the hot one), a settings slice (settings +
// capabilities), and a data slice (projects, workspaces, conversations
// + persistence). Doing them in stages keeps each PR reviewable.

import type { ActiveSheet, DetailMode, OpenFileHighlight } from './store';
import { defaultFileViewMode, type FileViewMode } from './filePreview';

type SetFn<T> = (
  partial: Partial<T> | ((s: T) => Partial<T>),
) => void;

export interface UiSliceState {
  detailMode: DetailMode;
  activeSheet: ActiveSheet | null;
  openFilePath: string | null;
  openFileHighlight: OpenFileHighlight | null;
  openFileMode: FileViewMode;
  explorerRootPath: string | null;
  sidebarVisible: boolean;
  showToolActivity: boolean;
}

export interface UiSliceActions {
  setDetailMode(mode: DetailMode): void;
  openSheet(sheet: ActiveSheet | null): void;
  openFile(path: string, highlight?: OpenFileHighlight, mode?: FileViewMode): void;
  setOpenFileMode(mode: FileViewMode): void;
  closeFile(): void;
  toggleSidebar(): void;
  toggleToolActivity(): void;
}

export type UiSlice = UiSliceState & UiSliceActions;

export const uiSliceInitialState: UiSliceState = {
  detailMode: 'conversation',
  activeSheet: null,
  openFilePath: null,
  openFileHighlight: null,
  openFileMode: 'edit',
  explorerRootPath: null,
  sidebarVisible: true,
  showToolActivity: false,
};

export function createUiSlice<T extends UiSlice>(set: SetFn<T>): UiSliceActions {
  return {
    setDetailMode(mode) {
      set({ detailMode: mode } as Partial<T>);
    },
    openSheet(sheet) {
      set({ activeSheet: sheet } as Partial<T>);
    },
    openFile(path, highlight, mode) {
      set({
        openFilePath: path,
        openFileHighlight: highlight ?? null,
        openFileMode: defaultFileViewMode(path, !!highlight, mode),
      } as Partial<T>);
    },
    setOpenFileMode(mode) {
      set({ openFileMode: mode } as Partial<T>);
    },
    closeFile() {
      set({
        openFilePath: null,
        openFileHighlight: null,
        openFileMode: 'edit',
      } as Partial<T>);
    },
    toggleSidebar() {
      set(((s) => ({ sidebarVisible: !s.sidebarVisible })) as (s: T) => Partial<T>);
    },
    toggleToolActivity() {
      set(((s) => ({ showToolActivity: !s.showToolActivity })) as (s: T) => Partial<T>);
    },
  };
}
