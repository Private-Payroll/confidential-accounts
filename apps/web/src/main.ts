import './app.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { browserStorage, computerIsDark, readPreferences, showAppearance, themeFor } from './preferences.js';
import { Root } from './root.js';

/**
 * THE NEW PAYROLL APPLICATION'S ENTRY.
 *
 * The person's light or dark and colour are shown on the page before anything
 * is drawn, so the first frame is already in them rather than flashing the
 * default. Then the application is mounted.
 */
/*
 * In development only, the page's errors, rejections, console errors and failed
 * requests are posted to the service. The condition is a build-time constant, so a
 * production build holds none of the sink and its first download does not grow;
 * the import is awaited so the sink is watching before the page is drawn.
 */
if (import.meta.env.DEV) await import('./adapters/error-report.js');
const kept = readPreferences(browserStorage());
showAppearance(document.documentElement, themeFor(kept.mode, computerIsDark()), kept.base);
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(createElement(Root));
