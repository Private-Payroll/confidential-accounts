import './app.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { KitProvider } from 'vaults-ui';
import { DocumentTitle } from './document-title.js';
import { LANGUAGES } from './languages.js';

/**
 * THE NEW PAYROLL APPLICATION'S ENTRY. IT SHOWS NOTHING YET.
 *
 * The application is built here one screen at a time while the one in
 * `src/web-legacy` keeps serving. What is mounted is what every screen will sit
 * inside, the kit's provider with the application's languages, and nothing
 * inside it but the page's title: this is the address the application will be
 * reached at, not a screen, so there is nothing on it to mistake for a working
 * product.
 */
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(createElement(KitProvider, { languages: LANGUAGES }, createElement(DocumentTitle)));
