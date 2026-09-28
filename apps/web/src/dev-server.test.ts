import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { searchForWorkspaceRoot } from 'vite';
import config, { SERVED_FROM } from '../vite.config.js';

/*
 * THE DEVELOPMENT SERVER SERVES THE KIT'S FONT, AND OPENS NOTHING WIDER.
 * The kit's stylesheet names the Inter package, installed at the top of the
 * repository; a server that may not serve it shows a fallback font.
 */
const APP = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const FONT = `${REPO}/node_modules/@fontsource-variable/inter`;

describe('the development server', () => {
  /* RED WHEN: the server may not serve the font package, may serve the whole of the repository's packages or the repository, or the list it serves from is not the one the config uses. */
  it('may serve this application and the font package, and nothing else', () => {
    const allow = (config as { server?: { fs?: { allow?: string[] } } }).server?.fs?.allow;
    expect(allow).toBe(SERVED_FROM);
    const served = SERVED_FROM.map((p) => p.replace(/\/$/, ''));
    expect(served).toEqual([searchForWorkspaceRoot(`${APP}/`).replace(/\/$/, ''), FONT]);
    expect(served[0]).toBe(APP);
    for (const wider of [REPO, `${REPO}/node_modules`, `${REPO}/node_modules/@fontsource-variable`]) expect(served).not.toContain(wider);
  });

  /* RED WHEN: the kit's stylesheet names a font package other than the one the server may serve, or that package is not there. */
  it('serves the font the kit\'s stylesheet names', () => {
    expect(readFileSync(`${REPO}/packages/ui/src/styles.css`, 'utf8')).toContain('@import "@fontsource-variable/inter";');
    expect(existsSync(`${FONT}/index.css`)).toBe(true);
  });
});
