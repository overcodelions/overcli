import React from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
