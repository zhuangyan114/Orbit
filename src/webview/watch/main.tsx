import React from 'react';
import { createRoot } from 'react-dom/client';
import { WatchApp } from './app';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<WatchApp />);
}
