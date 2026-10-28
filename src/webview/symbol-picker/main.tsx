import React from 'react';
import { createRoot } from 'react-dom/client';
import { SymbolPickerApp } from './app';

const container = document.getElementById('root');
if (container) createRoot(container).render(<SymbolPickerApp />);
