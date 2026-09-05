/*
 * THE SINK IS THE FIRST IMPORT AND THAT IS DELIBERATE. `X4` §1.
 *
 * Module imports are evaluated in source order, so this one is installed before
 * React, before `App` and before the stylesheet — and therefore before anything
 * below can throw while it is still being evaluated. It removes itself from a
 * production build; the note at the top of the file says how.
 */
import './error-sink.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';
/*
 * The page's commitment scheme comes from the one selector, not from an import
 * inside the page. `src/wiring/selection.ts` says what goes wrong when a page
 * and the ledger behind it are computing commitments under different schemes.
 *
 * NOTE FOR THE ROUND THAT ADDS A SECOND SELECTION: this build's scheme is fixed
 * at bundle time while the server's is fixed at boot, so the two are the same
 * only while there is one selection to make. The moment there are two, the page
 * has to learn which one the server is running — `/api/health` already reports
 * it — rather than being built with an answer of its own.
 */
import { wiring } from '../wiring/selection.js';
createRoot(document.getElementById('root')!).render(<App commitments={wiring().commitments} />);
