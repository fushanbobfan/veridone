import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { MotionGlobalConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

// Motion ignores the device's reduced-motion setting unless told, and its own option for it keeps fades. Skipping sets
// each value at once, as the end of styles.css does for CSS animation. Motion reads the flag as each animation starts,
// so a change to the setting applies from the next one.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const followReducedMotion = () => {
  MotionGlobalConfig.skipAnimations = reducedMotion.matches;
};
followReducedMotion();
reducedMotion.addEventListener('change', followReducedMotion);

const root = document.querySelector('#root');

if (!root) throw new Error('The application root was not found.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
