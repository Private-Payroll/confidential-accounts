// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DocumentTitle } from './document-title.js';

afterEach(cleanup);

/* Paths, not URL objects: under jsdom the global `URL` is jsdom's, and Node's file reader refuses a URL object it did not make. */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EN = JSON.parse(readFileSync(resolve(APP, 'src/locales/en.json'), 'utf8')) as Record<string, string>;
/* A second language, so following the language shown is seen and not assumed. */
const LANGUAGES = languagesFrom({ './locales/en.json': EN, './locales/de.json': { ...EN, 'app.title': 'Private Tresore' } });
const page = (pick: string) => createElement(KitProvider, { languages: LANGUAGES, pick }, createElement(DocumentTitle));

describe('the page title', () => {
  /* RED WHEN: the page is served with a title in a language, so one language shows before any is chosen. */
  it('is empty in the page as served', () => {
    expect(/<title>\s*<\/title>/.test(readFileSync(resolve(APP, 'index.html'), 'utf8'))).toBe(true);
  });

  /* RED WHEN: the title is not set from the language file, or does not follow when the language changes. */
  it('comes from the language file, in the language shown, and follows a change', async () => {
    document.title = '';
    const { rerender } = render(page('de'));
    expect(document.title).toBe('Private Tresore');
    await act(async () => { rerender(page('en')); });
    expect(document.title).toBe(EN['app.title']);
  });
});
