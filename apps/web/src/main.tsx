import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

const root = document.querySelector('#root');

if (!root) throw new Error('The application root was not found.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
