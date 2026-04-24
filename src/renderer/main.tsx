import React from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';
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
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
