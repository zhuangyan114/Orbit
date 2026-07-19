import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

console.log('[Orbit WebView] mounting...');
const container = document.getElementById('root');
if (container) {
  try {
    const root = createRoot(container);
    root.render(<App />);
    console.log('[Orbit WebView] mounted successfully');
  } catch (err) {
    console.error('[Orbit WebView] render error:', err);
    container.innerHTML = `<div style="padding:12px;font-size:12px;color:#f14c4c">Render error: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
} else {
  console.error('[Orbit WebView] #root element not found');
}
