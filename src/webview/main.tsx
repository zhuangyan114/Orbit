import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

console.log('[Ozone WebView] mounting...');
const container = document.getElementById('root');
if (container) {
  try {
    const root = createRoot(container);
    root.render(<App />);
    console.log('[Ozone WebView] mounted successfully');
  } catch (err) {
    console.error('[Ozone WebView] render error:', err);
    container.innerHTML = `<div style="padding:12px;font-size:12px;color:#f14c4c">Render error: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
} else {
  console.error('[Ozone WebView] #root element not found');
}