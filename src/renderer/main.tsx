import React from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';
import { TerminalWindow } from './components/TerminalWindow';
import { ExplorerWindow } from './components/ExplorerWindow';
import { FileWindow } from './components/FileWindow';
import { ConversationWindow } from './components/ConversationWindow';
import {
  popoutConversationId,
  popoutExplorerRoot,
  popoutFilePath,
  popoutTerminalId,
} from './popoutWindow';
import { CrashBoundary } from './components/CrashBoundary';
import { useStore } from './store';

// Expose the store on `window` in the Vite dev server so the renderer
// DevTools console can poke state (e.g. `useStore.setState({ projects: [] })`
// to preview the welcome screen). Skipped in production builds, which
// set VITE_DEV_SERVER_URL to empty.
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { useStore: typeof useStore }).useStore = useStore;
}

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
// A popped-out terminal, explorer, file or conversation is this same bundle
// opened with `?terminal=<id>`, `?explorer=<root>`, `?file=<path>` or
// `?conversation=<id>`.
createRoot(container).render(
  <React.StrictMode>
    <CrashBoundary>
      {popoutTerminalId ? (
        <TerminalWindow id={popoutTerminalId} />
      ) : popoutExplorerRoot ? (
        <ExplorerWindow root={popoutExplorerRoot} />
      ) : popoutFilePath ? (
        <FileWindow path={popoutFilePath} />
      ) : popoutConversationId ? (
        <ConversationWindow id={popoutConversationId} />
      ) : (
        <App />
      )}
    </CrashBoundary>
  </React.StrictMode>,
);
